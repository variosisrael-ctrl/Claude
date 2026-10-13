"use strict";

// Pestaña "Mi seguimiento": procesos guardados con estado, requisitos y notas (en este navegador).

const seguimiento = () => leer(CLAVE_SEGUIMIENTO, []);

function actualizarConteo() {
  const total = seguimiento().length;
  $("#conteo-seguimiento").textContent = total ? String(total) : "";
}

function seguirOportunidad(id) {
  const lista = seguimiento();
  const op = estado.op.datos?.resultados.find((o) => o.id === id);
  if (!op || lista.some((s) => s.id === id)) return;
  lista.unshift({
    id: op.id,
    nombre: op.nombre,
    descripcion: recortar(op.descripcion, 1500),
    entidad: op.entidad,
    nit_entidad: op.nit_entidad,
    referencia: op.referencia,
    presupuesto: op.presupuesto,
    modalidad: op.modalidad,
    categoria: op.categoria,
    portafolio: op.portafolio,
    cierre: op.cierre,
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
    <div class="herramientas-lista">
      <p class="resumen">Sigues ${plural(lista.length, "proceso", "procesos")}.
        Presupuesto en juego (sin perdidos ni descartados): ${esc(formatoCOP.format(enJuego))}.</p>
      <button class="boton" data-exportar="seguimiento">Descargar CSV</button>
    </div>
    <div class="lista">${lista.map(tarjetaSeguimiento).join("")}</div>`;
}

function tarjetaSeguimiento(s) {
  const cierre = s.cierre ? infoCierre(s) : null;
  return `
    <article class="tarjeta" data-id="${esc(s.id)}">
      <header class="tarjeta-cabecera">
        <label class="campo-inline">Estado
          <select data-campo="estado">
            ${ESTADOS.map((e) => `<option ${e === s.estado ? "selected" : ""}>${esc(e)}</option>`).join("")}
          </select>
        </label>
        <span class="chip" data-progreso>${s.requisitos.filter(Boolean).length} de ${REQUISITOS.length} requisitos listos</span>
        ${cierre ? `<span class="chip ${cierre.clase}">${esc(cierre.texto)}</span>` : ""}
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
        ${s.nit_entidad ? `<button class="boton primario-suave" data-detalle="${esc(s.id)}">Competencia y análisis</button>` : ""}
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

function iniciarSeguimiento() {
  actualizarConteo();
  Radar.alMostrar.seguimiento = renderSeguimiento;
  const vista = $("#vista-seguimiento");
  vista.addEventListener("change", alCambiarSeguimiento);
  vista.addEventListener("click", (evento) => {
    const id = evento.target.closest("[data-quitar]")?.dataset.quitar;
    if (id) quitarSeguimiento(id);
    if (evento.target.closest("[data-exportar='seguimiento']")) {
      descargarCSV("radar-secop-seguimiento", COLUMNAS_SEGUIMIENTO, seguimiento());
    }
  });
}
registrarInicio(iniciarSeguimiento);
