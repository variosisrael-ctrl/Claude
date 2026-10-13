"use strict";

// Ventana de detalle de un proceso: competencia histórica de la entidad en la categoría e índice de dificultad.
// Otras pantallas (p. ej. la IA) se enganchan con Radar.alAbrirDetalle.

const NIVELES_DIFICULTAD = { "Baja": "baja", "Media": "media", "Alta": "alta", "Sin datos suficientes": "sin-datos" };

function cuerpoDetalle(p) {
  const cierre = p.cierre ? infoCierre(p) : null;
  return `
    <p class="entidad">${esc(p.entidad || "")}</p>
    <div class="tarjeta-cabecera">
      ${p.modalidad ? `<span class="chip">${esc(p.modalidad)}</span>` : ""}
      ${cierre ? `<span class="chip ${cierre.clase}">${esc(cierre.texto)}</span>` : ""}
      ${p.adjudicado ? '<span class="chip cerrado">Ya adjudicado</span>' : ""}
    </div>
    <dl class="datos">
      <div><dt>Presupuesto</dt><dd>${esc(dinero(p.presupuesto))}</dd></div>
      <div><dt>Categoría UNSPSC</dt><dd>${esc(categoriaLegible(p.categoria))}</dd></div>
      <div><dt>Referencia</dt><dd>${esc(p.referencia || "—")}</dd></div>
    </dl>
    ${p.descripcion ? `<p class="descripcion">${esc(recortar(p.descripcion, 700))}</p>` : ""}
    <div class="acciones">${enlaceSecop(p.url)}</div>
    <section class="seccion-detalle" aria-labelledby="detalle-competencia-titulo">
      <h3 id="detalle-competencia-titulo">Competencia en esta entidad y categoría</h3>
      <div id="detalle-competencia">${mensaje("Revisando el historial de adjudicaciones de esta entidad…")}</div>
    </section>
    <div id="detalle-ia"></div>`;
}

function contextoCompetencia(resumen) {
  const categoria = resumen.clase ? `la categoría ${resumen.clase}` : "cualquier categoría";
  if (resumen.alcance === "entidad") {
    const base = `Basado en ${plural(resumen.n_procesos, "proceso competitivo adjudicado", "procesos competitivos adjudicados")} por esta entidad en ${categoria} en los últimos 2 años.`;
    return resumen.clase
      ? base
      : `${base} Este proceso no tiene código UNSPSC, así que se mezclan todos los objetos que compra la entidad: tómalo solo como una referencia general.`;
  }
  if (resumen.alcance === "pais") {
    return `Esta entidad tiene solo ${plural(resumen.n_entidad, "proceso", "procesos")} en ${categoria}, muy pocos para sacar conclusiones. ` +
      `Se usan ${plural(resumen.n_procesos, "proceso competitivo adjudicado", "procesos competitivos adjudicados")} en todo el país en la misma categoría; ` +
      "no hay datos de cuántos oferentes se presentaron.";
  }
  return "No hay procesos competitivos adjudicados de esta entidad en esta categoría en los últimos 2 años.";
}

function filaCompetidor(g) {
  const tasa = g.participaciones ? g.ganados / g.participaciones : null;
  return [
    esc(g.nombre || "Sin nombre"),
    esc(Analisis.enmascararDocumento(g.nombre, g.nit)),
    formatoNumero.format(g.ganados),
    g.participaciones === null ? "—" : `${formatoNumero.format(g.participaciones)} (ganó ${esc(porcentaje(tasa))})`,
    esc(formatoCOP.format(g.valor)),
  ];
}

function renderCompetencia(resumen, indice) {
  if (resumen.alcance === "sin_datos") return mensaje(contextoCompetencia(resumen));

  const nivel = NIVELES_DIFICULTAD[indice.nivel];
  const puntaje = indice.puntaje === null ? "" : ` (${indice.puntaje}/100)`;
  const factores = indice.factores.map((f) => `
    <li>
      <span class="factor-titulo">${esc(f.titulo)}</span>
      <span class="factor-barra" aria-hidden="true"><span style="width:${f.puntos}%"></span></span>
      <span class="ayuda">${esc(f.detalle)}</span>
    </li>`).join("");

  return `
    <div class="dificultad nivel-${nivel}">
      <strong>Dificultad estimada: ${esc(indice.nivel)}${esc(puntaje)}</strong>
      <span class="ayuda">Es una heurística explicable, no una probabilidad de ganar.
        ${indice.puntaje === null ? "Faltan datos para calcularla." : `Se calculó con ${indice.factores.length} de ${indice.factores_de} factores.`}</span>
    </div>
    ${factores ? `<ul class="factores">${factores}</ul>` : ""}
    <p class="ayuda">${esc(contextoCompetencia(resumen))}</p>
    ${resumen.ganadores.length ? `
      <div class="panel-tabla">
        <table>
          <thead><tr><th>Quién ganó</th><th>NIT</th><th>Ganados</th><th>Se presentó a</th><th>Valor ganado</th></tr></thead>
          <tbody>${resumen.ganadores.map((g) => `<tr>${filaCompetidor(g).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody>
        </table>
      </div>` : ""}
    <p class="ayuda">Los datos son los publicados por las entidades en SECOP II; pueden tener errores. El NIT de personas naturales se oculta.</p>`;
}

async function cargarCompetencia(proceso) {
  const caja = $("#detalle-competencia");
  if (!proceso.nit_entidad) {
    caja.innerHTML = mensaje("Este proceso se guardó sin el NIT de la entidad. Búscalo de nuevo y vuelve a seguirlo para ver su competencia.");
    return;
  }
  try {
    const crudo = await Secop.competenciaHistorica({ nit_entidad: proceso.nit_entidad, categoria: proceso.categoria });
    if (estado.detalle?.id !== proceso.id) return; // la persona cerró la ventana o abrió otro proceso
    const resumen = Analisis.resumirCompetencia(crudo);
    caja.innerHTML = renderCompetencia(resumen, Analisis.indiceDificultad(resumen));
  } catch (error) {
    if (estado.detalle?.id === proceso.id) caja.innerHTML = mensaje(error.message, "error");
  }
}

function abrirDetalle(id) {
  const proceso = buscarProceso(id);
  if (!proceso) return;
  estado.detalle = proceso;
  $("#detalle-titulo").textContent = proceso.nombre;
  $("#detalle-contenido").innerHTML = cuerpoDetalle(proceso);
  $("#detalle").showModal();
  cargarCompetencia(proceso);
  Radar.alAbrirDetalle.forEach((enganche) => enganche(proceso, $("#detalle-ia")));
}

function iniciarDetalle() {
  const dialogo = $("#detalle");
  document.addEventListener("click", (evento) => {
    const id = evento.target.closest("[data-detalle]")?.dataset.detalle;
    if (id) abrirDetalle(id);
  });
  dialogo.addEventListener("click", (evento) => {
    // Un clic en el fondo oscuro (fuera del contenido) o en "Cerrar" cierra la ventana.
    if (evento.target === dialogo || evento.target.closest("[data-cerrar-detalle]")) dialogo.close();
  });
  dialogo.addEventListener("close", () => { estado.detalle = null; });
}
registrarInicio(iniciarDetalle);
