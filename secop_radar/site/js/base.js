"use strict";

// Utilidades, estado y navegación compartidos por todas las pantallas. Los scripts son clásicos (sin módulos)
// para que la app también funcione abriendo index.html con doble clic, sin servidor.

const CLAVE_PERFIL = "radar-secop:perfil";
const CLAVE_SEGUIMIENTO = "radar-secop:seguimiento";
const CLAVE_BUSQUEDAS = "radar-secop:busquedas";
const CAMPOS_PERFIL = ["palabras", "codigos", "departamento", "min", "max", "dias"];
const CASILLAS_PERFIL = ["competitivos", "abiertos"]; // se guardan como "1" o "0"
const ESTADOS = ["Por revisar", "Preparando oferta", "Ofertada", "Ganada", "Perdida", "Descartada"];
const ESTADOS_SIN_PRESUPUESTO = ["Perdida", "Descartada"];
const POR_PAGINA = 25;

// Plantilla general. Cada proceso tiene sus propios requisitos: se confirman en el pliego de condiciones.
const REQUISITOS = [
  "RUP vigente (Registro Único de Proponentes), si el proceso lo exige",
  "Certificado de existencia y representación legal (Cámara de Comercio)",
  "RUT actualizado",
  "Antecedentes fiscales, disciplinarios, judiciales y de medidas correctivas (RNMC)",
  "Constancia de pago de seguridad social y aportes parafiscales",
  "Garantía de seriedad de la oferta, si el proceso la exige",
  "Certificaciones de experiencia que acrediten los requisitos habilitantes",
  "Oferta económica en el formato exacto del proceso",
  "Carta de presentación firmada por el representante legal",
  "Revisar adendas y cronograma vigente en SECOP II",
];

const $ = (selector) => document.querySelector(selector);
const formatoCOP = new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 });
const formatoNumero = new Intl.NumberFormat("es-CO");

const estado = {
  op: { datos: null, orden: "relevancia", visibles: POR_PAGINA, mostrados: [] },
  adj: { datos: null, meses: 6, visibles: POR_PAGINA },
  anioMercado: new Date().getFullYear() - 3,
  detalle: null,
  triaje: {}, // id de proceso -> evaluación de la IA (encaja, razón, alerta)
  ia: {}, // id de proceso -> análisis del pliego y su evaluación, mientras la página siga abierta
};

// Cada pantalla registra aquí lo que debe hacer al mostrarse y al iniciar la página.
const Radar = { alMostrar: {}, iniciadores: [], alAbrirDetalle: [] };
const registrarInicio = (funcion) => Radar.iniciadores.push(funcion);

// --- Almacenamiento local -----------------------------------------------------

function leer(clave, respaldo) {
  try {
    return JSON.parse(localStorage.getItem(clave)) ?? respaldo;
  } catch {
    return respaldo;
  }
}

function guardar(clave, valor) {
  try {
    localStorage.setItem(clave, JSON.stringify(valor));
  } catch {
    // Sin almacenamiento disponible (p. ej. ventana privada): la app sigue funcionando sin guardar.
  }
}

// --- Texto y formato ----------------------------------------------------------

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (texto) => String(texto ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

const mensaje = (texto, tipo = "info") => `<p class="mensaje ${tipo}">${esc(texto)}</p>`;
const dinero = (valor) => (valor ? formatoCOP.format(valor) : "No informado");
const porcentaje = (fraccion) => (fraccion === null || fraccion === undefined ? "—" : `${Math.round(fraccion * 100)} %`);
const recortar = (texto, largo) => (texto.length > largo ? texto.slice(0, largo).trimEnd() + "…" : texto);
const claseNivel = (puntaje) => (puntaje >= 70 ? "alto" : puntaje >= 40 ? "medio" : "bajo");
// Algunos procesos llegan sin código UNSPSC y la fuente escribe "UNSPECIFIED".
const categoriaLegible = (codigo) => (/^V1\.\d+$/.test(codigo || "") ? codigo : "No especificada");
const plural = (n, singular, pluralTexto) => `${formatoNumero.format(n)} ${n === 1 ? singular : pluralTexto}`;

function enlaceSecop(url) {
  return url && url.startsWith("https://")
    ? `<a class="boton" href="${esc(url)}" target="_blank" rel="noopener">Ver en SECOP II</a>`
    : "";
}

function fechaCorta(iso) {
  return iso
    ? new Date(iso + "T00:00:00").toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric" })
    : "—";
}

function textoPublicacion(iso) {
  if (!iso) return "Fecha no informada";
  const dias = Math.max(0, -Secop.diasHasta(iso, new Date()));
  return dias === 0 ? "Publicado hoy" : `Publicado hace ${plural(dias, "día", "días")}`;
}

/** Texto y estilo del plazo de recepción de ofertas, en días de calendario (hora de Colombia). */
function infoCierre(op) {
  const dias = Secop.diasHasta(op.cierre, new Date());
  if (dias === null) return { texto: "Cierre no informado", clase: "" };
  if (dias < 0) return { texto: `Cerró hace ${plural(-dias, "día", "días")}`, clase: "cerrado" };
  if (dias === 0) return { texto: "Cierra hoy", clase: "urgente" };
  if (dias === 1) return { texto: "Cierra mañana", clase: "urgente" };
  return { texto: `Cierra en ${dias} días (${fechaCorta(op.cierre)})`, clase: dias <= 3 ? "pronto" : "" };
}

// --- Perfil de búsqueda -------------------------------------------------------

const perfilDelFormulario = () => ({
  ...Object.fromEntries(CAMPOS_PERFIL.map((c) => [c, $("#" + c).value.trim()])),
  ...Object.fromEntries(CASILLAS_PERFIL.map((c) => [c, $("#" + c).checked ? "1" : "0"])),
});

const perfilTieneAlcance = (perfil) => Boolean(perfil.palabras || perfil.codigos);

function aplicarPerfilAlFormulario(perfil) {
  CAMPOS_PERFIL.forEach((campo) => {
    if (perfil[campo] !== undefined) $("#" + campo).value = perfil[campo];
  });
  CASILLAS_PERFIL.forEach((campo) => {
    $("#" + campo).checked = perfil[campo] !== "0";
  });
}

const aParametros = (valores) =>
  Object.fromEntries(Object.entries(valores).filter(([, valor]) => valor !== "" && valor !== undefined));

// --- Navegación ---------------------------------------------------------------

function mostrarPestana(nombre) {
  document.querySelectorAll(".pestanas button").forEach((boton) => {
    boton.setAttribute("aria-selected", String(boton.dataset.tab === nombre));
  });
  document.querySelectorAll(".vista").forEach((vista) => {
    vista.hidden = vista.id !== `vista-${nombre}`;
  });
  Radar.alMostrar[nombre]?.();
}

/** Busca un proceso por identificador en las listas cargadas (oportunidades, adjudicados y seguimiento). */
function buscarProceso(id) {
  return (
    estado.op.datos?.resultados.find((p) => p.id === id) ||
    estado.adj.datos?.resultados.find((p) => p.id === id) ||
    leer(CLAVE_SEGUIMIENTO, []).find((p) => p.id === id) ||
    null
  );
}
