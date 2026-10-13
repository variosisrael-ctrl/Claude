"use strict";

// Búsquedas guardadas (en este navegador) y enlaces para compartir un perfil de búsqueda con el equipo.

const PERFIL_VACIO = { palabras: "", codigos: "", departamento: "", min: "", max: "", dias: "30" };
const MAXIMO_BUSQUEDAS = 30;

const busquedasGuardadas = () => leer(CLAVE_BUSQUEDAS, []);

/** Perfil escrito en la dirección (?palabras=...&codigos=...), o null si no trae uno. */
function perfilDesdeURL() {
  const parametros = new URLSearchParams(location.search);
  if (!parametros.get("palabras") && !parametros.get("codigos")) return null;
  const perfil = {};
  for (const campo of [...CAMPOS_PERFIL, ...CASILLAS_PERFIL]) {
    if (parametros.has(campo)) perfil[campo] = parametros.get(campo);
  }
  return perfil;
}

const enlaceDeBusqueda = (perfil) => `${location.href.split(/[?#]/)[0]}?${new URLSearchParams(aParametros(perfil))}`;

function mostrarEstadoBusquedas(texto) {
  $("#estado-busquedas").textContent = texto;
}

function renderBusquedas() {
  const lista = busquedasGuardadas();
  $("#busquedas-guardadas").innerHTML =
    '<option value="">Elige una…</option>' + lista.map((b, i) => `<option value="${i}">${esc(b.nombre)}</option>`).join("");
}

function guardarBusquedaActual() {
  const nombre = $("#nombre-busqueda").value.trim();
  const perfil = perfilDelFormulario();
  if (!nombre) return mostrarEstadoBusquedas("Escribe un nombre para guardar la búsqueda.");
  if (!perfilTieneAlcance(perfil)) return mostrarEstadoBusquedas("Escribe palabras clave o códigos antes de guardarla.");
  const lista = busquedasGuardadas().filter((b) => b.nombre.toLowerCase() !== nombre.toLowerCase());
  lista.unshift({ nombre, perfil });
  guardar(CLAVE_BUSQUEDAS, lista.slice(0, MAXIMO_BUSQUEDAS));
  renderBusquedas();
  $("#nombre-busqueda").value = "";
  mostrarEstadoBusquedas(`Búsqueda “${nombre}” guardada en este navegador.`);
}

function cargarBusquedaElegida() {
  const indice = $("#busquedas-guardadas").value;
  const elegida = busquedasGuardadas()[Number(indice)];
  if (indice === "" || !elegida) return mostrarEstadoBusquedas("Elige una búsqueda guardada.");
  aplicarPerfilAlFormulario({ ...PERFIL_VACIO, ...elegida.perfil });
  mostrarEstadoBusquedas("");
  buscarOportunidades();
}

function borrarBusquedaElegida() {
  const indice = $("#busquedas-guardadas").value;
  if (indice === "") return mostrarEstadoBusquedas("Elige la búsqueda que quieres borrar.");
  guardar(CLAVE_BUSQUEDAS, busquedasGuardadas().filter((_, i) => i !== Number(indice)));
  renderBusquedas();
  mostrarEstadoBusquedas("Búsqueda borrada.");
}

async function copiarEnlace() {
  const perfil = perfilDelFormulario();
  if (!perfilTieneAlcance(perfil)) return mostrarEstadoBusquedas("Escribe palabras clave o códigos para generar el enlace.");
  const enlace = enlaceDeBusqueda(perfil);
  const campo = $("#enlace-compartir");
  try {
    await navigator.clipboard.writeText(enlace);
    campo.hidden = true;
    mostrarEstadoBusquedas("Enlace copiado. Quien lo abra verá esta misma búsqueda.");
  } catch {
    // Sin permiso para el portapapeles (p. ej. abriendo el archivo directamente): se muestra para copiarlo a mano.
    campo.hidden = false;
    campo.value = enlace;
    campo.select();
    mostrarEstadoBusquedas("Copia el enlace de abajo (Ctrl+C).");
  }
}

/** Copia el JSON para el secreto ALERTAS_BUSQUEDAS de GitHub con las búsquedas guardadas (o la actual). */
async function copiarParaAlertas() {
  const resumen = $("#incluir-resumen").checked;
  let lista = busquedasGuardadas();
  if (!lista.length) {
    const perfil = perfilDelFormulario();
    if (perfilTieneAlcance(perfil)) lista = [{ nombre: "Mi búsqueda", perfil }];
    else if (!resumen) return mostrarEstadoBusquedas("Guarda al menos una búsqueda (o escribe palabras clave) para generar la configuración.");
  }
  const texto = Analisis.aConfiguracionAlertas(lista, { resumen });
  const total = lista.length + (resumen ? 1 : 0);
  const campo = $("#enlace-compartir");
  try {
    await navigator.clipboard.writeText(texto);
    campo.hidden = true;
    mostrarEstadoBusquedas(`Configuración de ${plural(total, "búsqueda", "búsquedas")} copiada. Pégala en el secreto ALERTAS_BUSQUEDAS de GitHub.`);
  } catch {
    campo.hidden = false;
    campo.value = texto;
    campo.select();
    mostrarEstadoBusquedas("Copia el texto de abajo (Ctrl+C) y pégalo en el secreto ALERTAS_BUSQUEDAS de GitHub.");
  }
}

function iniciarBusquedas() {
  renderBusquedas();
  $("#guardar-busqueda").addEventListener("click", guardarBusquedaActual);
  $("#cargar-busqueda").addEventListener("click", cargarBusquedaElegida);
  $("#borrar-busqueda").addEventListener("click", borrarBusquedaElegida);
  $("#copiar-enlace").addEventListener("click", copiarEnlace);
  $("#copiar-alertas").addEventListener("click", copiarParaAlertas);
}
registrarInicio(iniciarBusquedas);
