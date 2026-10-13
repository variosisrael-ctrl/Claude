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

const resumenBusqueda = (extra = {}) => ({
  nombre: "Resumen nacional", params: { palabras: "", codigos: "", departamento: "", min: "", max: "", dias: "3", competitivos: "1", abiertos: "1" },
  minimo: 0, resumen: true, top: 15, ...extra,
});
const MANANA = Date.UTC(2026, 9, 13, 12); // 7:00 en Bogotá: la ejecución de la mañana
const TARDE = Date.UTC(2026, 9, 13, 22); // 17:00 en Bogotá

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

  await t.test("un resumen diario no necesita palabras ni códigos", () => {
    const [b] = Alertas.leerBusquedas(JSON.stringify([{ nombre: "Resumen nacional", resumen: true }]));
    assert.equal(b.resumen, true);
    assert.equal(b.top, 15);
    assert.equal(b.minimo, 0);
    assert.deepEqual(b.params, { palabras: "", codigos: "", departamento: "", min: "", max: "", dias: "3", competitivos: "1", abiertos: "1" });
    const [c] = Alertas.leerBusquedas(JSON.stringify([{ nombre: "Antioquia", resumen: true, departamento: "Antioquia", min: 50000000, top: 10, dias: 2 }]));
    assert.deepEqual([c.params.departamento, c.params.min, c.params.dias, c.top], ["Antioquia", "50000000", "2", 10]);
  });

  await t.test("el resumen valida sus datos igual que una búsqueda", () => {
    for (const extra of [{ top: 0 }, { top: 31 }, { top: 2.5 }, { departamento: "x' OR 1=1" }, { min: 9, max: 1 }, { dias: 0 }]) {
      assert.throws(() => Alertas.leerBusquedas(JSON.stringify([{ nombre: "R", resumen: true, ...extra }])), (error) => {
        assert.ok(error instanceof Alertas.ErrorDeAlertas);
        assert.ok(!error.message.includes("OR 1=1"));
        return true;
      });
    }
    assert.throws(() => Alertas.leerBusquedas(JSON.stringify([{ nombre: "A", resumen: "si" }])), /Indica al menos una palabra clave/, "solo resumen: true lo habilita");
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

  await t.test("resumen: total, modalidades y los de mayor presupuesto sin “coincidencia”", () => {
    const procesos = [
      proceso("P1", { presupuesto: 10_000_000, modalidad: "Mínima cuantía" }),
      proceso("P2", { presupuesto: 900_000_000, modalidad: "Licitación pública", nombre: "Obra <grande> & cara" }),
      proceso("P3", { presupuesto: null, modalidad: "Mínima cuantía" }),
      proceso("P4", { presupuesto: 300_000_000, modalidad: "Selección abreviada" }),
    ];
    const [mensaje] = Alertas.formatearResumen(resumenBusqueda({ top: 2 }), procesos, { hoy, appUrl: "https://x.github.io/Claude/?viejo=1" });
    assert.ok(mensaje.startsWith("<b>Radar SECOP: resumen de 4 procesos nuevos</b>\nResumen nacional\n"));
    assert.ok(mensaje.includes("Mínima cuantía: 2 · Licitación pública: 1 · Selección abreviada: 1"));
    assert.ok(mensaje.includes("Los 2 de mayor presupuesto:"));
    assert.ok(mensaje.indexOf("1. <b>Obra &lt;grande&gt; &amp; cara</b>") > 0, "el mayor presupuesto va primero y se escapa");
    assert.ok(mensaje.indexOf("$ 900.000.000") < mensaje.indexOf("$ 300.000.000"));
    assert.ok(!mensaje.includes("Proceso P1") && !mensaje.includes("Proceso P3"), "solo los 2 mayores");
    assert.ok(!mensaje.includes("coincidencia"));
    assert.ok(mensaje.includes('<a href="https://x.github.io/Claude/">Buscar en el Radar</a>'));
  });

  await t.test("resumen: muestra los filtros, sin presupuesto va al final y avisa si el límite de consulta se alcanzó", () => {
    const b = resumenBusqueda({ params: { ...resumenBusqueda().params, departamento: "Antioquia", min: "50000000" } });
    const [mensaje] = Alertas.formatearResumen(b, [proceso("P1", { presupuesto: null }), proceso("P2", { presupuesto: 5 })], { hoy, limiteAlcanzado: true });
    assert.ok(mensaje.includes("Resumen nacional (departamento: Antioquia, desde $ 50.000.000)"));
    assert.ok(mensaje.includes("puede estar incompleto"));
    assert.ok(mensaje.indexOf("Proceso P2") < mensaje.indexOf("Proceso P1"));
    assert.ok(mensaje.includes("presupuesto no informado"));
    assert.ok(!mensaje.includes("Buscar en el Radar"), "sin dirección de la app no hay enlace");
  });

  await t.test("resumen: trocea sin pasar el límite de Telegram y con más de 5 modalidades suma las demás", () => {
    const muchos = Array.from({ length: 30 }, (_, i) => proceso(`P${i}`, { nombre: "N".repeat(140), entidad: "E".repeat(200), presupuesto: 1000 + i, modalidad: `Modalidad ${i % 7}` }));
    const mensajes = Alertas.formatearResumen(resumenBusqueda({ top: 30 }), muchos, { hoy, appUrl: "https://x.github.io/Claude/" });
    assert.ok(mensajes.length >= 3);
    for (const m of mensajes) assert.ok(m.length <= 4096, `un mensaje de ${m.length} caracteres no cabe en Telegram`);
    assert.ok(mensajes[1].startsWith("<b>Radar SECOP</b> (continuación del resumen)"));
    assert.match(mensajes[0], / · otras: \d+/);
    assert.ok(mensajes.join("\n").includes("30. <b>"));
  });

  await t.test("horaEnBogota ignora la zona del servidor", () => {
    assert.equal(Alertas.horaEnBogota(new Date(Date.UTC(2026, 9, 13, 12))), 7);
    assert.equal(Alertas.horaEnBogota(new Date(Date.UTC(2026, 9, 13, 22))), 17);
    assert.equal(Alertas.horaEnBogota(new Date(Date.UTC(2026, 9, 13, 5))), 0);
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

  await t.test("resumen: sale en la mañana desde la primera vez (sin sembrar) y no repite lo ya resumido", async () => {
    const { mensajes, enviar } = enviadorFalso();
    const consultas = [];
    const cliente = { buscarOportunidades: async (params, opciones) => { consultas.push({ params, opciones }); return { resultados: [proceso("P1", { presupuesto: 5e8 }), proceso("P2")], limite_alcanzado: false }; } };
    const primera = await correr({ ahora: () => MANANA, busquedas: [resumenBusqueda()], estado: null, cliente, enviar });
    assert.equal(mensajes.length, 2);
    assert.match(mensajes[0], /alertas activadas/);
    assert.match(mensajes[0], /Cada mañana recibirás un resumen/);
    assert.match(mensajes[1], /resumen de 2 procesos nuevos/);
    assert.deepEqual(primera.resumen, { busquedas: 1, nuevos: 2, mensajes: 2, sembradas: 0, fallos_consulta: 0, fallos_telegram: 0 });
    assert.deepEqual(consultas[0].opciones, { amplio: true }, "pide la consulta amplia");

    const segunda = await correr({ ahora: () => MANANA + 864e5, busquedas: [resumenBusqueda()], estado: primera.estado, cliente, enviar });
    assert.equal(mensajes.length, 2, "no repite procesos");
    assert.equal(segunda.resumen.nuevos, 0);

    const nuevoCliente = { buscarOportunidades: async () => ({ resultados: [proceso("P1"), proceso("P2"), proceso("P3", { presupuesto: 7e8 })] }) };
    await correr({ ahora: () => MANANA + 2 * 864e5, busquedas: [resumenBusqueda()], estado: segunda.estado, cliente: nuevoCliente, enviar });
    assert.equal(mensajes.length, 3);
    assert.match(mensajes[2], /resumen de 1 proceso nuevo/);
    assert.ok(mensajes[2].includes("Proceso P3"));
  });

  await t.test("resumen: en la ejecución de la tarde no sale ni consulta, pero las demás búsquedas siguen; si es manual sí sale", async () => {
    const { mensajes, enviar } = enviadorFalso();
    const consultas = [];
    const cliente = { buscarOportunidades: async (params) => { consultas.push(params.palabras); return { resultados: params.palabras ? [proceso("P9")] : [proceso("R1")] }; } };
    const base = { version: 1, activadas: true, vistos: { "mantenimiento ti": {} } };
    const tarde = await correr({ ahora: () => TARDE, busquedas: [resumenBusqueda(), busqueda()], estado: base, cliente, enviar });
    assert.deepEqual(consultas, ["mantenimiento"], "el resumen ni se consulta");
    assert.equal(mensajes.length, 1);
    assert.match(mensajes[0], /Mantenimiento TI/);
    assert.ok(!("resumen nacional" in tarde.estado.vistos), "no toca el estado del resumen");

    const manual = await correr({ ahora: () => TARDE, manual: true, busquedas: [resumenBusqueda()], estado: tarde.estado, cliente, enviar });
    assert.equal(manual.resumen.nuevos, 1);
    assert.match(mensajes.at(-1), /resumen de 1 proceso nuevo/);
  });

  await t.test("resumen: si Telegram falla no marca los procesos y se reintenta en la siguiente ejecución", async () => {
    const cliente = { buscarOportunidades: async () => ({ resultados: [proceso("P1")] }) };
    const base = { version: 1, activadas: true, vistos: {} };
    const fallida = await correr({ ahora: () => MANANA, busquedas: [resumenBusqueda()], estado: base, cliente, enviar: async () => { throw new Alertas.ErrorDeAlertas("Telegram respondió 500"); } });
    assert.equal(fallida.resumen.fallos_telegram, 1);
    assert.deepEqual(fallida.estado.vistos["resumen nacional"], {});
    const { mensajes, enviar } = enviadorFalso();
    await correr({ ahora: () => MANANA, busquedas: [resumenBusqueda()], estado: fallida.estado, cliente, enviar });
    assert.equal(mensajes.length, 1);
  });

  await t.test("la clave de estado de una búsqueda es su identificador, no su nombre: renombrarla no vuelve a sembrarla", async () => {
    const { mensajes, enviar } = enviadorFalso();
    const cliente = clienteFalso({ mantenimiento: [proceso("P1"), proceso("P2")] });
    const base = { version: 1, activadas: true, vistos: { "a:abc12345": { P1: "2026-10-12" } } };
    const renombrada = busqueda({ nombre: "Nuevo nombre", clave: "a:abc12345" });
    const { resumen } = await correr({ busquedas: [renombrada], estado: base, cliente, enviar });
    assert.equal(resumen.sembradas, 0);
    assert.equal(resumen.nuevos, 1, "solo avisa P2");
    assert.match(mensajes[0], /Nuevo nombre/);
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
    assert.match(programada.stdout, /::warning::Alertas sin configurar: faltan los secretos TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, ALERTAS_GIST_ID \(o ALERTAS_BUSQUEDAS\)/);
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

  await t.test("con resumen agrega la entrada del resumen diario y el motor la acepta", () => {
    const busquedas = Alertas.leerBusquedas(Analisis.aConfiguracionAlertas(guardadas, { resumen: true }));
    assert.equal(busquedas.length, 3);
    assert.equal(busquedas[2].resumen, true);
    assert.equal(busquedas[2].nombre, "Resumen nacional");
    assert.equal(busquedas[2].params.dias, "3");
    assert.ok(!Analisis.aConfiguracionAlertas(guardadas).includes("Resumen nacional"), "sin la casilla no se agrega");
  });

  await t.test("el resumen solo (sin búsquedas guardadas) también es válido", () => {
    const [r] = Alertas.leerBusquedas(Analisis.aConfiguracionAlertas([], { resumen: true }));
    assert.equal(r.resumen, true);
  });

  await t.test("el nombre del resumen no choca con una búsqueda guardada que se llame igual", () => {
    const choque = [{ nombre: "resumen NACIONAL", perfil: { palabras: "software" } }];
    const busquedas = Alertas.leerBusquedas(Analisis.aConfiguracionAlertas(choque, { resumen: true }));
    assert.deepEqual(busquedas.map((b) => b.nombre), ["resumen NACIONAL", "Resumen nacional (resumen)"]);
  });

  await t.test("tolera campos ausentes del perfil guardado", () => {
    const [b] = JSON.parse(Analisis.aConfiguracionAlertas([{ nombre: "X", perfil: { palabras: "software" } }]));
    assert.deepEqual(b, { nombre: "X", palabras: "software", codigos: "", departamento: "", min: "", max: "", competitivos: "1", dias: "15", minimo: 40 });
  });
});

const seguido = (id, extra = {}) => ({ id, nombre: `Seguido ${id}`, entidad: "Alcaldía", cierre: "2026-10-20", ...extra });
const actualDe = (id, extra = {}) => ({
  id, nombre: `Proceso ${id}`, entidad: "Alcaldía de Honda", cierre: "2026-10-20", adjudicado: false, ganador: null, valor_adjudicado: null,
  estado_procedimiento: "Publicado", url: `https://community.secop.gov.co/${id}`, ...extra,
});
const clienteDeSeguimiento = (procesos) => ({
  buscarOportunidades: async () => ({ resultados: [] }),
  buscarProcesosPorId: async (ids) => {
    if (procesos instanceof Error) throw procesos;
    return new Map(ids.filter((id) => id in procesos).map((id) => [id, procesos[id]]));
  },
});

test("cambios en los procesos que se siguen", async (t) => {
  const correr = (opciones) => Alertas.ejecutar({ ahora: () => MANANA, busquedas: [], ...opciones });
  const base = { version: 1, activadas: true, vistos: {}, seguimiento: {} };

  await t.test("cambiosDeProceso detecta cierre, adjudicación y cancelación o suspensión", () => {
    const previo = { cierre: "2026-10-20", adjudicado: false, estado_proc: "Publicado" };
    assert.deepEqual(Alertas.cambiosDeProceso(previo, actualDe("A")), []);
    assert.deepEqual(Alertas.cambiosDeProceso(previo, actualDe("A", { cierre: "2026-10-27" })), [{ tipo: "cierre", de: "2026-10-20", a: "2026-10-27" }]);
    assert.deepEqual(Alertas.cambiosDeProceso(previo, actualDe("A", { adjudicado: true, ganador: "G SAS", valor_adjudicado: 5 })), [{ tipo: "adjudicado", ganador: "G SAS", valor: 5 }]);
    assert.deepEqual(Alertas.cambiosDeProceso(previo, actualDe("A", { estado_procedimiento: "Cancelado" })), [{ tipo: "estado", estado: "Cancelado" }]);
    assert.deepEqual(Alertas.cambiosDeProceso({ ...previo, estado_proc: "Cancelado" }, actualDe("A", { estado_procedimiento: "Cancelado" })), [], "no repite lo ya avisado");
    assert.deepEqual(Alertas.cambiosDeProceso(previo, actualDe("A", { estado_procedimiento: "Evaluación" })), [], "otros estados no se avisan");
    assert.deepEqual(Alertas.cambiosDeProceso({ ...previo, cierre: null }, actualDe("A")), [], "sin cierre previo no hay cambio de cierre");
    assert.equal(Alertas.cambiosDeProceso({ ...previo, adjudicado: true }, actualDe("A", { adjudicado: true })).length, 0);
  });

  await t.test("la primera vez usa el cierre que se conocía al seguirlo y avisa lo que cambió", async () => {
    const { mensajes, enviar } = enviadorFalso();
    const cliente = clienteDeSeguimiento({
      "CO1.REQ.1": actualDe("CO1.REQ.1", { cierre: "2026-10-27" }),
      "CO1.REQ.2": actualDe("CO1.REQ.2"),
      "CO1.REQ.3": actualDe("CO1.REQ.3", { adjudicado: true, ganador: "GANADOR <SAS>", valor_adjudicado: 12000000, estado_procedimiento: "Seleccionado" }),
    });
    const seguimiento = [seguido("CO1.REQ.1"), seguido("CO1.REQ.2"), seguido("CO1.REQ.3"), seguido("CO1.REQ.4")];
    const { estado, resumen } = await correr({ seguimiento, estado: base, cliente, enviar });
    assert.equal(mensajes.length, 1);
    assert.match(mensajes[0], /^<b>Radar SECOP: cambiaron 2 procesos que sigues<\/b>/);
    assert.ok(mensajes[0].includes("1. <b>Proceso CO1.REQ.1</b>\nAlcaldía de Honda\n• Cambió la fecha de cierre: 20 de oct → 27 de oct"));
    assert.ok(mensajes[0].includes("• Fue adjudicado a GANADOR &lt;SAS&gt; por $ 12.000.000"));
    assert.ok(mensajes[0].includes('<a href="https://community.secop.gov.co/CO1.REQ.3">Ver en SECOP II</a>'));
    assert.ok(!mensajes[0].includes("CO1.REQ.2") && !mensajes[0].includes("CO1.REQ.4"));
    assert.deepEqual(resumen.seguimiento, { revisados: 3, avisados: 2, fallos: 0 });
    assert.equal(resumen.nuevos, 2);
    assert.deepEqual(estado.seguimiento["CO1.REQ.1"], { cierre: "2026-10-27", adjudicado: false, estado_proc: "Publicado" });
    assert.deepEqual(Object.keys(estado.seguimiento).sort(), ["CO1.REQ.1", "CO1.REQ.2", "CO1.REQ.3", "CO1.REQ.4"], "el que aún no está en los datos conserva su línea base");
  });

  await t.test("la segunda ejecución no repite los cambios ya avisados", async () => {
    const { mensajes, enviar } = enviadorFalso();
    const cliente = clienteDeSeguimiento({ "CO1.REQ.1": actualDe("CO1.REQ.1", { cierre: "2026-10-27" }) });
    const primera = await correr({ seguimiento: [seguido("CO1.REQ.1")], estado: base, cliente, enviar });
    assert.equal(mensajes.length, 1);
    const segunda = await correr({ seguimiento: [seguido("CO1.REQ.1")], estado: primera.estado, cliente, enviar });
    assert.equal(mensajes.length, 1);
    assert.equal(segunda.resumen.seguimiento.avisados, 0);
    const cambiado = clienteDeSeguimiento({ "CO1.REQ.1": actualDe("CO1.REQ.1", { cierre: "2026-10-27", estado_procedimiento: "Cancelado" }) });
    await correr({ seguimiento: [seguido("CO1.REQ.1")], estado: segunda.estado, cliente: cambiado, enviar });
    assert.equal(mensajes.length, 2);
    assert.match(mensajes[1], /• Quedó cancelado/);
  });

  await t.test("si Telegram falla no da el cambio por avisado y se reintenta", async () => {
    const cliente = clienteDeSeguimiento({ "CO1.REQ.1": actualDe("CO1.REQ.1", { cierre: "2026-10-27" }) });
    const fallida = await correr({ seguimiento: [seguido("CO1.REQ.1")], estado: base, cliente, enviar: async () => { throw new Alertas.ErrorDeAlertas("Telegram respondió 500"); } });
    assert.equal(fallida.resumen.fallos_telegram, 1);
    assert.equal(fallida.estado.seguimiento["CO1.REQ.1"].cierre, "2026-10-20", "conserva la foto anterior");
    const { mensajes, enviar } = enviadorFalso();
    await correr({ seguimiento: [seguido("CO1.REQ.1")], estado: fallida.estado, cliente, enviar });
    assert.equal(mensajes.length, 1);
  });

  await t.test("si falla la consulta a SECOP II conserva el estado y lo informa sin avisar", async () => {
    const { mensajes, enviar } = enviadorFalso();
    const previo = { ...base, seguimiento: { "CO1.REQ.1": { cierre: "2026-10-20", adjudicado: false, estado_proc: "Publicado" } } };
    const { estado, resumen } = await correr({ seguimiento: [seguido("CO1.REQ.1")], estado: previo, cliente: clienteDeSeguimiento(new Error("caído")), enviar });
    assert.equal(mensajes.length, 0);
    assert.equal(resumen.seguimiento.fallos, 1);
    assert.deepEqual(estado.seguimiento, previo.seguimiento);
  });

  await t.test("olvida lo que ya no se sigue; sin el parámetro de seguimiento no toca lo guardado", async () => {
    const previo = { ...base, seguimiento: { "CO1.REQ.1": { cierre: "2026-10-20", adjudicado: false, estado_proc: "Publicado" } } };
    const { enviar } = enviadorFalso();
    const sinSeguir = await correr({ seguimiento: [], estado: previo, cliente: clienteDeSeguimiento({}), enviar });
    assert.deepEqual(sinSeguir.estado.seguimiento, {});
    const sinParametro = await correr({ estado: previo, cliente: clienteDeSeguimiento({}), enviar });
    assert.deepEqual(sinParametro.estado.seguimiento, previo.seguimiento);
    assert.equal(sinParametro.resumen.seguimiento, undefined);
  });

  await t.test("en simulación entrega el mensaje sin enviarlo", async () => {
    const impresos = [];
    const cliente = clienteDeSeguimiento({ "CO1.REQ.1": actualDe("CO1.REQ.1", { cierre: "2026-10-27" }) });
    await correr({ seguimiento: [seguido("CO1.REQ.1")], estado: base, cliente, enviar: async () => { throw new Error("no debe enviar"); }, simulacion: true, registrar: (m) => impresos.push(m) });
    assert.equal(impresos.length, 1);
    assert.match(impresos[0], /cambió un proceso que sigues/);
  });

  await t.test("la bienvenida menciona el seguimiento y no inventa búsquedas cuando no hay ninguna", () => {
    const solo = Alertas.mensajeDeBienvenida([], true);
    assert.equal(solo, "<b>Radar SECOP: alertas activadas</b>\nTambién te aviso si cambia un proceso que sigues (cierre, adjudicación o cancelación).");
    const completa = Alertas.mensajeDeBienvenida([busqueda(), resumenBusqueda()], true);
    assert.match(completa, /Vigilo 2 búsquedas: Mantenimiento TI, Resumen nacional\./);
    assert.match(completa, /Cada mañana recibirás un resumen/);
    assert.match(completa, /si cambia un proceso que sigues/);
  });

  await t.test("formatearCambios trocea sin pasar el límite de Telegram", () => {
    const avisos = Array.from({ length: 25 }, (_, i) => ({
      proceso: actualDe(`CO1.REQ.${i}`, { nombre: "N".repeat(200), entidad: "E".repeat(300) }), seguido: seguido(`CO1.REQ.${i}`),
      cambios: [{ tipo: "cierre", de: "2026-10-20", a: "2026-10-27" }, { tipo: "adjudicado", ganador: "G".repeat(200), valor: 1 }],
    }));
    const mensajes = Alertas.formatearCambios(avisos);
    assert.ok(mensajes.length >= 3);
    for (const m of mensajes) assert.ok(m.length <= 4096);
    assert.ok(mensajes[1].startsWith("<b>Radar SECOP</b> (continuación de los cambios)"));
    assert.ok(mensajes.join("\n").includes("25. <b>"));
  });
});

test("programa de línea de comandos con el gist de alertas (GitHub simulado)", async (t) => {
  const { spawn } = require("node:child_process");
  const programa = path.join(__dirname, "..", "alertas.js");
  const ID = "aa11bb22cc33dd44";
  const archivo = (contenido) => ({ files: { "radar-alertas.json": { content: contenido } } });

  /** Levanta un GitHub falso, corre el programa y devuelve su salida y las peticiones recibidas. */
  async function correr(env, responder) {
    const peticiones = [];
    const servidor = http.createServer((req, res) => {
      peticiones.push({ url: req.url, autorizacion: req.headers.authorization ?? null });
      const { status = 200, cuerpo = {} } = responder(peticiones.at(-1));
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(cuerpo));
    });
    await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${servidor.address().port}`;
      const hijo = spawn(process.execPath, [programa], {
        env: { PATH: process.env.PATH, TELEGRAM_BOT_TOKEN: "111:TOKEN-SECRETO", TELEGRAM_CHAT_ID: "1", TELEGRAM_API_BASE: base, ALERTAS_GITHUB_API: base, ...env },
      });
      let salida = "";
      hijo.stdout.on("data", (d) => (salida += d));
      hijo.stderr.on("data", (d) => (salida += d));
      const status = await new Promise((r) => hijo.on("close", r));
      return { status, salida, peticiones };
    } finally {
      servidor.close();
    }
  }

  await t.test("con todas las alertas en pausa no hay nada que revisar y termina bien sin hablar con Telegram", async () => {
    const contenido = JSON.stringify({ version: 1, alertas: [], resumen: { activo: false }, seguimiento: { avisar: true, procesos: [] } });
    const r = await correr({ ALERTAS_GIST_ID: ID }, ({ url }) => (url === `/gists/${ID}` ? { cuerpo: archivo(contenido) } : { status: 500 }));
    assert.equal(r.status, 0);
    assert.match(r.salida, /No hay alertas activas/);
    assert.deepEqual(r.peticiones.map((p) => p.url), [`/gists/${ID}`], "solo leyó el gist: nada de Telegram");
  });

  await t.test("lee el gist con el token del flujo y, si GitHub lo rechaza, sin token", async () => {
    const contenido = JSON.stringify({ version: 1 });
    const r = await correr({ ALERTAS_GIST_ID: ID, GITHUB_TOKEN: "ghs_del_flujo" }, ({ autorizacion }) =>
      autorizacion ? { status: 403, cuerpo: { message: "Resource not accessible by integration" } } : { cuerpo: archivo(contenido) });
    assert.equal(r.status, 0);
    assert.deepEqual(r.peticiones.map((p) => p.autorizacion), ["Bearer ghs_del_flujo", null]);
    assert.ok(!r.salida.includes("ghs_del_flujo"));
  });

  await t.test("si el gist no existe y no hay respaldo, falla con un mensaje claro y sin mostrar secretos", async () => {
    const r = await correr({ ALERTAS_GIST_ID: ID }, () => ({ status: 404, cuerpo: { message: "Not Found" } }));
    assert.equal(r.status, 1);
    assert.match(r.salida, /::error::No se pudo leer la configuración de alertas del gist\. No se encontró el gist/);
    assert.ok(!r.salida.includes("TOKEN-SECRETO") && !r.salida.includes(ID));
  });

  await t.test("si el gist falla pero existe ALERTAS_BUSQUEDAS, avisa y usa el respaldo", async () => {
    const r = await correr({ ALERTAS_GIST_ID: ID, ALERTAS_BUSQUEDAS: "respaldo-no-es-json" }, () => ({ status: 404 }));
    assert.equal(r.status, 1);
    assert.match(r.salida, /::warning::No se pudo leer el gist \(No se encontró el gist.*\); se usa ALERTAS_BUSQUEDAS/);
    assert.match(r.salida, /::error::ALERTAS_BUSQUEDAS no es un JSON válido/, "llegó a usar el respaldo");
  });

  await t.test("un gist dañado falla pidiendo guardarlo de nuevo desde la página", async () => {
    const r = await correr({ ALERTAS_GIST_ID: ID }, () => ({ cuerpo: archivo("{esto no es json") }));
    assert.equal(r.status, 1);
    assert.match(r.salida, /::error::La configuración del gist no se pudo leer\. Ábrela en la página y guárdala de nuevo\./);
  });

  await t.test("las entradas inválidas se ignoran y solo se informa cuántas, sin repetir su contenido", async () => {
    const contenido = JSON.stringify({ version: 1, alertas: [{ id: "abc12345", nombre: "Mala", palabras: "x' OR 1=1 --" }], resumen: { activo: false }, seguimiento: { avisar: false } });
    const r = await correr({ ALERTAS_GIST_ID: ID }, () => ({ cuerpo: archivo(contenido) }));
    assert.equal(r.status, 0);
    assert.match(r.salida, /::warning::1 entradas de la configuración de alertas no eran válidas y se ignoraron\./);
    assert.ok(!r.salida.includes("OR 1=1") && !r.salida.includes("Mala"));
  });
});
