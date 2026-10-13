"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Analisis = require("../site/analisis.js");

const proceso = (id, ganador, presupuesto = 100, adjudicado = 90) => ({
  id, presupuesto, valor_adjudicado: adjudicado, nit_ganador: ganador, ganador: `Empresa ${ganador}`,
});
const proponente = (id, nit) => ({ id, nit, nombre: `Empresa ${nit}` });
const casiIgual = (real, esperado) => assert.ok(Math.abs(real - esperado) < 1e-9, `${real} no es ${esperado}`);

test("estadística básica", async (t) => {
  await t.test("mediana", () => {
    assert.equal(Analisis.mediana([]), null);
    assert.equal(Analisis.mediana([3]), 3);
    assert.equal(Analisis.mediana([1, 3]), 2);
    assert.equal(Analisis.mediana([5, 1, 3]), 3);
  });

  await t.test("descuento sobre el presupuesto", () => {
    casiIgual(Analisis.descuento(100, 80), 0.2);
    assert.equal(Analisis.descuento(100, 120), 0, "adjudicar por encima no es descuento");
    assert.equal(Analisis.descuento(0, 50), null);
    assert.equal(Analisis.descuento(100, null), null);
  });
});

test("resumirCompetencia", async (t) => {
  // 6 procesos de una entidad. Oferentes por proceso: P1=2, P2=1, P3=3, P4=1, P5=1, P6=2.
  const raw = {
    clase: "801116",
    entidad: {
      procesos: [
        proceso("P1", "A", 100, 90), proceso("P2", "A", 100, 80), proceso("P3", "A", 100, 70),
        proceso("P4", "A", 100, 100), proceso("P5", "B", 100, 95), proceso("P6", "E", 100, 60),
      ],
      proponentes: [
        proponente("P1", "A"), proponente("P1", "B"),
        proponente("P2", "A"),
        proponente("P3", "A"), proponente("P3", "C"), proponente("P3", "D"), proponente("P3", "D"), // D repetido: cuenta una vez
        proponente("P4", "A"),
        proponente("P5", "B"),
        proponente("P6", "A"), proponente("P6", "E"),
      ],
    },
    pais: null,
  };

  await t.test("cuenta proveedores distintos por proceso", () => {
    const r = Analisis.resumirCompetencia(raw);
    assert.equal(r.alcance, "entidad");
    assert.equal(r.n_procesos, 6);
    assert.equal(r.oferentes.con_datos, 6);
    assert.equal(r.oferentes.mediana, 1.5); // [1,1,1,2,2,3]
    assert.equal(r.oferentes.uno_solo, 0.5);
    assert.equal(r.oferentes.cuatro_o_mas, 0);
  });

  await t.test("ordena ganadores y calcula participaciones", () => {
    const r = Analisis.resumirCompetencia(raw);
    assert.equal(r.ganadores[0].nit, "A");
    assert.equal(r.ganadores[0].ganados, 4);
    assert.equal(r.ganadores[0].participaciones, 5); // A se presentó a P1, P2, P3, P4 y P6
    assert.equal(r.ganadores[1].ganados, 1);
    assert.deepEqual(r.concentracion, { fraccion: 4 / 6, de: 6 });
  });

  await t.test("recupera el NIT del ganador por nombre cuando el proceso no lo trae", () => {
    const sinNit = (id) => ({ id, presupuesto: 100, valor_adjudicado: 90, nit_ganador: null, ganador: "Multiservicios S.A.S." });
    const r = Analisis.resumirCompetencia({
      clase: "801116",
      entidad: {
        procesos: ["P1", "P2", "P3", "P4", "P5"].map(sinNit),
        proponentes: [
          { id: "P1", nit: "901000111", nombre: "MULTISERVICIOS SAS" }, { id: "P2", nit: "901000111", nombre: "MULTISERVICIOS SAS" },
          { id: "P3", nit: "901000111", nombre: "MULTISERVICIOS SAS" }, { id: "P4", nit: "901000111", nombre: "MULTISERVICIOS SAS" },
          { id: "P5", nit: "901000111", nombre: "MULTISERVICIOS SAS" }, { id: "P5", nit: "900999888", nombre: "OTRA SAS" },
          { id: "P4", nit: "900999888", nombre: "OTRA SAS" }, { id: "P3", nit: "900999888", nombre: "OTRA SAS" },
        ],
      },
      pais: null,
    });
    assert.equal(r.ganadores.length, 1);
    assert.equal(r.ganadores[0].nit, "901000111");
    assert.equal(r.ganadores[0].ganados, 5);
    assert.equal(r.ganadores[0].participaciones, 5);
  });

  await t.test("descuento mediano entre procesos", () => {
    const r = Analisis.resumirCompetencia(raw);
    // descuentos: 0.10, 0.20, 0.30, 0, 0.05, 0.40 -> ordenados 0, .05, .10, .20, .30, .40 -> mediana 0.15
    assert.equal(r.descuento.n, 6);
    assert.ok(Math.abs(r.descuento.mediano - 0.15) < 1e-9);
  });

  await t.test("con pocos procesos usa el nivel nacional si existe", () => {
    const pocos = {
      clase: "801116",
      entidad: { procesos: [proceso("P1", "A"), proceso("P2", "B")], proponentes: [] },
      pais: {
        ganadores: [{ nit: "Z", nombre: "Empresa Z", ganados: 30, valor: 5e9 }, { nit: "Y", nombre: "Empresa Y", ganados: 10, valor: 1e9 }],
        totales: { n: 100, adjudicado: 8e9, base: 10e9 },
      },
    };
    const r = Analisis.resumirCompetencia(pocos);
    assert.equal(r.alcance, "pais");
    assert.equal(r.n_procesos, 100);
    assert.equal(r.n_entidad, 2);
    assert.equal(r.oferentes, null);
    assert.equal(r.ganadores[0].participaciones, null);
    assert.deepEqual(r.concentracion, { fraccion: 0.3, de: 100 });
    assert.ok(Math.abs(r.descuento.promedio - 0.2) < 1e-9);
  });

  await t.test("sin procesos ni datos nacionales devuelve sin_datos", () => {
    const r = Analisis.resumirCompetencia({ clase: null, entidad: { procesos: [], proponentes: [] }, pais: null });
    assert.equal(r.alcance, "sin_datos");
    assert.equal(r.n_procesos, 0);
    assert.equal(r.ganadores.length, 0);
  });
});

test("indiceDificultad", async (t) => {
  const resumen = (extra) => ({ n_procesos: 20, ganadores: [{ ganados: 10 }], ...extra });

  await t.test("alta cuando hay muchos oferentes, un ganador recurrente y descuentos fuertes", () => {
    const r = Analisis.indiceDificultad(resumen({
      oferentes: { mediana: 6, uno_solo: 0, cuatro_o_mas: 0.9 },
      concentracion: { fraccion: 0.7, de: 20 },
      descuento: { n: 20, mediano: 0.35, promedio: 0.35 },
    }));
    assert.equal(r.puntaje, 89); // (90*0.4 + 90*0.35 + 85*0.25) / 1
    assert.equal(r.nivel, "Alta");
    assert.equal(r.factores.length, 3);
  });

  await t.test("baja cuando casi no hay competencia", () => {
    const r = Analisis.indiceDificultad(resumen({
      oferentes: { mediana: 1, uno_solo: 0.8, cuatro_o_mas: 0 },
      concentracion: { fraccion: 0.2, de: 20 },
      descuento: { n: 20, mediano: 0.02, promedio: 0.02 },
    }));
    assert.equal(r.puntaje, 18); // (15*0.4 + 20*0.35 + 20*0.25)
    assert.equal(r.nivel, "Baja");
  });

  await t.test("reescala los pesos cuando falta un factor (nivel nacional sin oferentes)", () => {
    const r = Analisis.indiceDificultad(resumen({
      oferentes: null,
      concentracion: { fraccion: 0.5, de: 100 },
      descuento: { n: 100, mediano: null, promedio: 0.2 },
    }));
    assert.equal(r.puntaje, 68); // (70*0.35 + 65*0.25) / 0.6
    assert.equal(r.nivel, "Alta");
    assert.equal(r.factores.length, 2);
  });

  await t.test("no inventa un puntaje con pocos procesos o pocos factores", () => {
    const pocos = Analisis.indiceDificultad({
      n_procesos: 3, ganadores: [], oferentes: { mediana: 2, uno_solo: 0.5, cuatro_o_mas: 0 },
      concentracion: null, descuento: { n: 3, mediano: 0.1, promedio: 0.1 },
    });
    assert.equal(pocos.puntaje, null);
    assert.equal(pocos.nivel, "Sin datos suficientes");

    const unFactor = Analisis.indiceDificultad(resumen({ oferentes: null, concentracion: null, descuento: { n: 20, mediano: 0.1, promedio: 0.1 } }));
    assert.equal(unFactor.nivel, "Sin datos suficientes");
  });

  await t.test("cada factor explica su resultado en palabras", () => {
    const r = Analisis.indiceDificultad(resumen({
      oferentes: { mediana: 2, uno_solo: 0.4, cuatro_o_mas: 0.1 },
      concentracion: { fraccion: 0.5, de: 20 },
      descuento: { n: 20, mediano: 0.1, promedio: 0.1 },
    }));
    assert.match(r.factores[0].detalle, /Mediana de 2 oferentes; 40 % de los procesos tuvo un solo oferente/);
    assert.match(r.factores[1].detalle, /ganó 10 de 20 procesos \(50 %\)/);
    assert.match(r.factores[2].detalle, /descuento mediano de 10 %/);
  });
});

test("el factor de concentración se nombra según el alcance", () => {
  const base = {
    n_procesos: 100, ganadores: [{ ganados: 30 }], oferentes: null,
    concentracion: { fraccion: 0.3, de: 100 }, descuento: { n: 100, mediano: null, promedio: 0.2 },
  };
  const nacional = Analisis.indiceDificultad({ ...base, alcance: "pais" });
  assert.equal(nacional.factores[0].titulo, "Concentración del mercado (nacional)");
  assert.match(nacional.factores[0].detalle, /En todo el país/);
  assert.equal(nacional.factores_de, 3);
  const entidad = Analisis.indiceDificultad({ ...base, alcance: "entidad" });
  assert.equal(entidad.factores[0].titulo, "Ganador recurrente en la entidad");
});

test("resumirAdjudicados", () => {
  const r = Analisis.resumirAdjudicados([
    { presupuesto: 100, valor_adjudicado: 90, contrato: { estado: "En ejecución" } },
    { presupuesto: 100, valor_adjudicado: 70, contrato: { estado: "En ejecución" } },
    { presupuesto: 100, valor_adjudicado: 100, contrato: { estado: "Terminado" } },
    { presupuesto: null, valor_adjudicado: 50, contrato: null },
  ]);
  assert.equal(r.n, 4);
  assert.equal(r.valor_adjudicado, 310);
  casiIgual(r.descuento_mediano, 0.1); // descuentos 0.1, 0.3, 0
  assert.equal(r.con_contrato, 3);
  assert.deepEqual(r.estados, { "En ejecución": 2, Terminado: 1 });
});

test("enmascararDocumento", async (t) => {
  await t.test("muestra el NIT de las empresas", () => {
    for (const nombre of ["OFICIAR S.A.S", "Grupo Empresarial Ejecutar SAS", "COOPERATIVA MULTIACTIVA DE LA RENOVACIÓN",
      "Corporación Universidad de Antioquia", "UT Visión ICETEX 2024 Unión Temporal", "Tools & Services LTDA"]) {
      assert.equal(Analisis.enmascararDocumento(nombre, "830013740"), "830013740", nombre);
    }
  });

  await t.test("oculta la cédula de las personas naturales y deja 3 dígitos", () => {
    assert.equal(Analisis.enmascararDocumento("Carlos Alberto Rivera Escobar", "14274912"), "•••••912");
    assert.equal(Analisis.enmascararDocumento("Janyther Guerrero Arenas", "1032456789"), "•••••••789");
  });

  await t.test("muestra un NIT de 9 dígitos que empieza por 8 o 9 aunque el nombre no tenga forma jurídica", () => {
    assert.equal(Analisis.enmascararDocumento("CLOUD CITY", "901890823"), "901890823");
    assert.equal(Analisis.enmascararDocumento("Depósito La Veneciana", "830013740"), "830013740");
  });

  await t.test("sigue ocultando cédulas de 8 y 10 dígitos y números de 9 que no parecen NIT", () => {
    assert.equal(Analisis.enmascararDocumento("Carlos Rivera", "79123456"), "•••••456");
    assert.equal(Analisis.enmascararDocumento("Ana Gómez", "1019876543"), "•••••••543");
    assert.equal(Analisis.enmascararDocumento("Luis Pérez", "123456789"), "••••••789");
  });

  await t.test("ante la duda oculta, y tolera datos vacíos", () => {
    assert.equal(Analisis.enmascararDocumento(null, "12345678"), "•••••678");
    assert.equal(Analisis.enmascararDocumento("Cualquiera", null), "");
    assert.equal(Analisis.enmascararDocumento("Cualquiera", "12"), "12");
  });
});

test("exportación a CSV", async (t) => {
  const columnas = [
    { encabezado: "Nombre", valor: (f) => f.nombre },
    { encabezado: "Valor", valor: (f) => Analisis.numeroCSV(f.valor, 1) },
  ];

  await t.test("usa BOM, separador ; y fin de línea CRLF", () => {
    const csv = Analisis.aCSV(columnas, [{ nombre: "Café", valor: 1234.5 }]);
    assert.equal(csv, "﻿Nombre;Valor\r\nCafé;1234,5\r\n");
  });

  await t.test("entrecomilla textos con separador, comillas o saltos de línea", () => {
    const csv = Analisis.aCSV(columnas, [{ nombre: 'Uno; "dos"\ntres', valor: null }]);
    assert.ok(csv.includes('"Uno; ""dos""\ntres";'));
  });

  await t.test("neutraliza fórmulas pero deja pasar números negativos", () => {
    const csv = Analisis.aCSV(columnas, [{ nombre: "=HYPERLINK(\"x\")", valor: -5 }, { nombre: "-12", valor: 1 }]);
    const filas = csv.split("\r\n");
    assert.ok(filas[1].startsWith("\"'=HYPERLINK"), filas[1]);
    assert.ok(filas[1].endsWith(";-5,0"));
    assert.ok(filas[2].startsWith("-12;"), "un número como texto no es una fórmula");
  });

  await t.test("numeroCSV tolera vacíos", () => {
    assert.equal(Analisis.numeroCSV(null), "");
    assert.equal(Analisis.numeroCSV(undefined), "");
    assert.equal(Analisis.numeroCSV(0.256, 1), "0,3");
    assert.equal(Analisis.numeroCSV(1481021552), "1481021552");
  });
});
