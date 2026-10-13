"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const IA = require("../site/ia.js");

const EMPRESA = {
  nombre: "Servicios Técnicos del Norte SAS",
  actividades: "Mantenimiento preventivo y correctivo de equipos de cómputo y redes para entidades públicas.",
  experiencia: "Contrato 2024 con la Alcaldía de Montería por $180.000.000 de mantenimiento de equipos de cómputo.",
  financiero: "Liquidez 2,4; endeudamiento 38 %; patrimonio $950.000.000.",
};

const mensaje = (extra = {}) => ({
  stop_reason: "end_turn", model: "claude-opus-5-5", usage: { input_tokens: 40000, output_tokens: 3000 },
  content: [{ type: "text", text: "ok" }], ...extra,
});

/** Cliente de la API simulado que registra lo que recibe y responde con los mensajes de la cola. */
function clienteFalso({ mensajes = [], tokens = 1234 } = {}) {
  const llamadas = { create: [], stream: [], countTokens: [] };
  const cola = [...mensajes];
  const cliente = {
    messages: {
      create: async (parametros) => { llamadas.create.push(parametros); return cola.shift(); },
      countTokens: async (parametros) => { llamadas.countTokens.push(parametros); return { input_tokens: tokens }; },
      stream: (parametros, opciones) => {
        llamadas.stream.push({ parametros, opciones });
        const oyentes = {};
        return {
          on(evento, funcion) { oyentes[evento] = funcion; return this; },
          async finalMessage() {
            const m = cola.shift();
            for (const b of m.content) if (b.type === "text") oyentes.text?.(b.text);
            return m;
          },
        };
      },
    },
  };
  return { cliente, llamadas, ia: IA.crearIA({ crearCliente: () => cliente }) };
}

test("costo estimado", async (t) => {
  await t.test("usa los precios de lista de cada modelo", () => {
    assert.ok(Math.abs(IA.estimarCosto("claude-opus-5-5", 40000, 3000) - 0.22) < 1e-9);
    assert.ok(Math.abs(IA.estimarCosto("claude-sonnet-5-5", 40000, 3000) - 0.11) < 1e-9);
    assert.ok(Math.abs(IA.estimarCosto("claude-haiku-5-5", 40000, 3000) - 0.0055) < 1e-9);
  });

  await t.test("Haiku cobra más por los prompts de más de 100 mil tokens", () => {
    assert.ok(Math.abs(IA.estimarCosto("claude-haiku-5-5", 150000, 3000) - (150000 * 0.5 + 3000 * 2.5) / 1e6) < 1e-9);
  });

  await t.test("modelo desconocido y formato", () => {
    assert.equal(IA.estimarCosto("otro", 1000), null);
    assert.equal(IA.formatoUSD(null), "no disponible");
    assert.equal(IA.formatoUSD(0.0055), "menos de US$ 0,01");
    assert.equal(IA.formatoUSD(0.2234), "US$ 0,22");
  });
});

test("perfil de la empresa", async (t) => {
  await t.test("solo incluye los campos con contenido y los etiqueta", () => {
    const texto = IA.textoDeEmpresa({ nombre: "ACME SAS", actividades: "  ", restricciones: "No ofertamos obra civil" });
    assert.equal(texto, "Nombre de la empresa: ACME SAS\nLo que NO ofertan o no pueden cumplir: No ofertamos obra civil");
  });

  await t.test("limita el tamaño y exige un perfil con sustancia", () => {
    assert.ok(IA.textoDeEmpresa({ actividades: "x".repeat(50000) }).length < 2700);
    assert.equal(IA.empresaCompleta({ nombre: "ACME" }), false);
    assert.equal(IA.empresaCompleta(EMPRESA), true);
    assert.equal(IA.empresaCompleta(undefined), false);
  });
});

test("solicitud de análisis del pliego", async (t) => {
  const solicitud = IA.construirSolicitudAnalisis({
    modelo: "claude-opus-5-5", pdfBase64: "JVBERi0=", titulo: "Pliego MC-41-2026",
    proceso: { nombre: "Mantenimiento de equipos", entidad: "Alcaldía de Honda", referencia: "MC-41-2026", modalidad: "Mínima cuantía", presupuesto: 49000000 },
  });

  await t.test("adjunta el PDF con citas activadas, antes del texto", () => {
    const [documento, texto] = solicitud.messages[0].content;
    assert.equal(documento.type, "document");
    assert.deepEqual(documento.source, { type: "base64", media_type: "application/pdf", data: "JVBERi0=" });
    assert.deepEqual(documento.citations, { enabled: true });
    assert.equal(documento.title, "Pliego MC-41-2026");
    assert.equal(texto.type, "text");
  });

  await t.test("no combina citas con salida estructurada (la API lo rechaza) ni desactiva el pensamiento", () => {
    assert.equal(solicitud.output_config.format, undefined);
    assert.equal(solicitud.thinking, undefined);
    assert.equal(solicitud.output_config.effort, "high");
    assert.equal(solicitud.model, "claude-opus-5-5");
    assert.equal(solicitud.max_tokens, 16000);
  });

  await t.test("pide las siete secciones y da el contexto del proceso", () => {
    const texto = solicitud.messages[0].content[1].text;
    for (const seccion of ["1. Resumen del proceso", "2. Requisitos habilitantes", "3. Documentos que debo presentar",
      "4. Criterios de evaluación", "5. Garantías", "6. Riesgos", "7. Preguntas para la etapa de observaciones"]) {
      assert.ok(texto.includes(seccion), seccion);
    }
    assert.ok(texto.includes("Alcaldía de Honda") && texto.includes("MC-41-2026"));
    assert.match(solicitud.system, /No inventes/);
    assert.match(solicitud.system, /No encontré este dato/);
  });
});

/** Recorre un esquema y devuelve los problemas que la API rechazaría. */
function problemasDeEsquema(esquema, ruta = "raíz") {
  const problemas = [];
  const prohibidas = ["minimum", "maximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems", "pattern"];
  for (const clave of prohibidas) if (clave in esquema) problemas.push(`${ruta}: ${clave} no está soportado`);
  if (esquema.type === "object") {
    if (esquema.additionalProperties !== false) problemas.push(`${ruta}: falta additionalProperties: false`);
    const propiedades = Object.keys(esquema.properties || {});
    if (JSON.stringify([...(esquema.required || [])].sort()) !== JSON.stringify([...propiedades].sort())) {
      problemas.push(`${ruta}: todas las propiedades deben ser requeridas`);
    }
    for (const [nombre, hijo] of Object.entries(esquema.properties || {})) problemas.push(...problemasDeEsquema(hijo, `${ruta}.${nombre}`));
  }
  if (esquema.type === "array") problemas.push(...problemasDeEsquema(esquema.items, `${ruta}[]`));
  return problemas;
}

test("solicitudes con salida estructurada", async (t) => {
  await t.test("los esquemas cumplen las reglas de la API", () => {
    assert.deepEqual(problemasDeEsquema(IA.ESQUEMA_EVALUACION), []);
    assert.deepEqual(problemasDeEsquema(IA.ESQUEMA_TRIAJE), []);
  });

  await t.test("la evaluación va como texto sin documento y con el esquema en output_config.format", () => {
    const s = IA.construirSolicitudEvaluacion({
      modelo: "claude-opus-5-5", analisis: "### 2. Requisitos\n- Liquidez mínima 1,5", empresa: EMPRESA, proceso: { nombre: "Proceso X" },
    });
    assert.equal(s.output_config.format.type, "json_schema");
    assert.equal(s.output_config.format.schema, IA.ESQUEMA_EVALUACION);
    assert.equal(typeof s.messages[0].content, "string");
    assert.ok(s.messages[0].content.includes("<analisis_del_pliego>") && s.messages[0].content.includes("Liquidez 2,4"));
    assert.ok(!JSON.stringify(s).includes('"type":"document"'));
  });

  await t.test("el triaje recorta descripciones y usa esfuerzo bajo", () => {
    const s = IA.construirSolicitudTriaje({
      modelo: "claude-haiku-5-5", empresa: EMPRESA,
      procesos: [{ id: 7, nombre: "Software", descripcion: "d".repeat(900), entidad: "E", modalidad: "Mínima cuantía", presupuesto: 5, categoria: "V1.1" }],
    });
    assert.equal(s.output_config.effort, "low");
    const enviados = JSON.parse(/<procesos>\n(.*)\n<\/procesos>/s.exec(s.messages[0].content)[1]);
    assert.equal(enviados[0].id, "7", "el id viaja como texto");
    assert.equal(enviados[0].descripcion.length, 400);
  });
});

test("leerJSON", async (t) => {
  await t.test("lee la respuesta estructurada", () => {
    assert.deepEqual(IA.leerJSON(mensaje({ content: [{ type: "text", text: '{"a":1}' }] })), { a: 1 });
  });

  await t.test("explica en español los casos que no se pueden leer", () => {
    assert.throws(() => IA.leerJSON(mensaje({ content: [{ type: "text", text: "no es json" }] })), /no se pudo leer/);
    assert.throws(() => IA.leerJSON(mensaje({ stop_reason: "refusal" })), /reglas de seguridad/);
    assert.throws(() => IA.leerJSON(mensaje({ stop_reason: "max_tokens", content: [{ type: "text", text: '{"a"' }] })), /se cortó/);
  });
});

test("texto con notas al pie", async (t) => {
  await t.test("convierte encabezados, listas y negritas, y escapa el HTML", () => {
    const html = IA.markdownLigero("### 1. Resumen\nTexto con **negrita** y <script>alert(1)</script>.\n\n- uno\n- dos\n\n1. primero\n2. segundo");
    assert.ok(html.includes("<h4>1. Resumen</h4>"));
    assert.ok(html.includes("<strong>negrita</strong>"));
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
    assert.ok(!html.includes("<script"));
    assert.ok(html.includes("<ul><li>uno</li><li>dos</li></ul>"));
    assert.ok(html.includes("<ol><li>primero</li><li>segundo</li></ol>"));
  });

  const cita = (pagina, texto, fin = pagina + 1) => ({
    type: "page_location", cited_text: texto, document_index: 0, document_title: "Pliego", start_page_number: pagina, end_page_number: fin,
  });

  await t.test("numera las citas, une las repetidas y las pone antes del salto de línea", () => {
    const r = IA.renderizarAnalisis([
      { type: "text", text: "### 1. Resumen\n" },
      { type: "text", text: "Plazo de ejecución de 60 días.", citations: [cita(3, "plazo de sesenta (60) días")] },
      { type: "text", text: " Presupuesto de $49.000.000.\n", citations: [cita(3, "plazo de sesenta (60) días"), cita(5, "presupuesto oficial", 7)] },
      { type: "text", text: "- Siguiente punto" },
    ]);
    assert.deepEqual(r.fuentes.map((f) => [f.n, f.pagina]), [[1, "pág. 3"], [2, "págs. 5–6"]]);
    assert.ok(r.html.includes("<h4>1. Resumen</h4>"), "el encabezado no se rompe");
    assert.ok(r.html.includes('<sup class="cita"><a href="#fuente-1" data-fuente="1">[1]</a></sup>'));
    assert.ok(r.html.includes('data-fuente="2">[2]</a></sup>'));
    assert.equal((r.html.match(/data-fuente="1"/g) || []).length, 2, "la misma cita usa el mismo número");
    assert.ok(r.html.includes("<ul><li>Siguiente punto</li></ul>"));
    assert.equal(r.texto, "### 1. Resumen\nPlazo de ejecución de 60 días. Presupuesto de $49.000.000.\n- Siguiente punto");
  });

  await t.test("la lista de fuentes escapa el texto citado y recorta lo muy largo", () => {
    const html = IA.htmlFuentes([{ n: 1, pagina: "pág. 2", texto: '<img src=x onerror="alert(1)">' }, { n: 2, pagina: "pág. 4", texto: "a".repeat(500) }]);
    assert.ok(html.includes('id="fuente-1"') && html.includes("&lt;img src=x"));
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("…"));
    assert.equal(IA.htmlFuentes([]), "");
  });
});

test("mensajes de error", () => {
  class AuthenticationError extends Error {}
  class RateLimitError extends Error {}
  class BadRequestError extends Error {}
  class APIConnectionError extends Error {}
  class APIError extends Error { constructor(m, status) { super(m); this.status = status; } }
  const SDK = { AuthenticationError, RateLimitError, BadRequestError, APIConnectionError, APIError };

  assert.match(IA.mensajeDeError(new AuthenticationError("x"), SDK), /no aceptó la clave/);
  assert.match(IA.mensajeDeError(new RateLimitError("x"), SDK), /límite de uso/);
  assert.match(IA.mensajeDeError(new BadRequestError("PDF demasiado grande"), SDK), /rechazó la solicitud: PDF demasiado grande/);
  assert.match(IA.mensajeDeError(new APIConnectionError("x"), SDK), /No se pudo conectar/);
  assert.match(IA.mensajeDeError(new APIError("x", 529), SDK), /error \(529\)/);
  assert.match(IA.mensajeDeError(Object.assign(new Error("x"), { name: "AbortError" }), SDK), /Se canceló/);
  assert.equal(IA.mensajeDeError(new IA.ErrorDeIA("Falta algo"), SDK), "Falta algo");
  assert.equal(IA.mensajeDeError(new Error("otro"), SDK), "otro");
});

test("flujo con la API simulada", async (t) => {
  await t.test("sin clave no llama a la API", async () => {
    const { ia, llamadas } = clienteFalso();
    await assert.rejects(ia.probarClave({ clave: "  " }), /Falta la clave/);
    assert.equal(llamadas.create.length, 0);
  });

  await t.test("probarClave hace una llamada mínima", async () => {
    const { ia, llamadas } = clienteFalso({ mensajes: [mensaje()] });
    assert.equal(await ia.probarClave({ clave: " sk-ant-prueba ", modelo: "claude-haiku-5-5" }), true);
    assert.equal(llamadas.create[0].model, "claude-haiku-5-5");
    assert.ok(llamadas.create[0].max_tokens <= 64);
  });

  await t.test("estimarTokensPliego cuenta tokens con el mismo sistema y mensajes del análisis", async () => {
    const { ia, llamadas } = clienteFalso({ tokens: 41000 });
    const n = await ia.estimarTokensPliego({ clave: "k", modelo: "claude-opus-5-5", pdfBase64: "AAA", titulo: "P", proceso: { nombre: "X" } });
    assert.equal(n, 41000);
    const enviado = llamadas.countTokens[0];
    assert.deepEqual(Object.keys(enviado).sort(), ["messages", "model", "system"]);
    assert.equal(enviado.messages[0].content[0].citations.enabled, true);
  });

  await t.test("analizarPliego transmite el texto, pasa la señal de cancelación y devuelve el contenido con citas", async () => {
    const final = mensaje({
      content: [{ type: "text", text: "Plazo: 60 días.", citations: [{ type: "page_location", cited_text: "60 días", document_index: 0, start_page_number: 3, end_page_number: 4 }] }],
    });
    const { ia, llamadas } = clienteFalso({ mensajes: [final] });
    const recibido = [];
    const controlador = new AbortController();
    const r = await ia.analizarPliego({
      clave: "k", modelo: "claude-opus-5-5", pdfBase64: "AAA", titulo: "P", proceso: {}, alTexto: (d) => recibido.push(d), senal: controlador.signal,
    });
    assert.deepEqual(recibido, ["Plazo: 60 días."]);
    assert.equal(r.contenido[0].citations[0].start_page_number, 3);
    assert.equal(r.truncado, false);
    assert.equal(llamadas.stream[0].opciones.signal, controlador.signal);
    assert.equal(llamadas.stream[0].parametros.messages[0].content[0].type, "document");
  });

  await t.test("analizarPliego avisa si la respuesta se truncó y falla si hubo rechazo", async () => {
    const truncado = clienteFalso({ mensajes: [mensaje({ stop_reason: "max_tokens" })] });
    const r = await truncado.ia.analizarPliego({ clave: "k", modelo: "claude-opus-5-5", pdfBase64: "A" });
    assert.equal(r.truncado, true);
    const rechazo = clienteFalso({ mensajes: [mensaje({ stop_reason: "refusal" })] });
    await assert.rejects(rechazo.ia.analizarPliego({ clave: "k", modelo: "claude-opus-5-5", pdfBase64: "A" }), /reglas de seguridad/);
  });

  await t.test("evaluarContraEmpresa exige un perfil y devuelve el JSON", async () => {
    const evaluacion = { veredicto: "cumple_con_dudas", resumen: "ok", requisitos: [], proximos_pasos: [] };
    const { ia, llamadas } = clienteFalso({ mensajes: [mensaje({ content: [{ type: "text", text: JSON.stringify(evaluacion) }] })] });
    await assert.rejects(ia.evaluarContraEmpresa({ clave: "k", modelo: "claude-opus-5-5", analisis: "a", empresa: {} }), /Completa el perfil/);
    assert.deepEqual(await ia.evaluarContraEmpresa({ clave: "k", modelo: "claude-opus-5-5", analisis: "a", empresa: EMPRESA, proceso: {} }), evaluacion);
    assert.equal(llamadas.create.length, 1);
  });

  await t.test("el triaje va en lotes de 10, avisa el avance e ignora ids que no pidió", async () => {
    const procesos = Array.from({ length: 25 }, (_, i) => ({ id: `P${i}`, nombre: `Proceso ${i}` }));
    const responder = (ids) => mensaje({ content: [{ type: "text", text: JSON.stringify({ evaluaciones: [
      ...ids.map((id) => ({ id, encaja: "alto", razon: "r", alerta: "" })), { id: "INTRUSO", encaja: "bajo", razon: "x", alerta: "" },
    ] }) }] });
    const { ia, llamadas } = clienteFalso({ mensajes: [
      responder(procesos.slice(0, 10).map((p) => p.id)), responder(procesos.slice(10, 20).map((p) => p.id)), responder(procesos.slice(20).map((p) => p.id)),
    ] });
    const avances = [];
    const mapa = await ia.triaje({ clave: "k", modelo: "claude-haiku-5-5", procesos, empresa: EMPRESA, alAvance: (h, t) => avances.push([h, t]) });
    assert.equal(llamadas.create.length, 3);
    assert.deepEqual(avances, [[10, 25], [20, 25], [25, 25]]);
    assert.equal(mapa.size, 25);
    assert.equal(mapa.has("INTRUSO"), false);
    assert.equal(mapa.get("P3").encaja, "alto");
  });

  await t.test("el triaje sin perfil de empresa no gasta una llamada", async () => {
    const { ia, llamadas } = clienteFalso();
    await assert.rejects(ia.triaje({ clave: "k", modelo: "claude-haiku-5-5", procesos: [{ id: "A" }], empresa: {} }), /Completa el perfil/);
    assert.equal(llamadas.create.length, 0);
  });
});
