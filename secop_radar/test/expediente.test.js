"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Expediente = require("../site/expediente.js");

const PROCESO = { id: "CO1.REQ.1", nombre: "Mantenimiento de equipos", entidad: "Alcaldía de Montería", referencia: "SA-012-2026", cierre: "2026-11-20", presupuesto: 180_000_000 };
// 9 de noviembre de 2026 a las 10:00 en Colombia.
const AHORA = new Date("2026-11-09T15:00:00Z");

test("normalizar", async (t) => {
  await t.test("descarta lo que no tiene identificador y limpia lo demás", () => {
    assert.equal(Expediente.normalizar(null), null);
    assert.equal(Expediente.normalizar({ requisitos: [] }), null);
    const e = Expediente.normalizar({
      id: "CO1.REQ.1", proceso: PROCESO, sobra: "<script>", decision: { decision: "quizás" },
      requisitos: [{ descripcion: "  Liquidez mínima  ", indicador: "liquidez", valor: 1.5, validado: "sí" }, { descripcion: "" }, "texto"],
      hitos: [{ tipo: "cierre", fecha: "2026-11-20", hora: "9:30", confirmado: true }, { tipo: "inventado", fecha: "2026-02-31", confirmado: true }],
    });
    assert.equal(e.sobra, undefined);
    assert.equal(e.decision, null);
    assert.equal(e.requisitos.length, 1, "los requisitos sin descripción no entran");
    assert.deepEqual(
      { descripcion: e.requisitos[0].descripcion, validado: e.requisitos[0].validado, operador: e.requisitos[0].operador },
      { descripcion: "Liquidez mínima", validado: false, operador: ">=" }
    );
    assert.deepEqual([e.hitos[0].hora, e.hitos[0].confirmado], ["09:30", true]);
    assert.deepEqual([e.hitos[1].tipo, e.hitos[1].fecha, e.hitos[1].confirmado], ["otro", "", false], "una fecha imposible se borra y el hito deja de estar confirmado");
  });

  await t.test("el endeudamiento es un máximo por defecto y sin umbral el requisito es manual", () => {
    assert.equal(Expediente.normalizarRequisito({ descripcion: "Endeudamiento", indicador: "endeudamiento", valor: 70 }).operador, "<=");
    assert.equal(Expediente.normalizarRequisito({ descripcion: "Liquidez", indicador: "liquidez", valor: -1 }).valor, null);
    assert.equal(Expediente.normalizarRequisito({ descripcion: "RUP", indicador: "ninguno", valor: 5 }).valor, null);
  });

  await t.test("conserva el análisis sin HTML y renumera las fuentes", () => {
    const a = Expediente.normalizarAnalisis({
      archivo: "pliego.pdf", marcado: "Texto", html: "<img onerror=x>", fuentes: [{ n: 7, pagina: "pág. 3", texto: "cita" }],
      uso: { input_tokens: 10, otro: 5 }, evaluacion: { veredicto: "raro", requisitos: [{ requisito: "RUP", estado: "cumple" }] },
    });
    assert.equal(a.html, undefined);
    assert.deepEqual(a.fuentes, [{ n: 1, pagina: "pág. 3", texto: "cita" }]);
    assert.equal(a.uso.input_tokens, 10);
    assert.equal(a.evaluacion.veredicto, "indeterminado");
    assert.equal(Expediente.normalizarAnalisis({ archivo: "x" }), null, "sin texto no hay análisis");
  });
});

test("aplicarExtraccion deja todo sin validar, conserva lo hecho a mano y anula la decisión", () => {
  const previo = Expediente.normalizar({
    id: "1", decision: { decision: "ofertar", responsable: "Ana" },
    requisitos: [
      { descripcion: "Viejo de la IA", fuentes: [1], validado: true },
      { descripcion: "Agregado a mano", validado: true, manual: "cumple" },
    ],
    hitos: [{ tipo: "cierre", fecha: "2026-11-20", confirmado: true }],
  });
  const e = Expediente.aplicarExtraccion(previo, {
    requisitos: [{ descripcion: "Liquidez", indicador: "liquidez", valor: 1.5, fuentes: [2], validado: true }],
    hitos: [{ tipo: "observaciones", fecha: "2026-11-12", fuentes: [3], confirmado: true }, { tipo: "otro", descripcion: "", fecha: "" }],
  });
  assert.deepEqual(e.requisitos.map((r) => [r.descripcion, r.validado]), [["Liquidez", false], ["Agregado a mano", true]]);
  assert.deepEqual(e.hitos.map((h) => [h.tipo, h.confirmado]), [["observaciones", false], ["cierre", true]], "ordenados por fecha; los vacíos no entran");
  assert.equal(e.decision, null);
});

test("cronograma", async (t) => {
  const hito = (extra) => Expediente.normalizarHito({ tipo: "cierre", ...extra });

  await t.test("cuenta los días en hora de Colombia", () => {
    assert.equal(Expediente.diasParaHito(hito({ fecha: "2026-11-09" }), AHORA), 0);
    // A las 02:00 UTC del día 10 en Colombia todavía es el 9.
    assert.equal(Expediente.diasParaHito(hito({ fecha: "2026-11-10" }), new Date("2026-11-10T02:00:00Z")), 1);
    assert.equal(Expediente.diasParaHito(hito({}), AHORA), null);
  });

  await t.test("describe el estado de cada hito", () => {
    assert.deepEqual(Expediente.estadoHito(hito({ fecha: "2026-11-09", hora: "16:00" }), AHORA), { dias: 0, texto: "Hoy a las 16:00", clase: "urgente" });
    assert.equal(Expediente.estadoHito(hito({ fecha: "2026-11-08" }), AHORA).texto, "Pasó hace 1 día");
    assert.equal(Expediente.estadoHito(hito({ fecha: "2026-11-12" }), AHORA).clase, "pronto");
    assert.equal(Expediente.estadoHito(hito({ fecha: "2026-11-30" }), AHORA).clase, "");
    assert.equal(Expediente.estadoHito(hito({}), AHORA).texto, "Sin fecha");
  });

  await t.test("el próximo hito es el primero que no ha pasado", () => {
    const hitos = [hito({ fecha: "2026-11-20" }), hito({ fecha: "2026-11-01" }), hito({ tipo: "observaciones", fecha: "2026-11-12" }), hito({})];
    assert.equal(Expediente.proximoHito(hitos, AHORA).tipo, "observaciones");
    assert.equal(Expediente.proximoHito([hito({ fecha: "2026-11-01" })], AHORA), null);
  });
});

test("aICS", async (t) => {
  const expediente = Expediente.normalizar({
    id: "CO1.REQ.1", proceso: PROCESO,
    hitos: [
      { id: "h1", tipo: "cierre", fecha: "2026-11-20", hora: "16:30", confirmado: true },
      { id: "h2", tipo: "observaciones", fecha: "2026-12-31", confirmado: true },
      { id: "h3", tipo: "adjudicacion", fecha: "2026-11-27", confirmado: false },
      { id: "h4", tipo: "otro", descripcion: "Visita; sede, piso 2", fecha: "2026-11-15", confirmado: true },
    ],
  });
  const ics = Expediente.aICS(expediente, AHORA);
  const lineas = ics.split("\r\n");

  await t.test("incluye solo los hitos confirmados", () => {
    assert.equal(lineas.filter((l) => l === "BEGIN:VEVENT").length, 3);
    assert.ok(!ics.includes("Adjudicación"));
    assert.equal(lineas[0], "BEGIN:VCALENDAR");
    assert.equal(lineas.at(-2), "END:VCALENDAR");
  });

  await t.test("pasa la hora de Colombia a UTC y usa día completo cuando no hay hora", () => {
    assert.ok(lineas.includes("DTSTART:20261120T213000Z"), "16:30 en Colombia son las 21:30 UTC");
    assert.ok(lineas.includes("DTEND:20261120T220000Z"));
    assert.ok(lineas.includes("DTSTART;VALUE=DATE:20261231"));
    assert.ok(lineas.includes("DTEND;VALUE=DATE:20270101"), "el día siguiente cruza de año");
  });

  await t.test("escapa el texto, pone recordatorio y no pasa de 75 octetos por línea", () => {
    assert.ok(ics.includes(String.raw`SUMMARY:Visita\; sede\, piso 2 · SA-012-2026`));
    assert.ok(lineas.includes("UID:CO1.REQ.1-h1@radar-secop"));
    assert.ok(lineas.includes("TRIGGER:-P1D"));
    for (const linea of lineas) assert.ok(Buffer.byteLength(linea, "utf8") <= 75, `línea demasiado larga: ${linea}`);
    assert.ok(lineas.some((l) => l.startsWith(" ")), "las líneas largas se pliegan");
  });
});
