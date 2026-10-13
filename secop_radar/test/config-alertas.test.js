"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Config = require("../site/config-alertas.js");

const alerta = (extra = {}) => ({ id: "abc12345", nombre: "Mantenimiento TI", palabras: "mantenimiento, software", codigos: "8011", ...extra });
const rechaza = (valores, patron) =>
  assert.throws(() => Config.validarAlerta(valores), (error) => {
    assert.ok(error instanceof Config.ErrorDeConfiguracion, `se esperaba ErrorDeConfiguracion, llegó ${error}`);
    if (patron) assert.match(error.message, patron);
    return true;
  });

test("validarAlerta", async (t) => {
  await t.test("acepta una alerta válida y completa los valores por defecto", () => {
    assert.deepEqual(Config.validarAlerta(alerta()), {
      id: "abc12345", nombre: "Mantenimiento TI", palabras: "mantenimiento, software", codigos: "8011", departamento: "",
      min: "", max: "", competitivos: "1", minimo: 40, activa: true,
    });
  });

  await t.test("limpia espacios, respeta competitivos 0 y activa false", () => {
    const a = Config.validarAlerta(alerta({ nombre: "  Mi   alerta  ", competitivos: "0", activa: false, minimo: "0", min: "1000000", max: "9000000" }));
    assert.deepEqual([a.nombre, a.competitivos, a.activa, a.minimo, a.min, a.max], ["Mi alerta", "0", false, 0, "1000000", "9000000"]);
  });

  await t.test("exige nombre, identificador válido y palabras o códigos", () => {
    rechaza(alerta({ nombre: "  " }), /Ponle un nombre/);
    rechaza(alerta({ nombre: "N".repeat(61) }), /hasta 60 caracteres/);
    rechaza(alerta({ id: undefined }), /identificador/);
    rechaza(alerta({ id: "ab" }), /identificador/);
    rechaza(alerta({ id: "A B/../" }), /identificador/);
    rechaza(alerta({ palabras: "", codigos: "" }), /al menos una palabra clave o un código/);
  });

  await t.test("usa las mismas reglas de la página para palabras, códigos y presupuesto", () => {
    rechaza(alerta({ palabras: "x' OR 1=1" }), /no es válido/);
    rechaza(alerta({ codigos: "12" }), /UNSPSC/);
    rechaza(alerta({ min: "9", max: "1" }), /mínimo no puede ser mayor/);
    rechaza(alerta({ min: "abc" }), /número entero/);
    rechaza(alerta({ departamento: "a'b" }), /no es válido/);
  });

  await t.test("la coincidencia mínima va de 0 a 100", () => {
    for (const minimo of [-1, 101, 2.5, "x"]) rechaza(alerta({ minimo }), /entre 0 y 100/);
  });
});

test("normalizarConfig", async (t) => {
  await t.test("una configuración vacía o desconocida no falla", () => {
    for (const entrada of [null, undefined, 5, "texto", [], {}]) {
      const { config } = Config.normalizarConfig(entrada);
      assert.deepEqual(config, Config.configVacia());
    }
    assert.equal(Config.normalizarConfig(null).problemas, 1);
    assert.equal(Config.normalizarConfig({}).problemas, 0);
  });

  await t.test("descarta lo inválido y repetido y cuenta cuánto, sin tocar lo bueno", () => {
    const { config, problemas } = Config.normalizarConfig({
      alertas: [alerta(), alerta({ id: "zzzz9999", palabras: "x' OR 1=1" }), alerta({ nombre: "Otra" }), "no soy una alerta", alerta({ id: "ok123456", nombre: "Redes", palabras: "redes", codigos: "" })],
    });
    assert.deepEqual(config.alertas.map((a) => a.id), ["abc12345", "ok123456"]);
    assert.equal(problemas, 3, "una con palabra inválida, una con identificador repetido y una que no es objeto");
  });

  await t.test("limita a 50 alertas y a 200 procesos seguidos", () => {
    const alertas = Array.from({ length: 60 }, (_, i) => alerta({ id: `id${String(i).padStart(6, "0")}`, nombre: `A${i}` }));
    const procesos = Array.from({ length: 250 }, (_, i) => ({ id: `CO1.REQ.${1000 + i}` }));
    const { config, problemas } = Config.normalizarConfig({ alertas, seguimiento: { procesos } });
    assert.equal(config.alertas.length, 50);
    assert.equal(config.seguimiento.procesos.length, 200);
    assert.equal(problemas, 10 + 50);
  });

  await t.test("el resumen y el seguimiento se leen con valores por defecto y validados", () => {
    const { config } = Config.normalizarConfig({
      resumen: { activo: true, departamento: " Antioquia ", min: "50000000", top: "10" },
      seguimiento: { procesos: [{ id: "CO1.REQ.1", nombre: "  Proceso  uno ", entidad: "Alcaldía", cierre: "2026-10-20" }, { id: "x" }, { id: "CO1.REQ.1" }, { id: "CO1.REQ.2", cierre: "ayer" }] },
    });
    assert.deepEqual(config.resumen, { activo: true, departamento: "Antioquia", min: "50000000", top: 10 });
    assert.equal(config.seguimiento.avisar, true);
    assert.deepEqual(config.seguimiento.procesos, [
      { id: "CO1.REQ.1", nombre: "Proceso uno", entidad: "Alcaldía", cierre: "2026-10-20" },
      { id: "CO1.REQ.2", nombre: "", entidad: "", cierre: null },
    ]);
    assert.equal(Config.normalizarConfig({ seguimiento: { avisar: false } }).config.seguimiento.avisar, false);
  });

  await t.test("un resumen inválido se descarta y queda apagado", () => {
    for (const resumen of [{ activo: true, top: 99 }, { activo: true, min: "x" }, { activo: true, departamento: "a'b" }]) {
      const { config, problemas } = Config.normalizarConfig({ resumen });
      assert.equal(config.resumen.activo, false);
      assert.equal(problemas, 1);
    }
  });
});

test("aBusquedas", async (t) => {
  await t.test("convierte las alertas activas al formato del motor, con clave estable por identificador", () => {
    const { config } = Config.normalizarConfig({
      alertas: [alerta(), alerta({ id: "pausa123", nombre: "Pausada", activa: false }), alerta({ id: "otra1234", nombre: "Directa", competitivos: "0", minimo: 0 })],
    });
    const busquedas = Config.aBusquedas(config);
    assert.match(busquedas[0].clave, /^a:abc12345:[a-z0-9]+$/);
    assert.match(busquedas[1].clave, /^a:otra1234:[a-z0-9]+$/);
    assert.deepEqual(busquedas[0].params, { palabras: "mantenimiento, software", codigos: "8011", departamento: "", min: "", max: "", dias: "15", competitivos: "1", abiertos: "1" });
    assert.equal(busquedas[0].minimo, 40);
    assert.equal(busquedas[1].params.competitivos, "0");
    assert.equal(busquedas[1].minimo, 0);
  });

  await t.test("la clave cambia si se editan los filtros, pero no si solo cambian el nombre, la coincidencia mínima o la pausa", () => {
    const clave = (extra) => Config.aBusquedas(Config.normalizarConfig({ alertas: [alerta(extra)] }).config)[0].clave;
    const base = clave({});
    assert.equal(clave({ nombre: "Otro nombre" }), base);
    assert.equal(clave({ minimo: 10 }), base);
    for (const cambio of [{ palabras: "redes" }, { codigos: "8012" }, { departamento: "Antioquia" }, { min: "5" }, { max: "9" }, { competitivos: "0" }]) {
      assert.notEqual(clave(cambio), base, `debe cambiar con ${JSON.stringify(cambio)}`);
    }
    assert.equal(clave({}), base, "es determinista");
  });

  await t.test("el resumen activo se agrega como búsqueda de resumen", () => {
    const { config } = Config.normalizarConfig({ resumen: { activo: true, departamento: "Antioquia", min: "100000000", top: 12 } });
    const [r] = Config.aBusquedas(config);
    assert.deepEqual([r.clave, r.nombre, r.resumen, r.top, r.minimo], ["resumen", "Resumen nacional", true, 12, 0]);
    assert.deepEqual(r.params, { palabras: "", codigos: "", departamento: "Antioquia", min: "100000000", max: "", dias: "3", competitivos: "1", abiertos: "1" });
    assert.deepEqual(Config.aBusquedas(Config.configVacia()), []);
  });
});

test("procesosSeguidos", async (t) => {
  await t.test("deja fuera perdidos y descartados, repetidos y sin identificador válido", () => {
    const lista = [
      { id: "CO1.REQ.1", nombre: "Uno", entidad: "A", cierre: "2026-10-20", estado: "Preparando oferta" },
      { id: "CO1.REQ.2", estado: "Perdida" },
      { id: "CO1.REQ.3", estado: "Descartada" },
      { id: "CO1.REQ.1", estado: "Por revisar" },
      { id: "no válido!", estado: "Por revisar" },
      { id: "CO1.REQ.4", estado: "Ganada" },
    ];
    assert.deepEqual(Config.procesosSeguidos(lista).map((p) => p.id), ["CO1.REQ.1", "CO1.REQ.4"]);
    assert.deepEqual(Config.procesosSeguidos(null), []);
  });
});

test("serializar y desdeTexto", async (t) => {
  await t.test("ida y vuelta conserva la configuración", () => {
    const { config } = Config.normalizarConfig({ alertas: [alerta()], resumen: { activo: true, top: 5 }, seguimiento: { avisar: false, procesos: [{ id: "CO1.REQ.9", nombre: "Nueve" }] } });
    const { config: vuelta, problemas } = Config.desdeTexto(Config.serializar(config));
    assert.deepEqual(vuelta, config);
    assert.equal(problemas, 0);
  });

  await t.test("un texto dañado, no JSON o enorme da una configuración vacía contando el problema", () => {
    for (const texto of ["{no es json", "[]", null, "x".repeat(400_001)]) {
      const { config, problemas } = Config.desdeTexto(texto);
      assert.deepEqual(config, Config.configVacia());
      assert.equal(problemas, 1);
    }
  });

  await t.test("serializar rechaza una configuración demasiado grande", () => {
    const grande = Config.configVacia();
    grande.seguimiento.procesos = Array.from({ length: 5 }, () => ({ id: "CO1.REQ.1", nombre: "N".repeat(100_000) }));
    assert.throws(() => Config.serializar(grande), Config.ErrorDeConfiguracion);
  });
});

test("descripcionAlerta y nuevoId", async (t) => {
  await t.test("describe filtros y presupuesto en español", () => {
    const a = Config.validarAlerta(alerta({ departamento: "Antioquia", min: "1000000", max: "9000000", competitivos: "0" }));
    const texto = Config.descripcionAlerta(a);
    assert.match(texto, /Palabras: mantenimiento, software · Códigos: 8011 · Departamento: Antioquia/);
    assert.match(texto, /Presupuesto: \$ 1\.000\.000 a \$ 9\.000\.000/);
    assert.match(texto, /Incluye contratación directa/);
    assert.match(Config.descripcionAlerta({ ...a, max: "", competitivos: "1" }), /Presupuesto desde \$ 1\.000\.000$/);
  });

  await t.test("nuevoId genera identificadores válidos y distintos", () => {
    const ids = new Set(Array.from({ length: 200 }, () => Config.nuevoId()));
    assert.equal(ids.size, 200);
    for (const id of ids) assert.doesNotThrow(() => Config.validarAlerta(alerta({ id })));
  });
});
