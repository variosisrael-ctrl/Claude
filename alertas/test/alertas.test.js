"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const Alertas = require("../lib.js");
const Analisis = require("../../secop_radar/site/analisis.js");

const HOY = Date.UTC(2026, 9, 13, 17); // 13 de octubre de 2026, mediodía en Bogotá
const busqueda = (extra = {}) => ({ nombre: "Mantenimiento TI", params: { palabras: "mantenimiento", codigos: "8011", departamento: "", min: "", max: "", dias: "15", competitivos: "1", abiertos: "1" }, minimo: 40, ...extra });

const proceso = (id, extra = {}) => ({
  id, nombre: `Proceso ${id}`, entidad: "Alcaldía de Honda", ciudad: "Honda", departamento: "Tolima", presupuesto: 49000000,
  modalidad: "Mínima cuantía", cierre: "2026-10-14", puntaje: 80, url: `https://community.secop.gov.co/${id}`, ...extra,
});

/** Cliente de SECOP simulado: devuelve los resultados que correspondan a las palabras de la búsqueda. */
const clienteFalso = (porPalabras) => ({
  buscarOportunidades: async (params) => {
    const r = porPalabras[params.palabras];
    if (r instanceof Error) throw r;
    return { resultados: r ?? [] };
  },
});

const enviadorFalso = () => {
  const mensajes = [];
  return { mensajes, enviar: async (texto) => { mensajes.push(texto); } };
};

test("configuración de búsquedas", async (t) => {
  await t.test("completa los valores por defecto", () => {
    const [b] = Alertas.leerBusquedas(JSON.stringify([{ nombre: " Mantenimiento TI ", palabras: "mantenimiento", codigos: "8011" }]));
    assert.equal(b.nombre, "Mantenimiento TI");
    assert.deepEqual(b.params, { palabras: "mantenimiento", codigos: "8011", departamento: "", min: "", max: "", dias: "15", competitivos: "1", abiertos: "1" });
    assert.equal(b.minimo, 40);
  });

  await t.test("acepta un mínimo propio y datos numéricos", () => {
    const [b] = Alertas.leerBusquedas(JSON.stringify([{ nombre: "A", palabras: "software", min: 1000000, max: 9000000, minimo: 0 }]));
    assert.equal(b.params.min, "1000000");
    assert.equal(b.minimo, 0);
  });

  await t.test("rechaza configuraciones inválidas sin repetir su contenido", () => {
    const casos = [
      ["no es json", /no es un JSON válido/],
      ["{}", /lista con al menos una búsqueda/],
      ["[]", /lista con al menos una búsqueda/],
      [JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ nombre: `b${i}`, palabras: "x1" }))), /máximo 20/],
      [JSON.stringify([{ palabras: "software" }]), /#1 no tiene nombre/],
      [JSON.stringify([{ nombre: "A", palabras: "software" }, { nombre: "a", palabras: "redes" }]), /#2 repite un nombre/],
      [JSON.stringify([{ nombre: "A" }]), /#1 no es válida: Indica al menos una palabra clave/],
      [JSON.stringify([{ nombre: "A", palabras: "x' OR 1=1" }]), /#1 no es válida/],
      [JSON.stringify([{ nombre: "A", palabras: "software", minimo: 150 }]), /"minimo" fuera de 0 a 100/],
    ];
    for (const [texto, patron] of casos) {
      assert.throws(() => Alertas.leerBusquedas(texto), (error) => {
        assert.ok(error instanceof Alertas.ErrorDeAlertas);
        assert.match(error.message, patron);
        assert.ok(!error.message.includes("OR 1=1"), "no repite el contenido recibido");
        return true;
      });
    }
  });
});

test("mensajes", async (t) => {
  const hoy = new Date(HOY);

  await t.test("textoCierre describe el plazo en días", () => {
    assert.equal(Alertas.textoCierre("2026-10-13", hoy), "cierra hoy");
    assert.equal(Alertas.textoCierre("2026-10-14", hoy), "cierra mañana");
    assert.match(Alertas.textoCierre("2026-10-20", hoy), /^cierra en 7 días \(20 de oct/);
    assert.equal(Alertas.textoCierre(null, hoy), "cierre no informado");
  });

  await t.test("un proceso: título, datos y enlace, con el HTML escapado", () => {
    const [mensaje] = Alertas.formatearMensajes(busqueda({ nombre: "A & B <x>" }), [proceso("P1", { nombre: "Mantenimiento <b>urgente</b> & más" })], { hoy });
    assert.ok(mensaje.startsWith("<b>Radar SECOP: 1 proceso nuevo</b>\nBúsqueda: A &amp; B &lt;x&gt;"));
    assert.ok(mensaje.includes("1. <b>Mantenimiento &lt;b&gt;urgente&lt;/b&gt; &amp; más</b>"));
    assert.ok(mensaje.includes("$ 49.000.000 · Mínima cuantía"));
    assert.ok(mensaje.includes("cierra mañana · coincidencia 80 %"));
    assert.ok(mensaje.includes('<a href="https://community.secop.gov.co/P1">Ver en SECOP II</a>'));
  });

  await t.test("trocea en varios mensajes sin pasar el límite de Telegram y avisa de los que no caben", () => {
    const muchos = Array.from({ length: 30 }, (_, i) => proceso(`P${i}`, { nombre: "N".repeat(140) + i, entidad: "E".repeat(200) }));
    const mensajes = Alertas.formatearMensajes(busqueda(), muchos, { hoy, appUrl: "https://ejemplo.github.io/Claude/" });
    assert.ok(mensajes.length >= 3);
    for (const m of mensajes) assert.ok(m.length <= 4096, `un mensaje de ${m.length} caracteres no cabe en Telegram`);
    assert.ok(mensajes[0].startsWith("<b>Radar SECOP: 30 procesos nuevos</b>"));
    assert.ok(mensajes[1].startsWith("<b>Radar SECOP</b> (continuación)"));
    const todo = mensajes.join("\n");
    assert.ok(todo.includes("20. <b>"), "detalla hasta 20");
    assert.ok(!todo.includes("21. <b>"));
    assert.ok(todo.includes("Y 10 más."));
    assert.ok(todo.includes("https://ejemplo.github.io/Claude/?palabras=mantenimiento&amp;codigos=8011"), "enlace a la búsqueda en la app");
  });

  await t.test("enlaceDeLaApp usa el mismo formato que “Copiar enlace” y quita parámetros previos", () => {
    const enlace = Alertas.enlaceDeLaApp("https://x.github.io/Claude/?viejo=1#hash", busqueda());
    assert.equal(enlace, "https://x.github.io/Claude/?palabras=mantenimiento&codigos=8011&dias=15&competitivos=1&abiertos=1");
    assert.equal(Alertas.enlaceDeLaApp("", busqueda()), null);
  });
});

test("envío a Telegram", async (t) => {
  const respuesta = (status, cuerpo) => ({ ok: status >= 200 && status < 300, status, json: async () => cuerpo });

  await t.test("envía chat_id, HTML y sin vista previa de enlaces", async () => {
    const llamadas = [];
    const enviar = Alertas.crearEnviadorTelegram({ token: "123:ABC", chatId: "-1001", base: "http://telegram.falso", fetchFn: async (url, opciones) => { llamadas.push({ url, opciones }); return respuesta(200, { ok: true }); } });
    await enviar("hola");
    assert.equal(llamadas[0].url, "http://telegram.falso/bot123:ABC/sendMessage");
    assert.deepEqual(JSON.parse(llamadas[0].opciones.body), { chat_id: "-1001", text: "hola", parse_mode: "HTML", disable_web_page_preview: true });
  });

  await t.test("un error de Telegram se explica sin mostrar el token", async () => {
    const enviar = Alertas.crearEnviadorTelegram({ token: "123:ABC", chatId: "1", fetchFn: async () => respuesta(400, { ok: false, description: "Bad Request: chat not found" }) });
    await assert.rejects(enviar("x"), (e) => { assert.match(e.message, /400.*chat not found/); assert.ok(!e.message.includes("123:ABC")); return true; });
    const sinRed = Alertas.crearEnviadorTelegram({ token: "123:ABC", chatId: "1", fetchFn: async () => { throw new TypeError("fetch failed 123:ABC"); } });
    await assert.rejects(sinRed("x"), (e) => { assert.match(e.message, /No se pudo conectar/); assert.ok(!e.message.includes("123:ABC")); return true; });
  });

  await t.test("ante un 429 espera lo que pide Telegram y reintenta", async () => {
    const respuestas = [respuesta(429, { ok: false, description: "Too Many Requests", parameters: { retry_after: 3 } }), respuesta(200, { ok: true })];
    const esperas = [];
    const enviar = Alertas.crearEnviadorTelegram({ token: "t", chatId: "1", fetchFn: async () => respuestas.shift(), esperar: async (ms) => { esperas.push(ms); } });
    await enviar("x");
    assert.deepEqual(esperas, [4000]);
    assert.equal(respuestas.length, 0);
  });

  await t.test("habla con un servidor HTTP real (el de Telegram simulado)", async () => {
    const recibidas = [];
    const servidor = http.createServer((req, res) => {
      let cuerpo = "";
      req.on("data", (d) => (cuerpo += d));
      req.on("end", () => { recibidas.push({ url: req.url, metodo: req.method, cuerpo: JSON.parse(cuerpo) }); res.setHeader("content-type", "application/json"); res.end('{"ok":true,"result":{}}'); });
    });
    await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
    try {
      const enviar = Alertas.crearEnviadorTelegram({ token: "999:TOKEN", chatId: "-42", base: `http://127.0.0.1:${servidor.address().port}` });
      await enviar("<b>prueba</b>");
    } finally {
      await new Promise((r) => servidor.close(r));
    }
    assert.equal(recibidas.length, 1);
    assert.equal(recibidas[0].metodo, "POST");
    assert.equal(recibidas[0].url, "/bot999:TOKEN/sendMessage");
    assert.equal(recibidas[0].cuerpo.chat_id, "-42");
  });
});

test("ejecución de las alertas", async (t) => {
  const correr = (opciones) => Alertas.ejecutar({ ahora: () => HOY, ...opciones });

  await t.test("la primera vez avisa que quedó activa y siembra lo ya abierto sin inundar el chat", async () => {
    const { mensajes, enviar } = enviadorFalso();
    const cliente = clienteFalso({ mantenimiento: [proceso("P1"), proceso("P2")] });
    const { estado, resumen } = await correr({ busquedas: [busqueda()], estado: null, cliente, enviar });
    assert.equal(mensajes.length, 1);
    assert.match(mensajes[0], /alertas activadas/);
    assert.ok(mensajes[0].includes("Mantenimiento TI"));
    assert.deepEqual(resumen, { busquedas: 1, nuevos: 0, mensajes: 1, sembradas: 1, fallos_consulta: 0, fallos_telegram: 0 });
    assert.deepEqual(Object.keys(estado.vistos["mantenimiento ti"]).sort(), ["P1", "P2"]);
    assert.equal(estado.activadas, true);
  });

  await t.test("después solo avisa de los procesos nuevos, ordenados por cierre, y no los repite", async () => {
    const { mensajes, enviar } = enviadorFalso();
    const base = { version: 1, activadas: true, vistos: { "mantenimiento ti": { P1: "2026-10-12" } } };
    const cliente = clienteFalso({ mantenimiento: [proceso("P1"), proceso("P2", { cierre: "2026-10-20" }), proceso("P3", { cierre: "2026-10-14" })] });
    const r1 = await correr({ busquedas: [busqueda()], estado: base, cliente, enviar });
    assert.equal(mensajes.length, 1);
    assert.ok(mensajes[0].includes("2 procesos nuevos"));
    assert.ok(mensajes[0].indexOf("Proceso P3") < mensajes[0].indexOf("Proceso P2"), "el que cierra primero va primero");
    assert.ok(!mensajes[0].includes("Proceso P1"));
    assert.equal(r1.resumen.nuevos, 2);

    const { mensajes: segundos, enviar: enviar2 } = enviadorFalso();
    await correr({ busquedas: [busqueda()], estado: r1.estado, cliente, enviar: enviar2 });
    assert.equal(segundos.length, 0, "no repite lo ya avisado");
  });

  await t.test("respeta el mínimo de coincidencia de cada búsqueda", async () => {
    const { mensajes, enviar } = enviadorFalso();
    const base = { version: 1, activadas: true, vistos: { "mantenimiento ti": {} } };
    const cliente = clienteFalso({ mantenimiento: [proceso("ALTO", { puntaje: 60 }), proceso("BAJO", { puntaje: 20 })] });
    await correr({ busquedas: [busqueda({ minimo: 40 })], estado: base, cliente, enviar });
    assert.ok(mensajes[0].includes("Proceso ALTO") && !mensajes[0].includes("Proceso BAJO"));
  });

  await t.test("enviarTodo avisa también lo que ya estaba abierto", async () => {
    const { mensajes, enviar } = enviadorFalso();
    const cliente = clienteFalso({ mantenimiento: [proceso("P1")] });
    const { resumen } = await correr({ busquedas: [busqueda()], estado: { version: 1, activadas: true, vistos: {} }, cliente, enviar, enviarTodo: true });
    assert.equal(resumen.nuevos, 1);
    assert.ok(mensajes[0].includes("Proceso P1"));
  });

  await t.test("una búsqueda agregada después se siembra en silencio y las demás siguen avisando", async () => {
    const { mensajes, enviar } = enviadorFalso();
    const base = { version: 1, activadas: true, vistos: { "mantenimiento ti": {} } };
    const cliente = clienteFalso({ mantenimiento: [proceso("P1")], redes: [proceso("R1"), proceso("R2")] });
    const { resumen, estado } = await correr({ busquedas: [busqueda(), busqueda({ nombre: "Redes", params: { ...busqueda().params, palabras: "redes" } })], estado: base, cliente, enviar });
    assert.equal(resumen.sembradas, 1);
    assert.equal(resumen.nuevos, 1);
    assert.ok(!mensajes.join("").includes("Proceso R1"));
    assert.deepEqual(Object.keys(estado.vistos.redes).sort(), ["R1", "R2"]);
  });

  await t.test("si falla la consulta de una búsqueda sigue con las demás y la cuenta", async () => {
    const { mensajes, enviar } = enviadorFalso();
    const registros = [];
    const base = { version: 1, activadas: true, vistos: { "mantenimiento ti": {}, redes: {} } };
    const cliente = clienteFalso({ mantenimiento: new Secop_ErrorFalso("datos.gov.co no respondió"), redes: [proceso("R1")] });
    const { resumen } = await correr({ busquedas: [busqueda(), busqueda({ nombre: "Redes", params: { ...busqueda().params, palabras: "redes" } })], estado: base, cliente, enviar, registrar: (m) => registros.push(m) });
    assert.equal(resumen.fallos_consulta, 1);
    assert.equal(resumen.nuevos, 1);
    assert.equal(mensajes.length, 1);
    assert.ok(registros.every((r) => !r.includes("Mantenimiento") && !r.includes("Redes")), "los registros públicos no llevan nombres de búsquedas");
  });

  await t.test("si Telegram falla no marca los procesos como avisados, para reintentar después", async () => {
    const registros = [];
    const base = { version: 1, activadas: true, vistos: { "mantenimiento ti": {} } };
    const cliente = clienteFalso({ mantenimiento: [proceso("P1")] });
    const roto = async () => { throw new Alertas.ErrorDeAlertas("Telegram respondió 401: Unauthorized."); };
    const { resumen, estado } = await correr({ busquedas: [busqueda()], estado: base, cliente, enviar: roto, registrar: (m) => registros.push(m) });
    assert.equal(resumen.fallos_telegram, 1);
    assert.equal(resumen.nuevos, 0);
    assert.deepEqual(estado.vistos["mantenimiento ti"], {});
    assert.ok(registros.every((r) => !r.includes("Proceso P1") && !r.includes("Mantenimiento")));

    const { mensajes, enviar } = enviadorFalso();
    const reintento = await correr({ busquedas: [busqueda()], estado, cliente, enviar });
    assert.equal(reintento.resumen.nuevos, 1, "al arreglar Telegram sí llega");
    assert.ok(mensajes[0].includes("Proceso P1"));
  });

  await t.test("si falla la bienvenida (bot o chat mal configurados) queda registrado y se reintenta", async () => {
    const roto = async () => { throw new Alertas.ErrorDeAlertas("Telegram respondió 400: chat not found."); };
    const { resumen, estado } = await correr({ busquedas: [busqueda()], estado: null, cliente: clienteFalso({}), enviar: roto });
    assert.equal(resumen.fallos_telegram, 1);
    assert.equal(estado.activadas, false);
  });

  await t.test("en simulación no envía nada y entrega los mensajes para revisarlos", async () => {
    const registros = [];
    const enviar = async () => { throw new Error("no debe enviar"); };
    const base = { version: 1, activadas: true, vistos: { "mantenimiento ti": {} } };
    const { resumen } = await correr({ busquedas: [busqueda()], estado: base, cliente: clienteFalso({ mantenimiento: [proceso("P1")] }), enviar, simulacion: true, registrar: (m) => registros.push(m) });
    assert.equal(resumen.fallos_telegram, 0);
    assert.ok(registros[0].includes("Proceso P1"));
  });

  await t.test("olvida los procesos avisados hace más de 120 días", async () => {
    const base = { version: 1, activadas: true, vistos: { "mantenimiento ti": { VIEJO: "2026-05-01", RECIENTE: "2026-10-01" } } };
    const { estado } = await correr({ busquedas: [busqueda()], estado: base, cliente: clienteFalso({ mantenimiento: [] }), enviar: async () => {} });
    assert.deepEqual(Object.keys(estado.vistos["mantenimiento ti"]), ["RECIENTE"]);
  });
});

class Secop_ErrorFalso extends Error {}

test("programa de línea de comandos (sin red)", async (t) => {
  const programa = path.join(__dirname, "..", "alertas.js");
  const correr = (env) => spawnSync(process.execPath, [programa], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });

  await t.test("sin configurar, la ejecución programada solo avisa y la manual falla", () => {
    const programada = correr({});
    assert.equal(programada.status, 0);
    assert.match(programada.stdout, /::warning::Alertas sin configurar: faltan los secretos ALERTAS_BUSQUEDAS, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID/);
    const manual = correr({ GITHUB_EVENT_NAME: "workflow_dispatch" });
    assert.equal(manual.status, 1);
    assert.match(manual.stdout, /::error::Alertas sin configurar/);
  });

  await t.test("una configuración inválida falla sin imprimir su contenido", () => {
    const r = correr({ ALERTAS_BUSQUEDAS: "esto-es-secreto-123", TELEGRAM_BOT_TOKEN: "t", TELEGRAM_CHAT_ID: "1" });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /::error::ALERTAS_BUSQUEDAS no es un JSON válido/);
    assert.ok(!r.stdout.includes("secreto-123") && !r.stderr.includes("secreto-123"));
  });
});

test("configuración generada por la página", async (t) => {
  const guardadas = [
    { nombre: "Mantenimiento TI", perfil: { palabras: "mantenimiento, software", codigos: "8011", departamento: "Antioquia", min: "1000000", max: "", competitivos: "1", abiertos: "1", dias: "30" } },
    { nombre: "Capacitación", perfil: { palabras: "capacitación", codigos: "", competitivos: "0" } },
  ];

  await t.test("va en una sola línea y el motor de alertas la acepta", () => {
    const texto = Analisis.aConfiguracionAlertas(guardadas);
    assert.ok(!texto.includes("\n"));
    const busquedas = Alertas.leerBusquedas(texto);
    assert.equal(busquedas.length, 2);
    assert.deepEqual(busquedas[0].params, { palabras: "mantenimiento, software", codigos: "8011", departamento: "Antioquia", min: "1000000", max: "", dias: "15", competitivos: "1", abiertos: "1" });
    assert.equal(busquedas[1].params.competitivos, "0", "respeta que no se limite a procesos competitivos");
    assert.equal(busquedas[0].minimo, 40);
  });

  await t.test("tolera campos ausentes del perfil guardado", () => {
    const [b] = JSON.parse(Analisis.aConfiguracionAlertas([{ nombre: "X", perfil: { palabras: "software" } }]));
    assert.deepEqual(b, { nombre: "X", palabras: "software", codigos: "", departamento: "", min: "", max: "", competitivos: "1", dias: "15", minimo: 40 });
  });
});
