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

  await t.test("el filtro competitivo se puede desactivar", () => {
    const perfil = Secop.parsearPerfil({ codigos: "8011", competitivos: "0" });
    assert.equal(perfil.competitivos, false);
    assert.ok(!Secop.clausulaOportunidades(perfil, desde, hoy).includes("not in"));
  });
});

test("normalizarProceso", async (t) => {
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
    return { ok: true, status: 200, json: async () => responder(parametros) };
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
