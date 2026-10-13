/* Radar SECOP II: configuración de las alertas (qué vigilar), compartida por la página y el motor de alertas.
 *
 * La página la edita y la guarda en un gist secreto de GitHub; el flujo programado la lee desde allí. Como es una
 * entrada que no controla el motor, todo se valida con las mismas reglas que las búsquedas de la página y lo inválido
 * se descarta (contando cuánto) en vez de detener las alertas de las demás.
 *
 * Funciona en el navegador (define `ConfigAlertas` global; necesita `Secop` cargado antes) y en Node.
 */
(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) module.exports = fabrica(require("./secop.js"));
  else raiz.ConfigAlertas = fabrica(raiz.Secop);
})(typeof self !== "undefined" ? self : this, function (Secop) {
  "use strict";

  const VERSION = 1;
  const ARCHIVO = "radar-alertas.json";
  const MAX_ALERTAS = 50;
  const MAX_SEGUIDOS = 200;
  const MAX_CARACTERES = 400_000;
  const DIAS_ALERTA = "15";
  const DIAS_RESUMEN = "3";
  const MINIMO_POR_DEFECTO = 40;
  const TOP_POR_DEFECTO = 15;
  const TOP_MAXIMO = 30;
  const NOMBRE_RESUMEN = "Resumen nacional";
  const ESTADOS_NO_VIGILADOS = ["Perdida", "Descartada"];
  const PATRON_ID = /^[a-z0-9]{4,20}$/;
  const PATRON_PROCESO = /^[A-Za-z0-9._-]{3,40}$/;
  const PATRON_FECHA = /^\d{4}-\d{2}-\d{2}$/;

  class ErrorDeConfiguracion extends Error {
    constructor(mensaje) {
      super(mensaje);
      this.name = "ErrorDeConfiguracion";
    }
  }

  const texto = (valor, largo) => String(valor ?? "").trim().replace(/\s+/g, " ").slice(0, largo);

  function configVacia() {
    return {
      version: VERSION,
      alertas: [],
      resumen: { activo: false, departamento: "", min: "", top: TOP_POR_DEFECTO },
      seguimiento: { avisar: true, procesos: [] },
    };
  }

  /** Identificador corto para una alerta nueva (solo distingue alertas entre sí; no es un secreto). */
  function nuevoId() {
    let id = "";
    while (id.length < 10) id += Math.random().toString(36).slice(2);
    return id.slice(0, 10);
  }

  /** Reglas de la página para los filtros; convierte el error de validación en uno de configuración. */
  function validarFiltros(params, opciones) {
    try {
      return Secop.parsearPerfil(params, opciones);
    } catch (error) {
      if (error instanceof Secop.ErrorDeValidacion) throw new ErrorDeConfiguracion(error.message);
      throw error;
    }
  }

  /** Valida una alerta por tema y la devuelve limpia. Lanza ErrorDeConfiguracion con un mensaje para mostrar. */
  function validarAlerta(valores) {
    const v = valores ?? {};
    const id = typeof v.id === "string" ? v.id : "";
    if (!PATRON_ID.test(id)) throw new ErrorDeConfiguracion("La alerta no tiene un identificador válido.");
    const nombre = texto(v.nombre, 80);
    if (!nombre) throw new ErrorDeConfiguracion("Ponle un nombre a la alerta.");
    if (nombre.length > 60) throw new ErrorDeConfiguracion("El nombre puede tener hasta 60 caracteres.");

    const alerta = {
      id,
      nombre,
      palabras: texto(v.palabras, 300),
      codigos: texto(v.codigos, 100),
      departamento: texto(v.departamento, 60),
      min: texto(v.min, 18),
      max: texto(v.max, 18),
      competitivos: v.competitivos === "0" || v.competitivos === false ? "0" : "1",
      minimo: v.minimo === undefined || v.minimo === "" ? MINIMO_POR_DEFECTO : Number(v.minimo),
      activa: v.activa !== false,
    };
    if (!alerta.palabras && !alerta.codigos) {
      throw new ErrorDeConfiguracion("Indica al menos una palabra clave o un código UNSPSC.");
    }
    if (!Number.isInteger(alerta.minimo) || alerta.minimo < 0 || alerta.minimo > 100) {
      throw new ErrorDeConfiguracion("La coincidencia mínima debe ser un número entero entre 0 y 100.");
    }
    validarFiltros(parametrosDeAlerta(alerta));
    return alerta;
  }

  const parametrosDeAlerta = (a) => ({
    palabras: a.palabras, codigos: a.codigos, departamento: a.departamento, min: a.min, max: a.max,
    dias: DIAS_ALERTA, competitivos: a.competitivos, abiertos: "1",
  });

  function validarResumen(r) {
    const v = r && typeof r === "object" ? r : {};
    const top = v.top === undefined || v.top === "" ? TOP_POR_DEFECTO : Number(v.top);
    if (!Number.isInteger(top) || top < 1 || top > TOP_MAXIMO) {
      throw new ErrorDeConfiguracion(`La cantidad de procesos del resumen debe estar entre 1 y ${TOP_MAXIMO}.`);
    }
    const resumen = { activo: v.activo === true, departamento: texto(v.departamento, 60), min: texto(v.min, 18), top };
    validarFiltros({ departamento: resumen.departamento, min: resumen.min, dias: DIAS_RESUMEN }, { amplio: true });
    return resumen;
  }

  function validarProcesoSeguido(p) {
    const id = typeof p?.id === "string" ? p.id : "";
    if (!PATRON_PROCESO.test(id)) return null;
    return {
      id,
      nombre: texto(p.nombre, 200),
      entidad: texto(p.entidad, 120),
      cierre: typeof p.cierre === "string" && PATRON_FECHA.test(p.cierre) ? p.cierre : null,
    };
  }

  /**
   * Lee una configuración de origen desconocido. Nunca lanza: devuelve la parte válida y cuántas entradas descartó.
   * `problemas` es solo un conteo (los registros del flujo son públicos y no deben repetir lo escrito por la persona).
   */
  function normalizarConfig(datos) {
    const config = configVacia();
    if (!datos || typeof datos !== "object" || Array.isArray(datos)) return { config, problemas: 1 };
    let problemas = 0;

    const alertas = Array.isArray(datos.alertas) ? datos.alertas : [];
    const ids = new Set();
    for (const entrada of alertas.slice(0, MAX_ALERTAS)) {
      try {
        const alerta = validarAlerta(entrada);
        if (ids.has(alerta.id)) throw new ErrorDeConfiguracion("repetida");
        ids.add(alerta.id);
        config.alertas.push(alerta);
      } catch {
        problemas += 1;
      }
    }
    problemas += Math.max(0, alertas.length - MAX_ALERTAS);

    if (datos.resumen !== undefined) {
      try {
        config.resumen = validarResumen(datos.resumen);
      } catch {
        problemas += 1;
      }
    }

    if (datos.seguimiento && typeof datos.seguimiento === "object") {
      config.seguimiento.avisar = datos.seguimiento.avisar !== false;
      const procesos = Array.isArray(datos.seguimiento.procesos) ? datos.seguimiento.procesos : [];
      const vistos = new Set();
      for (const entrada of procesos.slice(0, MAX_SEGUIDOS)) {
        const proceso = validarProcesoSeguido(entrada);
        if (!proceso || vistos.has(proceso.id)) {
          problemas += 1;
          continue;
        }
        vistos.add(proceso.id);
        config.seguimiento.procesos.push(proceso);
      }
      problemas += Math.max(0, procesos.length - MAX_SEGUIDOS);
    }
    return { config, problemas };
  }

  /** Huella corta de los filtros de una alerta: si cambian, la alerta se trata como nueva (ver `clave` en aBusquedas). */
  function huella(a) {
    const texto = JSON.stringify([a.palabras, a.codigos, a.departamento, a.min, a.max, a.competitivos]);
    let h = 5381;
    for (let i = 0; i < texto.length; i += 1) h = ((h * 33) ^ texto.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }

  /**
   * Búsquedas que ejecuta el motor: las alertas activas y, si está activo, el resumen diario de todo el país.
   * La `clave` identifica a la alerta en lo ya avisado: sobrevive a un cambio de nombre o de coincidencia mínima, pero
   * cambia si se editan los filtros, para que la alerta editada empiece en silencio en vez de soltar de golpe todo lo
   * que ya está abierto.
   */
  function aBusquedas(config) {
    const busquedas = config.alertas
      .filter((a) => a.activa)
      .map((a) => ({ clave: `a:${a.id}:${huella(a)}`, nombre: a.nombre, params: parametrosDeAlerta(a), minimo: a.minimo }));
    if (config.resumen.activo) {
      const r = config.resumen;
      busquedas.push({
        clave: "resumen",
        nombre: NOMBRE_RESUMEN,
        params: { palabras: "", codigos: "", departamento: r.departamento, min: r.min, max: "", dias: DIAS_RESUMEN, competitivos: "1", abiertos: "1" },
        minimo: 0,
        resumen: true,
        top: r.top,
      });
    }
    return busquedas;
  }

  /** Procesos de "Mi seguimiento" que vale la pena vigilar (se dejan fuera los perdidos y descartados). */
  function procesosSeguidos(seguimiento) {
    const salida = [];
    const vistos = new Set();
    for (const s of Array.isArray(seguimiento) ? seguimiento : []) {
      if (ESTADOS_NO_VIGILADOS.includes(s?.estado)) continue;
      const proceso = validarProcesoSeguido(s);
      if (!proceso || vistos.has(proceso.id)) continue;
      vistos.add(proceso.id);
      salida.push(proceso);
    }
    return salida.slice(0, MAX_SEGUIDOS);
  }

  /** Texto de la configuración listo para guardar. Falla si es demasiado grande para un gist razonable. */
  function serializar(config) {
    const salida = JSON.stringify(config, null, 1);
    if (salida.length > MAX_CARACTERES) throw new ErrorDeConfiguracion("La configuración de alertas es demasiado grande.");
    return salida;
  }

  /** Lee el texto guardado; si no es JSON válido devuelve una configuración vacía contando el problema. */
  function desdeTexto(contenido) {
    if (typeof contenido !== "string" || contenido.length > MAX_CARACTERES) return { config: configVacia(), problemas: 1 };
    try {
      return normalizarConfig(JSON.parse(contenido));
    } catch {
      return { config: configVacia(), problemas: 1 };
    }
  }

  const formatoPesos = new Intl.NumberFormat("es-CO");

  /** Descripción corta de una alerta para mostrarla en la lista. */
  function descripcionAlerta(a) {
    const partes = [];
    if (a.palabras) partes.push(`Palabras: ${a.palabras}`);
    if (a.codigos) partes.push(`Códigos: ${a.codigos}`);
    if (a.departamento) partes.push(`Departamento: ${a.departamento}`);
    if (a.min && a.max) partes.push(`Presupuesto: $ ${formatoPesos.format(a.min)} a $ ${formatoPesos.format(a.max)}`);
    else if (a.min) partes.push(`Presupuesto desde $ ${formatoPesos.format(a.min)}`);
    else if (a.max) partes.push(`Presupuesto hasta $ ${formatoPesos.format(a.max)}`);
    if (a.competitivos === "0") partes.push("Incluye contratación directa");
    return partes.join(" · ");
  }

  return {
    VERSION, ARCHIVO, MAX_ALERTAS, MAX_SEGUIDOS, TOP_MAXIMO, MINIMO_POR_DEFECTO, TOP_POR_DEFECTO, NOMBRE_RESUMEN,
    ErrorDeConfiguracion, configVacia, nuevoId, validarAlerta, validarResumen, normalizarConfig, aBusquedas,
    procesosSeguidos, serializar, desdeTexto, descripcionAlerta,
  };
});
