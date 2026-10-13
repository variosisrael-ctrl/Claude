"use strict";

// Pestaña "Mis alertas": crear y administrar las alertas de Telegram desde la página. La configuración se guarda en un
// gist secreto de GitHub de la persona, con su propio token (solo necesita el permiso «gist»), y el flujo programado del
// repositorio la lee desde allí. El token vive solo en este navegador y solo viaja a api.github.com.

const CLAVE_GH_AJUSTES = "radar-secop:github";
const CLAVE_GH_TOKEN = "radar-secop:github-token";
const CLAVE_ALERTAS_COPIA = "radar-secop:alertas";
const MS_ESPERA_GUARDADO = 700;

const alertasUI = {
  config: null,        // configuración en memoria (ConfigAlertas)
  editando: null,      // "nueva", el identificador de la alerta que se edita o null
  formulario: null,    // valores del formulario abierto
  errorFormulario: "",
  estado: { texto: "", error: false },
  pendiente: false,
  guardando: false,
  temporizador: null,
  cargando: false,
};

// --- Almacenamiento del token y los ajustes -------------------------------------

function ajustesGitHub() {
  const a = leer(CLAVE_GH_AJUSTES, {});
  return {
    gistId: typeof a.gistId === "string" ? a.gistId : "",
    usuario: typeof a.usuario === "string" ? a.usuario : "",
    recordar: a.recordar === true,
  };
}

function tokenGitHub() {
  try {
    return localStorage.getItem(CLAVE_GH_TOKEN) || sessionStorage.getItem(CLAVE_GH_TOKEN) || "";
  } catch {
    return "";
  }
}

function guardarTokenGitHub(token, recordar) {
  try {
    localStorage.removeItem(CLAVE_GH_TOKEN);
    sessionStorage.removeItem(CLAVE_GH_TOKEN);
    if (token) (recordar ? localStorage : sessionStorage).setItem(CLAVE_GH_TOKEN, token);
  } catch {
    // Sin almacenamiento: el token solo vale mientras no se recargue la página.
  }
}

const alertasConectadas = () => Boolean(tokenGitHub() && ajustesGitHub().gistId);
const clienteGitHub = () => Gist.crearClienteGist({ token: tokenGitHub() });

/** Dirección del repositorio, deducida de la de la página (https://usuario.github.io/Repositorio/). */
function urlRepositorio() {
  const m = /^([a-z0-9-]+)\.github\.io$/i.exec(location.hostname);
  const repo = location.pathname.split("/").filter(Boolean)[0];
  return m && repo ? `https://github.com/${m[1]}/${repo}` : null;
}

// --- Estado y guardado -----------------------------------------------------------

function decirEstado(texto, error = false) {
  alertasUI.estado = { texto, error };
  const nodo = $("#estado-alertas");
  if (nodo) {
    nodo.textContent = texto;
    nodo.classList.toggle("error-texto", error);
  }
  const reintentar = document.querySelector('[data-accion="reintentar"]');
  if (reintentar) reintentar.hidden = !(error && alertasUI.pendiente);
}

const horaActual = () => new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" });

function guardarCopiaLocal() {
  if (alertasUI.config) guardar(CLAVE_ALERTAS_COPIA, alertasUI.config);
}

function programarGuardado() {
  guardarCopiaLocal();
  alertasUI.pendiente = true;
  decirEstado("Guardando…");
  clearTimeout(alertasUI.temporizador);
  alertasUI.temporizador = setTimeout(guardarEnGitHub, MS_ESPERA_GUARDADO);
}

/** Escribe la configuración en el gist. Si llegan cambios mientras escribe, vuelve a escribir al terminar. */
async function guardarEnGitHub() {
  if (alertasUI.guardando) return; // el guardado en curso verá `pendiente` al terminar y repetirá
  alertasUI.guardando = true;
  try {
    while (alertasUI.pendiente) {
      alertasUI.pendiente = false;
      const texto = ConfigAlertas.serializar(alertasUI.config);
      await clienteGitHub().guardar(ajustesGitHub().gistId, texto);
      decirEstado(`Guardado en GitHub a las ${horaActual()}.`);
    }
  } catch (error) {
    alertasUI.pendiente = true; // queda por guardar: "Reintentar"
    decirEstado(`No se pudo guardar: ${error.message}`, true);
  } finally {
    alertasUI.guardando = false;
  }
}

/**
 * Aplica un cambio a la configuración, la pinta y programa el guardado en GitHub. Los campos de texto de la pantalla
 * piden `pintar: false`: redibujar mientras alguien pasa de un campo a otro le quitaría el cursor y lo que escribió.
 */
function cambiarConfig(cambiar, { pintar = true } = {}) {
  cambiar(alertasUI.config);
  if (pintar) renderAlertas();
  programarGuardado();
}

async function cargarConfiguracion() {
  if (!alertasConectadas() || alertasUI.cargando) return;
  alertasUI.cargando = true;
  try {
    const contenido = await clienteGitHub().leer(ajustesGitHub().gistId);
    const { config, problemas } = ConfigAlertas.desdeTexto(contenido);
    alertasUI.config = config;
    guardarCopiaLocal();
    decirEstado(problemas ? `Se ignoraron ${plural(problemas, "entrada", "entradas")} de la configuración que no eran válidas.` : "");
  } catch (error) {
    // Sin conexión o con el gist inaccesible se usa la última copia conocida, pero no se guarda encima.
    const copia = leer(CLAVE_ALERTAS_COPIA, null);
    alertasUI.config ??= copia ? ConfigAlertas.normalizarConfig(copia).config : null;
    decirEstado(`No se pudo leer tu configuración de GitHub: ${error.message}`, true);
  } finally {
    alertasUI.cargando = false;
  }
}

// --- Sincronizar los procesos en seguimiento -----------------------------------

function sincronizarSeguimiento() {
  if (!alertasUI.config || !alertasConectadas()) return;
  const actuales = ConfigAlertas.procesosSeguidos(seguimiento());
  const previos = alertasUI.config.seguimiento.procesos;
  const igual = actuales.length === previos.length && actuales.every((p, i) => p.id === previos[i].id && p.cierre === previos[i].cierre);
  if (igual) return;
  alertasUI.config.seguimiento.procesos = actuales;
  programarGuardado();
  if (!$("#vista-alertas").hidden) renderAlertas();
}

// --- Conexión con GitHub ---------------------------------------------------------

async function conectarGitHub() {
  const escrito = $("#gh-token")?.value.trim() ?? "";
  const token = escrito || tokenGitHub();
  const recordar = $("#gh-recordar").checked;
  const gistEscrito = ($("#gh-gist")?.value.trim() ?? "") || ajustesGitHub().gistId;

  const problema = Gist.problemaDelToken(token);
  if (problema) return decirEstado(problema, true);
  decirEstado("Conectando con GitHub…");
  const cliente = Gist.crearClienteGist({ token });
  try {
    const { usuario } = await cliente.verificar();
    let gistId = gistEscrito;
    let config;
    if (gistId) {
      const { config: leida, problemas } = ConfigAlertas.desdeTexto(await cliente.leer(gistId));
      config = leida;
      if (problemas) decirEstado(`Se ignoraron ${plural(problemas, "entrada", "entradas")} que no eran válidas.`, true);
    } else {
      config = ConfigAlertas.configVacia();
      config.resumen.activo = true; // lo más útil para empezar: el resumen diario de todo el país
      config.seguimiento.procesos = ConfigAlertas.procesosSeguidos(seguimiento());
      ({ id: gistId } = await cliente.crear(ConfigAlertas.serializar(config)));
    }
    guardarTokenGitHub(token, recordar);
    guardar(CLAVE_GH_AJUSTES, { gistId, usuario: usuario ?? "", recordar });
    alertasUI.config = config;
    guardarCopiaLocal();
    renderAlertas();
    sincronizarSeguimiento();
    decirEstado(`Conectado${usuario ? ` como ${usuario}` : ""}.`);
  } catch (error) {
    decirEstado(error.message, true);
  }
}

function desconectarGitHub() {
  clearTimeout(alertasUI.temporizador);
  alertasUI.pendiente = false;
  guardarTokenGitHub("", false);
  guardar(CLAVE_GH_AJUSTES, { gistId: "", usuario: "", recordar: false });
  guardar(CLAVE_ALERTAS_COPIA, null);
  alertasUI.config = null;
  alertasUI.editando = null;
  renderAlertas();
  decirEstado("Token borrado de este navegador. Tus alertas siguen guardadas en tu gist de GitHub.");
}

// --- Pantalla ---------------------------------------------------------------------

function vistaConexion() {
  const ajustes = ajustesGitHub();
  const nuevoToken = "https://github.com/settings/tokens/new?scopes=gist&description=Radar%20SECOP";
  const guardado = Boolean(tokenGitHub());
  return `
    <section class="panel" aria-labelledby="titulo-conexion">
      <h2 id="titulo-conexion">Conecta tus alertas con GitHub</h2>
      <p class="ayuda">Aquí creas todas las alertas que quieras y te llegan por Telegram, sin volver a tocar la configuración de GitHub.
        Se guardan en un archivo privado (un «gist») de tu cuenta de GitHub y el programa de las 7:00 y las 5:00 las lee desde allí.</p>
      <ol class="pasos">
        <li>Crea un token en <a href="${esc(nuevoToken)}" target="_blank" rel="noopener">github.com/settings/tokens/new</a>.
          Ya viene con la casilla <strong>gist</strong> marcada; no marques ninguna otra. En «Expiration» elige el plazo que prefieras.
          Pulsa el botón verde <strong>Generate token</strong> al final y copia el token (empieza por <code>ghp_</code>).</li>
        <li>Pégalo aquí y pulsa <strong>Conectar</strong>.</li>
      </ol>
      <label>Token de GitHub
        <input id="gh-token" type="password" autocomplete="off" spellcheck="false" placeholder="${guardado ? "Token guardado (escribe otro para reemplazarlo)" : "ghp_…"}">
      </label>
      <label class="casilla">
        <input id="gh-recordar" type="checkbox" ${ajustes.recordar ? "checked" : ""}>
        Recordar el token en este navegador
        <span class="ayuda">Si no lo marcas, se borra al cerrar la pestaña. No lo recuerdes en un computador compartido.</span>
      </label>
      <details>
        <summary>Ya creé mis alertas antes (otro navegador o computador)</summary>
        <label>Identificador de tu gist
          <input id="gh-gist" autocomplete="off" spellcheck="false" value="${esc(ajustes.gistId)}" placeholder="por ejemplo 4f9c2a…">
        </label>
        <p class="ayuda">Lo ves en la pestaña «Mis alertas» de donde las creaste, en «Tu configuración».</p>
      </details>
      <div class="acciones"><button type="button" class="boton primario-suave" data-accion="conectar">Conectar</button></div>
      <p id="estado-alertas" class="ayuda ${alertasUI.estado.error ? "error-texto" : ""}" role="status">${esc(alertasUI.estado.texto)}</p>
      <p class="ayuda">El token solo se usa desde este navegador y solo se envía a GitHub. Con el permiso «gist» solo se pueden leer y escribir tus gists: no da acceso a tus repositorios.
        El gist es secreto (no aparece en buscadores ni en tu perfil) pero no está cifrado: lo ve quien tenga su dirección.</p>
    </section>`;
}

function formularioAlerta() {
  const f = alertasUI.formulario;
  return `
    <section class="panel" aria-labelledby="titulo-alerta">
      <h3 id="titulo-alerta">${alertasUI.editando === "nueva" ? "Crear alerta" : "Editar alerta"}</h3>
      <label>Nombre
        <input id="al-nombre" autocomplete="off" maxlength="60" value="${esc(f.nombre)}" placeholder="Ej.: Mantenimiento en Antioquia">
      </label>
      <label>Palabras clave
        <input id="al-palabras" autocomplete="off" value="${esc(f.palabras)}" placeholder="mantenimiento, software, capacitación">
        <span class="ayuda">Separadas por comas. Se busca en el nombre y la descripción del proceso.</span>
      </label>
      <label>Códigos UNSPSC (opcional)
        <input id="al-codigos" autocomplete="off" value="${esc(f.codigos)}" placeholder="8011, 72151">
      </label>
      <label>Departamento (opcional)
        <input id="al-departamento" autocomplete="off" value="${esc(f.departamento)}" placeholder="Antioquia">
      </label>
      <div class="fila-doble">
        <label>Presupuesto mínimo
          <input id="al-min" inputmode="numeric" autocomplete="off" value="${esc(f.min)}" placeholder="50000000">
        </label>
        <label>Presupuesto máximo
          <input id="al-max" inputmode="numeric" autocomplete="off" value="${esc(f.max)}" placeholder="500000000">
        </label>
      </div>
      <label class="casilla">
        <input id="al-competitivos" type="checkbox" ${f.competitivos === "0" ? "" : "checked"}>
        Solo procesos competitivos
        <span class="ayuda">Deja fuera contratación directa y régimen especial, donde la entidad ya eligió a quién contratar.</span>
      </label>
      <details>
        <summary>Más opciones</summary>
        <label>Coincidencia mínima (0 a 100)
          <input id="al-minimo" inputmode="numeric" autocomplete="off" value="${esc(f.minimo)}">
          <span class="ayuda">Solo te avisa de procesos que se parezcan al menos este porcentaje a tus palabras y códigos. 40 es un buen punto de partida.</span>
        </label>
      </details>
      <p id="alerta-error" class="mensaje error" role="alert" ${alertasUI.errorFormulario ? "" : "hidden"}>${esc(alertasUI.errorFormulario)}</p>
      <div class="acciones">
        <button type="button" class="boton primario-suave" data-accion="guardar-alerta">Guardar alerta</button>
        <button type="button" class="boton" data-accion="cancelar-alerta">Cancelar</button>
      </div>
    </section>`;
}

function tarjetaAlerta(a) {
  return `
    <article class="tarjeta" data-alerta="${esc(a.id)}">
      <header class="tarjeta-cabecera">
        <label class="campo-inline"><input type="checkbox" data-activa="${esc(a.id)}" ${a.activa ? "checked" : ""}> Activa</label>
        ${a.activa ? "" : '<span class="chip">En pausa</span>'}
      </header>
      <h3>${esc(a.nombre)}</h3>
      <p class="entidad">${esc(ConfigAlertas.descripcionAlerta(a))}</p>
      <footer class="acciones">
        <button type="button" class="boton" data-accion="editar" data-id="${esc(a.id)}">Editar</button>
        <button type="button" class="boton peligro" data-accion="borrar" data-id="${esc(a.id)}">Borrar</button>
      </footer>
    </article>`;
}

function vistaAlertas() {
  const { config } = alertasUI;
  const ajustes = ajustesGitHub();
  const repo = urlRepositorio();
  const seguidos = ConfigAlertas.procesosSeguidos(seguimiento()).length;
  const limite = config.alertas.length >= ConfigAlertas.MAX_ALERTAS;
  const r = config.resumen;
  return `
    <section class="panel" aria-labelledby="titulo-mis-alertas">
      <h2 id="titulo-mis-alertas">Mis alertas por tema</h2>
      <p class="ayuda">Cada alerta te avisa por Telegram cuando aparece un proceso nuevo que coincide. Puedes tener hasta ${ConfigAlertas.MAX_ALERTAS}.
        Los cambios se guardan solos y se aplican en la próxima revisión (7:00 a. m. y 5:00 p. m., hora de Colombia).</p>
      <div class="acciones">
        <button type="button" class="boton primario-suave" data-accion="nueva-alerta" ${limite ? "disabled" : ""}>Crear alerta</button>
        <button type="button" class="boton" data-accion="usar-busqueda" ${limite ? "disabled" : ""}>Crear alerta con mi búsqueda actual</button>
      </div>
      ${alertasUI.editando ? formularioAlerta() : ""}
      <div class="lista">
        ${config.alertas.length ? config.alertas.map(tarjetaAlerta).join("") : mensaje("Aún no tienes alertas por tema. Pulsa “Crear alerta”.")}
      </div>
    </section>

    <section class="panel" aria-labelledby="titulo-resumen">
      <h2 id="titulo-resumen">Resumen diario de todo el país</h2>
      <p class="ayuda">Si quieres estar atento a todo tipo de proceso, activa este resumen: un solo mensaje cada mañana con los procesos nuevos de mayor presupuesto.</p>
      <label class="casilla"><input id="res-activo" type="checkbox" ${r.activo ? "checked" : ""}> Recibir el resumen diario</label>
      <div class="fila-doble">
        <label>Departamento (opcional)
          <input id="res-departamento" autocomplete="off" value="${esc(r.departamento)}" placeholder="Todo el país">
        </label>
        <label>Presupuesto mínimo (opcional)
          <input id="res-min" inputmode="numeric" autocomplete="off" value="${esc(r.min)}" placeholder="100000000">
        </label>
      </div>
      <label>Cuántos procesos detallar (1 a ${ConfigAlertas.TOP_MAXIMO})
        <input id="res-top" inputmode="numeric" autocomplete="off" value="${esc(r.top)}">
      </label>
      <p id="res-error" class="mensaje error" role="alert" hidden></p>
    </section>

    <section class="panel" aria-labelledby="titulo-seguimiento-alertas">
      <h2 id="titulo-seguimiento-alertas">Procesos que sigues</h2>
      <p class="ayuda">Vigilamos ${plural(seguidos, "proceso", "procesos")} de «Mi seguimiento» (menos los perdidos y descartados).</p>
      <label class="casilla">
        <input id="seg-avisar" type="checkbox" ${config.seguimiento.avisar ? "checked" : ""}>
        Avisarme si cambia su fecha de cierre, se adjudica o se cancela
      </label>
    </section>

    <section class="panel" aria-labelledby="titulo-tu-configuracion">
      <h2 id="titulo-tu-configuracion">Tu configuración</h2>
      <p class="ayuda">Conectado${ajustes.usuario ? ` como <strong>${esc(ajustes.usuario)}</strong>` : ""}. Para que el programa de las alertas encuentre tu configuración
        hace falta, una sola vez, guardar este identificador como secreto del repositorio con el nombre <code>ALERTAS_GIST_ID</code>.</p>
      <label>Identificador de tu gist
        <input id="gh-gist-lectura" readonly value="${esc(ajustes.gistId)}" aria-label="Identificador del gist">
      </label>
      <div class="acciones">
        <button type="button" class="boton" data-accion="copiar-gist">Copiar identificador</button>
        ${repo ? `<a class="boton" href="${esc(repo)}/settings/secrets/actions/new" target="_blank" rel="noopener">Crear el secreto en GitHub</a>` : ""}
        <button type="button" class="boton peligro" data-accion="desconectar">Desconectar este navegador</button>
      </div>
      <p class="ayuda">En el secreto, «Name» es <code>ALERTAS_GIST_ID</code> y «Secret» es el identificador de arriba. Detalles en la
        <a href="${esc((repo || "https://github.com") + "/blob/main/alertas/README.md")}" target="_blank" rel="noopener">guía de alertas</a>.</p>
      <p id="estado-alertas" class="ayuda ${alertasUI.estado.error ? "error-texto" : ""}" role="status">${esc(alertasUI.estado.texto)}</p>
      <div class="acciones"><button type="button" class="boton" data-accion="reintentar" ${alertasUI.pendiente && alertasUI.estado.error ? "" : "hidden"}>Reintentar guardar</button></div>
    </section>`;
}

function renderAlertas() {
  const vista = $("#vista-alertas");
  if (!vista) return;
  if (!alertasConectadas()) {
    vista.innerHTML = vistaConexion();
    return;
  }
  if (!alertasUI.config) {
    vista.innerHTML = mensaje(alertasUI.cargando ? "Leyendo tus alertas desde GitHub…" : "No se pudo leer tu configuración.", alertasUI.cargando ? "info" : "error") +
      `<p id="estado-alertas" class="ayuda ${alertasUI.estado.error ? "error-texto" : ""}" role="status">${esc(alertasUI.estado.texto)}</p>` +
      '<div class="acciones"><button type="button" class="boton" data-accion="recargar">Reintentar</button> <button type="button" class="boton peligro" data-accion="desconectar">Desconectar este navegador</button></div>';
    return;
  }
  vista.innerHTML = vistaAlertas();
}

async function mostrarAlertas() {
  renderAlertas();
  if (alertasConectadas() && !alertasUI.pendiente && !alertasUI.guardando) {
    await cargarConfiguracion();
    sincronizarSeguimiento();
    renderAlertas();
  }
}

// --- Formulario de alertas ---------------------------------------------------------

const FORMULARIO_VACIO = { nombre: "", palabras: "", codigos: "", departamento: "", min: "", max: "", competitivos: "1", minimo: String(ConfigAlertas.MINIMO_POR_DEFECTO) };

function abrirFormulario(id, valores) {
  alertasUI.editando = id;
  alertasUI.formulario = { ...FORMULARIO_VACIO, ...valores };
  alertasUI.errorFormulario = "";
  renderAlertas();
  $("#al-nombre")?.focus();
}

function leerFormulario() {
  return {
    nombre: $("#al-nombre").value,
    palabras: $("#al-palabras").value,
    codigos: $("#al-codigos").value,
    departamento: $("#al-departamento").value,
    min: $("#al-min").value,
    max: $("#al-max").value,
    competitivos: $("#al-competitivos").checked ? "1" : "0",
    minimo: $("#al-minimo").value,
  };
}

function guardarAlertaDelFormulario() {
  const valores = leerFormulario();
  const id = alertasUI.editando === "nueva" ? ConfigAlertas.nuevoId() : alertasUI.editando;
  const previa = alertasUI.config.alertas.find((a) => a.id === id);
  let alerta;
  try {
    alerta = ConfigAlertas.validarAlerta({ ...valores, id, activa: previa ? previa.activa : true });
  } catch (error) {
    if (!(error instanceof ConfigAlertas.ErrorDeConfiguracion)) throw error;
    alertasUI.formulario = valores;
    alertasUI.errorFormulario = error.message;
    const nodo = $("#alerta-error");
    nodo.textContent = error.message;
    nodo.hidden = false;
    return;
  }
  alertasUI.editando = null;
  cambiarConfig((config) => {
    const i = config.alertas.findIndex((a) => a.id === id);
    if (i >= 0) config.alertas[i] = alerta;
    else config.alertas.unshift(alerta);
  });
}

/** Valores de la búsqueda de la izquierda para empezar una alerta con ellos. */
function valoresDeLaBusquedaActual() {
  const perfil = perfilDelFormulario();
  return { palabras: perfil.palabras, codigos: perfil.codigos, departamento: perfil.departamento, min: perfil.min, max: perfil.max, competitivos: perfil.competitivos };
}

/** Desde el panel «Mis búsquedas»: lleva a la pestaña con el formulario ya lleno con la búsqueda actual. */
async function crearAlertaConLaBusqueda() {
  mostrarPestana("alertas");
  if (!alertasConectadas()) return;
  if (!alertasUI.config) await cargarConfiguracion();
  if (alertasUI.config) abrirFormulario("nueva", valoresDeLaBusquedaActual());
}

// --- Resumen diario y seguimiento --------------------------------------------------

function cambiarResumen() {
  const candidato = {
    activo: $("#res-activo").checked,
    departamento: $("#res-departamento").value,
    min: $("#res-min").value,
    top: $("#res-top").value,
  };
  try {
    const valido = ConfigAlertas.validarResumen(candidato);
    $("#res-error").hidden = true;
    cambiarConfig((config) => { config.resumen = valido; }, { pintar: false });
  } catch (error) {
    if (!(error instanceof ConfigAlertas.ErrorDeConfiguracion)) throw error;
    const nodo = $("#res-error");
    nodo.textContent = error.message;
    nodo.hidden = false;
  }
}

// --- Eventos ---------------------------------------------------------------------

async function copiarIdentificadorGist() {
  const id = ajustesGitHub().gistId;
  try {
    await navigator.clipboard.writeText(id);
    decirEstado("Identificador copiado.");
  } catch {
    const campo = $("#gh-gist-lectura");
    campo.focus();
    campo.select();
    decirEstado("Copia el identificador seleccionado (Ctrl+C).");
  }
}

function alHacerClic(evento) {
  const boton = evento.target.closest("[data-accion]");
  if (!boton) return;
  const { accion, id } = boton.dataset;
  if (accion === "conectar") conectarGitHub();
  else if (accion === "desconectar") desconectarGitHub();
  else if (accion === "copiar-gist") copiarIdentificadorGist();
  else if (accion === "nueva-alerta") abrirFormulario("nueva", {});
  else if (accion === "usar-busqueda") abrirFormulario("nueva", valoresDeLaBusquedaActual());
  else if (accion === "cancelar-alerta") { alertasUI.editando = null; renderAlertas(); }
  else if (accion === "guardar-alerta") guardarAlertaDelFormulario();
  else if (accion === "editar") {
    const a = alertasUI.config.alertas.find((x) => x.id === id);
    if (a) abrirFormulario(id, { ...a, minimo: String(a.minimo) });
  } else if (accion === "borrar") {
    const a = alertasUI.config.alertas.find((x) => x.id === id);
    if (a && confirm(`¿Borrar la alerta “${a.nombre}”?`)) cambiarConfig((config) => { config.alertas = config.alertas.filter((x) => x.id !== id); });
  } else if (accion === "reintentar") { programarGuardado(); }
  else if (accion === "recargar") mostrarAlertas();
}

function alCambiar(evento) {
  const destino = evento.target;
  if (destino.dataset.activa) {
    cambiarConfig((config) => { config.alertas.find((a) => a.id === destino.dataset.activa).activa = destino.checked; });
  } else if (destino.id === "seg-avisar") {
    cambiarConfig((config) => { config.seguimiento.avisar = destino.checked; }, { pintar: false });
  } else if (["res-activo", "res-departamento", "res-min", "res-top"].includes(destino.id)) {
    cambiarResumen();
  }
}

function iniciarAlertas() {
  Radar.alMostrar.alertas = mostrarAlertas;
  Radar.alCambiarSeguimiento.push(sincronizarSeguimiento);
  const vista = $("#vista-alertas");
  vista.addEventListener("click", alHacerClic);
  vista.addEventListener("change", alCambiar);
  $("#crear-alerta-busqueda").addEventListener("click", crearAlertaConLaBusqueda);
  if (alertasConectadas()) cargarConfiguracion().then(sincronizarSeguimiento);
}
registrarInicio(iniciarAlertas);
