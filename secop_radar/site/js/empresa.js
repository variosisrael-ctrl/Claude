"use strict";

// Pestaña "Empresa e IA": la clave de Anthropic de cada persona, los modelos y el perfil de la empresa que usa la IA.
// La clave se guarda solo en este navegador y solo viaja a api.anthropic.com.

const CLAVE_IA_CONFIG = "radar-secop:ia";
const CLAVE_IA_SECRETO = "radar-secop:ia-clave";
const CLAVE_EMPRESA = "radar-secop:empresa";

const ia = IA.crearIA();

// --- Almacenamiento de la clave y la configuración ----------------------------

function configuracionIA() {
  const c = leer(CLAVE_IA_CONFIG, {});
  return {
    modeloAnalisis: c.modeloAnalisis in IA.MODELOS ? c.modeloAnalisis : IA.MODELO_ANALISIS,
    modeloTriaje: c.modeloTriaje in IA.MODELOS ? c.modeloTriaje : IA.MODELO_TRIAJE,
    recordar: c.recordar === true,
  };
}

function claveIA() {
  try {
    return localStorage.getItem(CLAVE_IA_SECRETO) || sessionStorage.getItem(CLAVE_IA_SECRETO) || "";
  } catch {
    return "";
  }
}

function guardarClaveIA(clave, recordar) {
  try {
    localStorage.removeItem(CLAVE_IA_SECRETO);
    sessionStorage.removeItem(CLAVE_IA_SECRETO);
    if (clave) (recordar ? localStorage : sessionStorage).setItem(CLAVE_IA_SECRETO, clave);
  } catch {
    // Sin almacenamiento: la clave solo vale mientras no se recargue la página.
  }
}

const perfilEmpresa = () => leer(CLAVE_EMPRESA, {});
const hayClaveIA = () => claveIA().length > 0;

// --- Carga diferida del SDK de Anthropic --------------------------------------

let promesaSDK = null;

/** El SDK pesa ~190 KB: solo se descarga cuando alguien usa una función de IA. */
function asegurarSDK() {
  if (typeof Anthropic !== "undefined") return Promise.resolve();
  promesaSDK ??= new Promise((resolver, rechazar) => {
    const script = document.createElement("script");
    script.src = "vendor/anthropic-sdk.js";
    script.onload = resolver;
    script.onerror = () => {
      promesaSDK = null;
      rechazar(new IA.ErrorDeIA("No se pudo cargar el componente de IA. Revisa tu conexión e inténtalo de nuevo."));
    };
    document.head.appendChild(script);
  });
  return promesaSDK;
}

// --- Pantalla -----------------------------------------------------------------

const opcionesModelo = (seleccionado) =>
  Object.entries(IA.MODELOS).map(([id, m]) => {
    const precio = `US$ ${m.entrada} / ${m.salida} por millón de tokens`;
    return `<option value="${id}" ${id === seleccionado ? "selected" : ""}>${esc(m.nombre)} · ${esc(precio)}</option>`;
  }).join("");

function campoEmpresa([clave, etiqueta], valor) {
  if (clave === "tamano") {
    const tamanos = ["", "Microempresa", "Pequeña", "Mediana", "Grande"];
    return `<label>${esc(etiqueta)}
      <select data-campo-empresa="${clave}">${tamanos.map((t) => `<option ${t === valor ? "selected" : ""}>${esc(t)}</option>`).join("")}</select></label>`;
  }
  const largo = ["nombre", "ubicacion"].includes(clave);
  return `<label>${esc(etiqueta)}
    ${largo
      ? `<input data-campo-empresa="${clave}" autocomplete="off" value="${esc(valor)}">`
      : `<textarea data-campo-empresa="${clave}" rows="3">${esc(valor)}</textarea>`}</label>`;
}

function renderEmpresa() {
  const config = configuracionIA();
  const empresa = perfilEmpresa();
  const guardada = hayClaveIA();
  $("#vista-empresa").innerHTML = `
    <section class="panel" aria-labelledby="titulo-clave">
      <h2 id="titulo-clave">IA con tu clave de Anthropic</h2>
      <p class="ayuda">La IA lee el pliego de un proceso, extrae requisitos con la página donde aparece cada uno y los compara con el perfil de tu empresa.
        Funciona con la clave de la API de cada persona de tu equipo: la creas en console.anthropic.com → API keys, y conviene ponerle un límite de gasto allí.</p>
      <label>Clave de la API
        <input id="clave-ia" type="password" autocomplete="off" spellcheck="false" placeholder="${guardada ? "Clave guardada (escribe otra para reemplazarla)" : "sk-ant-…"}">
      </label>
      <label class="casilla">
        <input id="recordar-clave" type="checkbox" ${config.recordar ? "checked" : ""}>
        Recordar la clave en este navegador
        <span class="ayuda">Si no la marcas, la clave se borra al cerrar la pestaña. No la recuerdes en un computador compartido.</span>
      </label>
      <label>Modelo para analizar pliegos
        <select id="modelo-analisis">${opcionesModelo(config.modeloAnalisis)}</select>
      </label>
      <label>Modelo para evaluar muchos procesos a la vez
        <select id="modelo-triaje">${opcionesModelo(config.modeloTriaje)}</select>
      </label>
      <div class="acciones">
        <button type="button" class="boton primario-suave" id="guardar-ia">Guardar</button>
        <button type="button" class="boton" id="probar-ia">Probar la clave</button>
        <button type="button" class="boton peligro" id="borrar-ia">Borrar la clave</button>
      </div>
      <p id="estado-ia" class="ayuda" role="status"></p>
      <p class="ayuda">Tu clave solo se usa desde este navegador y solo se envía a Anthropic. Los pliegos que subas y el perfil de tu empresa también
        viajan a Anthropic cuando uses la IA. Los precios son tarifas de lista de octubre de 2026 y sirven de estimación: el cobro real es el de tu cuenta.
        Antes de cada análisis verás el costo estimado.</p>
    </section>

    <section class="panel" aria-labelledby="titulo-empresa">
      <h2 id="titulo-empresa">Perfil de tu empresa</h2>
      <p class="ayuda">La IA lo usa para decir si cumples los requisitos de un proceso y qué tan bien encaja. Mientras más concreto (montos, años, entidades),
        mejor. Se guarda en este navegador y se actualiza al salir de cada campo.</p>
      ${IA.CAMPOS_EMPRESA.map((campo) => campoEmpresa(campo, empresa[campo[0]] ?? "")).join("")}
      <p id="estado-empresa" class="ayuda" role="status"></p>
    </section>`;
}

function mostrarEstadoIA(texto, error = false) {
  const nodo = $("#estado-ia");
  if (!nodo) return;
  nodo.textContent = texto;
  nodo.classList.toggle("error-texto", error);
}

function guardarAjustesIA() {
  const escrita = $("#clave-ia").value.trim();
  const recordar = $("#recordar-clave").checked;
  guardar(CLAVE_IA_CONFIG, {
    modeloAnalisis: $("#modelo-analisis").value,
    modeloTriaje: $("#modelo-triaje").value,
    recordar,
  });
  // Sin clave nueva se conserva la guardada, pero se mueve al almacén que corresponde a "recordar".
  guardarClaveIA(escrita || claveIA(), recordar);
  renderEmpresa();
  mostrarEstadoIA(hayClaveIA() ? "Ajustes guardados." : "Ajustes guardados. Falta la clave de la API.");
}

async function probarClaveIA() {
  const escrita = $("#clave-ia").value.trim();
  if (escrita) guardarAjustesIA();
  mostrarEstadoIA("Probando la clave…");
  try {
    await asegurarSDK();
    await ia.probarClave({ clave: claveIA(), modelo: configuracionIA().modeloTriaje });
    mostrarEstadoIA("La clave funciona.");
  } catch (error) {
    mostrarEstadoIA(IA.mensajeDeError(error), true);
  }
}

function borrarClaveGuardada() {
  guardarClaveIA("", false);
  renderEmpresa();
  mostrarEstadoIA("Clave borrada de este navegador.");
}

function iniciarEmpresa() {
  Radar.alMostrar.empresa = renderEmpresa;
  const vista = $("#vista-empresa");
  vista.addEventListener("click", (evento) => {
    const id = evento.target.id;
    if (id === "guardar-ia") guardarAjustesIA();
    if (id === "probar-ia") probarClaveIA();
    if (id === "borrar-ia") borrarClaveGuardada();
  });
  vista.addEventListener("change", (evento) => {
    const campo = evento.target.dataset.campoEmpresa;
    if (!campo) return;
    guardar(CLAVE_EMPRESA, { ...perfilEmpresa(), [campo]: evento.target.value.trim() });
    $("#estado-empresa").textContent = "Guardado.";
  });
}
registrarInicio(iniciarEmpresa);
