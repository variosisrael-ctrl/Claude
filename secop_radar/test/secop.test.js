"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Secop = require("../site/secop.js");

const rechaza = (fn, clase = Secop.ErrorDeValidacion) => assert.throws(fn, clase);

test("validación", async (t) => {
  await t.test("los códigos aceptan completos, prefijos y formato V1.", () => {
    assert.deepEqual(Secop.normalizarCodigos("V1.80111600, 8011 ; 7215"), ["80111600", "8011", "7215"]);
  });

  await t.test("un código inválido se rechaza", () => {
    for (const texto of ["80%", "123", "abcd", "123456789"]) rechaza(() => Secop.normalizarCodigos(texto));
  });

  await t.test("las palabras se limpian y conservan tildes", () => {
    assert.deepEqual(Secop.normalizarPalabras("  Mantenimiento , capacitación,"), ["MANTENIMIENTO", "CAPACITACIÓN"]);
  });

  await t.test("las palabras con caracteres de consulta se rechazan", () => {
    for (const texto of ["x' OR 1=1 --", "50%", "a_b", "(select)"]) rechaza(() => Secop.normalizarPalabras(texto));
  });

  await t.test("el perfil exige palabras o códigos", () => {
    rechaza(() => Secop.parsearPerfil({ dias: "30" }));
  });

  await t.test("el modo amplio (resumen de las alertas) permite no indicar palabras ni códigos", () => {
    const perfil = Secop.parsearPerfil({ dias: "3", min: "50000000" }, { amplio: true });
    assert.deepEqual([perfil.palabras, perfil.codigos], [[], []]);
    assert.equal(perfil.min, 50000000);
    rechaza(() => Secop.parsearPerfil({ dias: "3" }, { amplio: false }));
    rechaza(() => Secop.parsearPerfil({ palabras: "x' OR 1=1", dias: "3" }, { amplio: true }));
  });

  await t.test("el rango de presupuesto debe ser coherente", () => {
    rechaza(() => Secop.parsearPerfil({ palabras: "software", min: "5000000", max: "1000000" }));
  });

  await t.test("los días fuera de rango o no numéricos se rechazan", () => {
    for (const dias of ["4000", "0", "abc", "1e2", "5.5"]) {
      rechaza(() => Secop.parsearPerfil({ palabras: "software", dias }));
    }
  });

  await t.test("los días por defecto son 30 y el filtro competitivo está activo", () => {
    const perfil = Secop.parsearPerfil({ palabras: "software" });
    assert.equal(perfil.dias, 30);
    assert.equal(perfil.competitivos, true);
  });
});

test("cláusulas SoQL", async (t) => {
  const desde = new Date(Date.UTC(2026, 8, 13, 17)); // 13 de septiembre de 2026, mediodía en Bogotá
  const hoy = new Date(Date.UTC(2026, 9, 13, 17)); // 13 de octubre de 2026, mediodía en Bogotá

  await t.test("literal duplica las comillas simples", () => {
    assert.equal(Secop.literal("a'b"), "'a''b'");
  });

  await t.test("oportunidades filtran estado, fecha, categoría, palabra, presupuesto y departamento", () => {
    const perfil = Secop.parsearPerfil({
      codigos: "8011", palabras: "mantenimiento", min: "1000000", max: "9000000", departamento: "antioquia",
    });
    const clausula = Secop.clausulaOportunidades(perfil, desde, hoy);
    for (const fragmento of [
      "estado_de_apertura_del_proceso = 'Abierto'",
      "fecha_de_publicacion_del >= '2026-09-13T00:00:00'",
      "codigo_principal_de_categoria like 'V1.8011%'",
      "upper(nombre_del_procedimiento) like '%MANTENIMIENTO%'",
      "upper(descripci_n_del_procedimiento) like '%MANTENIMIENTO%'",
      "precio_base >= 1000000",
      "precio_base <= 9000000",
      "upper(departamento_entidad) like '%ANTIOQUIA%'",
    ]) {
      assert.ok(clausula.includes(fragmento), `falta: ${fragmento}`);
    }
  });

  await t.test("el mercado excluye valores atípicos", () => {
    const perfil = Secop.parsearPerfil({ codigos: "8011" });
    const clausula = Secop.clausulaMercado(perfil, 2023, false);
    assert.ok(clausula.includes(`valor_del_contrato < ${Secop.VALOR_MAXIMO_PLAUSIBLE}`));
    assert.ok(clausula.includes("fecha_de_firma >= '2023-01-01T00:00:00'"));
    assert.ok(clausula.includes("codigo_de_categoria_principal like 'V1.8011%'"));
    assert.ok(!clausula.includes("not in"));
  });

  await t.test("el filtro competitivo excluye directa pero no las variantes con ofertas", () => {
    const clausula = Secop.clausulaOportunidades(Secop.parsearPerfil({ codigos: "8011" }), desde, hoy);
    assert.ok(clausula.includes("modalidad_de_contratacion not in ("));
    assert.ok(clausula.includes("'Contratación directa'"));
    assert.ok(clausula.includes("'Contratación régimen especial'"));
    assert.ok(!clausula.includes("(con ofertas)"));
  });

  await t.test("por defecto solo pide procesos con plazo vigente y sin adjudicar", () => {
    const perfil = Secop.parsearPerfil({ codigos: "8011" });
    assert.equal(perfil.abiertos, true);
    const clausula = Secop.clausulaOportunidades(perfil, desde, hoy);
    assert.ok(clausula.includes("fecha_de_recepcion_de >= '2026-10-13T00:00:00'"));
    assert.ok(clausula.includes("adjudicado = 'No'"));
  });

  await t.test("con abiertos desactivado no filtra por plazo ni por adjudicación", () => {
    const perfil = Secop.parsearPerfil({ codigos: "8011", abiertos: "0" });
    const clausula = Secop.clausulaOportunidades(perfil, desde, hoy);
    assert.ok(!clausula.includes("fecha_de_recepcion_de"));
    assert.ok(!clausula.includes("adjudicado ="));
  });

  await t.test("sin palabras ni códigos no queda ninguna condición de alcance vacía", () => {
    const perfil = Secop.parsearPerfil({ dias: "3", min: "50000000" }, { amplio: true });
    const clausula = Secop.clausulaOportunidades(perfil, desde, hoy);
    assert.ok(!clausula.includes("()") && !clausula.includes("like '%") && !clausula.includes("V1."));
    for (const fragmento of ["estado_de_apertura_del_proceso = 'Abierto'", "adjudicado = 'No'", "precio_base >= 50000000", "not in"]) {
      assert.ok(clausula.includes(fragmento), `falta: ${fragmento}`);
    }
    assert.ok(!/AND\s*(AND|$)/.test(clausula));
  });

  await t.test("el filtro competitivo se puede desactivar", () => {
    const perfil = Secop.parsearPerfil({ codigos: "8011", competitivos: "0" });
    assert.equal(perfil.competitivos, false);
    assert.ok(!Secop.clausulaOportunidades(perfil, desde, hoy).includes("not in"));
  });
});

test("normalizarProceso", async (t) => {
  await t.test("la ciudad y el departamento “No Definido” de la fuente quedan vacíos", () => {
    const p = Secop.normalizarProceso({ id_del_proceso: "CO1.REQ.1", ciudad_entidad: "No Definido", departamento_entidad: "Distrito Capital de Bogotá" });
    assert.equal(p.ciudad, null);
    assert.equal(p.departamento, "Distrito Capital de Bogotá");
    assert.equal(Secop.normalizarProceso({ id_del_proceso: "CO1.REQ.2" }).ciudad, null);
  });

  await t.test("la url acepta objeto o texto, pero solo https", () => {
    const base = { id_del_proceso: "CO1.REQ.1" };
    const casos = [
      [{ url: "https://x.gov.co/a" }, "https://x.gov.co/a"],
      ["https://x.gov.co/b", "https://x.gov.co/b"],
      [{ url: "javascript:alert(1)" }, null],
      [null, null],
    ];
    for (const [entrada, esperado] of casos) {
      assert.equal(Secop.normalizarProceso({ ...base, urlproceso: entrada }).url, esperado);
    }
  });

  await t.test("el presupuesto en texto se convierte en número", () => {
    assert.equal(Secop.normalizarProceso({ precio_base: "7500000" }).presupuesto, 7500000);
    assert.equal(Secop.normalizarProceso({ precio_base: "N/D" }).presupuesto, null);
    assert.equal(Secop.normalizarProceso({}).presupuesto, null);
  });

  await t.test("la fecha se recorta a día", () => {
    assert.equal(Secop.normalizarProceso({ fecha_de_publicacion_del: "2026-10-09T00:00:00.000" }).publicado, "2026-10-09");
  });
});

test("puntuación", async (t) => {
  await t.test("categoría y palabras suman y explican", () => {
    const perfil = Secop.parsearPerfil({ codigos: "8011", palabras: "mantenimiento,software" });
    const oportunidad = {
      nombre: "Mantenimiento de sistemas", descripcion: "Incluye software", categoria: "V1.80111600", presupuesto: 5_000_000,
    };
    const [puntaje, razones] = Secop.puntuar(oportunidad, perfil);
    assert.equal(puntaje, 40 + 20 + 10); // categoría + palabra en nombre + palabra en descripción
    assert.equal(razones.length, 3);
  });

  await t.test("el presupuesto dentro del rango suma 20", () => {
    const perfil = Secop.parsearPerfil({ palabras: "software", min: "1000000", max: "9000000" });
    const base = { nombre: "Software", descripcion: "", categoria: "V1.1" };
    const [dentro] = Secop.puntuar({ ...base, presupuesto: 5_000_000 }, perfil);
    const [fuera] = Secop.puntuar({ ...base, presupuesto: 50_000_000 }, perfil);
    assert.equal(dentro - fuera, 20);
  });

  await t.test("sin coincidencias no puntúa", () => {
    const perfil = Secop.parsearPerfil({ palabras: "software" });
    const oportunidad = { nombre: "Suministro de alimentos", descripcion: "", categoria: "V1.50000000", presupuesto: null };
    assert.deepEqual(Secop.puntuar(oportunidad, perfil), [0, []]);
  });

  await t.test("el puntaje máximo es 100", () => {
    const perfil = Secop.parsearPerfil({ codigos: "8011", palabras: "a1,b2,c3", min: "0", max: "10" });
    const oportunidad = { nombre: "A1 B2 C3", descripcion: "", categoria: "V1.80111600", presupuesto: 5 };
    assert.equal(Secop.puntuar(oportunidad, perfil)[0], 100);
  });
});

/** Cliente con un `fetch` simulado que registra las llamadas. `responder(parametros)` devuelve las filas. */
function clienteFalso(responder, { ahora } = {}) {
  const llamadas = [];
  const fetchFn = async (direccion) => {
    const url = new URL(direccion);
    const parametros = Object.fromEntries(url.searchParams);
    llamadas.push({ base: url.origin + url.pathname, parametros });
    return { ok: true, status: 200, json: async () => responder(parametros, url.origin + url.pathname) };
  };
  return { cliente: Secop.crearCliente({ fetchFn, ahora }), llamadas };
}

const fila = (id, nombre, categoria, fecha) => ({
  id_del_proceso: id, nombre_del_procedimiento: nombre, descripci_n_del_procedimiento: "",
  codigo_principal_de_categoria: categoria, fecha_de_publicacion_del: fecha, precio_base: "100",
});

test("casos de uso con datos.gov.co simulado", async (t) => {
  await t.test("las oportunidades se deduplican y ordenan por puntaje", async () => {
    const filas = [
      fila("B", "Software", "V1.50000000", "2026-10-10T00:00:00.000"),
      fila("A", "Mantenimiento de software", "V1.80111600", "2026-10-09T00:00:00.000"),
      fila("A", "Mantenimiento de software", "V1.80111600", "2026-10-09T00:00:00.000"),
      { nombre_del_procedimiento: "Sin identificador" },
    ];
    const { cliente, llamadas } = clienteFalso(() => filas, { ahora: () => Date.UTC(2026, 9, 13, 17) });
    const resultado = await cliente.buscarOportunidades({ palabras: "software, mantenimiento", codigos: "8011" });

    assert.deepEqual(resultado.resultados.map((op) => op.id), ["A", "B"]);
    assert.equal(resultado.filas_revisadas, 4);
    assert.equal(resultado.desde, "2026-09-13");
    assert.equal(llamadas.length, 1);
    assert.equal(llamadas[0].base, Secop.URL_PROCESOS);
    assert.ok(llamadas[0].parametros.$where.includes("'Abierto'"));
    assert.equal(llamadas[0].parametros.$order, "fecha_de_recepcion_de ASC");
  });

  await t.test("buscarProcesosPorId agrupa por proceso en el servidor y solo informa el ganador si es uno", async () => {
    const base = { cierre_max: "2026-10-20T00:00:00.000", adjudicado_max: "No", estado_max: "Publicado", n_ganadores: "1", nombre_del_procedimiento: "P", entidad: "E" };
    const grupos = [
      { id_del_proceso: "CO1.REQ.1", ...base },
      { id_del_proceso: "CO1.REQ.2", ...base, estado_max: "Cancelado" },
      { id_del_proceso: "CO1.REQ.3", ...base, adjudicado_max: "Si", fecha_adj_max: "2026-10-02T00:00:00.000", valor_adj_max: "5000", ganador_max: "GANADOR SAS", n_ganadores: "1" },
      { id_del_proceso: "CO1.REQ.4", ...base, adjudicado_max: "Si", valor_adj_max: "9999", ganador_max: "UNO SAS", n_ganadores: "3" },
      { id_del_proceso: "CO1.REQ.1", ...base, adjudicado_max: "Si", ganador_max: "OTRO", valor_adj_max: "7", n_ganadores: "1" },
      { nombre_del_procedimiento: "sin identificador" },
    ];
    const { cliente, llamadas } = clienteFalso(() => grupos);
    const resultado = await cliente.buscarProcesosPorId(["CO1.REQ.1", "CO1.REQ.2", "CO1.REQ.1", "x' OR 1=1", "a"]);

    assert.deepEqual([...resultado.keys()], ["CO1.REQ.1", "CO1.REQ.2", "CO1.REQ.3", "CO1.REQ.4"]);
    assert.equal(resultado.get("CO1.REQ.2").estado_procedimiento, "Cancelado");
    assert.equal(resultado.get("CO1.REQ.1").adjudicado, true, "si alguna fila del proceso está adjudicada, lo está");
    const uno = resultado.get("CO1.REQ.3");
    assert.deepEqual([uno.adjudicado, uno.ganador, uno.valor_adjudicado, uno.fecha_adjudicacion, uno.cierre], [true, "GANADOR SAS", 5000, "2026-10-02", "2026-10-20"]);
    const varios = resultado.get("CO1.REQ.4");
    assert.deepEqual([varios.adjudicado, varios.ganador, varios.valor_adjudicado], [true, null, null], "con varios ganadores no se inventa uno");

    assert.equal(llamadas.length, 1);
    assert.equal(llamadas[0].parametros.$where, "id_del_proceso in ('CO1.REQ.1','CO1.REQ.2')", "descarta identificadores inválidos y repetidos");
    assert.equal(llamadas[0].parametros.$group, "id_del_proceso,nombre_del_procedimiento,entidad,urlproceso");
    assert.ok(llamadas[0].parametros.$select.includes("count(distinct nombre_del_proveedor) as n_ganadores"));
    for (const alias of llamadas[0].parametros.$select.split(",").filter((c) => c.includes(" as "))) {
      assert.ok(!/ as (adjudicado|entidad|id_del_proceso)$/.test(alias), "un alias no puede llamarse como una columna");
    }

    const muchos = Array.from({ length: 250 }, (_, i) => `CO1.REQ.${i + 10}`);
    const { cliente: otro, llamadas: otras } = clienteFalso(() => []);
    await otro.buscarProcesosPorId(muchos);
    assert.equal(otras.length, 3, "lotes de 100");
  });

  await t.test("el mercado convierte texto de la fuente en números y filtra por consulta", async () => {
    const respuestas = {
      nombre_entidad: [{ nombre_entidad: "Alcaldía X", contratos: "12", valor: "5414026672.5" }],
      documento_proveedor: [{ documento_proveedor: "900123", nombre: "PROVEEDOR SAS", contratos: "3", valor: "1000" }],
      modalidad_de_contratacion: [{ modalidad_de_contratacion: "Mínima cuantía", contratos: "7" }],
    };
    const { cliente, llamadas } = clienteFalso((parametros) => respuestas[parametros.$group]);
    const resultado = await cliente.inteligenciaMercado({ codigos: "8011", desde: "2024" });

    assert.equal(resultado.desde, 2024);
    assert.deepEqual(resultado.entidades, [{ nombre: "Alcaldía X", contratos: 12, valor: 5414026672.5 }]);
    assert.equal(resultado.proveedores[0].contratos, 3);
    assert.equal(resultado.proveedores[0].documento, "900123");
    assert.deepEqual(resultado.modalidades, [{ nombre: "Mínima cuantía", contratos: 7 }]);
    assert.equal(llamadas.length, 3);
    assert.ok(llamadas.every((l) => l.base === Secop.URL_CONTRATOS));

    const donde = Object.fromEntries(llamadas.map((l) => [l.parametros.$group, l.parametros.$where]));
    assert.ok(donde.nombre_entidad.includes("not in"));
    assert.ok(donde.documento_proveedor.includes("not in"));
    assert.ok(donde.documento_proveedor.includes("documento_proveedor != 'No Definido'"));
    assert.ok(!donde.nombre_entidad.includes("No Definido"));
    assert.ok(!donde.modalidad_de_contratacion.includes("not in")); // la mezcla de modalidades va completa
  });

  await t.test("el mercado rechaza un año inicial inválido", async () => {
    const { cliente } = clienteFalso(() => []);
    await assert.rejects(cliente.inteligenciaMercado({ codigos: "8011", desde: "1999" }), Secop.ErrorDeValidacion);
  });

  await t.test("un error HTTP de la fuente se informa con su código", async () => {
    const fetchFn = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const cliente = Secop.crearCliente({ fetchFn });
    await assert.rejects(cliente.buscarOportunidades({ palabras: "software" }), (error) => {
      assert.ok(error instanceof Secop.ErrorDeOrigen);
      assert.match(error.message, /503/);
      return true;
    });
  });

  await t.test("un fallo de red se informa como error de origen", async () => {
    const fetchFn = async () => { throw new TypeError("Failed to fetch"); };
    const cliente = Secop.crearCliente({ fetchFn });
    await assert.rejects(cliente.buscarOportunidades({ palabras: "software" }), Secop.ErrorDeOrigen);
  });

  await t.test("las consultas repetidas usan la caché hasta que vence", async () => {
    let momento = 1_000_000;
    const { cliente, llamadas } = clienteFalso(() => [], { ahora: () => momento });
    const params = { palabras: "software" };

    await cliente.buscarOportunidades(params);
    await cliente.buscarOportunidades(params);
    assert.equal(llamadas.length, 1);

    momento += 601_000; // pasaron más de 10 minutos
    await cliente.buscarOportunidades(params);
    assert.equal(llamadas.length, 2);
  });
});

test("fechas en hora de Colombia", async (t) => {
  await t.test("fechaIso usa la fecha de Bogotá, no la del servidor", () => {
    // 03:00 UTC del 14 de octubre son las 22:00 del 13 de octubre en Bogotá.
    assert.equal(Secop.fechaIso(new Date(Date.UTC(2026, 9, 14, 3))), "2026-10-13");
    assert.equal(Secop.fechaIso(new Date(Date.UTC(2026, 9, 14, 6))), "2026-10-14");
  });

  await t.test("diasHasta cuenta días de calendario", () => {
    const hoy = new Date(Date.UTC(2026, 9, 31, 17)); // 31 de octubre
    assert.equal(Secop.diasHasta("2026-10-31", hoy), 0);
    assert.equal(Secop.diasHasta("2026-11-01", hoy), 1);
    assert.equal(Secop.diasHasta("2026-10-29", hoy), -2);
    assert.equal(Secop.diasHasta("2027-01-01", hoy), 62);
    assert.equal(Secop.diasHasta(null, hoy), null);
  });
});

test("normalizarProceso: adjudicación y cierre", async (t) => {
  await t.test("lee cierre, estado, portafolio y entidad", () => {
    const op = Secop.normalizarProceso({
      id_del_proceso: "CO1.REQ.1", fecha_de_recepcion_de: "2026-10-16T00:00:00.000", estado_resumen: "Presentación de oferta",
      id_del_portafolio: "CO1.BDOS.9", nit_entidad: "899999027", adjudicado: "No",
    });
    assert.equal(op.cierre, "2026-10-16");
    assert.equal(op.estado, "Presentación de oferta");
    assert.equal(op.portafolio, "CO1.BDOS.9");
    assert.equal(op.nit_entidad, "899999027");
    assert.equal(op.adjudicado, false);
  });

  await t.test("trata 'No Definido' y 'No Adjudicado' como ausencia de dato", () => {
    const op = Secop.normalizarProceso({
      id_del_proceso: "CO1.REQ.2", adjudicado: "Si", valor_total_adjudicacion: "21559944",
      nombre_del_proveedor: "No Definido", nit_del_proveedor_adjudicado: "No Adjudicado",
    });
    assert.equal(op.adjudicado, true);
    assert.equal(op.valor_adjudicado, 21559944);
    assert.equal(op.ganador, null);
    assert.equal(op.nit_ganador, null);
  });

  await t.test("conserva al ganador cuando sí hay dato", () => {
    const op = Secop.normalizarProceso({ nombre_del_proveedor: "OFICIAR S.A.S", nit_del_proveedor_adjudicado: "830013740" });
    assert.equal(op.ganador, "OFICIAR S.A.S");
    assert.equal(op.nit_ganador, "830013740");
  });
});

test("búsqueda de oportunidades abiertas", async (t) => {
  await t.test("devuelve todos, pide primero los que cierran antes y avisa si se alcanzó el tope", async () => {
    const filas = Array.from({ length: 1000 }, (_, i) => ({
      id_del_proceso: `CO1.REQ.${i}`, nombre_del_procedimiento: "Software", fecha_de_recepcion_de: "2026-10-20T00:00:00.000",
    }));
    const { cliente, llamadas } = clienteFalso(() => filas, { ahora: () => Date.UTC(2026, 9, 13, 17) });
    const resultado = await cliente.buscarOportunidades({ palabras: "software" });
    assert.equal(resultado.limite_alcanzado, true);
    assert.equal(resultado.resultados.length, 1000); // se devuelven todos; la interfaz los pagina
    assert.equal(llamadas[0].parametros.$order, "fecha_de_recepcion_de ASC");
    assert.equal(llamadas[0].parametros.$limit, "1000");
  });

  await t.test("sin filtro de abiertos ordena por publicación reciente", async () => {
    const { cliente, llamadas } = clienteFalso(() => [], { ahora: () => Date.UTC(2026, 9, 13, 17) });
    const resultado = await cliente.buscarOportunidades({ palabras: "software", abiertos: "0" });
    assert.equal(resultado.limite_alcanzado, false);
    assert.equal(llamadas[0].parametros.$order, "fecha_de_publicacion_del DESC");
  });
});

test("clase de categoría y contratos", async (t) => {
  await t.test("claseCategoria toma los 6 primeros dígitos del código UNSPSC", () => {
    assert.equal(Secop.claseCategoria("V1.80111600"), "801116");
    assert.equal(Secop.claseCategoria("UNSPECIFIED"), null);
    assert.equal(Secop.claseCategoria(null), null);
  });

  await t.test("normalizarContrato ordena el estado y descarta valores absurdos", () => {
    const c = Secop.normalizarContrato({
      id_contrato: "CO1.PCCNTR.1", proceso_de_compra: "CO1.BDOS.1", estado_contrato: "terminado",
      valor_del_contrato: "104249364104249364", valor_pagado: "500", dias_adicionados: "30", proveedor_adjudicado: "No Definido",
    });
    assert.equal(c.estado, "Terminado");
    assert.equal(c.valor, null, "un valor mayor al máximo plausible es un error de digitación");
    assert.equal(c.pagado, 500);
    assert.equal(c.dias_adicionados, 30);
    assert.equal(c.proveedor, null);
  });
});

test("adjudicados y ejecución", async (t) => {
  const ahora = () => Date.UTC(2026, 9, 13, 17);
  const procesoAdj = (i) => ({
    id_del_proceso: `CO1.REQ.${i}`, id_del_portafolio: `CO1.BDOS.${i}`, nombre_del_procedimiento: "Mantenimiento de equipos",
    codigo_principal_de_categoria: "V1.80111600", adjudicado: "Si", precio_base: "100", valor_total_adjudicacion: "90",
    fecha_adjudicacion: "2026-10-01T00:00:00.000", nombre_del_proveedor: "Empresa Uno", nit_del_proveedor_adjudicado: "901000111",
  });

  await t.test("la cláusula pide adjudicados recientes y no mira el plazo de recepción", () => {
    const perfil = Secop.parsearPerfil({ palabras: "software" });
    const clausula = Secop.clausulaAdjudicados(perfil, new Date(Date.UTC(2026, 6, 15, 17)));
    assert.ok(clausula.includes("adjudicado = 'Si'"));
    assert.ok(clausula.includes("fecha_adjudicacion >= '2026-07-15T00:00:00'"));
    assert.ok(!clausula.includes("fecha_de_recepcion_de"));
    assert.ok(clausula.includes("upper(nombre_del_procedimiento) like '%SOFTWARE%'"));
  });

  await t.test("cruza cada proceso con su contrato por portafolio y consulta en lotes de 100", async () => {
    const filas = Array.from({ length: 250 }, (_, i) => procesoAdj(i));
    filas.push(procesoAdj(0)); // repetido: la fuente duplica filas
    const contratos = (parametros) => {
      const ids = [...parametros.$where.matchAll(/'(CO1\.BDOS\.\d+)'/g)].map((m) => m[1]);
      return ids.filter((id) => Number(id.split(".").pop()) % 2 === 0).map((id) => ({
        proceso_de_compra: id, id_contrato: `C-${id}`, estado_contrato: "En ejecución", valor_del_contrato: "90", valor_pagado: "45",
      }));
    };
    const { cliente, llamadas } = clienteFalso((parametros, base) => (base === Secop.URL_PROCESOS ? filas : contratos(parametros)), { ahora });
    const r = await cliente.buscarAdjudicados({ palabras: "mantenimiento", meses: "3" });

    assert.equal(r.resultados.length, 250, "deduplica por proceso");
    assert.equal(r.meses, 3);
    assert.equal(r.desde, "2026-07-15"); // 3 meses = 90 días antes del 13 de octubre
    const consultasContratos = llamadas.filter((l) => l.base === Secop.URL_CONTRATOS);
    assert.equal(consultasContratos.length, 3, "250 portafolios en lotes de 100");
    assert.equal(r.resultados.filter((p) => p.contrato).length, 125);
    const conContrato = r.resultados.find((p) => p.portafolio === "CO1.BDOS.4");
    assert.equal(conContrato.contrato.estado, "En ejecución");
    assert.equal(conContrato.contrato.pagado, 45);
    assert.equal(r.resultados.find((p) => p.portafolio === "CO1.BDOS.5").contrato, null);
    assert.equal(llamadas[0].parametros.$order, "fecha_adjudicacion DESC");
  });

  await t.test("si un proceso tiene varios contratos muestra el de mayor valor y los cuenta", async () => {
    const respuestas = (parametros, base) => (base === Secop.URL_PROCESOS
      ? [procesoAdj(1)]
      : [
          { proceso_de_compra: "CO1.BDOS.1", id_contrato: "A", estado_contrato: "Aprobado", valor_del_contrato: "30" },
          { proceso_de_compra: "CO1.BDOS.1", id_contrato: "B", estado_contrato: "En ejecución", valor_del_contrato: "60" },
        ]);
    const { cliente } = clienteFalso(respuestas, { ahora });
    const r = await cliente.buscarAdjudicados({ palabras: "mantenimiento" });
    assert.equal(r.resultados[0].contrato.id, "B");
    assert.equal(r.resultados[0].contrato.contratos, 2);
  });

  await t.test("sin procesos no consulta contratos y valida los meses", async () => {
    const { cliente, llamadas } = clienteFalso(() => [], { ahora });
    const r = await cliente.buscarAdjudicados({ palabras: "mantenimiento" });
    assert.deepEqual(r.resultados, []);
    assert.equal(llamadas.length, 1);
    await assert.rejects(cliente.buscarAdjudicados({ palabras: "mantenimiento", meses: "99" }), Secop.ErrorDeValidacion);
  });
});

test("competencia histórica de una entidad", async (t) => {
  const ahora = () => Date.UTC(2026, 9, 13, 17);
  const filaProceso = (i) => ({
    id_del_proceso: `CO1.REQ.${i}`, precio_base: "100", valor_total_adjudicacion: "90",
    nit_del_proveedor_adjudicado: "901000111", nombre_del_proveedor: "Empresa Uno", fecha_adjudicacion: "2026-05-01T00:00:00.000",
  });

  await t.test("rechaza un NIT que no sea numérico", async () => {
    const { cliente } = clienteFalso(() => [], { ahora });
    for (const nit of ["", "abc", "9000'; DROP", "123"]) {
      await assert.rejects(cliente.competenciaHistorica({ nit_entidad: nit, categoria: "V1.80111600" }), Secop.ErrorDeValidacion, nit);
    }
  });

  await t.test("con historial suficiente consulta procesos y proponentes, sin recurrir al nivel nacional", async () => {
    const procesos = Array.from({ length: 6 }, (_, i) => filaProceso(i));
    const proponentes = (parametros) => {
      const ids = [...parametros.$where.matchAll(/'(CO1\.REQ\.\d+)'/g)].map((m) => m[1]);
      return ids.flatMap((id) => [{ id_procedimiento: id, nit_proveedor: "901000111", proveedor: "Empresa Uno" }, { id_procedimiento: id, nit_proveedor: "900", proveedor: "Otra" }]);
    };
    const { cliente, llamadas } = clienteFalso((parametros, base) => (base === Secop.URL_PROCESOS ? procesos : proponentes(parametros)), { ahora });
    const raw = await cliente.competenciaHistorica({ nit_entidad: "899999034", categoria: "V1.72151802" });

    assert.equal(raw.clase, "721518");
    assert.equal(raw.pais, null);
    assert.equal(raw.entidad.procesos.length, 6);
    assert.equal(raw.entidad.proponentes.length, 12);
    assert.equal(llamadas.length, 2);
    const donde = llamadas[0].parametros.$where;
    for (const fragmento of ["nit_entidad = '899999034'", "codigo_principal_de_categoria like 'V1.721518%'", "adjudicado = 'Si'",
      "fecha_adjudicacion >= '2024-10-13T00:00:00'", "not in (", "valor_total_adjudicacion <= precio_base * 2"]) {
      assert.ok(donde.includes(fragmento), `falta: ${fragmento}`);
    }
    assert.equal(llamadas[1].base, Secop.URL_PROPONENTES);
    assert.ok(llamadas[1].parametros.$where.startsWith("id_procedimiento in ('CO1.REQ.0'"));
  });

  await t.test("con pocos procesos y categoría, complementa con el nivel nacional (sin alias que choquen con columnas)", async () => {
    const responder = (parametros, base) => {
      if (base === Secop.URL_PROPONENTES) return [];
      if (parametros.$group) return [{ nit_del_proveedor_adjudicado: "Z", nombre: "Empresa Z", ganados: "30", valor: "5000" }];
      if (parametros.$select.startsWith("count(*)")) return [{ n: "100", suma_adjudicada: "8000", suma_base: "10000" }];
      return [filaProceso(1), filaProceso(2)];
    };
    const { cliente, llamadas } = clienteFalso(responder, { ahora });
    const raw = await cliente.competenciaHistorica({ nit_entidad: "899999034", categoria: "V1.72151802" });

    assert.equal(raw.entidad.procesos.length, 2);
    assert.deepEqual(raw.pais.totales, { n: 100, adjudicado: 8000, base: 10000 });
    assert.equal(raw.pais.ganadores[0].ganados, 30);
    const totales = llamadas.find((l) => l.parametros.$select?.startsWith("count(*)"));
    assert.ok(!/\bas adjudicado\b/.test(totales.parametros.$select), "un alias llamado 'adjudicado' choca con la columna");
    assert.ok(!totales.parametros.$where.includes("nit_entidad"), "el nivel nacional no filtra por entidad");
  });

  await t.test("sin categoría no usa el nivel nacional", async () => {
    const { cliente, llamadas } = clienteFalso((parametros, base) => (base === Secop.URL_PROCESOS ? [filaProceso(1)] : []), { ahora });
    const raw = await cliente.competenciaHistorica({ nit_entidad: "899999034", categoria: "UNSPECIFIED" });
    assert.equal(raw.clase, null);
    assert.equal(raw.pais, null);
    assert.ok(!llamadas[0].parametros.$where.includes("codigo_principal_de_categoria"));
  });
});
