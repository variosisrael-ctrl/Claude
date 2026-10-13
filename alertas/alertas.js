#!/usr/bin/env node
"use strict";

// Punto de entrada de las alertas (lo ejecuta .github/workflows/alertas.yml). Ver alertas/README.md.
//
// Variables de entorno:
//   ALERTAS_GIST_ID      identificador del gist secreto donde la página guarda las alertas (secreto)
//   ALERTAS_BUSQUEDAS    (alternativa) JSON con las búsquedas, escrito a mano (secreto); también es el respaldo si el
//                        gist no se puede leer
//   GITHUB_TOKEN         lo entrega el propio flujo; sirve para leer el gist sin límites de consultas anónimas
//   TELEGRAM_BOT_TOKEN   token del bot (secreto)
//   TELEGRAM_CHAT_ID     chat o grupo que recibe los avisos (secreto)
//   ALERTAS_APP_URL      (opcional) dirección de la página, para enlazar cada búsqueda
//   ALERTAS_ENVIAR_TODO  "1" para avisar también lo que ya estaba abierto
//   ALERTAS_SIMULACION   "1" para no enviar nada e imprimir los mensajes (solo para pruebas locales)
//   TELEGRAM_API_BASE    (pruebas) servidor que reemplaza a api.telegram.org
//   ALERTAS_GITHUB_API   (pruebas) servidor que reemplaza a api.github.com

const fs = require("node:fs");
const path = require("node:path");
const Secop = require("../secop_radar/site/secop.js");
const ConfigAlertas = require("../secop_radar/site/config-alertas.js");
const Gist = require("../secop_radar/site/gist.js");
const { leerBusquedas, crearEnviadorTelegram, ejecutar, ErrorDeAlertas } = require("./lib.js");

const ARCHIVO_ESTADO = path.join(__dirname, "estado.json");

function leerEstado() {
  try {
    return JSON.parse(fs.readFileSync(ARCHIVO_ESTADO, "utf8"));
  } catch {
    return null; // primera ejecución o caché vacía
  }
}

/**
 * De dónde salen las alertas: del gist que administra la página (con el seguimiento de procesos) o, si no hay gist o
 * no se puede leer, del secreto ALERTAS_BUSQUEDAS escrito a mano.
 */
async function cargarConfiguracion(env) {
  if (env.ALERTAS_GIST_ID) {
    try {
      const cliente = Gist.crearClienteGist({ token: env.GITHUB_TOKEN || null, base: env.ALERTAS_GITHUB_API || undefined });
      const contenido = await cliente.leer(env.ALERTAS_GIST_ID.trim());
      let datos;
      try {
        if (contenido.length > 400_000) throw new Error("demasiado grande");
        datos = JSON.parse(contenido);
      } catch {
        // Un archivo dañado no debe pasar por "sin alertas": hay que enterarse de que no se está vigilando nada.
        throw new ErrorDeAlertas("La configuración del gist no se pudo leer. Ábrela en la página y guárdala de nuevo.");
      }
      const { config, problemas } = ConfigAlertas.normalizarConfig(datos);
      // Solo conteos: los registros de Actions son públicos.
      if (problemas) console.log(`::warning::${problemas} entradas de la configuración de alertas no eran válidas y se ignoraron.`);
      return {
        busquedas: ConfigAlertas.aBusquedas(config),
        seguimiento: config.seguimiento.avisar ? config.seguimiento.procesos : [],
        origen: "gist",
      };
    } catch (error) {
      if (!env.ALERTAS_BUSQUEDAS) {
        if (error instanceof ErrorDeAlertas) throw error;
        throw new ErrorDeAlertas(`No se pudo leer la configuración de alertas del gist. ${error.message}`);
      }
      console.log(`::warning::No se pudo leer el gist (${error.message}); se usa ALERTAS_BUSQUEDAS.`);
    }
  }
  return { busquedas: leerBusquedas(env.ALERTAS_BUSQUEDAS), seguimiento: undefined, origen: "secreto" };
}

async function principal(env = process.env) {
  const manual = env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const simulacion = env.ALERTAS_SIMULACION === "1";
  const faltantes = [
    ...(simulacion ? [] : ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]),
    ...(env.ALERTAS_GIST_ID || env.ALERTAS_BUSQUEDAS ? [] : ["ALERTAS_GIST_ID (o ALERTAS_BUSQUEDAS)"]),
  ].filter((k) => !env[k]);
  if (faltantes.length) {
    // Una ejecución programada sin configurar solo avisa; una manual falla para que se note.
    console.log(`::${manual ? "error" : "warning"}::Alertas sin configurar: faltan los secretos ${faltantes.join(", ")}. Mira alertas/README.md.`);
    return manual ? 1 : 0;
  }

  const { busquedas, seguimiento } = await cargarConfiguracion(env);
  if (!busquedas.length && !(seguimiento && seguimiento.length)) {
    console.log("No hay alertas activas ni procesos en seguimiento: no hay nada que revisar. Crea una alerta en la página (pestaña Mis alertas).");
    return 0;
  }

  const enviar = simulacion
    ? async () => {}
    : crearEnviadorTelegram({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, base: env.TELEGRAM_API_BASE || undefined });

  const { estado, resumen } = await ejecutar({
    busquedas, seguimiento, estado: leerEstado(), cliente: Secop.crearCliente(), enviar,
    appUrl: env.ALERTAS_APP_URL || "", enviarTodo: env.ALERTAS_ENVIAR_TODO === "1", manual, simulacion,
    registrar: (texto) => console.log(simulacion ? texto : `::warning::${texto}`),
  });

  fs.writeFileSync(ARCHIVO_ESTADO, JSON.stringify(estado));
  const segui = resumen.seguimiento;
  console.log(
    `Búsquedas: ${resumen.busquedas}. Procesos avisados: ${resumen.nuevos}. Mensajes: ${resumen.mensajes}. ` +
      `Búsquedas sembradas sin avisar: ${resumen.sembradas}. Fallos de Telegram: ${resumen.fallos_telegram}. ` +
      `Fallos de consulta a SECOP II: ${resumen.fallos_consulta}.` +
      (segui ? ` Seguimiento: ${segui.revisados} procesos revisados, ${segui.avisados} con cambios, ${segui.fallos} fallos.` : "")
  );
  // Si Telegram falla, las alertas no llegan: la ejecución debe quedar en rojo para que GitHub avise.
  // Si SECOP falla en algunas búsquedas, se reintenta en la siguiente ejecución; solo es grave si fallan todas.
  const fallaronTodas = resumen.busquedas > 0 && resumen.fallos_consulta >= resumen.busquedas;
  return resumen.fallos_telegram > 0 || fallaronTodas ? 1 : 0;
}

principal().then(
  (codigo) => process.exit(codigo),
  (error) => {
    console.log(`::error::${error instanceof ErrorDeAlertas ? error.message : "Error inesperado en las alertas."}`);
    process.exit(1);
  }
);
