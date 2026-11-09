"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Expediente = require("../site/expediente.js");
const Habilitantes = require("../site/habilitantes.js");

const EMPRESA = {
  indicadores: { liquidez: 2.4, endeudamiento: "38", cobertura_intereses: null, rentabilidad_patrimonio: 12, capital_trabajo: 90_000_000, patrimonio: 950_000_000 },
  experiencia: [
    { id: "a", entidad: "Alcaldía de Montería", objeto: "Mantenimiento de equipos", codigos: "811118, 432115", valor: 130_000_000, anio: 2024 }, // 100 SMMLV
    { id: "b", entidad: "Gobernación", objeto: "Soporte", codigos: ["81111800"], valor: 142_350_000, anio: 2025, participacion: 50 }, // 50 SMMLV
    { id: "c", entidad: "Hospital", objeto: "Aseo", codigos: "761115", valor: 116_000_000, anio: 2023 }, // 100 SMMLV, otro objeto
    { id: "d", entidad: "Sin datos", objeto: "Antiguo", codigos: "811118", valor: 50_000_000, anio: null },
  ],
};
const CONTEXTO = { presupuesto: 180_000_000, anio: 2025 };
const requisito = (extra) => Expediente.normalizarRequisito({ descripcion: "Requisito", validado: true, ...extra });
const evaluar = (extra, empresa = EMPRESA, contexto = CONTEXTO) =>
  Habilitantes.evaluarRequisito(requisito(extra), Habilitantes.normalizarEmpresa(empresa), contexto);

test("normalizarEmpresa acepta números escritos como texto y descarta lo inválido", () => {
  const e = Habilitantes.normalizarEmpresa({ indicadores: { liquidez: "2,4", endeudamiento: "abc" }, experiencia: [{ valor: "-5", anio: 1800, participacion: 150 }] });
  assert.equal(e.indicadores.liquidez, 2.4);
  assert.equal(e.indicadores.endeudamiento, null);
  assert.deepEqual([e.experiencia[0].valor, e.experiencia[0].anio, e.experiencia[0].participacion], [null, null, 100]);
  assert.deepEqual(Habilitantes.normalizarEmpresa(null).experiencia, []);
});

test("contratoEnSMMLV usa el salario del año de terminación y la participación", () => {
  const e = Habilitantes.normalizarEmpresa(EMPRESA);
  assert.deepEqual(e.experiencia.map(Habilitantes.contratoEnSMMLV), [100, 50, 100, null]);
});

test("indicadores financieros", async (t) => {
  await t.test("compara mínimos y máximos", () => {
    assert.equal(evaluar({ indicador: "liquidez", valor: 1.5 }).estado, "cumple");
    assert.equal(evaluar({ indicador: "liquidez", valor: 3 }).estado, "no_cumple");
    assert.equal(evaluar({ indicador: "endeudamiento", valor: 70, unidad: "porcentaje" }).estado, "cumple");
    const falla = evaluar({ indicador: "endeudamiento", valor: 30, unidad: "porcentaje" });
    assert.equal(falla.estado, "no_cumple");
    assert.match(falla.detalle, /tiene 38 % y el pliego pide máximo 30 %/);
    assert.equal(falla.brecha, "Sobra 8 %.");
  });

  await t.test("avisa cuando falta el dato de la empresa", () => {
    const r = evaluar({ indicador: "rentabilidad_activo", valor: 2, unidad: "porcentaje" });
    assert.equal(r.estado, "falta_dato");
    assert.match(r.detalle, /Rentabilidad del activo/);
  });

  await t.test("la cobertura de intereses cumple si no hay gastos de intereses", () => {
    assert.equal(evaluar({ indicador: "cobertura_intereses", valor: 2 }).estado, "falta_dato");
    assert.equal(evaluar({ indicador: "cobertura_intereses", valor: 2 }, { ...EMPRESA, sin_intereses: true }).estado, "cumple");
  });

  await t.test("convierte a pesos el capital de trabajo pedido en SMMLV o como porcentaje del presupuesto", () => {
    assert.equal(evaluar({ indicador: "capital_trabajo", valor: 50, unidad: "porcentaje_presupuesto" }).estado, "cumple"); // 90 M
    assert.equal(evaluar({ indicador: "capital_trabajo", valor: 60, unidad: "porcentaje_presupuesto" }).estado, "no_cumple"); // 108 M
    assert.equal(evaluar({ indicador: "capital_trabajo", valor: 60, unidad: "smmlv" }).estado, "cumple"); // 85,4 M
    assert.equal(evaluar({ indicador: "patrimonio", valor: 1_000_000_000, unidad: "cop" }).brecha, "Falta $ 50.000.000.");
    assert.equal(evaluar({ indicador: "capital_trabajo", valor: 50, unidad: "porcentaje_presupuesto" }, EMPRESA, { anio: 2025 }).estado, "falta_dato");
    assert.equal(evaluar({ indicador: "capital_trabajo", valor: 2, unidad: "veces" }).estado, "falta_dato");
  });
});

test("experiencia", async (t) => {
  await t.test("suma los contratos en SMMLV", () => {
    const r = evaluar({ indicador: "experiencia", valor: 250, unidad: "smmlv" });
    assert.equal(r.estado, "cumple");
    assert.match(r.detalle, /suma 250 SMMLV en cualquier código, contando 3 contratos y/);
    assert.match(r.detalle, /1 contrato no se contó/);
  });

  await t.test("filtra por clase UNSPSC y limita el número de contratos", () => {
    assert.equal(evaluar({ indicador: "experiencia", valor: 150, unidad: "smmlv", codigos: ["81111800"] }).estado, "cumple");
    const limitado = evaluar({ indicador: "experiencia", valor: 150, unidad: "smmlv", codigos: ["811118"], max_contratos: 1 });
    assert.equal(limitado.estado, "no_cumple");
    assert.equal(limitado.brecha, "Faltan 50 SMMLV.");
    assert.equal(evaluar({ indicador: "experiencia", valor: 10, unidad: "smmlv", codigos: ["721515"] }).estado, "no_cumple");
  });

  await t.test("convierte el umbral desde pesos o desde un porcentaje del presupuesto", () => {
    // 100 % de 180 M ÷ 1.423.500 = 126,4 SMMLV; la empresa tiene 150 en la clase 811118.
    assert.equal(evaluar({ indicador: "experiencia", valor: 100, unidad: "porcentaje_presupuesto", codigos: ["811118"] }).estado, "cumple");
    assert.equal(evaluar({ indicador: "experiencia", valor: 400_000_000, unidad: "cop" }).estado, "no_cumple");
    assert.equal(evaluar({ indicador: "experiencia", valor: 100, unidad: "veces" }).estado, "falta_dato");
    assert.equal(evaluar({ indicador: "experiencia", valor: 10, unidad: "smmlv" }, { experiencia: [] }).estado, "falta_dato");
  });
});

test("los requisitos sin umbral dependen de lo que marque la persona", () => {
  assert.equal(evaluar({}).estado, "manual");
  assert.equal(evaluar({ manual: "cumple" }).estado, "cumple");
  assert.equal(evaluar({ manual: "no_cumple" }).estado, "no_cumple");
});

test("evaluarHabilitantes ignora los que dan puntaje y los que nadie validó", () => {
  const requisitos = [
    requisito({ id: "r1", indicador: "liquidez", valor: 1.5 }),
    requisito({ id: "r2", indicador: "liquidez", valor: 9, validado: false }),
    requisito({ id: "r3", tipo: "ponderable" }),
    requisito({ id: "r4" }),
  ];
  const h = Habilitantes.evaluarHabilitantes(requisitos, EMPRESA, CONTEXTO);
  assert.deepEqual(h.conteo, { cumple: 1, no_cumple: 0, falta_dato: 0, manual: 1, sin_validar: 1, ponderables: 1 });
  assert.equal(h.evaluados, 2);
  assert.equal(h.porRequisito.get("r1").estado, "cumple");
  assert.equal(h.porRequisito.has("r2"), false);
});

test("tarjetaDecision", async (t) => {
  const habilitacion = (lista) => Habilitantes.evaluarHabilitantes(lista, EMPRESA, CONTEXTO);
  const cumple = requisito({ indicador: "liquidez", valor: 1.5 });
  const noCumple = requisito({ indicador: "liquidez", valor: 9 });
  const cierre = [{ tipo: "cierre", fecha: "2026-11-20", hora: "16:00", confirmado: true }];
  const recomendar = (extra) => Habilitantes.tarjetaDecision({ habilitacion: habilitacion([cumple]), diasAlCierre: 10, hitos: cierre, ...extra });

  await t.test("recomienda ofertar solo cuando todo está revisado", () => {
    const tarjeta = recomendar({ dificultad: { puntaje: 72, nivel: "Alta" } });
    assert.equal(tarjeta.recomendacion, "ofertar");
    assert.equal(tarjeta.titulo, "Se puede ofertar");
    assert.deepEqual(tarjeta.factores.map((f) => [f.clave, f.estado]), [["habilitacion", "bueno"], ["plazo", "bueno"], ["cronograma", "bueno"], ["competencia", "medio"]]);
  });

  await t.test("un habilitante incumplido o un plazo vencido llevan a no ofertar", () => {
    assert.equal(recomendar({ habilitacion: habilitacion([cumple, noCumple]) }).recomendacion, "no_ofertar");
    assert.equal(recomendar({ diasAlCierre: -1 }).recomendacion, "no_ofertar");
  });

  await t.test("pide revisar cuando falta validar, confirmar el cierre o queda poco tiempo", () => {
    assert.equal(recomendar({ habilitacion: habilitacion([cumple, requisito({ validado: false })]) }).recomendacion, "revisar");
    assert.equal(recomendar({ habilitacion: habilitacion([cumple, requisito({})]) }).recomendacion, "revisar");
    assert.equal(recomendar({ hitos: [] }).recomendacion, "revisar");
    assert.equal(recomendar({ diasAlCierre: 2 }).recomendacion, "revisar");
    assert.equal(recomendar({ diasAlCierre: null }).recomendacion, "revisar");
  });

  await t.test("sin requisitos validados no recomienda nada", () => {
    const tarjeta = recomendar({ habilitacion: habilitacion([requisito({ validado: false })]) });
    assert.equal(tarjeta.recomendacion, "sin_datos");
    assert.match(tarjeta.factores[0].detalle, /1 requisito sin validar/);
    assert.equal(recomendar({ habilitacion: habilitacion([]) }).recomendacion, "sin_datos");
  });
});
