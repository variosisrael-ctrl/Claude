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
  const URL_PROPONENTES = "https://www.datos.gov.co/resource/hgi6-6wh3.json"; // quiénes se presentaron a cada proceso

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
  const MAXIMO_ADJUDICADOS = 300;
  const MINIMO_PROCESOS_ENTIDAD = 5; // igual que Analisis.MIN_PROCESOS: con menos, se complementa con el nivel nacional
  const DIAS_HISTORIAL = 730;
  const TAMANO_LOTE = 100; // identificadores por consulta "in (...)", para no pasar el largo máximo de la URL

  // Solo las columnas que usa la app: el dataset tiene 59 y pedirlas todas multiplica el tamaño de la respuesta.
  const CAMPOS_PROCESO = [
    "id_del_proceso", "id_del_portafolio", "referencia_del_proceso", "nombre_del_procedimiento",
    "descripci_n_del_procedimiento", "entidad", "nit_entidad", "ciudad_entidad", "departamento_entidad",
    "fecha_de_publicacion_del", "fecha_de_recepcion_de", "precio_base", "modalidad_de_contratacion",
    "codigo_principal_de_categoria", "estado_resumen", "adjudicado", "fecha_adjudicacion",
    "valor_total_adjudicacion", "nombre_del_proveedor", "nit_del_proveedor_adjudicado", "urlproceso",
  ].join(",");

  const CAMPOS_CONTRATO = [
    "proceso_de_compra", "id_contrato", "estado_contrato", "valor_del_contrato", "valor_pagado", "valor_facturado",
    "valor_pendiente_de_pago", "fecha_de_inicio_del_contrato", "fecha_de_fin_del_contrato", "dias_adicionados",
    "liquidaci_n", "proveedor_adjudicado", "documento_proveedor",
  ].join(",");
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
  /** `amplio` permite un perfil sin palabras ni códigos (todo el mercado): lo usa el resumen diario de las alertas. */
  function parsearPerfil(params, { amplio = false } = {}) {
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
    if (!amplio && !perfil.palabras.length && !perfil.codigos.length) {
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

  /** Condiciones del perfil del usuario sobre un proceso: alcance (códigos o palabras), modalidad, presupuesto, lugar. */
  function condicionesDePerfil(perfil) {
    const alcance = [];
    if (perfil.codigos.length) alcance.push(condicionCodigos(perfil.codigos, "codigo_principal_de_categoria"));
    for (const palabra of perfil.palabras) {
      const patron = literal(`%${palabra}%`);
      alcance.push(
        `upper(nombre_del_procedimiento) like ${patron} OR upper(descripci_n_del_procedimiento) like ${patron}`
      );
    }
    const condiciones = alcance.length ? ["(" + alcance.map((parte) => `(${parte})`).join(" OR ") + ")"] : [];
    if (perfil.competitivos) condiciones.push(condicionCompetitiva());
    if (perfil.min !== null) condiciones.push(`precio_base >= ${perfil.min}`);
    if (perfil.max !== null) condiciones.push(`precio_base <= ${perfil.max}`);
    if (perfil.departamento) {
      condiciones.push(`upper(departamento_entidad) like ${literal("%" + perfil.departamento + "%")}`);
    }
    return condiciones;
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
    return [...condiciones, ...condicionesDePerfil(perfil)].join(" AND ");
  }

  function clausulaAdjudicados(perfil, desde) {
    return [
      "adjudicado = 'Si'",
      `fecha_adjudicacion >= ${literal(fechaIso(desde) + "T00:00:00")}`,
      ...condicionesDePerfil(perfil),
    ].join(" AND ");
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
      ciudad: dato(fila.ciudad_entidad),
      departamento: dato(fila.departamento_entidad),
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

  /** Clase UNSPSC (6 dígitos) de un código como "V1.80111600", o null si el proceso no tiene categoría. */
  function claseCategoria(categoria) {
    const m = /^V1\.(\d{6})/.exec(categoria || "");
    return m ? m[1] : null;
  }

  function normalizarContrato(fila) {
    const estado = (fila.estado_contrato || "").trim();
    const valor = numero(fila.valor_del_contrato);
    return {
      id: fila.id_contrato ?? null,
      portafolio: fila.proceso_de_compra ?? null,
      estado: estado ? estado.charAt(0).toUpperCase() + estado.slice(1) : null,
      // Los valores absurdos son errores de digitación de la fuente (ver VALOR_MAXIMO_PLAUSIBLE).
      valor: valor !== null && valor < VALOR_MAXIMO_PLAUSIBLE ? valor : null,
      pagado: numero(fila.valor_pagado),
      facturado: numero(fila.valor_facturado),
      pendiente_pago: numero(fila.valor_pendiente_de_pago),
      inicio: soloDia(fila.fecha_de_inicio_del_contrato),
      fin: soloDia(fila.fecha_de_fin_del_contrato),
      dias_adicionados: conteo(fila.dias_adicionados),
      liquidacion: dato(fila.liquidaci_n),
      proveedor: dato(fila.proveedor_adjudicado),
      documento: dato(fila.documento_proveedor),
    };
  }

  /** Normaliza filas de procesos, quita repetidos y calcula la coincidencia con el perfil. */
  function prepararProcesos(filas, perfil) {
    const vistos = new Set();
    const lista = [];
    for (const fila of filas) {
      const proceso = normalizarProceso(fila);
      if (!proceso.id || vistos.has(proceso.id)) continue;
      vistos.add(proceso.id);
      [proceso.puntaje, proceso.razones] = puntuar(proceso, perfil);
      lista.push(proceso);
    }
    return lista;
  }

  const lotes = (lista, tamano = TAMANO_LOTE) => {
    const salida = [];
    for (let i = 0; i < lista.length; i += tamano) salida.push(lista.slice(i, i + tamano));
    return salida;
  };

  const listaLiterales = (ids) => ids.map(literal).join(",");

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

    async function buscarOportunidades(params, opciones) {
      const perfil = parsearPerfil(params, opciones);
      const hoy = new Date(ahora());
      const desde = new Date(hoy.getTime() - perfil.dias * MS_POR_DIA);
      const filas = await consultar(URL_PROCESOS, {
        $select: CAMPOS_PROCESO,
        $where: clausulaOportunidades(perfil, desde, hoy),
        // Si hay más filas que el tope, que queden las que cierran primero (las más urgentes).
        $order: perfil.abiertos ? "fecha_de_recepcion_de ASC" : "fecha_de_publicacion_del DESC",
        $limit: FILAS_A_PUNTUAR,
      });

      const resultados = prepararProcesos(filas, perfil);
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

    /** Un contrato por proceso (el de mayor valor si hay varios, p. ej. por lotes), indexado por portafolio. */
    async function contratosPorPortafolio(portafolios) {
      const respuestas = await Promise.all(
        lotes(portafolios).map((lote) =>
          consultar(
            URL_CONTRATOS,
            { $select: CAMPOS_CONTRATO, $where: `proceso_de_compra in (${listaLiterales(lote)})`, $limit: 5000 },
            MS_TIMEOUT_MERCADO
          )
        )
      );
      const porProceso = new Map();
      for (const fila of respuestas.flat()) {
        const contrato = normalizarContrato(fila);
        if (!contrato.portafolio) continue;
        const previo = porProceso.get(contrato.portafolio);
        const mayor = previo && (previo.valor || 0) >= (contrato.valor || 0) ? previo : contrato;
        porProceso.set(contrato.portafolio, { ...mayor, contratos: (previo?.contratos || 0) + 1 });
      }
      return porProceso;
    }

    /** Procesos ya adjudicados que encajan con el perfil, con su contrato (estado, pagos, plazo) si existe. */
    async function buscarAdjudicados(params) {
      const perfil = parsearPerfil(params);
      const meses = entero(params.meses, "Los meses", 1, 36, 6);
      const hoy = new Date(ahora());
      const desde = new Date(hoy.getTime() - meses * 30 * MS_POR_DIA);
      const filas = await consultar(
        URL_PROCESOS,
        {
          $select: CAMPOS_PROCESO,
          $where: clausulaAdjudicados(perfil, desde),
          $order: "fecha_adjudicacion DESC",
          $limit: MAXIMO_ADJUDICADOS,
        },
        MS_TIMEOUT_MERCADO
      );
      const resultados = prepararProcesos(filas, perfil);
      const portafolios = [...new Set(resultados.map((p) => p.portafolio).filter(Boolean))];
      const contratos = portafolios.length ? await contratosPorPortafolio(portafolios) : new Map();
      for (const proceso of resultados) proceso.contrato = contratos.get(proceso.portafolio) ?? null;
      return {
        desde: fechaIso(desde),
        meses,
        limite_alcanzado: filas.length >= MAXIMO_ADJUDICADOS,
        resultados,
      };
    }

    /** Respaldo cuando una entidad tiene pocos procesos: quién gana y a qué precio en todo el país. */
    async function historialNacional(comunes) {
      const dondeBase = comunes.join(" AND ");
      const [ganadores, totales] = await Promise.all([
        consultar(
          URL_PROCESOS,
          {
            $select:
              "nit_del_proveedor_adjudicado,max(nombre_del_proveedor) as nombre,count(*) as ganados," +
              "sum(valor_total_adjudicacion) as valor",
            $where: `${dondeBase} AND nit_del_proveedor_adjudicado != 'No Definido'`,
            $group: "nit_del_proveedor_adjudicado",
            $order: "ganados DESC",
            $limit: 10,
          },
          MS_TIMEOUT_MERCADO
        ),
        consultar(
          URL_PROCESOS,
          {
            // Los alias no pueden llamarse como una columna (p. ej. "adjudicado"): chocan con el WHERE.
            $select: "count(*) as n,sum(valor_total_adjudicacion) as suma_adjudicada,sum(precio_base) as suma_base",
            $where: dondeBase,
          },
          MS_TIMEOUT_MERCADO
        ),
      ]);
      const total = totales[0] || {};
      return {
        ganadores: ganadores.map((f) => ({
          nit: dato(f.nit_del_proveedor_adjudicado),
          nombre: f.nombre ?? null,
          ganados: conteo(f.ganados),
          valor: numero(f.valor) || 0,
        })),
        totales: { n: conteo(total.n), adjudicado: numero(total.suma_adjudicada) || 0, base: numero(total.suma_base) || 0 },
      };
    }

    /**
     * Historial de competencia de una entidad en una categoría (últimos 2 años, solo procesos competitivos):
     * procesos adjudicados y quiénes se presentaron a cada uno.
     */
    async function competenciaHistorica({ nit_entidad: nitEntidad, categoria } = {}) {
      const nit = String(nitEntidad ?? "");
      if (!/^\d{5,12}$/.test(nit)) {
        throw new ErrorDeValidacion("La entidad no tiene un NIT válido para consultar su historial.");
      }
      const clase = claseCategoria(categoria);
      const hoy = new Date(ahora());
      const desde = new Date(hoy.getTime() - DIAS_HISTORIAL * MS_POR_DIA);
      const comunes = [
        "adjudicado = 'Si'",
        `fecha_adjudicacion >= ${literal(fechaIso(desde) + "T00:00:00")}`,
        condicionCompetitiva(),
        "precio_base > 0",
        "valor_total_adjudicacion > 0",
        "valor_total_adjudicacion <= precio_base * 2", // descarta adjudicaciones con valores mal digitados
      ];
      if (clase) comunes.push(`codigo_principal_de_categoria like ${literal("V1." + clase + "%")}`);

      const filas = await consultar(
        URL_PROCESOS,
        {
          $select:
            "id_del_proceso,precio_base,valor_total_adjudicacion,nit_del_proveedor_adjudicado,nombre_del_proveedor,fecha_adjudicacion",
          $where: [...comunes, `nit_entidad = ${literal(nit)}`].join(" AND "),
          $order: "fecha_adjudicacion DESC",
          $limit: 300,
        },
        MS_TIMEOUT_MERCADO
      );
      const procesos = filas.map((f) => ({
        id: f.id_del_proceso ?? null,
        presupuesto: numero(f.precio_base),
        valor_adjudicado: numero(f.valor_total_adjudicacion),
        nit_ganador: dato(f.nit_del_proveedor_adjudicado),
        ganador: dato(f.nombre_del_proveedor),
        fecha_adjudicacion: soloDia(f.fecha_adjudicacion),
      }));

      const ids = procesos.map((p) => p.id).filter(Boolean);
      const [respuestas, pais] = await Promise.all([
        Promise.all(
          lotes(ids).map((lote) =>
            consultar(
              URL_PROPONENTES,
              {
                $select: "id_procedimiento,nit_proveedor,proveedor",
                $where: `id_procedimiento in (${listaLiterales(lote)})`,
                $limit: 5000,
              },
              MS_TIMEOUT_MERCADO
            )
          )
        ),
        clase && procesos.length < MINIMO_PROCESOS_ENTIDAD ? historialNacional(comunes) : null,
      ]);
      const proponentes = respuestas.flat().map((f) => ({
        id: f.id_procedimiento,
        nit: dato(f.nit_proveedor),
        nombre: dato(f.proveedor),
      }));
      return { clase, desde: fechaIso(desde), entidad: { procesos, proponentes }, pais };
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

    return { buscarOportunidades, buscarAdjudicados, competenciaHistorica, inteligenciaMercado };
  }

  const clientePredeterminado = crearCliente();

  return {
    URL_PROCESOS,
    URL_CONTRATOS,
    URL_PROPONENTES,
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
    clausulaAdjudicados,
    clausulaMercado,
    claseCategoria,
    normalizarProceso,
    normalizarContrato,
    puntuar,
    crearCliente,
    buscarOportunidades: clientePredeterminado.buscarOportunidades,
    buscarAdjudicados: clientePredeterminado.buscarAdjudicados,
    competenciaHistorica: clientePredeterminado.competenciaHistorica,
    inteligenciaMercado: clientePredeterminado.inteligenciaMercado,
  };
});
