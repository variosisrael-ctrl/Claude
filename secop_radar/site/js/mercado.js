"use strict";

// Pestaña "Mercado y competencia": quién compra y quién gana contratos en tu sector.

const barra = (valor, maximo) =>
  `<span class="barra" style="width:${maximo ? Math.round((valor / maximo) * 100) : 0}%"></span>`;

function tabla(titulo, encabezados, filas, celdas) {
  if (!filas.length) {
    return `<section class="panel panel-tabla"><h3>${esc(titulo)}</h3>${mensaje("Sin datos para este criterio.")}</section>`;
  }
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
      ${tabla("Proveedores con más contratos: tu competencia" + sufijo, ["Proveedor", "NIT", "Contratos", "Valor total"], datos.proveedores, (f) => [
        esc(f.nombre), esc(Analisis.enmascararDocumento(f.nombre, f.documento)), conBarra(f, topeProveedores), esc(formatoCOP.format(f.valor)),
      ])}
      ${tabla("Todas las modalidades usadas en tu sector", ["Modalidad", "Contratos"], datos.modalidades, (f) => [
        esc(f.nombre), conBarra(f, topeModalidades),
      ])}
    </div>
    <p class="aviso">Contratos firmados desde ${datos.desde} en SECOP II. Se excluyen valores atípicos mayores a
      100 billones de COP (errores de digitación en la fuente). Los proveedores se agrupan por NIT o cédula; la cédula
      de personas naturales se oculta. La tabla de modalidades muestra todo el mercado para que veas cuánto es
      contratación directa, que no se disputa.</p>`;
}

function iniciarMercado() {
  Radar.alMostrar.mercado = cargarMercado;
  $("#vista-mercado").addEventListener("change", (evento) => {
    if (evento.target.id !== "anio-mercado") return;
    estado.anioMercado = Number(evento.target.value);
    cargarMercado();
  });
}
registrarInicio(iniciarMercado);
