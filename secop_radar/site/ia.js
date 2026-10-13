/* Radar SECOP II: funciones de IA (Claude) con la clave de cada persona, llamadas directo desde el navegador.
 *
 * Funciona en el navegador (define `IA` global; usa la variable global `Anthropic` de vendor/anthropic-sdk.js) y en
 * Node (module.exports), donde se inyecta un cliente falso para las pruebas.
 *
 * Dos pasos separados porque la API no permite combinar citas con salida estructurada:
 *   1. analizarPliego: el PDF con citas por página (texto).
 *   2. evaluarContraEmpresa / triaje: JSON con esquema, sin citas.
 */
(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) module.exports = fabrica();
  else raiz.IA = fabrica();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Precios de lista en USD por millón de tokens (referencia de octubre de 2026): son una estimación,
  // el cobro real es el de la cuenta de Anthropic de cada persona.
  const MODELOS = {
    "claude-haiku-5-5": { nombre: "Haiku 5.5 (rápido y barato)", entrada: 0.1, salida: 0.5, umbralLargo: 100_000, entradaLarga: 0.5, salidaLarga: 2.5 },
    "claude-sonnet-5-5": { nombre: "Sonnet 5.5 (equilibrado)", entrada: 2, salida: 10 },
    "claude-opus-5-5": { nombre: "Opus 5.5 (el más capaz)", entrada: 4, salida: 20 },
  };
  const MODELO_ANALISIS = "claude-opus-5-5";
  const MODELO_TRIAJE = "claude-haiku-5-5";

  // La solicitud completa admite 32 MB y el PDF viaja en base64 (≈ 4/3 de su tamaño).
  const MAX_BYTES_PDF = 24 * 1024 * 1024;
  const MAX_TOKENS_ANALISIS = 16000;
  const MAX_TOKENS_EVALUACION = 8000;
  const MAX_TOKENS_TRIAJE = 4000;
  const TAMANO_LOTE_TRIAJE = 10;
  const MAX_CARACTERES_EMPRESA = 9000;

  class ErrorDeIA extends Error {
    constructor(mensaje) {
      super(mensaje);
      this.name = "ErrorDeIA";
    }
  }

  // --- Costo ------------------------------------------------------------------

  /** Costo estimado en USD, o null si el modelo no está en la tabla. */
  function estimarCosto(modelo, tokensEntrada, tokensSalida = 0) {
    const m = MODELOS[modelo];
    if (!m) return null;
    const largo = m.umbralLargo && tokensEntrada > m.umbralLargo;
    const pe = largo ? m.entradaLarga : m.entrada;
    const ps = largo ? m.salidaLarga : m.salida;
    return (tokensEntrada * pe + tokensSalida * ps) / 1_000_000;
  }

  function formatoUSD(valor) {
    if (valor === null || valor === undefined) return "no disponible";
    return valor < 0.01 ? "menos de US$ 0,01" : `US$ ${valor.toFixed(2).replace(".", ",")}`;
  }

  // --- Perfil de la empresa como texto ----------------------------------------

  const CAMPOS_EMPRESA = [
    ["nombre", "Nombre de la empresa"],
    ["tamano", "Tamaño"],
    ["actividades", "A qué se dedica (productos y servicios)"],
    ["experiencia", "Experiencia: contratos ejecutados (objeto, valor, año, entidad)"],
    ["rup", "RUP: códigos UNSPSC y capacidad"],
    ["financiero", "Indicadores financieros (liquidez, endeudamiento, patrimonio, capital de trabajo, ingresos)"],
    ["personal", "Personal clave, certificaciones y equipos"],
    ["ubicacion", "Dónde opera"],
    ["restricciones", "Lo que NO ofertan o no pueden cumplir"],
  ];

  function textoDeEmpresa(empresa) {
    const partes = CAMPOS_EMPRESA.map(([clave, etiqueta]) => {
      const valor = String(empresa?.[clave] ?? "").trim();
      return valor ? `${etiqueta}: ${valor.slice(0, 2500)}` : null;
    }).filter(Boolean);
    return partes.join("\n").slice(0, MAX_CARACTERES_EMPRESA);
  }

  const empresaCompleta = (empresa) => textoDeEmpresa(empresa).length > 40;

  // --- Solicitudes (puras: se prueban sin red) ---------------------------------

  const SISTEMA_ANALISIS = [
    "Eres un asesor experto en contratación pública colombiana (SECOP II, Ley 80 de 1993, Ley 1150 de 2007 y Decreto 1082 de 2015).",
    "Ayudas a una empresa proponente a entender un pliego de condiciones, una invitación o un estudio previo.",
    "",
    "Reglas:",
    "- Basa cada afirmación en el documento y cítalo. Si algo no aparece, escribe «No encontré este dato en el documento»; no lo supongas.",
    "- No inventes cifras, fechas, porcentajes ni requisitos.",
    "- Escribe en español claro y sin tablas. Usa solo encabezados con ###, listas con guiones y **negritas**.",
    "- Sé concreto: montos en pesos colombianos, plazos en días, indicadores con su fórmula y el valor mínimo exigido.",
    "- Esto no es asesoría legal: señala lo que conviene confirmar en el proceso oficial.",
  ].join("\n");

  const SISTEMA_EVALUACION = [
    "Eres un asesor experto en contratación pública colombiana. Comparas los requisitos de un pliego con el perfil de una empresa.",
    "- Marca «cumple» solo si el perfil lo demuestra con datos concretos.",
    "- Si el perfil no dice nada sobre un requisito, usa «falta_informacion» e indica en «accion» qué dato o documento se necesita.",
    "- Marca «no_cumple» solo con evidencia clara de que no se cumple.",
    "- No inventes datos de la empresa. Escribe en español.",
  ].join("\n");

  const SISTEMA_TRIAJE = [
    "Clasificas qué tan bien encaja cada proceso de contratación con una empresa, a partir de su perfil.",
    "- «alto»: el objeto coincide con lo que hace la empresa y el presupuesto es razonable para ella.",
    "- «medio»: coincide parcialmente o hay dudas sobre capacidad o experiencia.",
    "- «bajo»: el objeto no corresponde a lo que hace la empresa o choca con sus restricciones.",
    "En «razon» escribe una frase de máximo 25 palabras. En «alerta» escribe un riesgo breve, o una cadena vacía si no hay.",
    "Devuelve una evaluación por cada proceso, con el mismo «id» que recibiste.",
  ].join("\n");

  const dineroTexto = (valor) => (valor ? `$ ${Math.round(valor).toLocaleString("es-CO")} COP` : "no informado");

  function instruccionAnalisis(proceso = {}) {
    const contexto = [
      proceso.nombre && `Proceso: ${proceso.nombre}`,
      proceso.entidad && `Entidad: ${proceso.entidad}`,
      proceso.referencia && `Referencia: ${proceso.referencia}`,
      proceso.modalidad && `Modalidad: ${proceso.modalidad}`,
      `Presupuesto: ${dineroTexto(proceso.presupuesto)}`,
    ].filter(Boolean).join("\n");
    return [
      "Analiza el documento adjunto. Estos datos del proceso son solo contexto:",
      contexto,
      "",
      "Entrega estas secciones, en este orden:",
      "### 1. Resumen del proceso",
      "### 2. Requisitos habilitantes (jurídicos, financieros, técnicos y de experiencia, organizacionales)",
      "### 3. Documentos que debo presentar",
      "### 4. Criterios de evaluación y ponderación",
      "### 5. Garantías, seguros y forma de pago",
      "### 6. Riesgos y puntos de atención",
      "### 7. Preguntas para la etapa de observaciones",
    ].join("\n");
  }

  function mensajesAnalisis({ pdfBase64, titulo, proceso }) {
    return [{
      role: "user",
      content: [
        {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
          title: titulo || "Pliego",
          citations: { enabled: true },
        },
        { type: "text", text: instruccionAnalisis(proceso) },
      ],
    }];
  }

  function construirSolicitudAnalisis({ modelo, pdfBase64, titulo, proceso }) {
    return {
      model: modelo,
      max_tokens: MAX_TOKENS_ANALISIS,
      output_config: { effort: "high" },
      system: SISTEMA_ANALISIS,
      messages: mensajesAnalisis({ pdfBase64, titulo, proceso }),
    };
  }

  const ESQUEMA_EVALUACION = {
    type: "object",
    properties: {
      veredicto: { type: "string", enum: ["cumple", "cumple_con_dudas", "no_cumple", "indeterminado"] },
      resumen: { type: "string" },
      requisitos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            requisito: { type: "string" },
            categoria: { type: "string", enum: ["juridico", "financiero", "tecnico_experiencia", "organizacional", "documental", "otro"] },
            estado: { type: "string", enum: ["cumple", "no_cumple", "falta_informacion"] },
            evidencia: { type: "string" },
            accion: { type: "string" },
          },
          required: ["requisito", "categoria", "estado", "evidencia", "accion"],
          additionalProperties: false,
        },
      },
      proximos_pasos: { type: "array", items: { type: "string" } },
    },
    required: ["veredicto", "resumen", "requisitos", "proximos_pasos"],
    additionalProperties: false,
  };

  const ESQUEMA_TRIAJE = {
    type: "object",
    properties: {
      evaluaciones: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            encaja: { type: "string", enum: ["alto", "medio", "bajo"] },
            razon: { type: "string" },
            alerta: { type: "string" },
          },
          required: ["id", "encaja", "razon", "alerta"],
          additionalProperties: false,
        },
      },
    },
    required: ["evaluaciones"],
    additionalProperties: false,
  };

  function construirSolicitudEvaluacion({ modelo, analisis, empresa, proceso }) {
    return {
      model: modelo,
      max_tokens: MAX_TOKENS_EVALUACION,
      output_config: { effort: "high", format: { type: "json_schema", schema: ESQUEMA_EVALUACION } },
      system: SISTEMA_EVALUACION,
      messages: [{
        role: "user",
        content:
          `Proceso: ${proceso?.nombre || "sin nombre"}\n\n` +
          `<analisis_del_pliego>\n${analisis}\n</analisis_del_pliego>\n\n` +
          `<perfil_de_la_empresa>\n${textoDeEmpresa(empresa)}\n</perfil_de_la_empresa>\n\n` +
          "Evalúa cada requisito habilitante del análisis frente al perfil y da un veredicto general.",
      }],
    };
  }

  function construirSolicitudTriaje({ modelo, procesos, empresa }) {
    const datos = procesos.map((p) => ({
      id: String(p.id),
      nombre: p.nombre,
      descripcion: (p.descripcion || "").slice(0, 400),
      entidad: p.entidad,
      modalidad: p.modalidad,
      presupuesto: p.presupuesto,
      categoria: p.categoria,
    }));
    return {
      model: modelo,
      max_tokens: MAX_TOKENS_TRIAJE,
      output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA_TRIAJE } },
      system: SISTEMA_TRIAJE,
      messages: [{
        role: "user",
        content:
          `<perfil_de_la_empresa>\n${textoDeEmpresa(empresa)}\n</perfil_de_la_empresa>\n\n` +
          `<procesos>\n${JSON.stringify(datos)}\n</procesos>`,
      }],
    };
  }

  // --- Lectura de respuestas ---------------------------------------------------

  const bloquesDeTexto = (contenido) => (contenido || []).filter((b) => b.type === "text");
  const textoPlano = (contenido) => bloquesDeTexto(contenido).map((b) => b.text).join("");

  function verificarParada(mensaje) {
    if (mensaje.stop_reason === "refusal") {
      throw new ErrorDeIA("La IA no quiso procesar esta solicitud por sus reglas de seguridad. Prueba con otro documento.");
    }
  }

  function leerJSON(mensaje) {
    verificarParada(mensaje);
    if (mensaje.stop_reason === "max_tokens") {
      throw new ErrorDeIA("La respuesta de la IA se cortó antes de terminar. Inténtalo con menos procesos o un documento más corto.");
    }
    try {
      return JSON.parse(textoPlano(mensaje.content));
    } catch {
      throw new ErrorDeIA("La IA devolvió una respuesta que no se pudo leer. Inténtalo de nuevo.");
    }
  }

  // --- Citas y texto ligero -----------------------------------------------------

  const MARCA_INICIO = "";
  const MARCA_FIN = "";
  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const escaparHTML = (texto) => String(texto ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

  /** En las citas de PDF la página final es exclusiva: [5, 6) es solo la página 5. */
  function etiquetaPagina(cita) {
    if (cita.type === "page_location") {
      const ultima = cita.end_page_number - 1;
      return ultima > cita.start_page_number ? `págs. ${cita.start_page_number}–${ultima}` : `pág. ${cita.start_page_number}`;
    }
    return "documento";
  }

  /** Convierte un subconjunto de Markdown (encabezados, listas, negritas) a HTML seguro. */
  function markdownLigero(texto) {
    const salida = [];
    let lista = null;
    const cerrarLista = () => {
      if (lista) salida.push(`</${lista}>`);
      lista = null;
    };
    const enLinea = (t) =>
      t
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(new RegExp(`${MARCA_INICIO}(\\d+)${MARCA_FIN}`, "g"),
          (_, n) => `<sup class="cita"><a href="#fuente-${n}" data-fuente="${n}">[${n}]</a></sup>`);
    const abrirLista = (tipo) => {
      if (lista === tipo) return;
      cerrarLista();
      salida.push(`<${tipo}>`);
      lista = tipo;
    };

    for (const crudo of escaparHTML(texto).split(/\r?\n/)) {
      const linea = crudo.trimEnd();
      let m;
      if (!linea.trim()) cerrarLista();
      else if ((m = /^\s*#{1,4}\s+(.*)$/.exec(linea))) {
        cerrarLista();
        salida.push(`<h4>${enLinea(m[1])}</h4>`);
      } else if ((m = /^\s*[-*•]\s+(.*)$/.exec(linea))) {
        abrirLista("ul");
        salida.push(`<li>${enLinea(m[1])}</li>`);
      } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(linea))) {
        abrirLista("ol");
        salida.push(`<li>${enLinea(m[1])}</li>`);
      } else {
        cerrarLista();
        salida.push(`<p>${enLinea(linea)}</p>`);
      }
    }
    cerrarLista();
    return salida.join("");
  }

  /** Une los bloques de texto del análisis, pone notas al pie numeradas donde hay citas y arma la lista de fuentes. */
  function renderizarAnalisis(contenido) {
    const fuentes = [];
    const indices = new Map();
    let texto = "";
    for (const bloque of bloquesDeTexto(contenido)) {
      const marcas = [];
      for (const cita of bloque.citations || []) {
        const clave = [cita.document_index, cita.start_page_number, cita.end_page_number, cita.cited_text].join("|");
        if (!indices.has(clave)) {
          indices.set(clave, fuentes.length + 1);
          fuentes.push({ n: fuentes.length + 1, pagina: etiquetaPagina(cita), texto: cita.cited_text || "" });
        }
        const n = indices.get(clave);
        if (!marcas.includes(n)) marcas.push(n);
      }
      // Las notas van antes de los saltos de línea finales para no romper el encabezado o la lista siguiente.
      const finales = /\s*$/.exec(bloque.text)[0];
      const cuerpo = bloque.text.slice(0, bloque.text.length - finales.length);
      texto += cuerpo + marcas.map((n) => `${MARCA_INICIO}${n}${MARCA_FIN}`).join("") + finales;
    }
    return { html: markdownLigero(texto), fuentes, texto: textoPlano(contenido) };
  }

  function htmlFuentes(fuentes) {
    if (!fuentes.length) return "";
    const recorte = (t) => (t.length > 300 ? t.slice(0, 300).trimEnd() + "…" : t);
    return `<ol class="fuentes">${fuentes.map((f) =>
      `<li id="fuente-${f.n}"><strong>${escaparHTML(f.pagina)}:</strong> «${escaparHTML(recorte(f.texto))}»</li>`).join("")}</ol>`;
  }

  // --- Errores en español -------------------------------------------------------

  function mensajeDeError(error, SDK = typeof Anthropic !== "undefined" ? Anthropic : undefined) {
    const es = (nombre) => SDK && SDK[nombre] && error instanceof SDK[nombre];
    if (error instanceof ErrorDeIA) return error.message;
    if (error?.name === "AbortError" || es("APIUserAbortError")) return "Se canceló el análisis.";
    if (es("AuthenticationError")) return "Anthropic no aceptó la clave: no es válida o fue revocada. Revísala en la pestaña “Empresa e IA”.";
    if (es("PermissionDeniedError")) return "Tu clave no tiene permiso para usar este modelo.";
    if (es("RateLimitError")) return "Alcanzaste el límite de uso de tu clave. Espera un momento e inténtalo de nuevo.";
    if (es("BadRequestError")) return `Anthropic rechazó la solicitud: ${error.message}`;
    if (es("APIConnectionError")) return "No se pudo conectar con Anthropic. Verifica tu conexión a internet.";
    if (es("APIError")) return `Anthropic respondió con un error (${error.status ?? "sin código"}). Inténtalo más tarde.`;
    return error?.message || "Ocurrió un error inesperado.";
  }

  // --- Cliente ----------------------------------------------------------------

  function clientePorDefecto(clave) {
    if (typeof Anthropic === "undefined") throw new ErrorDeIA("El componente de IA todavía no se cargó. Inténtalo de nuevo.");
    // La clave es de la persona que usa la página y solo viaja a api.anthropic.com.
    return new Anthropic({ apiKey: clave, dangerouslyAllowBrowser: true });
  }

  const lotes = (lista, tamano) => {
    const salida = [];
    for (let i = 0; i < lista.length; i += tamano) salida.push(lista.slice(i, i + tamano));
    return salida;
  };

  function validarClave(clave) {
    if (!clave || !String(clave).trim()) {
      throw new ErrorDeIA("Falta la clave de Anthropic. Agrégala en la pestaña “Empresa e IA”.");
    }
  }

  function crearIA({ crearCliente = clientePorDefecto } = {}) {
    const cliente = (clave) => {
      validarClave(clave);
      return crearCliente(String(clave).trim());
    };

    /** Una llamada mínima para comprobar que la clave funciona. */
    async function probarClave({ clave, modelo = MODELO_TRIAJE }) {
      await cliente(clave).messages.create({
        model: modelo,
        max_tokens: 64,
        messages: [{ role: "user", content: "Responde solo con la palabra: ok" }],
      });
      return true;
    }

    /** Cuenta los tokens del análisis para estimar el costo antes de gastar. */
    async function estimarTokensPliego({ clave, modelo, pdfBase64, titulo, proceso }) {
      const solicitud = construirSolicitudAnalisis({ modelo, pdfBase64, titulo, proceso });
      const respuesta = await cliente(clave).messages.countTokens({
        model: modelo,
        system: solicitud.system,
        messages: solicitud.messages,
      });
      return respuesta.input_tokens;
    }

    /** Analiza un pliego en PDF. `alTexto(delta)` recibe el texto a medida que se genera. */
    async function analizarPliego({ clave, modelo, pdfBase64, titulo, proceso, alTexto, senal }) {
      const flujo = cliente(clave).messages.stream(
        construirSolicitudAnalisis({ modelo, pdfBase64, titulo, proceso }),
        senal ? { signal: senal } : undefined
      );
      if (alTexto) flujo.on("text", (delta) => alTexto(delta));
      const mensaje = await flujo.finalMessage();
      verificarParada(mensaje);
      return {
        contenido: mensaje.content,
        truncado: mensaje.stop_reason === "max_tokens",
        uso: mensaje.usage,
        modelo: mensaje.model || modelo,
      };
    }

    /** Compara los requisitos ya analizados con el perfil de la empresa. */
    async function evaluarContraEmpresa({ clave, modelo, analisis, empresa, proceso }) {
      if (!empresaCompleta(empresa)) {
        throw new ErrorDeIA("Completa el perfil de tu empresa en la pestaña “Empresa e IA” para poder evaluar los requisitos.");
      }
      const mensaje = await cliente(clave).messages.create(
        construirSolicitudEvaluacion({ modelo, analisis, empresa, proceso })
      );
      return leerJSON(mensaje);
    }

    /** Clasifica en lotes qué procesos encajan con la empresa. Devuelve un Map id → evaluación. */
    async function triaje({ clave, modelo, procesos, empresa, alAvance }) {
      if (!empresaCompleta(empresa)) {
        throw new ErrorDeIA("Completa el perfil de tu empresa en la pestaña “Empresa e IA” para que la IA pueda evaluar cada proceso.");
      }
      const resultados = new Map();
      let hechos = 0;
      for (const lote of lotes(procesos, TAMANO_LOTE_TRIAJE)) {
        const mensaje = await cliente(clave).messages.create(construirSolicitudTriaje({ modelo, procesos: lote, empresa }));
        const permitidos = new Set(lote.map((p) => String(p.id)));
        for (const e of leerJSON(mensaje).evaluaciones) {
          if (permitidos.has(e.id)) resultados.set(e.id, e);
        }
        hechos += lote.length;
        if (alAvance) alAvance(hechos, procesos.length);
      }
      return resultados;
    }

    return { probarClave, estimarTokensPliego, analizarPliego, evaluarContraEmpresa, triaje };
  }

  return {
    MODELOS,
    MODELO_ANALISIS,
    MODELO_TRIAJE,
    MAX_BYTES_PDF,
    CAMPOS_EMPRESA,
    ESQUEMA_EVALUACION,
    ESQUEMA_TRIAJE,
    ErrorDeIA,
    estimarCosto,
    formatoUSD,
    textoDeEmpresa,
    empresaCompleta,
    construirSolicitudAnalisis,
    construirSolicitudEvaluacion,
    construirSolicitudTriaje,
    leerJSON,
    markdownLigero,
    renderizarAnalisis,
    htmlFuentes,
    escaparHTML,
    mensajeDeError,
    crearIA,
  };
});
