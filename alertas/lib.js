"use strict";

// Motor de alertas: busca oportunidades nuevas con las búsquedas del equipo y las avisa por Telegram.
// Reutiliza la misma lógica de datos que la página (secop_radar/site/secop.js). Sin dependencias.
//
// Privacidad: el repositorio y los registros de GitHub Actions son públicos, así que este código nunca imprime
// nombres de procesos ni de búsquedas en los registros (`registrar` solo recibe conteos).

const Secop = require("../secop_radar/site/secop.js");

const MAXIMO_BUSQUEDAS = 20;
const MAXIMO_POR_BUSQUEDA = 20; // procesos nuevos que se detallan por búsqueda y por ejecución
const LIMITE_MENSAJE = 3800; // Telegram admite 4096 caracteres por mensaje
const MAXIMO_POR_MENSAJE = 8;
const DIAS_MEMORIA = 120; // cuánto se recuerda un proceso ya avisado
const MINIMO_POR_DEFECTO = 40;
const DIAS_POR_DEFECTO = "15";
const DIAS_RESUMEN_POR_DEFECTO = "3"; // ventana del resumen: cubre fines de semana y el retraso con que SECOP II publica sus datos
const TOP_RESUMEN_POR_DEFECTO = 15;
const TOP_RESUMEN_MAXIMO = 30;
const HORA_RESUMEN_HASTA = 12; // el resumen sale en la ejecución de la mañana (7:00 en Colombia), no en la de la tarde

class ErrorDeAlertas extends Error {
  constructor(mensaje) {
    super(mensaje);
    this.name = "ErrorDeAlertas";
  }
}

// --- Configuración -------------------------------------------------------------

const clavePorNombre = (nombre) => String(nombre).trim().toLowerCase();

/** Lee y valida el JSON de búsquedas. Los mensajes de error no repiten el contenido (puede ser sensible). */
function leerBusquedas(texto) {
  let datos;
  try {
    datos = JSON.parse(texto);
  } catch {
    throw new ErrorDeAlertas("ALERTAS_BUSQUEDAS no es un JSON válido. Cópialo desde la pestaña “Mis búsquedas” de la app.");
  }
  if (!Array.isArray(datos) || !datos.length) {
    throw new ErrorDeAlertas("ALERTAS_BUSQUEDAS debe ser una lista con al menos una búsqueda.");
  }
  if (datos.length > MAXIMO_BUSQUEDAS) {
    throw new ErrorDeAlertas(`ALERTAS_BUSQUEDAS admite como máximo ${MAXIMO_BUSQUEDAS} búsquedas.`);
  }

  const nombres = new Set();
  return datos.map((b, i) => {
    const nombre = String(b?.nombre ?? "").trim();
    if (!nombre) throw new ErrorDeAlertas(`La búsqueda #${i + 1} no tiene nombre.`);
    if (nombres.has(clavePorNombre(nombre))) throw new ErrorDeAlertas(`La búsqueda #${i + 1} repite un nombre ya usado.`);
    nombres.add(clavePorNombre(nombre));
    const resumen = b.resumen === true;
    const params = {
      palabras: String(b.palabras ?? ""), codigos: String(b.codigos ?? ""), departamento: String(b.departamento ?? ""),
      min: String(b.min ?? ""), max: String(b.max ?? ""), dias: String(b.dias ?? (resumen ? DIAS_RESUMEN_POR_DEFECTO : DIAS_POR_DEFECTO)),
      competitivos: String(b.competitivos ?? "1"), abiertos: "1",
    };
    if (!resumen && !params.palabras.trim() && !params.codigos.trim()) {
      throw new ErrorDeAlertas(`La búsqueda #${i + 1} no es válida: Indica al menos una palabra clave o un código UNSPSC.`);
    }
    try {
      Secop.parsearPerfil(params, { amplio: resumen }); // reutiliza las mismas validaciones que la página
    } catch {
      // El mensaje de la validación repite lo escrito (p. ej. la palabra inválida) y los registros de Actions son públicos.
      throw new ErrorDeAlertas(
        `La búsqueda #${i + 1} no es válida: revisa que las palabras clave (letras, números, espacios y guiones), ` +
          "los códigos UNSPSC (4 a 8 dígitos) y el presupuesto estén bien escritos."
      );
    }
    if (resumen) {
      // El resumen no puntúa por coincidencia: muestra los procesos nuevos de mayor presupuesto.
      const top = b.top === undefined ? TOP_RESUMEN_POR_DEFECTO : Number(b.top);
      if (!Number.isInteger(top) || top < 1 || top > TOP_RESUMEN_MAXIMO) {
        throw new ErrorDeAlertas(`La búsqueda #${i + 1} tiene un "top" fuera de 1 a ${TOP_RESUMEN_MAXIMO}.`);
      }
      return { nombre, params, minimo: 0, resumen: true, top };
    }
    const minimo = b.minimo === undefined ? MINIMO_POR_DEFECTO : Number(b.minimo);
    if (!Number.isFinite(minimo) || minimo < 0 || minimo > 100) {
      throw new ErrorDeAlertas(`La búsqueda #${i + 1} tiene un "minimo" fuera de 0 a 100.`);
    }
    return { nombre, params, minimo };
  });
}

// --- Mensajes de Telegram (formato HTML) ---------------------------------------

const escaparHTML = (texto) => String(texto ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escaparAtributo = (texto) => escaparHTML(texto).replace(/"/g, "&quot;");
const recortar = (texto, largo) => (texto.length > largo ? texto.slice(0, largo - 1).trimEnd() + "…" : texto);

const formatoFecha = new Intl.DateTimeFormat("es-CO", { day: "numeric", month: "short", timeZone: "UTC" });
const dinero = (valor) => (valor ? `$ ${Math.round(valor).toLocaleString("es-CO")}` : "presupuesto no informado");

function textoCierre(cierre, hoy) {
  const dias = Secop.diasHasta(cierre, hoy);
  if (dias === null) return "cierre no informado";
  if (dias <= 0) return "cierra hoy";
  if (dias === 1) return "cierra mañana";
  return `cierra en ${dias} días (${formatoFecha.format(new Date(cierre + "T00:00:00Z"))})`;
}

function bloqueProceso(p, numero, hoy, { coincidencia = true } = {}) {
  const lugar = [p.ciudad, p.departamento].filter(Boolean).join(", ");
  const enlace = p.url ? `\n<a href="${escaparAtributo(p.url)}">Ver en SECOP II</a>` : "";
  return (
    `${numero}. <b>${escaparHTML(recortar(p.nombre, 140))}</b>\n` +
    `${escaparHTML(p.entidad || "Entidad no informada")}${lugar ? " · " + escaparHTML(lugar) : ""}\n` +
    `${escaparHTML(dinero(p.presupuesto))} · ${escaparHTML(p.modalidad || "modalidad no informada")}\n` +
    `${escaparHTML(textoCierre(p.cierre, hoy))}${coincidencia ? ` · coincidencia ${p.puntaje} %` : ""}${enlace}`
  );
}

/** Enlace a la app con la misma búsqueda ya escrita (el mismo formato de "Copiar enlace"). */
function enlaceDeLaApp(appUrl, busqueda) {
  if (!appUrl) return null;
  const p = busqueda.params;
  const parametros = new URLSearchParams(
    Object.fromEntries(Object.entries({ ...p }).filter(([, valor]) => valor !== ""))
  );
  return `${appUrl.replace(/[?#].*$/, "")}?${parametros}`;
}

/**
 * Reparte los bloques en mensajes que no pasen el límite de Telegram. El título va en el primero, `continuacion`
 * encabeza los siguientes y el pie va al final (en un mensaje aparte si ya no cabe).
 */
function empaquetar({ titulo, continuacion, bloques, pie, limite, porMensaje }) {
  const mensajes = [];
  let actual = titulo;
  let enActual = 0;
  bloques.forEach((bloque) => {
    if (enActual > 0 && (actual.length + bloque.length + 2 > limite || enActual >= porMensaje)) {
      mensajes.push(actual);
      actual = continuacion;
      enActual = 0;
    }
    actual += `\n\n${bloque}`;
    enActual += 1;
  });
  mensajes.push(actual + (actual.length + pie.length <= limite ? pie : ""));
  if (actual.length + pie.length > limite && pie) mensajes.push(pie.trim());
  return mensajes;
}

/** Arma los mensajes (cada uno por debajo del límite de Telegram) para los procesos nuevos de una búsqueda. */
function formatearMensajes(busqueda, procesos, { hoy, appUrl, limite = LIMITE_MENSAJE, porMensaje = MAXIMO_POR_MENSAJE } = {}) {
  const detallados = procesos.slice(0, MAXIMO_POR_BUSQUEDA);
  const restantes = procesos.length - detallados.length;
  const enlaceApp = enlaceDeLaApp(appUrl, busqueda);
  return empaquetar({
    titulo:
      `<b>Radar SECOP: ${procesos.length} ${procesos.length === 1 ? "proceso nuevo" : "procesos nuevos"}</b>\n` +
      `Búsqueda: ${escaparHTML(busqueda.nombre)}`,
    continuacion: `<b>Radar SECOP</b> (continuación)\nBúsqueda: ${escaparHTML(busqueda.nombre)}`,
    bloques: detallados.map((proceso, i) => bloqueProceso(proceso, i + 1, hoy)),
    pie:
      (restantes > 0 ? `\nY ${restantes} más.` : "") +
      (enlaceApp ? `\n<a href="${escaparAtributo(enlaceApp)}">Abrir esta búsqueda en el Radar</a>` : ""),
    limite,
    porMensaje,
  });
}

/**
 * Resumen diario: cuántos procesos nuevos hay, cómo se reparten por modalidad y los de mayor presupuesto.
 * Sirve para estar atento a todo el mercado sin recibir un aviso por proceso.
 */
function formatearResumen(busqueda, procesos, { hoy, appUrl, limiteAlcanzado = false, limite = LIMITE_MENSAJE, porMensaje = MAXIMO_POR_MENSAJE } = {}) {
  const porPresupuesto = [...procesos].sort((a, b) => (b.presupuesto ?? -1) - (a.presupuesto ?? -1));
  const destacados = porPresupuesto.slice(0, busqueda.top ?? TOP_RESUMEN_POR_DEFECTO);

  const porModalidad = new Map();
  for (const p of procesos) {
    const modalidad = p.modalidad || "Modalidad no informada";
    porModalidad.set(modalidad, (porModalidad.get(modalidad) ?? 0) + 1);
  }
  const modalidades = [...porModalidad.entries()].sort((a, b) => b[1] - a[1]);
  const lineaModalidades = modalidades.slice(0, 5).map(([nombre, n]) => `${escaparHTML(nombre)}: ${n}`).join(" · ") +
    (modalidades.length > 5 ? ` · otras: ${modalidades.slice(5).reduce((suma, [, n]) => suma + n, 0)}` : "");

  const filtros = [
    busqueda.params.departamento && `departamento: ${busqueda.params.departamento}`,
    busqueda.params.min && `desde ${dinero(Number(busqueda.params.min))}`,
    busqueda.params.max && `hasta ${dinero(Number(busqueda.params.max))}`,
  ].filter(Boolean);
  const encabezado =
    `<b>Radar SECOP: resumen de ${procesos.length} ${procesos.length === 1 ? "proceso nuevo" : "procesos nuevos"}</b>\n` +
    `${escaparHTML(busqueda.nombre)}${filtros.length ? ` (${escaparHTML(filtros.join(", "))})` : ""}\n` +
    `${lineaModalidades}\n` +
    `Los ${destacados.length === 1 ? "de mayor presupuesto" : `${destacados.length} de mayor presupuesto`}:` +
    (limiteAlcanzado ? "\n(Había más procesos de los que se pueden revisar de una vez; el resumen puede estar incompleto.)" : "");

  const apertura = appUrl ? `\n<a href="${escaparAtributo(appUrl.replace(/[?#].*$/, ""))}">Buscar en el Radar</a>` : "";
  return empaquetar({
    titulo: encabezado,
    continuacion: `<b>Radar SECOP</b> (continuación del resumen)`,
    bloques: destacados.map((proceso, i) => bloqueProceso(proceso, i + 1, hoy, { coincidencia: false })),
    pie: apertura,
    limite,
    porMensaje,
  });
}

// --- Seguimiento de procesos ------------------------------------------------------

const ESTADOS_QUE_SE_AVISAN = ["Cancelado", "Suspendido"];
const fechaLarga = (iso) => (iso ? formatoFecha.format(new Date(iso + "T00:00:00Z")) : "sin fecha");

/**
 * Qué cambió en un proceso seguido. `previo` es lo último que se vio de él o, la primera vez, lo que se sabía al
 * seguirlo ({cierre, adjudicado, estado_proc}); `actual` es el proceso tal como está hoy en SECOP II.
 */
function cambiosDeProceso(previo, actual) {
  const cambios = [];
  if (previo.cierre && actual.cierre && previo.cierre !== actual.cierre) {
    cambios.push({ tipo: "cierre", de: previo.cierre, a: actual.cierre });
  }
  if (!previo.adjudicado && actual.adjudicado) {
    cambios.push({ tipo: "adjudicado", ganador: actual.ganador, valor: actual.valor_adjudicado });
  }
  const estado = actual.estado_procedimiento;
  if (estado && estado !== previo.estado_proc && ESTADOS_QUE_SE_AVISAN.includes(estado)) {
    cambios.push({ tipo: "estado", estado });
  }
  return cambios;
}

function bloqueCambios({ proceso, seguido, cambios }, numero) {
  const lineas = cambios.map((c) => {
    if (c.tipo === "cierre") return `• Cambió la fecha de cierre: ${fechaLarga(c.de)} → ${fechaLarga(c.a)}`;
    if (c.tipo === "adjudicado") {
      return `• Fue adjudicado${c.ganador ? ` a ${escaparHTML(c.ganador)}` : ""}${c.valor ? ` por ${escaparHTML(dinero(c.valor))}` : ""}`;
    }
    return `• Quedó ${escaparHTML(c.estado.toLowerCase())}`;
  });
  const nombre = proceso.nombre || seguido.nombre || "Proceso sin nombre";
  const entidad = proceso.entidad || seguido.entidad;
  const enlace = proceso.url ? `\n<a href="${escaparAtributo(proceso.url)}">Ver en SECOP II</a>` : "";
  return `${numero}. <b>${escaparHTML(recortar(nombre, 140))}</b>${entidad ? `\n${escaparHTML(entidad)}` : ""}\n${lineas.join("\n")}${enlace}`;
}

/** Mensajes con los cambios de los procesos que la persona sigue (uno o varios, según el límite de Telegram). */
function formatearCambios(avisos, { limite = LIMITE_MENSAJE, porMensaje = MAXIMO_POR_MENSAJE } = {}) {
  return empaquetar({
    titulo: `<b>Radar SECOP: ${avisos.length === 1 ? "cambió un proceso que sigues" : `cambiaron ${avisos.length} procesos que sigues`}</b>`,
    continuacion: "<b>Radar SECOP</b> (continuación de los cambios)",
    bloques: avisos.map((aviso, i) => bloqueCambios(aviso, i + 1)),
    pie: "",
    limite,
    porMensaje,
  });
}

// --- Telegram -------------------------------------------------------------------

/** Devuelve una función que envía un mensaje. Los errores no incluyen el token. */
function crearEnviadorTelegram({ token, chatId, base = "https://api.telegram.org", fetchFn = (...a) => globalThis.fetch(...a), esperar = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  return async function enviar(texto, intento = 0) {
    let respuesta;
    try {
      respuesta = await fetchFn(`${base}/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: texto, parse_mode: "HTML", disable_web_page_preview: true }),
      });
    } catch {
      throw new ErrorDeAlertas("No se pudo conectar con Telegram.");
    }
    const cuerpo = await respuesta.json().catch(() => ({}));
    if (respuesta.status === 429 && intento < 2) {
      await esperar(((cuerpo.parameters?.retry_after ?? 5) + 1) * 1000);
      return enviar(texto, intento + 1);
    }
    if (!respuesta.ok || cuerpo.ok === false) {
      throw new ErrorDeAlertas(`Telegram respondió ${respuesta.status}: ${cuerpo.description || "sin detalle"}.`);
    }
  };
}

// --- Ejecución -------------------------------------------------------------------

const formatoHoraBogota = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: "America/Bogota" });
/** Hora (0 a 23) en Colombia, sin importar la zona horaria del servidor. */
const horaEnBogota = (fecha) => Number(formatoHoraBogota.format(fecha));

/** Quita del estado lo que ya no hace falta recordar. */
function limpiarEstado(estado, hoyIso) {
  const limite = Date.parse(hoyIso) - DIAS_MEMORIA * 86_400_000;
  for (const vistos of Object.values(estado.vistos)) {
    for (const [id, fecha] of Object.entries(vistos)) {
      if (Date.parse(fecha) < limite) delete vistos[id];
    }
  }
}

function mensajeDeBienvenida(busquedas, haySeguimiento) {
  const porTema = busquedas.filter((b) => !b.resumen);
  const partes = ["<b>Radar SECOP: alertas activadas</b>"];
  if (busquedas.length) {
    partes.push(
      `Vigilo ${busquedas.length} ${busquedas.length === 1 ? "búsqueda" : "búsquedas"}: ${busquedas.map((b) => escaparHTML(b.nombre)).join(", ")}.`
    );
  }
  const avisos = [];
  if (porTema.length) avisos.push("Te aviso cuando aparezcan procesos nuevos. Los que ya están abiertos hoy no se reenvían.");
  if (busquedas.some((b) => b.resumen)) avisos.push("Cada mañana recibirás un resumen de los procesos nuevos del país.");
  if (haySeguimiento) avisos.push("También te aviso si cambia un proceso que sigues (cierre, adjudicación o cancelación).");
  return [...partes, avisos.join(" ")].filter(Boolean).join("\n");
}

/**
 * Compara los procesos que la persona sigue con su estado actual en SECOP II y avisa lo que cambió. Un cambio solo se
 * da por avisado si el mensaje se envió; lo demás actualiza la última foto de cada proceso.
 */
async function revisarSeguimiento({ seguimiento, cliente, enviar, nuevoEstado, previas, resumen, simulacion, registrar }) {
  resumen.seguimiento = { revisados: 0, avisados: 0, fallos: 0 };
  if (!seguimiento.length) {
    nuevoEstado.seguimiento = {}; // ya no se sigue nada: se olvida lo anterior
    return;
  }

  let actuales;
  try {
    actuales = await cliente.buscarProcesosPorId(seguimiento.map((p) => p.id));
  } catch (error) {
    registrar(`No se pudo revisar el seguimiento en SECOP II: ${error.message}`);
    resumen.seguimiento.fallos += 1;
    return; // se conserva lo último que se vio y se reintenta en la siguiente ejecución
  }

  const fotos = {};
  const avisos = [];
  for (const seguido of seguimiento) {
    const actual = actuales.get(seguido.id);
    const previo = previas[seguido.id] ?? { cierre: seguido.cierre ?? null, adjudicado: false, estado_proc: null };
    if (!actual) {
      fotos[seguido.id] = previas[seguido.id] ?? previo; // SECOP II aún no lo publica en los datos abiertos
      continue;
    }
    resumen.seguimiento.revisados += 1;
    fotos[seguido.id] = { cierre: actual.cierre, adjudicado: actual.adjudicado, estado_proc: actual.estado_procedimiento };
    const cambios = cambiosDeProceso(previo, actual);
    if (cambios.length) avisos.push({ proceso: actual, seguido, cambios, previo });
  }

  if (avisos.length) {
    try {
      const mensajes = formatearCambios(avisos);
      if (simulacion) mensajes.forEach((m) => registrar(m));
      else for (const mensaje of mensajes) await enviar(mensaje);
      resumen.seguimiento.avisados = avisos.length;
      resumen.nuevos += avisos.length;
      resumen.mensajes += mensajes.length;
    } catch (error) {
      registrar(`No se pudieron avisar los cambios del seguimiento: ${error.message}`);
      resumen.fallos_telegram += 1;
      for (const { seguido, previo } of avisos) fotos[seguido.id] = previo; // se reintenta en la siguiente ejecución
    }
  }
  nuevoEstado.seguimiento = fotos;
}

/**
 * Corre todas las búsquedas. Devuelve el estado nuevo y un resumen con conteos (nunca nombres).
 * - Una búsqueda sin historial se "siembra" en silencio para no inundar el chat, salvo `enviarTodo`.
 * - Un proceso se marca como avisado solo si el mensaje se envió.
 * - Una búsqueda de tipo resumen sale una vez al día (en la ejecución de la mañana, o en cualquiera si es manual) y
 *   cubre los procesos nuevos desde el resumen anterior; su primer resumen no se siembra en silencio.
 */
async function ejecutar({ busquedas, seguimiento, estado, cliente, enviar, ahora = Date.now, appUrl = "", enviarTodo = false, manual = false, simulacion = false, registrar = () => {} }) {
  const hoy = new Date(ahora());
  const hoyIso = Secop.fechaIso(hoy);
  const tocaResumen = manual || enviarTodo || horaEnBogota(hoy) < HORA_RESUMEN_HASTA;
  const nuevoEstado = { version: 1, vistos: { ...(estado?.vistos ?? {}) }, activadas: estado?.activadas === true, seguimiento: { ...(estado?.seguimiento ?? {}) } };
  const resumen = { busquedas: busquedas.length, nuevos: 0, mensajes: 0, sembradas: 0, fallos_consulta: 0, fallos_telegram: 0 };
  const procesosSeguidos = seguimiento?.length ?? 0;

  if (!nuevoEstado.activadas && !simulacion) {
    try {
      await enviar(mensajeDeBienvenida(busquedas, procesosSeguidos > 0));
      nuevoEstado.activadas = true;
      resumen.mensajes += 1;
    } catch (error) {
      registrar(`No se pudo enviar el mensaje de bienvenida: ${error.message}`);
      resumen.fallos_telegram += 1;
    }
  }

  for (const busqueda of busquedas) {
    if (busqueda.resumen && !tocaResumen) continue; // el resumen de la mañana cubre también lo publicado en la tarde
    const clave = busqueda.clave ?? clavePorNombre(busqueda.nombre);
    let resultados;
    let limiteAlcanzado = false;
    try {
      const respuesta = await cliente.buscarOportunidades(busqueda.params, { amplio: Boolean(busqueda.resumen) });
      resultados = respuesta.resultados;
      limiteAlcanzado = Boolean(respuesta.limite_alcanzado);
    } catch (error) {
      registrar(`Una búsqueda falló al consultar SECOP II: ${error.message}`);
      resumen.fallos_consulta += 1;
      continue;
    }

    const esNueva = !(clave in nuevoEstado.vistos);
    const vistos = (nuevoEstado.vistos[clave] = { ...(nuevoEstado.vistos[clave] ?? {}) });
    const candidatos = resultados.filter((p) => p.puntaje >= busqueda.minimo);
    const nuevos = candidatos
      .filter((p) => !(p.id in vistos))
      .sort((a, b) => (a.cierre || "9999").localeCompare(b.cierre || "9999") || b.puntaje - a.puntaje);

    if (esNueva && !enviarTodo && !busqueda.resumen) {
      nuevos.forEach((p) => { vistos[p.id] = hoyIso; });
      resumen.sembradas += 1;
      continue;
    }
    if (!nuevos.length) continue;

    try {
      const mensajes = busqueda.resumen
        ? formatearResumen(busqueda, nuevos, { hoy, appUrl, limiteAlcanzado })
        : formatearMensajes(busqueda, nuevos, { hoy, appUrl });
      if (simulacion) {
        mensajes.forEach((m) => registrar(m));
      } else {
        for (const mensaje of mensajes) await enviar(mensaje);
      }
      nuevos.forEach((p) => { vistos[p.id] = hoyIso; });
      resumen.nuevos += nuevos.length;
      resumen.mensajes += mensajes.length;
    } catch (error) {
      registrar(`No se pudo avisar una búsqueda: ${error.message}`);
      resumen.fallos_telegram += 1;
    }
  }

  if (seguimiento) await revisarSeguimiento({ seguimiento, cliente, enviar, nuevoEstado, previas: estado?.seguimiento ?? {}, resumen, simulacion, registrar });

  limpiarEstado(nuevoEstado, hoyIso);
  return { estado: nuevoEstado, resumen };
}

module.exports = {
  ErrorDeAlertas, MINIMO_POR_DEFECTO, LIMITE_MENSAJE,
  leerBusquedas, formatearMensajes, formatearResumen, formatearCambios, cambiosDeProceso, mensajeDeBienvenida, horaEnBogota, enlaceDeLaApp, textoCierre, crearEnviadorTelegram, ejecutar, escaparHTML,
};
