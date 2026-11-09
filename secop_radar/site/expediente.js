/* Radar SECOP II: expediente de un proceso (análisis guardado, requisitos del pliego, cronograma y decisión).
 *
 * Funciona en el navegador (define `Expediente` global) y en Node (module.exports). Es lógica pura: no toca la red,
 * el DOM ni el almacenamiento. Todo lo que entra (de la IA o de un archivo de respaldo) pasa por `normalizar`,
 * que descarta lo que no tenga la forma esperada.
 */
(function (raiz, fabrica) {
  if (typeof module === "object" && module.exports) module.exports = fabrica();
  else raiz.Expediente = fabrica();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = 1;

  const TIPOS_REQUISITO = {
    juridico: "Jurídico", financiero: "Financiero", organizacional: "Organizacional", experiencia: "Experiencia",
    tecnico: "Técnico", documental: "Documental", ponderable: "Da puntaje", otro: "Otro",
  };
  // Los que se pueden comprobar con números del perfil de la empresa. El resto se revisa a mano.
  const INDICADORES = {
    ninguno: "Revisión manual",
    liquidez: "Índice de liquidez",
    endeudamiento: "Nivel de endeudamiento",
    cobertura_intereses: "Razón de cobertura de intereses",
    rentabilidad_patrimonio: "Rentabilidad del patrimonio",
    rentabilidad_activo: "Rentabilidad del activo",
    capital_trabajo: "Capital de trabajo",
    patrimonio: "Patrimonio",
    experiencia: "Experiencia acreditada",
  };
  const OPERADORES = [">=", "<="];
  const UNIDADES = {
    veces: "veces", porcentaje: "%", cop: "COP", smmlv: "SMMLV", porcentaje_presupuesto: "% del presupuesto oficial",
  };
  const SUBSANABLE = { si: "Subsanable", no: "No subsanable", no_dice: "" };
  const RESPUESTAS_MANUALES = ["", "cumple", "no_cumple"];

  const TIPOS_HITO = {
    observaciones: "Límite para observaciones al pliego",
    respuesta_observaciones: "Respuesta a las observaciones",
    adendas: "Límite para expedir adendas",
    cierre: "Cierre: presentación de ofertas",
    informe: "Publicación del informe de evaluación",
    subsanacion: "Subsanación y observaciones al informe",
    adjudicacion: "Adjudicación",
    otro: "Otro",
  };
  const DECISIONES = { ofertar: "Ofertar", no_ofertar: "No ofertar" };

  // --- Limpieza de entradas ---------------------------------------------------

  const texto = (valor, maximo) => (typeof valor === "string" ? valor.trim().slice(0, maximo) : "");
  const deLista = (valor, permitidos, respaldo) => (permitidos.includes(valor) ? valor : respaldo);
  const numero = (valor) => (typeof valor === "number" && Number.isFinite(valor) ? valor : null);
  const lista = (valor, maximo) => (Array.isArray(valor) ? valor.slice(0, maximo) : []);
  const objeto = (valor) => (valor && typeof valor === "object" && !Array.isArray(valor) ? valor : {});

  function fechaValida(valor) {
    if (typeof valor !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(valor)) return "";
    const [anio, mes, dia] = valor.split("-").map(Number);
    const fecha = new Date(Date.UTC(anio, mes - 1, dia));
    return fecha.getUTCMonth() === mes - 1 && fecha.getUTCDate() === dia ? valor : "";
  }

  function horaValida(valor) {
    const m = typeof valor === "string" ? /^(\d{1,2}):(\d{2})/.exec(valor) : null;
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return "";
    return `${m[1].padStart(2, "0")}:${m[2]}`;
  }

  const numerosDeFuente = (valor) =>
    [...new Set(lista(valor, 12).filter((n) => Number.isInteger(n) && n > 0 && n < 10000))];

  let contador = 0;
  /** Identificador corto para requisitos e hitos; solo necesita ser único dentro de un expediente. */
  const nuevoId = () => `${Date.now().toString(36)}${(contador++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const idValido = (valor) => (typeof valor === "string" && /^[\w-]{1,40}$/.test(valor) ? valor : nuevoId());

  function normalizarRequisito(crudo) {
    const r = objeto(crudo);
    const descripcion = texto(r.descripcion, 600);
    if (!descripcion) return null;
    const indicador = deLista(r.indicador, Object.keys(INDICADORES), "ninguno");
    const valor = numero(r.valor);
    return {
      id: idValido(r.id),
      descripcion,
      tipo: deLista(r.tipo, Object.keys(TIPOS_REQUISITO), "otro"),
      indicador,
      operador: deLista(r.operador, OPERADORES, indicador === "endeudamiento" ? "<=" : ">="),
      // Sin umbral numérico el requisito se revisa a mano aunque tenga indicador.
      valor: indicador !== "ninguno" && valor !== null && valor >= 0 ? valor : null,
      unidad: deLista(r.unidad, Object.keys(UNIDADES), "veces"),
      max_contratos: Number.isInteger(r.max_contratos) && r.max_contratos > 0 ? Math.min(r.max_contratos, 99) : 0,
      codigos: lista(r.codigos, 30).map((c) => String(c).replace(/\D/g, "")).filter((c) => c.length >= 4 && c.length <= 8),
      subsanable: deLista(r.subsanable, Object.keys(SUBSANABLE), "no_dice"),
      fuentes: numerosDeFuente(r.fuentes),
      validado: r.validado === true,
      manual: deLista(r.manual, RESPUESTAS_MANUALES, ""),
    };
  }

  function normalizarHito(crudo) {
    const h = objeto(crudo);
    const tipo = deLista(h.tipo, Object.keys(TIPOS_HITO), "otro");
    const fecha = fechaValida(h.fecha);
    const descripcion = texto(h.descripcion, 300);
    return {
      id: idValido(h.id),
      tipo,
      descripcion,
      fecha,
      hora: fecha ? horaValida(h.hora) : "",
      // Un hito sin fecha no se puede dar por confirmado.
      confirmado: h.confirmado === true && Boolean(fecha),
      fuentes: numerosDeFuente(h.fuentes),
    };
  }

  function normalizarAnalisis(crudo) {
    const a = objeto(crudo);
    const marcado = texto(a.marcado, 400_000);
    if (!marcado) return null;
    const uso = objeto(a.uso);
    const evaluacion = normalizarEvaluacion(a.evaluacion);
    return {
      archivo: texto(a.archivo, 200),
      modelo: texto(a.modelo, 80),
      fecha: fechaValida(a.fecha),
      truncado: a.truncado === true,
      uso: Object.fromEntries(
        ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
          .map((clave) => [clave, numero(uso[clave]) || 0])
      ),
      marcado,
      texto: texto(a.texto, 400_000),
      fuentes: lista(a.fuentes, 500).map((f, i) => ({
        n: i + 1, pagina: texto(objeto(f).pagina, 40), texto: texto(objeto(f).texto, 2000),
      })),
      evaluacion,
    };
  }

  /** La evaluación de la IA contra el perfil de la empresa (ver IA.ESQUEMA_EVALUACION). */
  function normalizarEvaluacion(crudo) {
    if (!crudo || typeof crudo !== "object") return null;
    return {
      veredicto: deLista(crudo.veredicto, ["cumple", "cumple_con_dudas", "no_cumple", "indeterminado"], "indeterminado"),
      resumen: texto(crudo.resumen, 2000),
      requisitos: lista(crudo.requisitos, 200).map((r) => ({
        requisito: texto(objeto(r).requisito, 600),
        categoria: texto(objeto(r).categoria, 40),
        estado: deLista(objeto(r).estado, ["cumple", "no_cumple", "falta_informacion"], "falta_informacion"),
        evidencia: texto(objeto(r).evidencia, 1000),
        accion: texto(objeto(r).accion, 1000),
      })),
      proximos_pasos: lista(crudo.proximos_pasos, 50).map((p) => texto(p, 600)).filter(Boolean),
    };
  }

  function normalizarDecision(crudo) {
    const d = objeto(crudo);
    if (!(d.decision in DECISIONES)) return null;
    return {
      decision: d.decision,
      responsable: texto(d.responsable, 120),
      motivo: texto(d.motivo, 1500),
      fecha: fechaValida(d.fecha),
    };
  }

  /** Datos mínimos del proceso para reconocer el expediente en un respaldo, aunque ya no esté en el seguimiento. */
  function resumenDeProceso(proceso) {
    const p = objeto(proceso);
    return {
      nombre: texto(p.nombre, 400), entidad: texto(p.entidad, 300), referencia: texto(p.referencia, 120),
      cierre: fechaValida(p.cierre), presupuesto: numero(p.presupuesto),
    };
  }

  function nuevo(proceso) {
    return {
      version: VERSION, id: String(objeto(proceso).id ?? ""), proceso: resumenDeProceso(proceso),
      analisis: null, requisitos: [], hitos: [], decision: null, actualizado: "",
    };
  }

  /** Devuelve un expediente con la forma actual, o null si no tiene identificador. */
  function normalizar(crudo) {
    const e = objeto(crudo);
    const id = texto(typeof e.id === "number" ? String(e.id) : e.id, 200);
    if (!id) return null;
    return {
      version: VERSION,
      id,
      proceso: resumenDeProceso(e.proceso),
      analisis: normalizarAnalisis(e.analisis),
      requisitos: lista(e.requisitos, 300).map(normalizarRequisito).filter(Boolean),
      hitos: lista(e.hitos, 100).map(normalizarHito),
      decision: normalizarDecision(e.decision),
      actualizado: texto(e.actualizado, 40),
    };
  }

  // --- Requisitos e hitos que propone la IA ------------------------------------

  /**
   * Integra una extracción nueva. La IA propone; nada queda validado ni confirmado hasta que una persona lo revise.
   * Los requisitos e hitos agregados a mano (sin fuentes de la IA) se conservan.
   */
  function aplicarExtraccion(expediente, extraccion) {
    const aMano = (elemento) => elemento.fuentes.length === 0;
    const requisitos = lista(extraccion?.requisitos, 300)
      .map((r) => normalizarRequisito({ ...r, id: undefined, validado: false, manual: "" })).filter(Boolean);
    const hitos = lista(extraccion?.hitos, 100)
      .map((h) => normalizarHito({ ...h, id: undefined, confirmado: false })).filter((h) => h.fecha || h.descripcion);
    return {
      ...expediente,
      requisitos: [...requisitos, ...expediente.requisitos.filter(aMano)],
      hitos: ordenarHitos([...hitos, ...expediente.hitos.filter(aMano)]),
      // Una decisión tomada sobre los requisitos anteriores deja de valer.
      decision: null,
    };
  }

  // --- Cronograma ---------------------------------------------------------------

  const ordenarHitos = (hitos) =>
    [...hitos].sort((a, b) => `${a.fecha || "9999"}T${a.hora || "23:59"}`.localeCompare(`${b.fecha || "9999"}T${b.hora || "23:59"}`));

  const formatoFechaBogota = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const MS_POR_DIA = 86_400_000;

  /** Días de calendario (hora de Colombia) hasta la fecha del hito; null si no tiene fecha. */
  function diasParaHito(hito, ahora) {
    if (!hito.fecha) return null;
    const [anio, mes, dia] = hito.fecha.split("-").map(Number);
    const [anioHoy, mesHoy, diaHoy] = formatoFechaBogota.format(ahora).split("-").map(Number);
    return Math.round((Date.UTC(anio, mes - 1, dia) - Date.UTC(anioHoy, mesHoy - 1, diaHoy)) / MS_POR_DIA);
  }

  function estadoHito(hito, ahora) {
    const dias = diasParaHito(hito, ahora);
    if (dias === null) return { dias, texto: "Sin fecha", clase: "pronto" };
    if (dias < 0) return { dias, texto: `Pasó hace ${-dias} día${dias === -1 ? "" : "s"}`, clase: "cerrado" };
    if (dias === 0) return { dias, texto: `Hoy${hito.hora ? ` a las ${hito.hora}` : ""}`, clase: "urgente" };
    if (dias === 1) return { dias, texto: `Mañana${hito.hora ? ` a las ${hito.hora}` : ""}`, clase: "urgente" };
    return { dias, texto: `En ${dias} días`, clase: dias <= 3 ? "pronto" : "" };
  }

  /** El siguiente hito con fecha que aún no pasó. */
  function proximoHito(hitos, ahora) {
    return ordenarHitos(hitos).find((h) => h.fecha && diasParaHito(h, ahora) >= 0) || null;
  }

  // --- Calendario (.ics) --------------------------------------------------------

  const dosDigitos = (n) => String(n).padStart(2, "0");
  const textoICS = (valor) => String(valor).replace(/\\/g, "\\\\").replace(/([,;])/g, "\\$1").replace(/\r?\n/g, "\\n");
  const marcaUTC = (fecha) =>
    `${fecha.getUTCFullYear()}${dosDigitos(fecha.getUTCMonth() + 1)}${dosDigitos(fecha.getUTCDate())}` +
    `T${dosDigitos(fecha.getUTCHours())}${dosDigitos(fecha.getUTCMinutes())}${dosDigitos(fecha.getUTCSeconds())}Z`;

  /** Las líneas de un .ics no pueden pasar de 75 octetos: se parten y la continuación empieza con un espacio. */
  function plegar(linea) {
    const partes = [];
    let actual = "";
    let octetos = 0;
    for (const caracter of linea) {
      const peso = caracter.codePointAt(0) < 0x80 ? 1 : caracter.codePointAt(0) < 0x800 ? 2 : caracter.codePointAt(0) < 0x10000 ? 3 : 4;
      if (octetos + peso > (partes.length ? 74 : 75)) {
        partes.push(actual);
        actual = "";
        octetos = 0;
      }
      actual += caracter;
      octetos += peso;
    }
    partes.push(actual);
    return partes.join("\r\n ");
  }

  /**
   * Calendario con los hitos confirmados. Colombia está siempre en UTC−5 (no tiene horario de verano), así que las
   * horas se escriben en UTC y cualquier calendario las muestra bien. Sin hora, el hito ocupa el día completo.
   */
  function aICS(expediente, ahora = new Date()) {
    const proceso = expediente.proceso;
    const nombre = proceso.referencia || proceso.nombre || expediente.id;
    const lineas = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Radar SECOP II//Cronograma//ES", "CALSCALE:GREGORIAN"];
    for (const hito of ordenarHitos(expediente.hitos).filter((h) => h.confirmado && h.fecha)) {
      const [anio, mes, dia] = hito.fecha.split("-").map(Number);
      const titulo = hito.tipo === "otro" && hito.descripcion ? hito.descripcion : TIPOS_HITO[hito.tipo];
      const descripcion = [hito.descripcion, proceso.nombre, proceso.entidad, "Confirma la fecha y la hora en SECOP II: una adenda puede cambiarlas."]
        .filter(Boolean).join("\n");
      lineas.push("BEGIN:VEVENT", `UID:${`${expediente.id}-${hito.id}`.replace(/[^\w.-]/g, "_")}@radar-secop`, `DTSTAMP:${marcaUTC(ahora)}`);
      if (hito.hora) {
        const [hora, minuto] = hito.hora.split(":").map(Number);
        const inicio = new Date(Date.UTC(anio, mes - 1, dia, hora + 5, minuto));
        lineas.push(`DTSTART:${marcaUTC(inicio)}`, `DTEND:${marcaUTC(new Date(inicio.getTime() + 30 * 60_000))}`);
      } else {
        const siguiente = new Date(Date.UTC(anio, mes - 1, dia + 1));
        lineas.push(
          `DTSTART;VALUE=DATE:${anio}${dosDigitos(mes)}${dosDigitos(dia)}`,
          `DTEND;VALUE=DATE:${siguiente.getUTCFullYear()}${dosDigitos(siguiente.getUTCMonth() + 1)}${dosDigitos(siguiente.getUTCDate())}`
        );
      }
      lineas.push(
        `SUMMARY:${textoICS(`${titulo} · ${nombre}`)}`,
        `DESCRIPTION:${textoICS(descripcion)}`,
        "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${textoICS(titulo)}`, "TRIGGER:-P1D", "END:VALARM",
        "END:VEVENT"
      );
    }
    lineas.push("END:VCALENDAR");
    return lineas.map(plegar).join("\r\n") + "\r\n";
  }

  return {
    VERSION,
    TIPOS_REQUISITO,
    INDICADORES,
    OPERADORES,
    UNIDADES,
    SUBSANABLE,
    TIPOS_HITO,
    DECISIONES,
    nuevoId,
    nuevo,
    normalizar,
    normalizarRequisito,
    normalizarHito,
    normalizarAnalisis,
    normalizarDecision,
    resumenDeProceso,
    aplicarExtraccion,
    ordenarHitos,
    diasParaHito,
    estadoHito,
    proximoHito,
    aICS,
  };
});
