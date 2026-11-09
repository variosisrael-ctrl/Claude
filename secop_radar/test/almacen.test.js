"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Almacen = require("../site/almacen.js");

const reloj = (...fechas) => {
  const cola = fechas.map((f) => new Date(f));
  return () => (cola.length > 1 ? cola.shift() : cola[0]);
};

test("guarda expedientes normalizados con su fecha de modificación", async () => {
  const almacen = Almacen.crearAlmacen({ ahora: reloj("2026-11-09T15:00:00Z") });
  assert.equal(almacen.persistente, false, "el motor en memoria no es persistente");
  assert.equal(await almacen.leer("CO1.REQ.1"), null);

  const guardado = await almacen.guardar({ id: "CO1.REQ.1", requisitos: [{ descripcion: "RUP vigente" }], sobra: 1 });
  assert.equal(guardado.actualizado, "2026-11-09T15:00:00.000Z");
  assert.equal(guardado.sobra, undefined);

  const leido = await almacen.leer("CO1.REQ.1");
  assert.equal(leido.requisitos[0].descripcion, "RUP vigente");
  assert.equal((await almacen.todos()).length, 1);

  await almacen.borrar("CO1.REQ.1");
  assert.equal(await almacen.leer("CO1.REQ.1"), null);
  await assert.rejects(almacen.guardar({ requisitos: [] }), /identificador/);
});

test("exportar e importar", async (t) => {
  const origen = Almacen.crearAlmacen({ ahora: reloj("2026-11-09T15:00:00Z") });
  await origen.guardar({ id: "A", requisitos: [{ descripcion: "Liquidez" }] });
  await origen.guardar({ id: "B", decision: { decision: "ofertar", responsable: "Ana" } });
  const respaldo = JSON.parse(JSON.stringify(await origen.exportar({ empresa: { nombre: "Mi empresa" }, tipo: "otro" })));

  await t.test("el respaldo lleva los expedientes y los datos adicionales", () => {
    assert.equal(respaldo.tipo, Almacen.TIPO_RESPALDO, "los datos adicionales no pueden cambiar el tipo");
    assert.equal(respaldo.version, 1);
    assert.equal(respaldo.expedientes.length, 2);
    assert.equal(respaldo.empresa.nombre, "Mi empresa");
  });

  await t.test("restaura en un navegador vacío", async () => {
    const destino = Almacen.crearAlmacen();
    assert.deepEqual(await destino.importar(respaldo), { guardados: 2, conservados: 0 });
    assert.equal((await destino.leer("B")).decision.responsable, "Ana");
  });

  await t.test("no pisa un expediente que aquí es más reciente", async () => {
    const destino = Almacen.crearAlmacen({ ahora: reloj("2026-11-10T15:00:00Z") });
    await destino.guardar({ id: "A", requisitos: [{ descripcion: "Editado después" }] });
    assert.deepEqual(await destino.importar(respaldo), { guardados: 1, conservados: 1 });
    assert.equal((await destino.leer("A")).requisitos[0].descripcion, "Editado después");
  });

  await t.test("rechaza archivos que no son un respaldo", async () => {
    const destino = Almacen.crearAlmacen();
    await assert.rejects(destino.importar({ expedientes: [] }), /no es un respaldo/);
    await assert.rejects(destino.importar(null), /no es un respaldo/);
    await assert.rejects(destino.importar({ ...respaldo, version: 99 }), /versión más nueva/);
    await assert.rejects(destino.importar({ ...respaldo, expedientes: "x" }), /dañado/);
    assert.deepEqual(await destino.importar({ ...respaldo, expedientes: [{ sin: "id" }, null] }), { guardados: 0, conservados: 0 });
  });
});

test("motorIndexedDB rechaza cuando el navegador no tiene IndexedDB", async () => {
  await assert.rejects(Almacen.motorIndexedDB(null), /no permite guardar/);
});
