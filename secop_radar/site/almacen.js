/* Radar SECOP II: almacén de expedientes en el navegador (IndexedDB) y respaldo en un archivo.
 *
 * Funciona en el navegador (define `Almacen` global) y en Node (module.exports), donde las pruebas usan el motor en
 * memoria. Los expedientes viven solo en el navegador de cada persona: no se suben a ningún servidor. Por eso el
 * respaldo importa: si se borran los datos del navegador, se pierde lo que no se haya exportado.
 */
(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) module.exports = fabrica(require("./expediente.js"));
  else raiz.Almacen = fabrica(raiz.Expediente);
})(typeof self !== "undefined" ? self : this, function (Expediente) {
  "use strict";

  const TIPO_RESPALDO = "radar-secop-respaldo";
  const VERSION_RESPALDO = 1;
  const NOMBRE_BD = "radar-secop";
  const TABLA = "expedientes";

  class ErrorDeAlmacen extends Error {
    constructor(mensaje) {
      super(mensaje);
      this.name = "ErrorDeAlmacen";
    }
  }

  // --- Motores ------------------------------------------------------------------

  /** Guarda en memoria: para las pruebas y como respaldo cuando el navegador no deja usar IndexedDB. */
  function motorMemoria() {
    const datos = new Map();
    const copia = (valor) => (valor === undefined ? undefined : JSON.parse(JSON.stringify(valor)));
    return {
      persistente: false,
      leer: async (id) => copia(datos.get(id)),
      guardar: async (registro) => { datos.set(registro.id, copia(registro)); },
      borrar: async (id) => { datos.delete(id); },
      todos: async () => [...datos.values()].map(copia),
    };
  }

  const pedir = (solicitud) => new Promise((resolver, rechazar) => {
    solicitud.onsuccess = () => resolver(solicitud.result);
    solicitud.onerror = () => rechazar(solicitud.error);
  });

  /** Abre (o crea) la base de datos del navegador. Rechaza si IndexedDB no está disponible. */
  async function motorIndexedDB(fabricaIDB) {
    if (!fabricaIDB) throw new ErrorDeAlmacen("Este navegador no permite guardar datos.");
    const apertura = fabricaIDB.open(NOMBRE_BD, 1);
    apertura.onupgradeneeded = () => apertura.result.createObjectStore(TABLA, { keyPath: "id" });
    const bd = await pedir(apertura);
    const tabla = (modo) => bd.transaction(TABLA, modo).objectStore(TABLA);
    return {
      persistente: true,
      leer: (id) => pedir(tabla("readonly").get(id)),
      guardar: (registro) => pedir(tabla("readwrite").put(registro)).then(() => undefined),
      borrar: (id) => pedir(tabla("readwrite").delete(id)).then(() => undefined),
      todos: () => pedir(tabla("readonly").getAll()),
    };
  }

  // --- Almacén ------------------------------------------------------------------

  function crearAlmacen({ motor = motorMemoria(), ahora = () => new Date() } = {}) {
    async function leer(id) {
      return Expediente.normalizar(await motor.leer(String(id)));
    }

    /** Guarda el expediente normalizado, con la fecha de la última modificación, y lo devuelve. */
    async function guardar(expediente) {
      const limpio = Expediente.normalizar({ ...expediente, actualizado: ahora().toISOString() });
      if (!limpio) throw new ErrorDeAlmacen("El expediente no tiene identificador de proceso.");
      await motor.guardar(limpio);
      return limpio;
    }

    const borrar = (id) => motor.borrar(String(id));

    async function todos() {
      return (await motor.todos()).map(Expediente.normalizar).filter(Boolean);
    }

    /** Arma el respaldo: los expedientes más los datos adicionales que entregue la página (empresa, seguimiento). */
    async function exportar(adicionales = {}) {
      return {
        ...adicionales,
        tipo: TIPO_RESPALDO,
        version: VERSION_RESPALDO,
        fecha: ahora().toISOString(),
        expedientes: await todos(),
      };
    }

    /**
     * Restaura los expedientes de un respaldo. Los que ya existen se reemplazan solo si el del respaldo es más
     * reciente. Devuelve cuántos se guardaron y cuántos se dejaron como estaban.
     */
    async function importar(respaldo) {
      const expedientes = leerRespaldo(respaldo).expedientes;
      let guardados = 0;
      let conservados = 0;
      for (const crudo of expedientes) {
        const nuevo = Expediente.normalizar(crudo);
        if (!nuevo) continue;
        const actual = await leer(nuevo.id);
        if (actual && actual.actualizado >= nuevo.actualizado) {
          conservados++;
        } else {
          await motor.guardar(nuevo);
          guardados++;
        }
      }
      return { guardados, conservados };
    }

    return { persistente: motor.persistente === true, leer, guardar, borrar, todos, exportar, importar };
  }

  /** Comprueba que un objeto (ya leído de un archivo JSON) sea un respaldo de esta app. */
  function leerRespaldo(respaldo) {
    if (!respaldo || typeof respaldo !== "object" || respaldo.tipo !== TIPO_RESPALDO) {
      throw new ErrorDeAlmacen("El archivo no es un respaldo de Radar SECOP II.");
    }
    if (!(respaldo.version <= VERSION_RESPALDO)) {
      throw new ErrorDeAlmacen("El respaldo se hizo con una versión más nueva de la app. Actualiza la página e inténtalo de nuevo.");
    }
    if (!Array.isArray(respaldo.expedientes)) {
      throw new ErrorDeAlmacen("El respaldo está dañado: no trae la lista de expedientes.");
    }
    return respaldo;
  }

  return { TIPO_RESPALDO, VERSION_RESPALDO, ErrorDeAlmacen, motorMemoria, motorIndexedDB, crearAlmacen, leerRespaldo };
});
