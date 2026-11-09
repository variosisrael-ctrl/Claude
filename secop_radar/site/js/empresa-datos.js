"use strict";

// Pestaña "Empresa e IA": los números de la empresa con que se verifican los requisitos habilitantes (indicadores
// financieros y contratos ejecutados) y el respaldo de todo lo guardado en este navegador.

const CLAVE_EMPRESA_DATOS = "radar-secop:empresa-datos";

const datosEmpresa = () => Habilitantes.normalizarEmpresa(leer(CLAVE_EMPRESA_DATOS, {}));
const guardarDatosEmpresa = (datos) => guardar(CLAVE_EMPRESA_DATOS, Habilitantes.normalizarEmpresa(datos));

// --- Almacén de expedientes ---------------------------------------------------

let almacenListo = null;

/** Abre el almacén una sola vez. Si el navegador no deja usar IndexedDB, guarda en memoria y la pantalla lo avisa. */
function abrirAlmacen() {
  almacenListo ??= Promise.resolve()
    .then(() => Almacen.motorIndexedDB(indexedDB))
    .catch(() => Almacen.motorMemoria())
    .then((motor) => {
      // Pide al navegador que no borre estos datos cuando le falte espacio.
      if (motor.persistente) navigator.storage?.persist?.().catch(() => {});
      return Almacen.crearAlmacen({ motor });
    });
  return almacenListo;
}

// --- Indicadores y experiencia ------------------------------------------------

const salariosLegibles = (valor) => (valor === null ? "—" : formatoNumero.format(Math.round(valor * 100) / 100));

function resumenExperiencia(experiencia) {
  if (!experiencia.length) return "";
  const total = experiencia.map(Habilitantes.contratoEnSMMLV).filter((v) => v !== null).reduce((a, b) => a + b, 0);
  return `Experiencia total: ${formatoNumero.format(Math.round(total))} SMMLV en ${plural(experiencia.length, "contrato", "contratos")}.`;
}

function filaContrato(contrato) {
  const enSalarios = Habilitantes.contratoEnSMMLV(contrato);
  const campo = (nombre, valor, extra = "") =>
    `<input data-campo-contrato="${nombre}" value="${esc(valor ?? "")}" autocomplete="off" aria-label="${nombre}" ${extra}>`;
  return `<tr data-contrato="${esc(contrato.id)}">
    <td>${campo("entidad", contrato.entidad)}</td>
    <td>${campo("objeto", contrato.objeto)}</td>
    <td>${campo("codigos", contrato.codigos.join(", "), 'placeholder="801116, 721515"')}</td>
    <td>${campo("valor", contrato.valor, 'type="number" min="0" step="1" inputmode="numeric"')}</td>
    <td>${campo("anio", contrato.anio, 'type="number" min="1990" max="2100" step="1" inputmode="numeric"')}</td>
    <td>${campo("participacion", contrato.participacion, 'type="number" min="1" max="100" step="any" inputmode="decimal"')}</td>
    <td data-smmlv>${esc(salariosLegibles(enSalarios))}</td>
    <td><button type="button" class="boton peligro" data-quitar-contrato="${esc(contrato.id)}">Quitar</button></td>
  </tr>`;
}

function dibujarDatosEmpresa() {
  const caja = $("#empresa-datos");
  if (!caja) return;
  const datos = datosEmpresa();
  const indicadores = Habilitantes.INDICADORES_FINANCIEROS.map(([clave, nombre, unidad, formula]) => `
    <label>${esc(nombre)} <span class="ayuda">${esc(formula)} · en ${esc(unidad)}</span>
      <input data-indicador="${clave}" type="number" step="any" inputmode="decimal" value="${esc(datos.indicadores[clave] ?? "")}">
    </label>`).join("");

  caja.innerHTML = `
    <section class="panel" aria-labelledby="titulo-datos-empresa">
      <h2 id="titulo-datos-empresa">Datos para verificar requisitos habilitantes</h2>
      <p class="ayuda">Con estos números la página compara, sin IA, los umbrales de cada pliego con tu empresa. Usa los del RUP vigente
        o de los últimos estados financieros. Se guardan solo en este navegador y no se envían a ningún sitio.</p>
      <label>Fecha de corte de los estados financieros
        <input data-dato-empresa="corte" autocomplete="off" placeholder="31 de diciembre de 2025" value="${esc(datos.corte)}">
      </label>
      <div class="fila-doble">${indicadores}</div>
      <label class="casilla">
        <input type="checkbox" data-dato-empresa="sin_intereses" ${datos.sin_intereses ? "checked" : ""}>
        La empresa no tiene gastos de intereses
        <span class="ayuda">En ese caso la cobertura de intereses es indeterminada y, por regla general, cumple.</span>
      </label>

      <h3>Experiencia: contratos ejecutados</h3>
      <p class="ayuda">Un contrato por fila, con el valor final en pesos y el año en que terminó: se convierte a salarios mínimos (SMMLV) de ese año,
        como lo piden los pliegos. Si fue en consorcio o unión temporal, escribe tu porcentaje de participación.
        La tabla de SMMLV llega hasta ${Habilitantes.ULTIMO_ANIO_SMMLV}.</p>
      <div class="panel-tabla">
        <table class="tabla-ancha tabla-edicion">
          <thead><tr><th>Entidad</th><th>Objeto</th><th>Códigos UNSPSC</th><th>Valor (COP)</th><th>Año de terminación</th><th>Participación (%)</th><th>SMMLV</th><th></th></tr></thead>
          <tbody>${datos.experiencia.map(filaContrato).join("") || '<tr><td colspan="8">Aún no hay contratos.</td></tr>'}</tbody>
        </table>
      </div>
      <div class="acciones">
        <button type="button" class="boton primario-suave" data-agregar-contrato>Agregar contrato</button>
      </div>
      <p class="ayuda" role="status" id="estado-datos-empresa">${esc(resumenExperiencia(datos.experiencia))}</p>
    </section>`;
}

function alCambiarDatosEmpresa(evento) {
  const objetivo = evento.target;
  const datos = datosEmpresa();
  const { indicador, datoEmpresa, campoContrato } = objetivo.dataset;

  if (indicador) {
    datos.indicadores[indicador] = objetivo.value;
  } else if (datoEmpresa === "sin_intereses") {
    datos.sin_intereses = objetivo.checked;
  } else if (datoEmpresa === "corte") {
    datos.corte = objetivo.value;
  } else if (campoContrato) {
    const contrato = datos.experiencia.find((c) => c.id === objetivo.closest("[data-contrato]").dataset.contrato);
    if (!contrato) return;
    contrato[campoContrato] = objetivo.value;
  } else {
    return;
  }
  guardarDatosEmpresa(datos);
  if (campoContrato) {
    // Solo se actualizan la celda de SMMLV y el total, para no mover el cursor mientras se llena la fila.
    const fila = objetivo.closest("[data-contrato]");
    const guardados = datosEmpresa();
    const contrato = guardados.experiencia.find((c) => c.id === fila.dataset.contrato);
    fila.querySelector("[data-smmlv]").textContent = salariosLegibles(Habilitantes.contratoEnSMMLV(contrato));
    $("#estado-datos-empresa").textContent = resumenExperiencia(guardados.experiencia);
  } else {
    $("#estado-datos-empresa").textContent = "Guardado.";
  }
}

function alPulsarDatosEmpresa(evento) {
  const datos = datosEmpresa();
  const quitar = evento.target.closest("[data-quitar-contrato]")?.dataset.quitarContrato;
  if (evento.target.closest("[data-agregar-contrato]")) {
    datos.experiencia.push({ id: Expediente.nuevoId() });
  } else if (quitar) {
    datos.experiencia = datos.experiencia.filter((c) => c.id !== quitar);
  } else {
    return;
  }
  guardarDatosEmpresa(datos);
  dibujarDatosEmpresa();
}

// --- Respaldo -----------------------------------------------------------------

function dibujarRespaldo() {
  const caja = $("#empresa-respaldo");
  if (!caja) return;
  caja.innerHTML = `
    <section class="panel" aria-labelledby="titulo-respaldo">
      <h2 id="titulo-respaldo">Respaldo</h2>
      <p class="ayuda">Los expedientes, el perfil de la empresa y el seguimiento viven solo en este navegador: si borras sus datos o cambias de
        computador, se pierden. Descarga un respaldo de vez en cuando y guárdalo en un lugar privado; contiene información de tu empresa.
        La clave de Anthropic y el token de GitHub no se incluyen.</p>
      <div class="acciones">
        <button type="button" class="boton primario-suave" data-respaldo="descargar">Descargar respaldo</button>
        <label class="boton">Restaurar un respaldo
          <input type="file" id="archivo-respaldo" accept="application/json,.json" hidden>
        </label>
      </div>
      <p class="ayuda" role="status" id="estado-respaldo"></p>
    </section>`;
}

const estadoRespaldo = (texto, error = false) => {
  const nodo = $("#estado-respaldo");
  if (!nodo) return;
  nodo.textContent = texto;
  nodo.classList.toggle("error-texto", error);
};

async function descargarRespaldo() {
  try {
    const almacen = await abrirAlmacen();
    const respaldo = await almacen.exportar({
      empresa: perfilEmpresa(), empresa_datos: datosEmpresa(), seguimiento: seguimiento(),
    });
    descargarArchivo(`radar-secop-respaldo-${Secop.fechaIso(new Date())}.json`, JSON.stringify(respaldo, null, 2), "application/json");
    estadoRespaldo(`Respaldo descargado con ${plural(respaldo.expedientes.length, "expediente", "expedientes")}.`);
  } catch (error) {
    estadoRespaldo(error.message, true);
  }
}

/** Un proceso seguido leído de un archivo: solo se aceptan los campos conocidos y con el tipo esperado. */
function seguidoDeRespaldo(crudo) {
  if (!crudo || typeof crudo !== "object" || typeof crudo.id !== "string" || !crudo.id) return null;
  const t = (valor, maximo) => (typeof valor === "string" ? valor.slice(0, maximo) : "");
  return {
    id: t(crudo.id, 200), nombre: t(crudo.nombre, 400), descripcion: t(crudo.descripcion, 1500), entidad: t(crudo.entidad, 300),
    nit_entidad: t(crudo.nit_entidad, 30), referencia: t(crudo.referencia, 120),
    presupuesto: Number.isFinite(crudo.presupuesto) ? crudo.presupuesto : null,
    modalidad: t(crudo.modalidad, 120), categoria: t(crudo.categoria, 40), portafolio: t(crudo.portafolio, 80),
    cierre: /^\d{4}-\d{2}-\d{2}$/.test(crudo.cierre) ? crudo.cierre : "",
    url: t(crudo.url, 600).startsWith("https://") ? t(crudo.url, 600) : "",
    estado: ESTADOS.includes(crudo.estado) ? crudo.estado : ESTADOS[0],
    nota: t(crudo.nota, 5000),
    requisitos: REQUISITOS.map((_, i) => Array.isArray(crudo.requisitos) && crudo.requisitos[i] === true),
  };
}

async function restaurarRespaldo(archivo) {
  try {
    let respaldo;
    try {
      respaldo = JSON.parse(await archivo.text());
    } catch {
      throw new Almacen.ErrorDeAlmacen("El archivo no se pudo leer: no es un respaldo de Radar SECOP II.");
    }
    const almacen = await abrirAlmacen();
    const { guardados, conservados } = await almacen.importar(respaldo);

    const partes = [`${plural(guardados, "expediente restaurado", "expedientes restaurados")}`];
    if (conservados) partes.push(`${plural(conservados, "expediente se dejó", "expedientes se dejaron")} como estaba porque aquí es más reciente`);

    // El seguimiento se completa con los procesos que falten; los que ya están no se tocan.
    const actuales = seguimiento();
    const conocidos = new Set(actuales.map((s) => s.id));
    const nuevos = (Array.isArray(respaldo.seguimiento) ? respaldo.seguimiento : [])
      .map(seguidoDeRespaldo).filter((s) => s && !conocidos.has(s.id));
    if (nuevos.length) {
      guardarSeguimiento([...actuales, ...nuevos]);
      actualizarConteo();
      partes.push(`${plural(nuevos.length, "proceso agregado", "procesos agregados")} al seguimiento`);
    }

    // El perfil de la empresa solo se restaura si aquí está vacío: nunca se pisa lo que ya se escribió.
    const textoRespaldo = Object.fromEntries(IA.CAMPOS_EMPRESA
      .map(([clave]) => [clave, typeof respaldo.empresa?.[clave] === "string" ? respaldo.empresa[clave].slice(0, 2500) : ""]));
    if (!IA.textoDeEmpresa(perfilEmpresa()) && IA.textoDeEmpresa(textoRespaldo)) {
      guardar(CLAVE_EMPRESA, textoRespaldo);
      partes.push("perfil de la empresa restaurado");
    }
    const vacios = Habilitantes.normalizarEmpresa({});
    if (JSON.stringify(datosEmpresa()) === JSON.stringify(vacios) && respaldo.empresa_datos) {
      guardarDatosEmpresa(respaldo.empresa_datos);
      partes.push("datos de habilitantes restaurados");
    }

    renderEmpresa();
    estadoRespaldo(`Listo: ${partes.join("; ")}.`);
  } catch (error) {
    estadoRespaldo(error.message, true);
  }
}

function iniciarEmpresaDatos() {
  Radar.alDibujarEmpresa.push(dibujarDatosEmpresa, dibujarRespaldo);
  const vista = $("#vista-empresa");
  vista.addEventListener("change", (evento) => {
    if (evento.target.id === "archivo-respaldo") {
      if (evento.target.files[0]) restaurarRespaldo(evento.target.files[0]);
    } else if (evento.target.closest("#empresa-datos")) {
      alCambiarDatosEmpresa(evento);
    }
  });
  vista.addEventListener("click", (evento) => {
    if (evento.target.closest("[data-respaldo='descargar']")) descargarRespaldo();
    else if (evento.target.closest("#empresa-datos")) alPulsarDatosEmpresa(evento);
  });
}
registrarInicio(iniciarEmpresaDatos);
