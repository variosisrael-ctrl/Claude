/* Radar SECOP II: consultas a datos abiertos, puntuación de oportunidades e inteligencia de mercado.
 *
 * Funciona en el navegador (define `Secop` global) y en Node (module.exports) sin dependencias.
 * datos.gov.co responde con `Access-Control-Allow-Origin: *`, así que el navegador lo consulta directo.
 */
(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) module.exports = fabrica();
  else raiz.Secop = fabrica();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Datasets abiertos de SECOP II publicados en datos.gov.co.
  const URL_PROCESOS = "https://www.datos.gov.co/resource/p6dx-8zbt.json";
  const URL_CONTRATOS = "https://www.datos.gov.co/resource/jbjy-vk9h.json";

  // Valores de contrato por encima de este monto (COP) son errores de digitación en la fuente,
  // por ejemplo 104249364104249364. Se excluyen del análisis de mercado.
  const VALOR_MAXIMO_PLAUSIBLE = 100_000_000_000_000;

  // Modalidades en las que la entidad ya eligió a quién contratar, o que no son compras a proveedores.
  // Las variantes "(con ofertas)" sí reciben ofertas y por eso no se excluyen.
  const MODALIDADES_NO_COMPETITIVAS = [
    "Contratación directa",
    "Contratación régimen especial",
    "Solicitud de información a los Proveedores",
    "Subasta de prueba",
    "Enajenación de bienes con subasta",
    "Enajenación de bienes con sobre cerrado",
  ];

  const FILAS_A_PUNTUAR = 1000;
  const MAXIMO_FILAS_MERCADO = 10;
  const MS_CACHE = 600_000;
  const MS_TIMEOUT = 30_000;
  const MS_TIMEOUT_MERCADO = 90_000; // las agregaciones de contratos son lentas en datos.gov.co
  const MS_POR_DIA = 86_400_000;

  const PATRON_CODIGO = /^\d{4,8}$/;
  const PATRON_TEXTO = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9 \-]{2,60}$/;

  class ErrorDeValidacion extends Error {
    constructor(mensaje) {
      super(mensaje);
      this.name = "ErrorDeValidacion";
    }
  }

  class ErrorDeOrigen extends Error {
    constructor(mensaje) {
      super(mensaje);
      this.name = "ErrorDeOrigen";
    }
  }

  // --- Validación de parámetros -----------------------------------------------

  /** Quita espacios sobrantes, pasa a mayúsculas y rechaza caracteres que alteren la consulta SoQL. */
  function textoValidado(texto) {
    const limpio = String(texto ?? "").split(/\s+/).filter(Boolean).join(" ").toUpperCase();
    if (limpio && !PATRON_TEXTO.test(limpio)) {
      throw new ErrorDeValidacion(`'${limpio}' no es válido. Usa entre 2 y 60 letras, números, espacios o guiones.`);
    }
    return limpio;
  }

  /** Acepta códigos completos (80111600), prefijos (8011) o con el prefijo V1. que usa SECOP. */
  function normalizarCodigos(texto) {
    const codigos = [];
    for (const parte of String(texto ?? "").split(/[,;\s]+/)) {
      if (!parte) continue;
      const digitos = parte.replace(/^V1\./i, "");
      if (!PATRON_CODIGO.test(digitos)) {
        throw new ErrorDeValidacion(`'${parte}' no es un código UNSPSC válido. Usa entre 4 y 8 dígitos.`);
      }
      codigos.push(digitos);
    }
    return codigos.slice(0, 10);
  }

  function normalizarPalabras(texto) {
    return String(texto ?? "").split(",").map(textoValidado).filter(Boolean).slice(0, 10);
  }

  function entero(valor, nombre, minimo, maximo, defecto = null) {
    if (valor === undefined || valor === null || valor === "") return defecto;
    if (!/^-?\d+$/.test(String(valor).trim())) {
      throw new ErrorDeValidacion(`${nombre} debe ser un número entero.`);
    }
    const numero = Number(valor);
    if (numero < minimo || numero > maximo) {
      throw new ErrorDeValidacion(`${nombre} debe estar entre ${minimo} y ${maximo}.`);
    }
    return numero;
  }

  /** Valida los filtros del usuario. Lanza ErrorDeValidacion si algo no sirve. */
  function parsearPerfil(params) {
    const perfil = {
      palabras: normalizarPalabras(params.palabras),
      codigos: normalizarCodigos(params.codigos),
      departamento: textoValidado(params.departamento),
      min: entero(params.min, "El presupuesto mínimo", 0, 1e15),
      max: entero(params.max, "El presupuesto máximo", 0, 1e15),
      dias: entero(params.dias, "Los días", 1, 365, 30),
      competitivos: params.competitivos !== "0",
      abiertos: params.abiertos !== "0",
    };
    if (!perfil.palabras.length && !perfil.codigos.length) {
      throw new ErrorDeValidacion("Indica al menos una palabra clave o un código UNSPSC.");
    }
    if (perfil.min !== null && perfil.max !== null && perfil.min > perfil.max) {
      throw new ErrorDeValidacion("El presupuesto mínimo no puede ser mayor que el máximo.");
    }
    return perfil;
  }

  // --- Construcción de consultas SoQL -----------------------------------------

  /** Escribe un texto como literal SoQL entre comillas simples. */
  const literal = (texto) => "'" + texto.replace(/'/g, "''") + "'";

  const condicionCodigos = (codigos, columna) =>
    codigos.map((codigo) => `${columna} like ${literal("V1." + codigo + "%")}`).join(" OR ");

  const condicionCompetitiva = () =>
    `modalidad_de_contratacion not in (${MODALIDADES_NO_COMPETITIVAS.map(literal).join(",")})`;

  // Todas las fechas "de hoy" se calculan en hora de Colombia, sin importar dónde corra el código
  // (las alertas corren en servidores en UTC, donde la fecha local puede estar un día adelantada).
  const formatoFechaBogota = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const fechaIso = (fecha) => formatoFechaBogota.format(fecha);

  /** Días de calendario desde `hoy` hasta la fecha ISO (AAAA-MM-DD). 0 es hoy; negativo, ya pasó. */
  function diasHasta(iso, hoy) {
    if (!iso) return null;
    const [anio, mes, dia] = iso.split("-").map(Number);
    const [anioHoy, mesHoy, diaHoy] = fechaIso(hoy).split("-").map(Number);
    return Math.round((Date.UTC(anio, mes - 1, dia) - Date.UTC(anioHoy, mesHoy - 1, diaHoy)) / MS_POR_DIA);
  }

  function clausulaOportunidades(perfil, desde, hoy = new Date()) {
    const condiciones = [
      "estado_de_apertura_del_proceso = 'Abierto'",
      // 'Abierto' no se actualiza en procesos viejos, por eso también filtramos por fecha de publicación.
      `fecha_de_publicacion_del >= ${literal(fechaIso(desde) + "T00:00:00")}`,
    ];
    if (perfil.abiertos) {
      // Solo procesos que todavía reciben ofertas: plazo de recepción vigente y sin adjudicar.
      condiciones.push(`fecha_de_recepcion_de >= ${literal(fechaIso(hoy) + "T00:00:00")}`);
      condiciones.push("adjudicado = 'No'");
    }
    const alcance = [];
    if (perfil.codigos.length) alcance.push(condicionCodigos(perfil.codigos, "codigo_principal_de_categoria"));
    for (const palabra of perfil.palabras) {
      const patron = literal(`%${palabra}%`);
      alcance.push(
        `upper(nombre_del_procedimiento) like ${patron} OR upper(descripci_n_del_procedimiento) like ${patron}`
      );
    }
    condiciones.push("(" + alcance.map((parte) => `(${parte})`).join(" OR ") + ")");

    if (perfil.competitivos) condiciones.push(condicionCompetitiva());
    if (perfil.min !== null) condiciones.push(`precio_base >= ${perfil.min}`);
    if (perfil.max !== null) condiciones.push(`precio_base <= ${perfil.max}`);
    if (perfil.departamento) {
      condiciones.push(`upper(departamento_entidad) like ${literal("%" + perfil.departamento + "%")}`);
    }
    return condiciones.join(" AND ");
  }

  function clausulaMercado(perfil, desdeAnio, soloCompetitivas) {
    const condiciones = [
      `valor_del_contrato < ${VALOR_MAXIMO_PLAUSIBLE}`,
      `fecha_de_firma >= ${literal(desdeAnio + "-01-01T00:00:00")}`,
    ];
    if (soloCompetitivas) condiciones.push(condicionCompetitiva());
    const alcance = [];
    if (perfil.codigos.length) alcance.push(condicionCodigos(perfil.codigos, "codigo_de_categoria_principal"));
    for (const palabra of perfil.palabras) {
      alcance.push(`upper(descripcion_del_proceso) like ${literal("%" + palabra + "%")}`);
    }
    condiciones.push("(" + alcance.map((parte) => `(${parte})`).join(" OR ") + ")");
    return condiciones.join(" AND ");
  }

  // --- Normalización ----------------------------------------------------------

  function numero(valor) {
    if (valor === undefined || valor === null || valor === "") return null;
    const n = Number(valor);
    return Number.isFinite(n) ? n : null;
  }

  const conteo = (valor) => Math.trunc(numero(valor) || 0);

  const soloDia = (valor) => (valor || "").slice(0, 10) || null;

  // La fuente escribe "No Definido" / "No Adjudicado" donde no hay dato.
  const dato = (valor) => (valor && !/^no (definido|adjudicado)$/i.test(valor) ? valor : null);

  // La fuente entrega 'urlproceso' como objeto {"url": ...}. Solo aceptamos enlaces https.
  function urlProceso(valor) {
    const url = valor && typeof valor === "object" ? valor.url : valor;
    return typeof url === "string" && url.startsWith("https://") ? url : null;
  }

  function normalizarProceso(fila) {
    return {
      id: fila.id_del_proceso ?? null,
      referencia: fila.referencia_del_proceso ?? null,
      nombre: fila.nombre_del_procedimiento || "",
      descripcion: fila.descripci_n_del_procedimiento || "",
      entidad: fila.entidad ?? null,
      nit_entidad: fila.nit_entidad ?? null,
      ciudad: fila.ciudad_entidad ?? null,
      departamento: fila.departamento_entidad ?? null,
      publicado: soloDia(fila.fecha_de_publicacion_del),
      cierre: soloDia(fila.fecha_de_recepcion_de),
      presupuesto: numero(fila.precio_base),
      modalidad: fila.modalidad_de_contratacion ?? null,
      categoria: fila.codigo_principal_de_categoria ?? null,
      estado: fila.estado_resumen ?? null,
      portafolio: fila.id_del_portafolio ?? null,
      adjudicado: fila.adjudicado === "Si",
      fecha_adjudicacion: soloDia(fila.fecha_adjudicacion),
      valor_adjudicado: numero(fila.valor_total_adjudicacion),
      ganador: dato(fila.nombre_del_proveedor),
      nit_ganador: dato(fila.nit_del_proveedor_adjudicado),
      url: urlProceso(fila.urlproceso),
    };
  }

  // --- Puntuación -------------------------------------------------------------

  /** Devuelve [puntaje de 0 a 100, razones legibles que lo explican]. */
  function puntuar(oportunidad, perfil) {
    let puntos = 0;
    const razones = [];
    const nombre = oportunidad.nombre.toUpperCase();
    const descripcion = oportunidad.descripcion.toUpperCase();
    const categoria = oportunidad.categoria || "";

    if (perfil.codigos.some((codigo) => categoria.startsWith("V1." + codigo))) {
      puntos += 40;
      razones.push(`Categoría ${categoria} coincide con tus códigos UNSPSC`);
    }

    const enNombre = perfil.palabras.filter((palabra) => nombre.includes(palabra));
    const enDescripcion = perfil.palabras.filter(
      (palabra) => !enNombre.includes(palabra) && descripcion.includes(palabra)
    );
    if (enNombre.length) {
      puntos += Math.min(40, 20 * enNombre.length);
      razones.push("El nombre menciona: " + enNombre.join(", ").toLowerCase());
    }
    if (enDescripcion.length) {
      puntos += Math.min(20, 10 * enDescripcion.length);
      razones.push("La descripción menciona: " + enDescripcion.join(", ").toLowerCase());
    }

    const presupuesto = oportunidad.presupuesto;
    const tieneRango = perfil.min !== null || perfil.max !== null;
    if (tieneRango && presupuesto !== null) {
      const dentro =
        (perfil.min === null || presupuesto >= perfil.min) && (perfil.max === null || presupuesto <= perfil.max);
      if (dentro) {
        puntos += 20;
        razones.push("El presupuesto está dentro de tu rango");
      }
    }

    return [Math.min(puntos, 100), razones];
  }

  // --- Cliente de datos.gov.co ------------------------------------------------

  /**
   * Crea un cliente con su propia caché. `fetchFn` y `ahora` se pueden reemplazar en las pruebas.
   */
  function crearCliente({ fetchFn = (...args) => globalThis.fetch(...args), ahora = () => Date.now() } = {}) {
    const cache = new Map();

    async function consultar(url, parametros, msTimeout = MS_TIMEOUT) {
      const direccion = `${url}?${new URLSearchParams(parametros)}`;
      const guardado = cache.get(direccion);
      if (guardado && ahora() - guardado.momento < MS_CACHE) return guardado.datos;

      const controlador = new AbortController();
      const temporizador = setTimeout(() => controlador.abort(), msTimeout);
      let datos;
      try {
        // Sin cabeceras personalizadas: así el navegador no necesita una petición previa (preflight).
        const respuesta = await fetchFn(direccion, { signal: controlador.signal });
        if (!respuesta.ok) {
          throw new ErrorDeOrigen(
            `datos.gov.co respondió con error ${respuesta.status}. Inténtalo de nuevo más tarde.`
          );
        }
        datos = await respuesta.json();
      } catch (error) {
        if (error instanceof ErrorDeOrigen) throw error;
        throw new ErrorDeOrigen(
          "No fue posible consultar datos.gov.co. Verifica tu conexión e inténtalo de nuevo."
        );
      } finally {
        clearTimeout(temporizador);
      }

      cache.set(direccion, { momento: ahora(), datos });
      return datos;
    }

    async function buscarOportunidades(params) {
      const perfil = parsearPerfil(params);
      const hoy = new Date(ahora());
      const desde = new Date(hoy.getTime() - perfil.dias * MS_POR_DIA);
      const filas = await consultar(URL_PROCESOS, {
        $where: clausulaOportunidades(perfil, desde, hoy),
        // Si hay más filas que el tope, que queden las que cierran primero (las más urgentes).
        $order: perfil.abiertos ? "fecha_de_recepcion_de ASC" : "fecha_de_publicacion_del DESC",
        $limit: FILAS_A_PUNTUAR,
      });

      const vistos = new Set();
      const resultados = [];
      for (const fila of filas) {
        const oportunidad = normalizarProceso(fila);
        if (!oportunidad.id || vistos.has(oportunidad.id)) continue;
        vistos.add(oportunidad.id);
        [oportunidad.puntaje, oportunidad.razones] = puntuar(oportunidad, perfil);
        resultados.push(oportunidad);
      }

      resultados.sort(
        (a, b) => b.puntaje - a.puntaje || (b.publicado || "").localeCompare(a.publicado || "")
      );
      return {
        filas_revisadas: filas.length,
        limite_alcanzado: filas.length >= FILAS_A_PUNTUAR,
        desde: fechaIso(desde),
        resultados,
      };
    }

    /** Quién compra y quién gana contratos en las mismas categorías o palabras clave. */
    async function inteligenciaMercado(params) {
      const perfil = parsearPerfil(params);
      const anioActual = Number(fechaIso(new Date(ahora())).slice(0, 4));
      const desdeAnio = entero(params.desde, "El año inicial", 2015, anioActual, anioActual - 3);
      const base = { $order: "contratos DESC", $limit: MAXIMO_FILAS_MERCADO };
      const dondeCompetitivo = clausulaMercado(perfil, desdeAnio, perfil.competitivos);
      // La mezcla de modalidades siempre se muestra completa para ver cuánto del mercado no es disputable.
      const dondeCompleto = clausulaMercado(perfil, desdeAnio, false);

      // Estas agregaciones recorren millones de contratos y tardan: en paralelo el tiempo es el de la más lenta.
      const [entidades, proveedores, modalidades] = await Promise.all([
        consultar(
          URL_CONTRATOS,
          {
            ...base,
            $where: dondeCompetitivo,
            $select: "nombre_entidad,count(*) as contratos,sum(valor_del_contrato) as valor",
            $group: "nombre_entidad",
          },
          MS_TIMEOUT_MERCADO
        ),
        consultar(
          URL_CONTRATOS,
          {
            ...base,
            // Los contratos sin documento ('No Definido') agrupan proveedores distintos: no son un competidor real.
            $where: `${dondeCompetitivo} AND documento_proveedor != 'No Definido'`,
            $select:
              "documento_proveedor,max(proveedor_adjudicado) as nombre,count(*) as contratos," +
              "sum(valor_del_contrato) as valor",
            $group: "documento_proveedor",
          },
          MS_TIMEOUT_MERCADO
        ),
        consultar(
          URL_CONTRATOS,
          {
            ...base,
            $where: dondeCompleto,
            $select: "modalidad_de_contratacion,count(*) as contratos",
            $group: "modalidad_de_contratacion",
          },
          MS_TIMEOUT_MERCADO
        ),
      ]);

      return {
        desde: desdeAnio,
        competitivos: perfil.competitivos,
        entidades: entidades.map((f) => ({
          nombre: f.nombre_entidad ?? null,
          contratos: conteo(f.contratos),
          valor: numero(f.valor) || 0,
        })),
        proveedores: proveedores.map((f) => ({
          nombre: f.nombre ?? null,
          documento: f.documento_proveedor ?? null,
          contratos: conteo(f.contratos),
          valor: numero(f.valor) || 0,
        })),
        modalidades: modalidades.map((f) => ({
          nombre: f.modalidad_de_contratacion ?? null,
          contratos: conteo(f.contratos),
        })),
      };
    }

    return { buscarOportunidades, inteligenciaMercado };
  }

  const clientePredeterminado = crearCliente();

  return {
    URL_PROCESOS,
    URL_CONTRATOS,
    VALOR_MAXIMO_PLAUSIBLE,
    ErrorDeValidacion,
    ErrorDeOrigen,
    normalizarCodigos,
    normalizarPalabras,
    parsearPerfil,
    literal,
    fechaIso,
    diasHasta,
    clausulaOportunidades,
    clausulaMercado,
    normalizarProceso,
    puntuar,
    crearCliente,
    buscarOportunidades: clientePredeterminado.buscarOportunidades,
    inteligenciaMercado: clientePredeterminado.inteligenciaMercado,
  };
});
