"use strict";

// Pestaña "Adjudicados y ejecución": qué se adjudicó en tu sector, a quién, a qué precio y cómo va el contrato.

const MESES_ADJUDICADOS = [1, 3, 6, 12, 24];

const claseEstadoContrato = (estadoContrato) =>
  /terminado|cerrado|liquidado/i.test(estadoContrato || "") ? "cerrado" : /suspendido|cedido/i.test(estadoContrato || "") ? "urgente" : "";

function celdaContrato(contrato) {
  if (!contrato) return '<span class="ayuda">Aún sin contrato publicado</span>';
  const pagado = contrato.valor > 0 && contrato.pagado !== null ? contrato.pagado / contrato.valor : null;
  return `
    <span class="chip ${claseEstadoContrato(contrato.estado)}">${esc(contrato.estado || "Sin estado")}</span>
    ${pagado !== null ? `<span class="ayuda">Pagado ${esc(porcentaje(Math.min(pagado, 1)))} de ${esc(dinero(contrato.valor))}</span>` : ""}
    ${contrato.fin ? `<span class="ayuda">Termina el ${esc(fechaCorta(contrato.fin))}${contrato.dias_adicionados ? ` (+${contrato.dias_adicionados} días adicionados)` : ""}</span>` : ""}`;
}

function filaAdjudicado(p) {
  const dto = Analisis.descuento(p.presupuesto, p.valor_adjudicado);
  return `
    <tr>
      <td><strong>${esc(recortar(p.nombre, 110))}</strong>
        <span class="ayuda">${esc(p.entidad)} · ${esc(p.modalidad || "Modalidad no informada")}</span></td>
      <td>${esc(fechaCorta(p.fecha_adjudicacion))}</td>
      <td>${p.ganador ? `${esc(p.ganador)}<span class="ayuda">${esc(Analisis.enmascararDocumento(p.ganador, p.nit_ganador))}</span>` : '<span class="ayuda">Sin dato</span>'}</td>
      <td>${esc(dinero(p.valor_adjudicado))}
        <span class="ayuda">de ${esc(dinero(p.presupuesto))}${dto === null ? "" : ` · descuento ${esc(porcentaje(dto))}`}</span></td>
      <td>${celdaContrato(p.contrato)}</td>
      <td class="acciones-fila">
        <button class="boton primario-suave" data-detalle="${esc(p.id)}">Competencia</button>
        ${enlaceSecop(p.url)}
      </td>
    </tr>`;
}

function renderAdjudicados() {
  const { datos, visibles } = estado.adj;
  const contenido = $("#contenido-adjudicados");
  if (!datos.resultados.length) {
    contenido.innerHTML = mensaje(
      `No hay procesos adjudicados desde el ${fechaCorta(datos.desde)} que coincidan con tu perfil. ` +
        "Prueba con más meses, más palabras clave o desmarca “Solo procesos competitivos”."
    );
    return;
  }

  const resumen = Analisis.resumirAdjudicados(datos.resultados);
  const estados = Object.entries(resumen.estados).sort((a, b) => b[1] - a[1])
    .map(([nombre, n]) => `${n} ${nombre.toLowerCase()}`).join(", ");
  const mostrados = datos.resultados.slice(0, visibles);
  contenido.innerHTML = `
    ${datos.limite_alcanzado ? `<p class="aviso-limite">Hay más adjudicaciones que las que consultamos: revisamos las 300 más
      recientes. Elige menos meses o estrecha tu perfil para ver todas.</p>` : ""}
    <p class="resumen">${plural(resumen.n, "proceso adjudicado", "procesos adjudicados")} desde el ${esc(fechaCorta(datos.desde))}
      por ${esc(dinero(resumen.valor_adjudicado))}. Descuento mediano sobre el presupuesto: ${esc(porcentaje(resumen.descuento_mediano))}.
      ${resumen.con_contrato} con contrato publicado${estados ? ` (${esc(estados)})` : ""}.</p>
    <div class="panel panel-tabla">
      <table class="tabla-ancha">
        <thead><tr><th>Proceso</th><th>Adjudicación</th><th>Ganador</th><th>Valor adjudicado</th><th>Contrato</th><th></th></tr></thead>
        <tbody>${mostrados.map(filaAdjudicado).join("")}</tbody>
      </table>
    </div>
    ${datos.resultados.length > mostrados.length
      ? `<p class="mas"><button class="boton" data-mas-adjudicados>Mostrar más (${datos.resultados.length - mostrados.length} restantes)</button></p>`
      : ""}
    <p class="aviso">Los contratos se cruzan con el proceso por su identificador de portafolio. Las adjudicaciones muy recientes
      pueden no tener aún contrato firmado. El NIT de personas naturales se oculta.</p>`;
}

async function cargarAdjudicados() {
  const vista = $("#vista-adjudicados");
  const perfil = leer(CLAVE_PERFIL, {});
  if (!perfilTieneAlcance(perfil)) {
    vista.innerHTML = mensaje("Define palabras clave o códigos UNSPSC en tu perfil para ver qué se ha adjudicado en tu sector.");
    return;
  }

  vista.innerHTML = `
    <div class="herramientas-lista">
      <label>Adjudicados en los últimos
        <select id="meses-adjudicados">
          ${MESES_ADJUDICADOS.map((m) => `<option value="${m}" ${m === estado.adj.meses ? "selected" : ""}>${m === 1 ? "1 mes" : `${m} meses`}</option>`).join("")}
        </select>
      </label>
      <button class="boton" data-exportar="adjudicados">Descargar CSV</button>
    </div>
    <div id="contenido-adjudicados">${mensaje("Consultando adjudicaciones y sus contratos…")}</div>`;

  try {
    const parametros = aParametros({
      palabras: perfil.palabras, codigos: perfil.codigos, departamento: perfil.departamento,
      min: perfil.min, max: perfil.max, competitivos: perfil.competitivos, meses: estado.adj.meses,
    });
    estado.adj.datos = await Secop.buscarAdjudicados(parametros);
    estado.adj.visibles = POR_PAGINA;
    renderAdjudicados();
  } catch (error) {
    $("#contenido-adjudicados").innerHTML = mensaje(error.message, "error");
  }
}

function iniciarAdjudicados() {
  Radar.alMostrar.adjudicados = cargarAdjudicados;
  const vista = $("#vista-adjudicados");
  vista.addEventListener("change", (evento) => {
    if (evento.target.id !== "meses-adjudicados") return;
    estado.adj.meses = Number(evento.target.value);
    cargarAdjudicados();
  });
  vista.addEventListener("click", (evento) => {
    if (evento.target.closest("[data-mas-adjudicados]")) {
      estado.adj.visibles += POR_PAGINA;
      renderAdjudicados();
    }
    if (evento.target.closest("[data-exportar='adjudicados']") && estado.adj.datos) {
      descargarCSV("radar-secop-adjudicados", COLUMNAS_ADJUDICADOS, estado.adj.datos.resultados);
    }
  });
}
registrarInicio(iniciarAdjudicados);
