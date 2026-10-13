"use strict";

const CLAVE_PERFIL = "radar-secop:perfil";
const CLAVE_SEGUIMIENTO = "radar-secop:seguimiento";
const CAMPOS_PERFIL = ["palabras", "codigos", "departamento", "min", "max", "dias"];
const ESTADOS = ["Por revisar", "Preparando oferta", "Ofertada", "Ganada", "Perdida", "Descartada"];
const ESTADOS_SIN_PRESUPUESTO = ["Perdida", "Descartada"];

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

const POR_PAGINA = 25;
const estado = {
  datosBusqueda: null,
  orden: "relevancia",
  visibles: POR_PAGINA,
  anioMercado: new Date().getFullYear() - 3,
};

// --- Utilidades ---------------------------------------------------------------

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

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (texto) => String(texto ?? "").replace(/[&<>"']/g, (c) => ESCAPES[c]);

const mensaje = (texto, tipo = "info") => `<p class="mensaje ${tipo}">${esc(texto)}</p>`;
const dinero = (valor) => (valor ? formatoCOP.format(valor) : "No informado");
const recortar = (texto, largo) => (texto.length > largo ? texto.slice(0, largo).trimEnd() + "…" : texto);
const claseNivel = (puntaje) => (puntaje >= 70 ? "alto" : puntaje >= 40 ? "medio" : "bajo");
// Algunos procesos llegan sin código UNSPSC y la fuente escribe "UNSPECIFIED".
const categoriaLegible = (codigo) => (/^V1\.\d+$/.test(codigo || "") ? codigo : "No especificada");

function enlaceSecop(url) {
  return url && url.startsWith("https://")
    ? `<a class="boton" href="${esc(url)}" target="_blank" rel="noopener">Ver en SECOP II</a>`
    : "";
}

function textoPublicacion(iso) {
  if (!iso) return "Fecha no informada";
  const dias = Math.max(0, Math.floor((Date.now() - new Date(iso + "T00:00:00").getTime()) / 86400000));
  if (dias === 0) return "Publicado hoy";
  return `Publicado hace ${dias} día${dias === 1 ? "" : "s"}`;
}

function fechaCorta(iso) {
  return new Date(iso + "T00:00:00").toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric" });
}

/** Texto y estilo del plazo de recepción de ofertas, en días de calendario (hora de Colombia). */
function infoCierre(op) {
  const dias = Secop.diasHasta(op.cierre, new Date());
  if (dias === null) return { texto: "Cierre no informado", clase: "" };
  if (dias < 0) return { texto: `Cerró hace ${-dias} día${dias === -1 ? "" : "s"}`, clase: "cerrado" };
  if (dias === 0) return { texto: "Cierra hoy", clase: "urgente" };
  if (dias === 1) return { texto: "Cierra mañana", clase: "urgente" };
  return { texto: `Cierra en ${dias} días (${fechaCorta(op.cierre)})`, clase: dias <= 3 ? "pronto" : "" };
}

const ORDENES = {
  relevancia: { etiqueta: "Relevancia", comparar: () => 0 },
  cierre: {
    etiqueta: "Cierra primero",
    comparar: (a, b) => (a.cierre || "9999").localeCompare(b.cierre || "9999") || b.puntaje - a.puntaje,
  },
  presupuesto: { etiqueta: "Mayor presupuesto", comparar: (a, b) => (b.presupuesto ?? -1) - (a.presupuesto ?? -1) },
  recientes: { etiqueta: "Más recientes", comparar: (a, b) => (b.publicado || "").localeCompare(a.publicado || "") },
};

// --- Perfil -------------------------------------------------------------------

const perfilDelFormulario = () => ({
  ...Object.fromEntries(CAMPOS_PERFIL.map((c) => [c, $("#" + c).value.trim()])),
  competitivos: $("#competitivos").checked ? "1" : "0",
  abiertos: $("#abiertos").checked ? "1" : "0",
});
const perfilTieneAlcance = (perfil) => Boolean(perfil.palabras || perfil.codigos);

function cargarPerfilEnFormulario() {
  const perfil = leer(CLAVE_PERFIL, {});
  CAMPOS_PERFIL.forEach((campo) => {
    if (perfil[campo] !== undefined) $("#" + campo).value = perfil[campo];
  });
  $("#competitivos").checked = perfil.competitivos !== "0";
  $("#abiertos").checked = perfil.abiertos !== "0";
}

const aParametros = (valores) =>
  Object.fromEntries(Object.entries(valores).filter(([, valor]) => valor !== "" && valor !== undefined));

// --- Oportunidades ------------------------------------------------------------

async function buscarOportunidades() {
  const perfil = perfilDelFormulario();
  guardar(CLAVE_PERFIL, perfil);
  const vista = $("#vista-oportunidades");
  mostrarPestana("oportunidades");

  if (!perfilTieneAlcance(perfil)) {
    vista.innerHTML = mensaje("Escribe al menos una palabra clave o un código UNSPSC en tu perfil y vuelve a buscar.");
    return;
  }
  vista.innerHTML = mensaje("Consultando SECOP II…");
  try {
    estado.datosBusqueda = await Secop.buscarOportunidades(aParametros(perfil));
    estado.visibles = POR_PAGINA;
    renderOportunidades();
  } catch (error) {
    vista.innerHTML = mensaje(error.message, "error");
  }
}

function renderOportunidades() {
  const datos = estado.datosBusqueda;
  const vista = $("#vista-oportunidades");
  const soloAbiertos = leer(CLAVE_PERFIL, {}).abiertos !== "0";
  if (!datos.resultados.length) {
    vista.innerHTML = mensaje(
      soloAbiertos
        ? "No hay procesos que sigan recibiendo ofertas y coincidan con tu perfil. Prueba con más palabras clave, " +
            "un prefijo de código más corto, más días de publicación o desmarca “Solo los que aún reciben ofertas”."
        : `No hay procesos publicados desde el ${fechaCorta(datos.desde)} que coincidan con tu perfil. ` +
            "Prueba con más palabras clave, un prefijo de código más corto, más días o un rango de presupuesto más amplio."
    );
    return;
  }

  const ordenados = [...datos.resultados].sort(ORDENES[estado.orden].comparar);
  const visibles = ordenados.slice(0, estado.visibles);
  vista.innerHTML = `
    ${datos.limite_alcanzado ? `<p class="aviso-limite">Tu perfil coincide con más de ${formatoNumero.format(datos.filas_revisadas)} procesos y solo
      revisamos ese tope. Estrecha las palabras clave, los códigos o el presupuesto para no perder ninguno.</p>` : ""}
    <div class="herramientas-lista">
      <p class="resumen">${datos.resultados.length} proceso${datos.resultados.length === 1 ? "" : "s"} coinciden con tu perfil
        (publicados desde el ${fechaCorta(datos.desde)}). El porcentaje indica qué tanto se parecen a tu perfil.</p>
      <label>Ordenar por
        <select id="orden">
          ${Object.entries(ORDENES).map(([clave, o]) => `<option value="${clave}" ${clave === estado.orden ? "selected" : ""}>${o.etiqueta}</option>`).join("")}
        </select>
      </label>
    </div>
    <div class="lista">${visibles.map(tarjetaOportunidad).join("")}</div>
    ${ordenados.length > visibles.length
      ? `<p class="mas"><button class="boton" data-mas>Mostrar más (${ordenados.length - visibles.length} restantes)</button></p>`
      : ""}`;
}

function tarjetaOportunidad(op) {
  const siguiendo = seguimiento().some((s) => s.id === op.id);
  const lugar = [op.ciudad, op.departamento].filter(Boolean).join(", ");
  return `
    <article class="tarjeta">
      <header class="tarjeta-cabecera">
        <span class="puntaje ${claseNivel(op.puntaje)}" title="Coincidencia con tu perfil">${op.puntaje}%</span>
        <span class="chip">${esc(op.modalidad || "Modalidad no informada")}</span>
        <span class="chip ${infoCierre(op).clase}">${esc(infoCierre(op).texto)}</span>
        ${op.adjudicado ? '<span class="chip cerrado">Ya adjudicado</span>' : ""}
        <span class="chip">${esc(textoPublicacion(op.publicado))}</span>
      </header>
      <h3>${esc(op.nombre)}</h3>
      <p class="entidad">${esc(op.entidad)}${lugar ? " · " + esc(lugar) : ""}</p>
      <p class="descripcion">${esc(recortar(op.descripcion, 260))}</p>
      <dl class="datos">
        <div><dt>Presupuesto</dt><dd>${esc(dinero(op.presupuesto))}</dd></div>
        <div><dt>Categoría UNSPSC</dt><dd>${esc(categoriaLegible(op.categoria))}</dd></div>
        <div><dt>Referencia</dt><dd>${esc(op.referencia || "—")}</dd></div>
      </dl>
      ${op.razones.length ? `<ul class="razones">${op.razones.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      <footer class="acciones">
        ${enlaceSecop(op.url)}
        <button class="boton" data-seguir="${esc(op.id)}" ${siguiendo ? "disabled" : ""}>
          ${siguiendo ? "En seguimiento" : "Seguir"}
        </button>
      </footer>
    </article>`;
}

// --- Seguimiento --------------------------------------------------------------

const seguimiento = () => leer(CLAVE_SEGUIMIENTO, []);

function actualizarConteo() {
  const total = seguimiento().length;
  $("#conteo-seguimiento").textContent = total ? String(total) : "";
}

function seguirOportunidad(id) {
  const lista = seguimiento();
  const op = estado.datosBusqueda?.resultados.find((o) => o.id === id);
  if (!op || lista.some((s) => s.id === id)) return;
  lista.unshift({
    id: op.id,
    nombre: op.nombre,
    entidad: op.entidad,
    referencia: op.referencia,
    presupuesto: op.presupuesto,
    url: op.url,
    estado: ESTADOS[0],
    nota: "",
    requisitos: REQUISITOS.map(() => false),
  });
  guardar(CLAVE_SEGUIMIENTO, lista);
  actualizarConteo();
  renderOportunidades();
}

function renderSeguimiento() {
  const vista = $("#vista-seguimiento");
  const lista = seguimiento();
  if (!lista.length) {
    vista.innerHTML = mensaje("Aún no sigues ningún proceso. Búscalos en Oportunidades y pulsa “Seguir”.");
    return;
  }
  const enJuego = lista
    .filter((s) => !ESTADOS_SIN_PRESUPUESTO.includes(s.estado))
    .reduce((total, s) => total + (s.presupuesto || 0), 0);
  vista.innerHTML = `
    <p class="resumen">Sigues ${lista.length} proceso${lista.length === 1 ? "" : "s"}.
      Presupuesto en juego (sin perdidos ni descartados): ${esc(formatoCOP.format(enJuego))}.</p>
    <div class="lista">${lista.map(tarjetaSeguimiento).join("")}</div>`;
}

function tarjetaSeguimiento(s) {
  return `
    <article class="tarjeta" data-id="${esc(s.id)}">
      <header class="tarjeta-cabecera">
        <label class="campo-inline">Estado
          <select data-campo="estado">
            ${ESTADOS.map((e) => `<option ${e === s.estado ? "selected" : ""}>${esc(e)}</option>`).join("")}
          </select>
        </label>
        <span class="chip" data-progreso>${s.requisitos.filter(Boolean).length} de ${REQUISITOS.length} requisitos listos</span>
      </header>
      <h3>${esc(s.nombre)}</h3>
      <p class="entidad">${esc(s.entidad)} · Ref. ${esc(s.referencia || "—")} · ${esc(dinero(s.presupuesto))}</p>
      <details>
        <summary>Requisitos de la oferta</summary>
        <ul class="requisitos">
          ${REQUISITOS.map((r, i) => `
            <li><label><input type="checkbox" data-requisito="${i}" ${s.requisitos[i] ? "checked" : ""}>${esc(r)}</label></li>`).join("")}
        </ul>
        <p class="ayuda">Plantilla general. Confirma cada requisito en el pliego de condiciones del proceso.</p>
      </details>
      <label>Notas
        <textarea data-campo="nota" rows="2">${esc(s.nota)}</textarea>
      </label>
      <footer class="acciones">
        ${enlaceSecop(s.url)}
        <button class="boton peligro" data-quitar="${esc(s.id)}">Quitar</button>
      </footer>
    </article>`;
}

function actualizarSeguimiento(id, cambiar) {
  const lista = seguimiento();
  const elemento = lista.find((s) => s.id === id);
  if (!elemento) return;
  cambiar(elemento);
  guardar(CLAVE_SEGUIMIENTO, lista);
}

function alCambiarSeguimiento(evento) {
  const tarjeta = evento.target.closest("[data-id]");
  if (!tarjeta) return;
  const id = tarjeta.dataset.id;
  const { campo, requisito } = evento.target.dataset;

  if (campo) {
    actualizarSeguimiento(id, (s) => { s[campo] = evento.target.value; });
    if (campo === "estado") renderSeguimiento();
  } else if (requisito !== undefined) {
    actualizarSeguimiento(id, (s) => { s.requisitos[Number(requisito)] = evento.target.checked; });
    const marcados = tarjeta.querySelectorAll("[data-requisito]:checked").length;
    tarjeta.querySelector("[data-progreso]").textContent = `${marcados} de ${REQUISITOS.length} requisitos listos`;
  }
}

function quitarSeguimiento(id) {
  guardar(CLAVE_SEGUIMIENTO, seguimiento().filter((s) => s.id !== id));
  actualizarConteo();
  renderSeguimiento();
}

// --- Mercado y competencia ----------------------------------------------------

const barra = (valor, maximo) => `<span class="barra" style="width:${maximo ? Math.round((valor / maximo) * 100) : 0}%"></span>`;

function tabla(titulo, encabezados, filas, celdas) {
  if (!filas.length) return `<section class="panel panel-tabla"><h3>${esc(titulo)}</h3>${mensaje("Sin datos para este criterio.")}</section>`;
  return `
    <section class="panel panel-tabla">
      <h3>${esc(titulo)}</h3>
      <table>
        <thead><tr>${encabezados.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
        <tbody>${filas.map((f) => `<tr>${celdas(f).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>
    </section>`;
}

async function cargarMercado() {
  const vista = $("#vista-mercado");
  const perfil = leer(CLAVE_PERFIL, {});
  if (!perfilTieneAlcance(perfil)) {
    vista.innerHTML = mensaje("Define palabras clave o códigos UNSPSC en tu perfil para ver el mercado de tu sector.");
    return;
  }

  const anioActual = new Date().getFullYear();
  const anios = Array.from({ length: 6 }, (_, i) => anioActual - 5 + i);
  vista.innerHTML = `
    <label class="barra-herramientas">Contratos firmados desde
      <select id="anio-mercado">
        ${anios.map((a) => `<option ${a === estado.anioMercado ? "selected" : ""}>${a}</option>`).join("")}
      </select>
    </label>
    <div id="contenido-mercado">${mensaje("Analizando contratos de millones de registros… la primera vez puede tardar hasta un minuto.")}</div>`;

  const contenido = $("#contenido-mercado");
  try {
    const parametros = aParametros({
      palabras: perfil.palabras,
      codigos: perfil.codigos,
      competitivos: perfil.competitivos,
      desde: estado.anioMercado,
    });
    contenido.innerHTML = renderMercado(await Secop.inteligenciaMercado(parametros));
  } catch (error) {
    contenido.innerHTML = mensaje(error.message, "error");
  }
}

function renderMercado(datos) {
  const maximo = (filas) => Math.max(0, ...filas.map((f) => f.contratos));
  const conBarra = (fila, tope) => `${formatoNumero.format(fila.contratos)}${barra(fila.contratos, tope)}`;
  const topeEntidades = maximo(datos.entidades);
  const topeProveedores = maximo(datos.proveedores);
  const topeModalidades = maximo(datos.modalidades);

  const sufijo = datos.competitivos ? " (solo procesos competitivos)" : "";
  return `
    <div class="columnas">
      ${tabla("Entidades que más contratan" + sufijo, ["Entidad", "Contratos", "Valor total"], datos.entidades, (f) => [
        esc(f.nombre), conBarra(f, topeEntidades), esc(formatoCOP.format(f.valor)),
      ])}
      ${tabla("Proveedores con más contratos: tu competencia" + sufijo, ["Proveedor", "NIT / cédula", "Contratos", "Valor total"], datos.proveedores, (f) => [
        esc(f.nombre), esc(f.documento), conBarra(f, topeProveedores), esc(formatoCOP.format(f.valor)),
      ])}
      ${tabla("Todas las modalidades usadas en tu sector", ["Modalidad", "Contratos"], datos.modalidades, (f) => [
        esc(f.nombre), conBarra(f, topeModalidades),
      ])}
    </div>
    <p class="aviso">Contratos firmados desde ${datos.desde} en SECOP II. Se excluyen valores atípicos mayores a
      100 billones de COP (errores de digitación en la fuente). Los proveedores se agrupan por NIT o cédula.
      La tabla de modalidades muestra todo el mercado para que veas cuánto es contratación directa, que no se disputa.</p>`;
}

// --- Navegación e inicio ------------------------------------------------------

function mostrarPestana(nombre) {
  document.querySelectorAll(".pestanas button").forEach((boton) => {
    boton.setAttribute("aria-selected", String(boton.dataset.tab === nombre));
  });
  document.querySelectorAll(".vista").forEach((vista) => {
    vista.hidden = vista.id !== `vista-${nombre}`;
  });
  if (nombre === "mercado") cargarMercado();
  if (nombre === "seguimiento") renderSeguimiento();
}

function iniciar() {
  cargarPerfilEnFormulario();
  actualizarConteo();

  $("#formulario").addEventListener("submit", (evento) => {
    evento.preventDefault();
    buscarOportunidades();
  });
  document.querySelectorAll(".pestanas button").forEach((boton) => {
    boton.addEventListener("click", () => mostrarPestana(boton.dataset.tab));
  });
  $("#vista-oportunidades").addEventListener("click", (evento) => {
    const id = evento.target.closest("[data-seguir]")?.dataset.seguir;
    if (id) seguirOportunidad(id);
    if (evento.target.closest("[data-mas]")) {
      estado.visibles += POR_PAGINA;
      renderOportunidades();
    }
  });
  $("#vista-oportunidades").addEventListener("change", (evento) => {
    if (evento.target.id !== "orden") return;
    estado.orden = evento.target.value;
    estado.visibles = POR_PAGINA;
    renderOportunidades();
  });
  $("#vista-mercado").addEventListener("change", (evento) => {
    if (evento.target.id !== "anio-mercado") return;
    estado.anioMercado = Number(evento.target.value);
    cargarMercado();
  });
  $("#vista-seguimiento").addEventListener("change", alCambiarSeguimiento);
  $("#vista-seguimiento").addEventListener("click", (evento) => {
    const id = evento.target.closest("[data-quitar]")?.dataset.quitar;
    if (id) quitarSeguimiento(id);
  });

  if (perfilTieneAlcance(leer(CLAVE_PERFIL, {}))) {
    buscarOportunidades();
  } else {
    $("#vista-oportunidades").innerHTML = mensaje(
      "Completa tu perfil a la izquierda (palabras clave y/o códigos UNSPSC) y pulsa “Buscar oportunidades”."
    );
  }
}

document.addEventListener("DOMContentLoaded", iniciar);
