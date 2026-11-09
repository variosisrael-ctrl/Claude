"use strict";

// Expediente dentro del detalle de un proceso: requisitos del pliego validados por una persona, verificación de
// habilitantes contra los datos de la empresa, cronograma con calendario y registro de la decisión de ofertar.
// La lógica está en expediente.js, habilitantes.js y almacen.js; aquí solo hay interfaz.

let expediente = null; // el del proceso que está abierto en el detalle
let requisitoAbierto = null; // id del requisito cuyo formulario de corrección debe seguir abierto al redibujar

const CLASES_RESULTADO = {
  cumple: ["Cumple", "bueno"], no_cumple: ["No cumple", "urgente"],
  falta_dato: ["Falta un dato", "pronto"], manual: ["Por revisar", "pronto"],
};
const CLASES_FACTOR = { bueno: "bueno", medio: "pronto", malo: "urgente", sin_datos: "cerrado" };
const NIVEL_RECOMENDACION = { ofertar: "baja", revisar: "media", no_ofertar: "alta", sin_datos: "sin-datos" };

const expedienteVigente = (proceso) => expediente && proceso && expediente.id === String(proceso.id) && detalleVigente(proceso.id);
const opciones = (mapa, elegido) =>
  Object.entries(mapa).map(([valor, etiqueta]) => `<option value="${esc(valor)}" ${valor === elegido ? "selected" : ""}>${esc(etiqueta)}</option>`).join("");

// --- Carga y guardado ---------------------------------------------------------

async function guardarExpediente() {
  const actual = expediente; // la persona puede cerrar el detalle mientras se guarda
  const almacen = await abrirAlmacen();
  const guardado = await almacen.guardar(actual);
  if (expediente === actual) expediente.actualizado = guardado.actualizado;
}

/** Dónde está el cursor dentro del expediente, para devolverlo allí después de redibujar. */
function selectorDelFoco() {
  const activo = document.activeElement;
  if (!activo?.closest?.("#detalle-expediente")) return null;
  const fila = activo.closest("[data-requisito-id], [data-hito-id]");
  const { campoRequisito, campoHito } = activo.dataset;
  if (!fila || !(campoRequisito || campoHito)) return activo.id ? `#${activo.id}` : null;
  return fila.dataset.requisitoId
    ? `[data-requisito-id="${fila.dataset.requisitoId}"] [data-campo-requisito="${campoRequisito}"]`
    : `[data-hito-id="${fila.dataset.hitoId}"] [data-campo-hito="${campoHito}"]`;
}

/** Aplica un cambio al expediente abierto, lo guarda y redibuja la sección. */
function cambiarExpediente(proceso, cambiar) {
  cambiar(expediente);
  expediente = Expediente.normalizar(expediente);
  guardarExpediente().catch((error) => estadoExpediente(`No se pudo guardar: ${error.message}`, true));
  // Se redibuja un instante después: al pasar de un campo a otro con el tabulador, el cursor ya está en el siguiente.
  setTimeout(() => {
    const foco = selectorDelFoco();
    dibujarExpediente(proceso);
    if (foco) $(`#detalle-expediente ${foco}`)?.focus();
  }, 0);
}

/** La IA terminó un análisis o una evaluación: se guarda aunque la persona ya haya cerrado el detalle. */
async function guardarAnalisisEnExpediente(proceso) {
  const analisis = Expediente.normalizarAnalisis(estado.ia[proceso.id]);
  if (!analisis) return;
  try {
    const almacen = await abrirAlmacen();
    if (expedienteVigente(proceso)) {
      expediente.analisis = analisis;
      await guardarExpediente();
      dibujarExpediente(proceso);
    } else {
      const guardado = (await almacen.leer(proceso.id)) || Expediente.nuevo(proceso);
      await almacen.guardar({ ...guardado, analisis });
    }
  } catch {
    // Sin almacenamiento el análisis sigue disponible mientras la página esté abierta.
  }
}

async function montarExpediente(proceso) {
  const caja = $("#detalle-expediente");
  expediente = null;
  caja.innerHTML = "";
  if (!proceso.id) return;
  let almacen;
  let guardado = null;
  try {
    almacen = await abrirAlmacen();
    guardado = await almacen.leer(proceso.id);
  } catch {
    guardado = null;
  }
  if (!detalleVigente(proceso.id)) return;

  expediente = guardado || Expediente.nuevo(proceso);
  expediente.proceso = Expediente.resumenDeProceso(proceso);
  if (expediente.analisis && !estado.ia[proceso.id]) {
    estado.ia[proceso.id] = { ...expediente.analisis };
    renderSeccionIA(proceso);
  }
  dibujarExpediente(proceso, almacen?.persistente === false);
}

// --- Requisitos ---------------------------------------------------------------

function enlacesAFuentes(numeros) {
  const fuentes = expediente.analisis?.fuentes || [];
  const enlaces = numeros.map((n) => fuentes.find((f) => f.n === n)).filter(Boolean)
    .map((f) => `<a href="#fuente-${f.n}" data-fuente="${f.n}" title="${esc(recortar(f.texto, 300))}">${esc(f.pagina)}</a>`);
  return enlaces.length ? enlaces.join(", ") : "sin página de respaldo";
}

function umbralLegible(r) {
  if (r.indicador === "ninguno" || r.valor === null) return "";
  const unidad = Expediente.UNIDADES[r.unidad];
  const valor = r.unidad === "cop" ? formatoCOP.format(r.valor) : `${formatoNumero.format(r.valor)} ${unidad}`;
  return `${Expediente.INDICADORES[r.indicador]} ${r.operador === "<=" ? "máximo" : "mínimo"} ${valor}` +
    (r.max_contratos ? `, en máximo ${plural(r.max_contratos, "contrato", "contratos")}` : "") +
    (r.codigos.length ? `, códigos ${r.codigos.join(", ")}` : "");
}

function formularioRequisito(r) {
  return `
    <details class="correccion" data-correccion="${esc(r.id)}" ${requisitoAbierto === r.id ? "open" : ""}>
      <summary>Corregir</summary>
      <label>Requisito <textarea data-campo-requisito="descripcion" rows="2">${esc(r.descripcion)}</textarea></label>
      <div class="fila-doble">
        <label>Tipo <select data-campo-requisito="tipo">${opciones(Expediente.TIPOS_REQUISITO, r.tipo)}</select></label>
        <label>Se comprueba con <select data-campo-requisito="indicador">${opciones(Expediente.INDICADORES, r.indicador)}</select></label>
        <label>Condición <select data-campo-requisito="operador">
          ${opciones({ ">=": "Mínimo (mayor o igual)", "<=": "Máximo (menor o igual)" }, r.operador)}</select></label>
        <label>Valor exigido <input data-campo-requisito="valor" type="number" min="0" step="any" inputmode="decimal" value="${esc(r.valor ?? "")}"></label>
        <label>Unidad <select data-campo-requisito="unidad">${opciones(Expediente.UNIDADES, r.unidad)}</select></label>
        <label>Máximo de contratos <span class="ayuda">solo experiencia; vacío si no hay límite</span>
          <input data-campo-requisito="max_contratos" type="number" min="0" step="1" inputmode="numeric" value="${esc(r.max_contratos || "")}"></label>
      </div>
      <label>Códigos UNSPSC exigidos <span class="ayuda">solo experiencia; separados por coma</span>
        <input data-campo-requisito="codigos" autocomplete="off" value="${esc(r.codigos.join(", "))}"></label>
      <button type="button" class="boton peligro" data-quitar-requisito="${esc(r.id)}">Quitar requisito</button>
    </details>`;
}

function filaRequisito(r, evaluado) {
  let resultado = '<span class="chip cerrado">Sin validar</span>';
  if (r.tipo === "ponderable") {
    resultado = '<span class="chip">Da puntaje</span><span class="ayuda">No habilita ni inhabilita: tenlo en cuenta al armar la oferta.</span>';
  } else if (evaluado) {
    const [etiqueta, clase] = CLASES_RESULTADO[evaluado.estado];
    const aMano = r.indicador === "ninguno" || r.valor === null;
    resultado = `<span class="chip ${clase}">${esc(etiqueta)}</span>
      <span class="ayuda">${esc(evaluado.detalle)} ${evaluado.brecha ? `<strong>${esc(evaluado.brecha)}</strong>` : ""}</span>
      ${aMano ? `<label class="campo-inline">¿La empresa lo cumple?
        <select data-campo-requisito="manual">${opciones({ "": "Sin revisar", cumple: "Sí", no_cumple: "No" }, r.manual)}</select></label>` : ""}`;
  }
  const subsanable = Expediente.SUBSANABLE[r.subsanable];
  return `<tr data-requisito-id="${esc(r.id)}">
    <td><input type="checkbox" data-campo-requisito="validado" ${r.validado ? "checked" : ""} aria-label="Validado contra el pliego"></td>
    <td>
      ${esc(r.descripcion)}
      <span class="ayuda">${esc(Expediente.TIPOS_REQUISITO[r.tipo])}${subsanable ? ` · ${esc(subsanable)}` : ""} · ${enlacesAFuentes(r.fuentes)}</span>
      ${umbralLegible(r) ? `<span class="ayuda"><strong>${esc(umbralLegible(r))}</strong></span>` : ""}
      ${formularioRequisito(r)}
    </td>
    <td>${resultado}</td>
  </tr>`;
}

function htmlRequisitos(proceso, habilitacion) {
  const hayAnalisis = Boolean(estado.ia[proceso.id]);
  const requisitos = expediente.requisitos;
  const sinValidar = requisitos.filter((r) => !r.validado).length;
  return `
    <h4>Requisitos del pliego</h4>
    <p class="ayuda">La IA propone los requisitos a partir del análisis; tú los confirmas contra el pliego (el enlace de cada uno lleva a la cita).
      Solo los que marques como validados se comparan con los datos de tu empresa, y esa comparación es un cálculo, no IA.</p>
    <div class="acciones">
      <button type="button" class="boton primario-suave" data-expediente="extraer" ${hayAnalisis && hayClaveIA() ? "" : "disabled"}>
        ${requisitos.some((r) => r.fuentes.length) ? "Volver a extraer con IA" : "Extraer requisitos y fechas con IA"}</button>
      <button type="button" class="boton" data-expediente="agregar-requisito">Agregar requisito a mano</button>
      ${sinValidar > 1 ? '<button type="button" class="boton" data-expediente="validar-todos">Marcar todos como validados</button>' : ""}
    </div>
    ${hayAnalisis ? "" : '<p class="ayuda">Para extraerlos con IA, primero analiza el pliego en la sección de arriba.</p>'}
    ${requisitos.length ? `
      <div class="panel-tabla">
        <table class="tabla-requisitos">
          <thead><tr><th>Validado</th><th>Requisito</th><th>Tu empresa</th></tr></thead>
          <tbody>${requisitos.map((r) => filaRequisito(r, habilitacion.porRequisito.get(r.id))).join("")}</tbody>
        </table>
      </div>
      <p class="ayuda">Los datos de tu empresa se llenan en la pestaña «Empresa e IA».
        <button type="button" class="boton" data-ir-empresa>Abrir los datos de la empresa</button></p>` : ""}`;
}

// --- Cronograma ---------------------------------------------------------------

function filaHito(h) {
  const situacion = Expediente.estadoHito(h, new Date());
  return `<tr data-hito-id="${esc(h.id)}">
    <td>
      <select data-campo-hito="tipo" aria-label="Tipo de hito">${opciones(Expediente.TIPOS_HITO, h.tipo)}</select>
      <input data-campo-hito="descripcion" autocomplete="off" placeholder="Detalle (opcional)" aria-label="Detalle" value="${esc(h.descripcion)}">
      ${h.fuentes.length ? `<span class="ayuda">${enlacesAFuentes(h.fuentes)}</span>` : ""}
    </td>
    <td><input data-campo-hito="fecha" type="date" aria-label="Fecha" value="${esc(h.fecha)}"></td>
    <td><input data-campo-hito="hora" type="time" aria-label="Hora" value="${esc(h.hora)}"></td>
    <td>
      <label class="campo-inline"><input type="checkbox" data-campo-hito="confirmado" ${h.confirmado ? "checked" : ""} ${h.fecha ? "" : "disabled"}>Confirmado</label>
      <span class="chip ${situacion.clase}">${esc(situacion.texto)}</span>
    </td>
    <td><button type="button" class="boton peligro" data-quitar-hito="${esc(h.id)}">Quitar</button></td>
  </tr>`;
}

function htmlCronograma() {
  const hitos = expediente.hitos;
  const confirmados = hitos.filter((h) => h.confirmado).length;
  return `
    <h4>Cronograma</h4>
    <p class="ayuda">Anota las fechas del cronograma del proceso y márcalas como confirmadas cuando las hayas comprobado en SECOP II, con la hora.
      Una oferta fuera de plazo se rechaza, y una adenda puede mover las fechas: vuelve a confirmarlas si sale alguna. Hora de Colombia.</p>
    ${hitos.length ? `
      <div class="panel-tabla">
        <table class="tabla-edicion">
          <thead><tr><th>Hito</th><th>Fecha</th><th>Hora</th><th>Estado</th><th></th></tr></thead>
          <tbody>${hitos.map(filaHito).join("")}</tbody>
        </table>
      </div>` : ""}
    <div class="acciones">
      <button type="button" class="boton" data-expediente="agregar-hito">Agregar fecha</button>
      <button type="button" class="boton primario-suave" data-expediente="calendario" ${confirmados ? "" : "disabled"}>
        Descargar calendario (.ics)</button>
    </div>
    <p class="ayuda">El calendario incluye solo las fechas confirmadas, con un recordatorio un día antes. Se abre en Google Calendar, Outlook o el calendario del celular.</p>`;
}

// --- Decisión -----------------------------------------------------------------

function diasAlCierre(proceso) {
  const cierre = expediente.hitos.find((h) => h.tipo === "cierre" && h.fecha);
  return Secop.diasHasta(cierre?.fecha || proceso.cierre, new Date());
}

function htmlDecision(proceso, habilitacion) {
  const tarjeta = Habilitantes.tarjetaDecision({
    habilitacion, dificultad: estado.dificultad[proceso.id] || null, diasAlCierre: diasAlCierre(proceso), hitos: expediente.hitos,
  });
  const d = expediente.decision;
  const factores = tarjeta.factores.map((f) => `
    <li><span class="chip ${CLASES_FACTOR[f.estado]}">${esc(f.titulo)}</span> <span class="ayuda">${esc(f.detalle)}</span></li>`).join("");
  return `
    <h4>Decisión: ofertar o no</h4>
    <div class="dificultad nivel-${NIVEL_RECOMENDACION[tarjeta.recomendacion]}">
      <strong>${esc(tarjeta.titulo)}</strong>
      <span class="ayuda">Es un resumen de lo que hay en este expediente, no una probabilidad de ganar. La decisión es de la empresa.</span>
    </div>
    <ul class="factores-decision">${factores}</ul>
    ${d ? `
      <p><strong>Decisión registrada: ${esc(Expediente.DECISIONES[d.decision])}.</strong>
        ${esc(d.responsable || "Sin responsable")} · ${esc(fechaCorta(d.fecha))}${d.motivo ? ` · ${esc(d.motivo)}` : ""}</p>
      <div class="acciones"><button type="button" class="boton" data-expediente="cambiar-decision">Cambiar la decisión</button></div>` : `
      <div class="fila-doble">
        <label>Quién decide <input id="decision-responsable" autocomplete="off" placeholder="Nombre y cargo"></label>
        <label>Decisión <select id="decision-valor">${opciones(Expediente.DECISIONES, tarjeta.recomendacion === "no_ofertar" ? "no_ofertar" : "ofertar")}</select></label>
      </div>
      <label>Motivo <textarea id="decision-motivo" rows="2" placeholder="Por qué se toma esta decisión"></textarea></label>
      <div class="acciones"><button type="button" class="boton primario-suave" data-expediente="registrar-decision">Registrar la decisión</button></div>`}
    <p class="ayuda">La oferta la presenta el representante legal en SECOP II con su usuario: esta página no presenta ofertas.</p>`;
}

// --- Sección completa ---------------------------------------------------------

function estadoExpediente(texto, error = false) {
  const nodo = $("#estado-expediente");
  if (!nodo) return;
  nodo.textContent = texto;
  nodo.classList.toggle("error-texto", error);
}

function dibujarExpediente(proceso, sinAlmacen = Boolean($("#aviso-sin-almacen"))) {
  const caja = $("#detalle-expediente");
  if (!caja || !expedienteVigente(proceso)) return;
  const contexto = { presupuesto: proceso.presupuesto, anio: Number(Secop.fechaIso(new Date()).slice(0, 4)) };
  const habilitacion = Habilitantes.evaluarHabilitantes(expediente.requisitos, datosEmpresa(), contexto);
  const mensajePrevio = $("#estado-expediente")?.textContent || "";
  caja.innerHTML = `
    <section class="seccion-detalle" aria-labelledby="expediente-titulo">
      <h3 id="expediente-titulo">Expediente del proceso</h3>
      ${sinAlmacen ? '<p class="aviso-limite" id="aviso-sin-almacen">Este navegador no permite guardar datos (por ejemplo, en una ventana privada): el expediente se perderá al cerrar la página.</p>' : ""}
      <p id="estado-expediente" class="ayuda" role="status">${esc(mensajePrevio)}</p>
      ${htmlRequisitos(proceso, habilitacion)}
      ${htmlCronograma()}
      ${htmlDecision(proceso, habilitacion)}
    </section>`;
}

// --- Acciones -----------------------------------------------------------------

async function extraerRequisitosConIA(proceso) {
  const analisis = estado.ia[proceso.id];
  if (!analisis) return;
  const validados = expediente.requisitos.filter((r) => r.fuentes.length && r.validado).length;
  if (validados && !confirm(`Ya validaste ${plural(validados, "requisito", "requisitos")}. Al extraer de nuevo se reemplazan y tendrás que validarlos otra vez. ¿Continuar?`)) return;

  const modelo = configuracionIA().modeloAnalisis;
  try {
    estadoExpediente(`Extrayendo requisitos y fechas con ${nombreModelo(modelo)}…`);
    await asegurarSDK();
    const extraccion = await ia.extraerRequisitos({ clave: claveIA(), modelo, marcado: analisis.marcado, fuentes: analisis.fuentes, proceso });
    if (!expedienteVigente(proceso)) return;
    const costo = IA.estimarCosto(extraccion.modelo, extraccion.uso?.input_tokens || 0, extraccion.uso?.output_tokens || 0);
    estadoExpediente(
      `La IA propuso ${plural(extraccion.requisitos.length, "requisito", "requisitos")} y ${plural(extraccion.hitos.length, "fecha", "fechas")}` +
      `${extraccion.sinFuente ? `; ${extraccion.sinFuente} sin página de respaldo: revísalos con más cuidado` : ""}. ` +
      `Valídalos contra el pliego.${costo === null ? "" : ` Costo aproximado: ${IA.formatoUSD(costo)}.`}`
    );
    cambiarExpediente(proceso, (e) => Object.assign(e, Expediente.aplicarExtraccion(e, extraccion)));
  } catch (error) {
    estadoExpediente(IA.mensajeDeError(error), true);
  }
}

function descargarCalendario() {
  const referencia = (expediente.proceso.referencia || expediente.id).replace(/[^\w.-]+/g, "-");
  descargarArchivo(`cronograma-${referencia}.ics`, Expediente.aICS(expediente), "text/calendar;charset=utf-8");
}

function alPulsarExpediente(evento, proceso) {
  const objetivo = evento.target;
  const accion = objetivo.closest("[data-expediente]")?.dataset.expediente;
  const quitarRequisito = objetivo.closest("[data-quitar-requisito]")?.dataset.quitarRequisito;
  const quitarHito = objetivo.closest("[data-quitar-hito]")?.dataset.quitarHito;

  if (accion === "extraer") extraerRequisitosConIA(proceso);
  if (accion === "calendario") descargarCalendario();
  if (accion === "agregar-requisito") {
    const nuevo = Expediente.normalizarRequisito({ descripcion: "Nuevo requisito: descríbelo aquí", validado: true });
    requisitoAbierto = nuevo.id;
    cambiarExpediente(proceso, (e) => { e.requisitos.push(nuevo); });
  }
  if (accion === "validar-todos") cambiarExpediente(proceso, (e) => { e.requisitos.forEach((r) => { r.validado = true; }); });
  if (accion === "agregar-hito") {
    cambiarExpediente(proceso, (e) => { e.hitos.push({ id: Expediente.nuevoId(), tipo: "cierre", descripcion: "", fecha: "", hora: "", confirmado: false, fuentes: [] }); });
  }
  if (accion === "registrar-decision") {
    const decision = Expediente.normalizarDecision({
      decision: $("#decision-valor").value, responsable: $("#decision-responsable").value,
      motivo: $("#decision-motivo").value, fecha: Secop.fechaIso(new Date()),
    });
    if (!decision.responsable) return estadoExpediente("Escribe quién toma la decisión.", true);
    estadoExpediente("");
    cambiarExpediente(proceso, (e) => { e.decision = decision; });
  }
  if (accion === "cambiar-decision") cambiarExpediente(proceso, (e) => { e.decision = null; });
  if (quitarRequisito) cambiarExpediente(proceso, (e) => { e.requisitos = e.requisitos.filter((r) => r.id !== quitarRequisito); });
  if (quitarHito) cambiarExpediente(proceso, (e) => { e.hitos = e.hitos.filter((h) => h.id !== quitarHito); });
}

function alCambiarExpediente(evento, proceso) {
  const objetivo = evento.target;
  const { campoRequisito, campoHito } = objetivo.dataset;
  const valor = objetivo.type === "checkbox" ? objetivo.checked : objetivo.value;

  if (campoRequisito) {
    const id = objetivo.closest("[data-requisito-id]").dataset.requisitoId;
    requisitoAbierto = objetivo.closest("[data-correccion]") ? id : null;
    cambiarExpediente(proceso, (e) => {
      const indice = e.requisitos.findIndex((r) => r.id === id);
      if (indice < 0) return;
      const cambio = { ...e.requisitos[indice], [campoRequisito]: valor };
      if (campoRequisito === "valor") cambio.valor = valor === "" ? null : Number(valor);
      if (campoRequisito === "max_contratos") cambio.max_contratos = Number(valor) || 0;
      if (campoRequisito === "codigos") cambio.codigos = valor.split(/[\s,;]+/);
      // Al elegir un indicador se propone la condición habitual: el endeudamiento es un máximo; los demás, mínimos.
      if (campoRequisito === "indicador") cambio.operador = valor === "endeudamiento" ? "<=" : ">=";
      e.requisitos[indice] = Expediente.normalizarRequisito(cambio) || e.requisitos[indice];
    });
  } else if (campoHito) {
    const id = objetivo.closest("[data-hito-id]").dataset.hitoId;
    cambiarExpediente(proceso, (e) => {
      const hito = e.hitos.find((h) => h.id === id);
      if (!hito) return;
      hito[campoHito] = valor;
      // Si cambia la fecha o la hora hay que volver a confirmarla.
      if (campoHito === "fecha" || campoHito === "hora") hito.confirmado = false;
    });
  }
}

function iniciarExpediente() {
  Radar.alAbrirDetalle.push(montarExpediente);
  Radar.alAnalizar.push(guardarAnalisisEnExpediente);
  Radar.alConocerDificultad.push((proceso) => dibujarExpediente(proceso));
  const dialogo = $("#detalle");
  dialogo.addEventListener("click", (evento) => {
    if (evento.target.closest("#detalle-expediente") && expedienteVigente(estado.detalle)) alPulsarExpediente(evento, estado.detalle);
  });
  dialogo.addEventListener("change", (evento) => {
    if (evento.target.closest("#detalle-expediente") && expedienteVigente(estado.detalle)) alCambiarExpediente(evento, estado.detalle);
  });
  dialogo.addEventListener("close", () => { expediente = null; requisitoAbierto = null; });
}
registrarInicio(iniciarExpediente);
