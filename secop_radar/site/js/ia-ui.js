"use strict";

// Funciones de IA en la pantalla: análisis del pliego dentro del detalle de un proceso y evaluación por lotes
// de la lista de oportunidades. La lógica de las solicitudes está en ia.js; aquí solo hay interfaz.

let analisisEnCurso = null; // { id, controlador } mientras la IA lee un pliego

const ETIQUETAS_VEREDICTO = {
  cumple: ["Cumple los requisitos", "baja"],
  cumple_con_dudas: ["Cumple, con dudas", "media"],
  no_cumple: ["No cumple", "alta"],
  indeterminado: ["No se puede determinar", "sin-datos"],
};
const ETIQUETAS_ESTADO = {
  cumple: ["Cumple", ""],
  no_cumple: ["No cumple", "urgente"],
  falta_informacion: ["Falta información", "pronto"],
};
const ETIQUETAS_CATEGORIA = {
  juridico: "Jurídico", financiero: "Financiero", tecnico_experiencia: "Técnico y experiencia",
  organizacional: "Organizacional", documental: "Documental", otro: "Otro",
};

const nombreModelo = (id) => IA.MODELOS[id]?.nombre || id;

// --- Evaluación por lotes en la lista ------------------------------------------

function notaTriaje(op) {
  const t = estado.triaje[op.id];
  if (!t) return "";
  return `<p class="ia-nota nivel-${esc(t.encaja)}"><strong>IA: encaja ${esc(t.encaja)}.</strong> ${esc(t.razon)}${
    t.alerta ? ` <span class="ayuda">Ojo: ${esc(t.alerta)}</span>` : ""}</p>`;
}

async function evaluarVisiblesConIA() {
  const mostrarEstado = (texto) => { if ($("#estado-triaje")) $("#estado-triaje").textContent = texto; };
  const pendientes = estado.op.mostrados.filter((p) => !estado.triaje[p.id]);
  if (!pendientes.length) return mostrarEstado("Todos los procesos que ves ya fueron evaluados.");
  if (!hayClaveIA()) return mostrarEstado("Agrega tu clave de Anthropic en la pestaña “Empresa e IA” para usar la IA.");

  const modelo = configuracionIA().modeloTriaje;
  try {
    mostrarEstado(`Evaluando 0 de ${pendientes.length}…`);
    await asegurarSDK();
    const resultados = await ia.triaje({
      clave: claveIA(), modelo, procesos: pendientes, empresa: perfilEmpresa(),
      alAvance: (hechos, total) => mostrarEstado(`Evaluando ${hechos} de ${total}…`),
    });
    resultados.forEach((evaluacion, id) => { estado.triaje[id] = evaluacion; });
    renderOportunidades();
    mostrarEstado(`Listo: la IA evaluó ${plural(resultados.size, "proceso", "procesos")} con ${nombreModelo(modelo)}.`);
  } catch (error) {
    mostrarEstado(IA.mensajeDeError(error));
  }
}

// --- Análisis del pliego en el detalle -----------------------------------------

function leerPDFComoBase64(archivo) {
  return new Promise((resolver, rechazar) => {
    const lector = new FileReader();
    lector.onload = () => resolver(String(lector.result).split(",")[1] || "");
    lector.onerror = () => rechazar(new IA.ErrorDeIA("No se pudo leer el archivo."));
    lector.readAsDataURL(archivo);
  });
}

async function prepararPDF() {
  const archivo = $("#ia-archivo")?.files[0];
  if (!archivo) throw new IA.ErrorDeIA("Elige primero el PDF del pliego.");
  if (archivo.size > IA.MAX_BYTES_PDF) {
    throw new IA.ErrorDeIA(`El PDF pesa ${(archivo.size / 1048576).toFixed(1)} MB y el máximo es ${Math.round(IA.MAX_BYTES_PDF / 1048576)} MB. Comprímelo o sube solo las partes principales.`);
  }
  const datos = await leerPDFComoBase64(archivo);
  if (!datos.startsWith("JVBERi")) throw new IA.ErrorDeIA("El archivo no parece un PDF válido.");
  return { archivo, datos };
}

function htmlEvaluacion(e) {
  const [titulo, nivel] = ETIQUETAS_VEREDICTO[e.veredicto] || ETIQUETAS_VEREDICTO.indeterminado;
  const filas = e.requisitos.map((r) => {
    const [etiqueta, clase] = ETIQUETAS_ESTADO[r.estado] || [r.estado, ""];
    return `<tr>
      <td>${esc(r.requisito)}<span class="ayuda">${esc(ETIQUETAS_CATEGORIA[r.categoria] || r.categoria)}</span></td>
      <td><span class="chip ${clase}">${esc(etiqueta)}</span></td>
      <td>${esc(r.evidencia)}</td>
      <td>${esc(r.accion)}</td>
    </tr>`;
  }).join("");
  return `
    <div class="dificultad nivel-${nivel}">
      <strong>${esc(titulo)}</strong>
      <span class="ayuda">${esc(e.resumen)}</span>
    </div>
    ${filas ? `<div class="panel-tabla"><table>
      <thead><tr><th>Requisito</th><th>Estado</th><th>Por qué</th><th>Qué hacer</th></tr></thead>
      <tbody>${filas}</tbody></table></div>` : ""}
    ${e.proximos_pasos.length ? `<h4>Próximos pasos</h4><ul>${e.proximos_pasos.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}
    <p class="ayuda">Es una orientación basada solo en lo que escribiste en el perfil de tu empresa. Verifica cada punto contra el pliego.</p>`;
}

function htmlResultadoIA(r) {
  const entrada = r.uso ? (r.uso.input_tokens || 0) + (r.uso.cache_read_input_tokens || 0) + (r.uso.cache_creation_input_tokens || 0) : null;
  const costo = entrada === null ? null : IA.estimarCosto(r.modelo, entrada, r.uso.output_tokens || 0);
  return `
    <div class="analisis-ia">
      <p class="ayuda">Análisis de «${esc(r.archivo)}» con ${esc(nombreModelo(r.modelo))}${costo === null ? "" : `. Costo aproximado: ${esc(IA.formatoUSD(costo))}`}.</p>
      ${r.truncado ? '<p class="aviso-limite">La respuesta llegó al límite de longitud y puede estar incompleta.</p>' : ""}
      <div class="texto-ia">${r.html}</div>
      ${r.fuentes.length ? `<details id="ia-fuentes"><summary>Fuentes citadas (${r.fuentes.length})</summary>${IA.htmlFuentes(r.fuentes)}</details>` : ""}
      <p class="ayuda">La IA puede equivocarse. Los números entre corchetes indican la página del PDF donde aparece cada dato: confírmalo en el pliego.</p>
      <div class="acciones">
        <button class="boton primario-suave" id="ia-evaluar">Evaluar contra mi empresa</button>
        <button class="boton" id="ia-copiar">Copiar texto</button>
        <button class="boton" id="ia-descargar">Descargar (.md)</button>
      </div>
      <p id="ia-estado-evaluacion" class="ayuda" role="status"></p>
      <div id="ia-evaluacion">${r.evaluacion ? htmlEvaluacion(r.evaluacion) : ""}</div>
    </div>`;
}

function renderSeccionIA(proceso) {
  const cuerpo = $("#ia-cuerpo");
  if (!cuerpo) return;
  if (!hayClaveIA()) {
    cuerpo.innerHTML = `${mensaje("Agrega tu clave de Anthropic para que la IA lea el pliego y compare sus requisitos con tu empresa.")}
      <p><button class="boton primario-suave" data-ir-empresa>Configurar la IA</button></p>`;
    return;
  }
  const config = configuracionIA();
  const previo = estado.ia[proceso.id];
  const enCurso = analisisEnCurso?.id === proceso.id;
  cuerpo.innerHTML = `
    <ol class="pasos">
      <li>Descarga el pliego o la invitación desde SECOP II (botón “Ver en SECOP II” y la sección de documentos del proceso).</li>
      <li>Súbelo aquí en PDF (hasta ${Math.round(IA.MAX_BYTES_PDF / 1048576)} MB).</li>
    </ol>
    <div class="fila">
      <label>Pliego (PDF) <input id="ia-archivo" type="file" accept="application/pdf,.pdf"></label>
      <label>Modelo <select id="ia-modelo">${opcionesModelo(config.modeloAnalisis)}</select></label>
    </div>
    <div class="acciones">
      <button class="boton" id="ia-estimar" ${enCurso ? "disabled" : ""}>Estimar costo</button>
      <button class="boton primario-suave" id="ia-analizar" ${enCurso ? "disabled" : ""}>Analizar pliego</button>
      <button class="boton peligro" id="ia-cancelar" ${enCurso ? "" : "hidden"}>Cancelar</button>
    </div>
    <p id="ia-estado" class="ayuda" role="status">${enCurso ? "Analizando el pliego…" : ""}</p>
    <div id="ia-resultado">${previo ? htmlResultadoIA(previo) : ""}</div>`;
}

function montarSeccionIA(proceso, contenedor) {
  contenedor.innerHTML = `
    <section class="seccion-detalle" aria-labelledby="ia-titulo">
      <h3 id="ia-titulo">Análisis del pliego con IA</h3>
      <div id="ia-cuerpo"></div>
    </section>`;
  renderSeccionIA(proceso);
}

const estadoIA = (texto) => { if ($("#ia-estado")) $("#ia-estado").textContent = texto; };
const detalleVigente = (id) => estado.detalle?.id === id;

async function estimarCostoPliego(proceso) {
  const modelo = $("#ia-modelo").value;
  try {
    const { archivo, datos } = await prepararPDF();
    estadoIA("Contando el tamaño del pliego…");
    await asegurarSDK();
    const tokens = await ia.estimarTokensPliego({ clave: claveIA(), modelo, pdfBase64: datos, titulo: archivo.name, proceso });
    const costo = IA.estimarCosto(modelo, tokens, 4000);
    estadoIA(`El pliego tiene unos ${formatoNumero.format(tokens)} tokens. Costo estimado con ${nombreModelo(modelo)}: ${IA.formatoUSD(costo)} (suponiendo unos 4.000 tokens de respuesta).`);
  } catch (error) {
    estadoIA(IA.mensajeDeError(error));
  }
}

async function analizarPliegoConIA(proceso) {
  const modelo = $("#ia-modelo").value;
  let preparado;
  try {
    preparado = await prepararPDF();
  } catch (error) {
    return estadoIA(IA.mensajeDeError(error));
  }

  const controlador = new AbortController();
  analisisEnCurso = { id: proceso.id, controlador };
  $("#ia-analizar").disabled = true;
  $("#ia-estimar").disabled = true;
  $("#ia-cancelar").hidden = false;
  estadoIA(`Analizando con ${nombreModelo(modelo)}… puede tardar uno o dos minutos.`);
  $("#ia-resultado").innerHTML = '<pre class="ia-vivo" id="ia-vivo" aria-live="polite"></pre>';
  let acumulado = "";

  try {
    await asegurarSDK();
    const respuesta = await ia.analizarPliego({
      clave: claveIA(), modelo, pdfBase64: preparado.datos, titulo: preparado.archivo.name, proceso, senal: controlador.signal,
      alTexto: (delta) => {
        acumulado += delta;
        if (detalleVigente(proceso.id) && $("#ia-vivo")) $("#ia-vivo").textContent = acumulado;
      },
    });
    const dibujado = IA.renderizarAnalisis(respuesta.contenido);
    estado.ia[proceso.id] = {
      archivo: preparado.archivo.name, modelo: respuesta.modelo, truncado: respuesta.truncado, uso: respuesta.uso,
      html: dibujado.html, fuentes: dibujado.fuentes, texto: dibujado.texto, evaluacion: null,
    };
    analisisEnCurso = null;
    if (detalleVigente(proceso.id)) renderSeccionIA(proceso);
  } catch (error) {
    analisisEnCurso = null;
    if (!detalleVigente(proceso.id)) return;
    renderSeccionIA(proceso);
    estadoIA(IA.mensajeDeError(error));
  }
}

async function evaluarContraMiEmpresa(proceso) {
  const resultado = estado.ia[proceso.id];
  const mostrar = (texto) => { if ($("#ia-estado-evaluacion")) $("#ia-estado-evaluacion").textContent = texto; };
  if (!resultado) return;
  try {
    mostrar("Comparando los requisitos con el perfil de tu empresa…");
    await asegurarSDK();
    resultado.evaluacion = await ia.evaluarContraEmpresa({
      clave: claveIA(), modelo: $("#ia-modelo")?.value || configuracionIA().modeloAnalisis,
      analisis: resultado.texto, empresa: perfilEmpresa(), proceso,
    });
    if (detalleVigente(proceso.id)) {
      $("#ia-evaluacion").innerHTML = htmlEvaluacion(resultado.evaluacion);
      mostrar("");
    }
  } catch (error) {
    mostrar(IA.mensajeDeError(error));
  }
}

function markdownDelAnalisis(proceso, r) {
  const lineas = [
    `# Análisis del pliego: ${proceso.nombre}`, "",
    `- Entidad: ${proceso.entidad || "—"}`, `- Referencia: ${proceso.referencia || "—"}`, `- Documento: ${r.archivo}`,
    `- Generado con ${nombreModelo(r.modelo)} el ${Secop.fechaIso(new Date())}. La IA puede equivocarse: confirma cada dato en el pliego.`, "",
    r.texto.trim(),
  ];
  if (r.fuentes.length) lineas.push("", "## Fuentes citadas", ...r.fuentes.map((f) => `${f.n}. ${f.pagina}: «${f.texto}»`));
  if (r.evaluacion) {
    lineas.push("", "## Evaluación contra el perfil de la empresa", "", `**${(ETIQUETAS_VEREDICTO[r.evaluacion.veredicto] || [r.evaluacion.veredicto])[0]}.** ${r.evaluacion.resumen}`, "");
    for (const q of r.evaluacion.requisitos) {
      lineas.push(`- **${(ETIQUETAS_ESTADO[q.estado] || [q.estado])[0]}:** ${q.requisito}. ${q.evidencia} ${q.accion ? `Qué hacer: ${q.accion}` : ""}`.trim());
    }
    if (r.evaluacion.proximos_pasos.length) lineas.push("", "### Próximos pasos", ...r.evaluacion.proximos_pasos.map((p) => `- ${p}`));
  }
  return lineas.join("\n") + "\n";
}

async function copiarAnalisis(proceso) {
  const r = estado.ia[proceso.id];
  try {
    await navigator.clipboard.writeText(markdownDelAnalisis(proceso, r));
    $("#ia-estado-evaluacion").textContent = "Texto copiado.";
  } catch {
    $("#ia-estado-evaluacion").textContent = "Tu navegador no permitió copiar. Usa “Descargar (.md)”.";
  }
}

function irAFuente(numero) {
  const detalles = $("#ia-fuentes");
  if (detalles) detalles.open = true;
  const fuente = $(`#fuente-${numero}`);
  if (!fuente) return;
  fuente.scrollIntoView({ block: "nearest" });
  fuente.classList.add("resaltada");
  setTimeout(() => fuente.classList.remove("resaltada"), 1800);
}

function iniciarIAUI() {
  Radar.alAbrirDetalle.push(montarSeccionIA);
  document.addEventListener("click", (evento) => {
    const objetivo = evento.target;
    const proceso = estado.detalle;
    if (objetivo.closest("[data-triaje]")) evaluarVisiblesConIA();
    if (objetivo.closest("[data-ir-empresa]")) {
      $("#detalle").close();
      mostrarPestana("empresa");
    }
    const fuente = objetivo.closest("a[data-fuente]");
    if (fuente) {
      evento.preventDefault();
      irAFuente(fuente.dataset.fuente);
    }
    if (!proceso) return;
    if (objetivo.id === "ia-estimar") estimarCostoPliego(proceso);
    if (objetivo.id === "ia-analizar") analizarPliegoConIA(proceso);
    if (objetivo.id === "ia-cancelar") analisisEnCurso?.controlador.abort();
    if (objetivo.id === "ia-evaluar") evaluarContraMiEmpresa(proceso);
    if (objetivo.id === "ia-copiar") copiarAnalisis(proceso);
    if (objetivo.id === "ia-descargar") {
      const referencia = (proceso.referencia || proceso.id).replace(/[^\w.-]+/g, "-");
      descargarArchivo(`analisis-pliego-${referencia}.md`, markdownDelAnalisis(proceso, estado.ia[proceso.id]), "text/markdown;charset=utf-8");
    }
  });
}
registrarInicio(iniciarIAUI);
