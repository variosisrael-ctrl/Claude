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
    const params = {
      palabras: String(b.palabras ?? ""), codigos: String(b.codigos ?? ""), departamento: String(b.departamento ?? ""),
      min: String(b.min ?? ""), max: String(b.max ?? ""), dias: String(b.dias ?? DIAS_POR_DEFECTO),
      competitivos: String(b.competitivos ?? "1"), abiertos: "1",
    };
    if (!params.palabras.trim() && !params.codigos.trim()) {
      throw new ErrorDeAlertas(`La búsqueda #${i + 1} no es válida: Indica al menos una palabra clave o un código UNSPSC.`);
    }
    try {
      Secop.parsearPerfil(params); // reutiliza las mismas validaciones que la página
    } catch {
      // El mensaje de la validación repite lo escrito (p. ej. la palabra inválida) y los registros de Actions son públicos.
      throw new ErrorDeAlertas(
        `La búsqueda #${i + 1} no es válida: revisa que las palabras clave (letras, números, espacios y guiones), ` +
          "los códigos UNSPSC (4 a 8 dígitos) y el presupuesto estén bien escritos."
      );
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

function bloqueProceso(p, numero, hoy) {
  const lugar = [p.ciudad, p.departamento].filter(Boolean).join(", ");
  const enlace = p.url ? `\n<a href="${escaparAtributo(p.url)}">Ver en SECOP II</a>` : "";
  return (
    `${numero}. <b>${escaparHTML(recortar(p.nombre, 140))}</b>\n` +
    `${escaparHTML(p.entidad || "Entidad no informada")}${lugar ? " · " + escaparHTML(lugar) : ""}\n` +
    `${escaparHTML(dinero(p.presupuesto))} · ${escaparHTML(p.modalidad || "modalidad no informada")}\n` +
    `${escaparHTML(textoCierre(p.cierre, hoy))} · coincidencia ${p.puntaje} %${enlace}`
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

/** Arma los mensajes (cada uno por debajo del límite de Telegram) para los procesos nuevos de una búsqueda. */
function formatearMensajes(busqueda, procesos, { hoy, appUrl, limite = LIMITE_MENSAJE, porMensaje = MAXIMO_POR_MENSAJE } = {}) {
  const detallados = procesos.slice(0, MAXIMO_POR_BUSQUEDA);
  const restantes = procesos.length - detallados.length;
  const titulo =
    `<b>Radar SECOP: ${procesos.length} ${procesos.length === 1 ? "proceso nuevo" : "procesos nuevos"}</b>\n` +
    `Búsqueda: ${escaparHTML(busqueda.nombre)}`;
  const enlaceApp = enlaceDeLaApp(appUrl, busqueda);
  const pie =
    (restantes > 0 ? `\nY ${restantes} más.` : "") +
    (enlaceApp ? `\n<a href="${escaparAtributo(enlaceApp)}">Abrir esta búsqueda en el Radar</a>` : "");

  const mensajes = [];
  let actual = titulo;
  let enActual = 0;
  detallados.forEach((proceso, i) => {
    const bloque = bloqueProceso(proceso, i + 1, hoy);
    if (enActual > 0 && (actual.length + bloque.length + 2 > limite || enActual >= porMensaje)) {
      mensajes.push(actual);
      actual = `<b>Radar SECOP</b> (continuación)\nBúsqueda: ${escaparHTML(busqueda.nombre)}`;
      enActual = 0;
    }
    actual += `\n\n${bloque}`;
    enActual += 1;
  });
  mensajes.push(actual + (actual.length + pie.length <= limite ? pie : ""));
  if (actual.length + pie.length > limite && pie) mensajes.push(pie.trim());
  return mensajes;
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

/** Quita del estado lo que ya no hace falta recordar. */
function limpiarEstado(estado, hoyIso) {
  const limite = Date.parse(hoyIso) - DIAS_MEMORIA * 86_400_000;
  for (const vistos of Object.values(estado.vistos)) {
    for (const [id, fecha] of Object.entries(vistos)) {
      if (Date.parse(fecha) < limite) delete vistos[id];
    }
  }
}

/**
 * Corre todas las búsquedas. Devuelve el estado nuevo y un resumen con conteos (nunca nombres).
 * - Una búsqueda sin historial se "siembra" en silencio para no inundar el chat, salvo `enviarTodo`.
 * - Un proceso se marca como avisado solo si el mensaje se envió.
 */
async function ejecutar({ busquedas, estado, cliente, enviar, ahora = Date.now, appUrl = "", enviarTodo = false, simulacion = false, registrar = () => {} }) {
  const hoy = new Date(ahora());
  const hoyIso = Secop.fechaIso(hoy);
  const nuevoEstado = { version: 1, vistos: { ...(estado?.vistos ?? {}) }, activadas: estado?.activadas === true };
  const resumen = { busquedas: busquedas.length, nuevos: 0, mensajes: 0, sembradas: 0, fallos_consulta: 0, fallos_telegram: 0 };

  if (!nuevoEstado.activadas && !simulacion) {
    try {
      await enviar(
        `<b>Radar SECOP: alertas activadas</b>\nVigilo ${busquedas.length} ${busquedas.length === 1 ? "búsqueda" : "búsquedas"}: ` +
          `${busquedas.map((b) => escaparHTML(b.nombre)).join(", ")}.\n` +
          "Te aviso cuando aparezcan procesos nuevos. Los que ya están abiertos hoy no se reenvían."
      );
      nuevoEstado.activadas = true;
      resumen.mensajes += 1;
    } catch (error) {
      registrar(`No se pudo enviar el mensaje de bienvenida: ${error.message}`);
      resumen.fallos_telegram += 1;
    }
  }

  for (const busqueda of busquedas) {
    const clave = clavePorNombre(busqueda.nombre);
    let resultados;
    try {
      resultados = (await cliente.buscarOportunidades(busqueda.params)).resultados;
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

    if (esNueva && !enviarTodo) {
      nuevos.forEach((p) => { vistos[p.id] = hoyIso; });
      resumen.sembradas += 1;
      continue;
    }
    if (!nuevos.length) continue;

    try {
      const mensajes = formatearMensajes(busqueda, nuevos, { hoy, appUrl });
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

  limpiarEstado(nuevoEstado, hoyIso);
  return { estado: nuevoEstado, resumen };
}

module.exports = {
  ErrorDeAlertas, MINIMO_POR_DEFECTO, LIMITE_MENSAJE,
  leerBusquedas, formatearMensajes, enlaceDeLaApp, textoCierre, crearEnviadorTelegram, ejecutar, escaparHTML,
};
