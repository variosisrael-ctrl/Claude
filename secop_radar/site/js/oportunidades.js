"use strict";

// Pestaña "Oportunidades": procesos que aún reciben ofertas y encajan con el perfil.

const ORDENES = {
  relevancia: { etiqueta: "Relevancia", comparar: () => 0 },
  cierre: {
    etiqueta: "Cierra primero",
    comparar: (a, b) => (a.cierre || "9999").localeCompare(b.cierre || "9999") || b.puntaje - a.puntaje,
  },
  presupuesto: { etiqueta: "Mayor presupuesto", comparar: (a, b) => (b.presupuesto ?? -1) - (a.presupuesto ?? -1) },
  recientes: { etiqueta: "Más recientes", comparar: (a, b) => (b.publicado || "").localeCompare(a.publicado || "") },
};

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
    estado.op.datos = await Secop.buscarOportunidades(aParametros(perfil));
    estado.op.visibles = POR_PAGINA;
    renderOportunidades();
  } catch (error) {
    vista.innerHTML = mensaje(error.message, "error");
  }
}

function renderOportunidades() {
  const { datos, orden, visibles } = estado.op;
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

  const ordenados = [...datos.resultados].sort(ORDENES[orden].comparar);
  const mostrados = ordenados.slice(0, visibles);
  vista.innerHTML = `
    ${datos.limite_alcanzado ? `<p class="aviso-limite">Tu perfil coincide con más de ${formatoNumero.format(datos.filas_revisadas)} procesos y solo
      revisamos ese tope. Estrecha las palabras clave, los códigos o el presupuesto para no perder ninguno.</p>` : ""}
    <div class="herramientas-lista">
      <p class="resumen">${plural(datos.resultados.length, "proceso coincide", "procesos coinciden")} con tu perfil
        (publicados desde el ${fechaCorta(datos.desde)}). El porcentaje indica qué tanto se parecen a tu perfil.</p>
      <label>Ordenar por
        <select id="orden">
          ${Object.entries(ORDENES).map(([clave, o]) => `<option value="${clave}" ${clave === orden ? "selected" : ""}>${o.etiqueta}</option>`).join("")}
        </select>
      </label>
      <button class="boton" data-exportar="oportunidades">Descargar CSV</button>
    </div>
    <div class="lista">${mostrados.map(tarjetaOportunidad).join("")}</div>
    ${ordenados.length > mostrados.length
      ? `<p class="mas"><button class="boton" data-mas>Mostrar más (${ordenados.length - mostrados.length} restantes)</button></p>`
      : ""}`;
}

function tarjetaOportunidad(op) {
  const siguiendo = seguimiento().some((s) => s.id === op.id);
  const lugar = [op.ciudad, op.departamento].filter(Boolean).join(", ");
  const cierre = infoCierre(op);
  return `
    <article class="tarjeta">
      <header class="tarjeta-cabecera">
        <span class="puntaje ${claseNivel(op.puntaje)}" title="Coincidencia con tu perfil">${op.puntaje}%</span>
        <span class="chip">${esc(op.modalidad || "Modalidad no informada")}</span>
        <span class="chip ${cierre.clase}">${esc(cierre.texto)}</span>
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
        <button class="boton primario-suave" data-detalle="${esc(op.id)}">Competencia y análisis</button>
        ${enlaceSecop(op.url)}
        <button class="boton" data-seguir="${esc(op.id)}" ${siguiendo ? "disabled" : ""}>
          ${siguiendo ? "En seguimiento" : "Seguir"}
        </button>
      </footer>
    </article>`;
}

function iniciarOportunidades() {
  const vista = $("#vista-oportunidades");
  vista.addEventListener("click", (evento) => {
    const id = evento.target.closest("[data-seguir]")?.dataset.seguir;
    if (id) seguirOportunidad(id);
    if (evento.target.closest("[data-mas]")) {
      estado.op.visibles += POR_PAGINA;
      renderOportunidades();
    }
    if (evento.target.closest("[data-exportar='oportunidades']")) {
      descargarCSV("radar-secop-oportunidades", COLUMNAS_OPORTUNIDADES, estado.op.datos.resultados);
    }
  });
  vista.addEventListener("change", (evento) => {
    if (evento.target.id !== "orden") return;
    estado.op.orden = evento.target.value;
    estado.op.visibles = POR_PAGINA;
    renderOportunidades();
  });
  $("#formulario").addEventListener("submit", (evento) => {
    evento.preventDefault();
    buscarOportunidades();
  });
}
registrarInicio(iniciarOportunidades);
