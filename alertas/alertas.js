#!/usr/bin/env node
"use strict";

// Punto de entrada de las alertas (lo ejecuta .github/workflows/alertas.yml). Ver alertas/README.md.
//
// Variables de entorno:
//   ALERTAS_BUSQUEDAS    JSON con las búsquedas (secreto)
//   TELEGRAM_BOT_TOKEN   token del bot (secreto)
//   TELEGRAM_CHAT_ID     chat o grupo que recibe los avisos (secreto)
//   ALERTAS_APP_URL      (opcional) dirección de la página, para enlazar cada búsqueda
//   ALERTAS_ENVIAR_TODO  "1" para avisar también lo que ya estaba abierto
//   ALERTAS_SIMULACION   "1" para no enviar nada e imprimir los mensajes (solo para pruebas locales)
//   TELEGRAM_API_BASE    (pruebas) servidor que reemplaza a api.telegram.org

const fs = require("node:fs");
const path = require("node:path");
const Secop = require("../secop_radar/site/secop.js");
const { leerBusquedas, crearEnviadorTelegram, ejecutar, ErrorDeAlertas } = require("./lib.js");

const ARCHIVO_ESTADO = path.join(__dirname, "estado.json");

function leerEstado() {
  try {
    return JSON.parse(fs.readFileSync(ARCHIVO_ESTADO, "utf8"));
  } catch {
    return null; // primera ejecución o caché vacía
  }
}

async function principal(env = process.env) {
  const manual = env.GITHUB_EVENT_NAME === "workflow_dispatch";
  const simulacion = env.ALERTAS_SIMULACION === "1";
  const faltantes = ["ALERTAS_BUSQUEDAS", ...(simulacion ? [] : ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"])].filter((k) => !env[k]);
  if (faltantes.length) {
    // Una ejecución programada sin configurar solo avisa; una manual falla para que se note.
    console.log(`::${manual ? "error" : "warning"}::Alertas sin configurar: faltan los secretos ${faltantes.join(", ")}. Mira alertas/README.md.`);
    return manual ? 1 : 0;
  }

  const busquedas = leerBusquedas(env.ALERTAS_BUSQUEDAS);
  const enviar = simulacion
    ? async () => {}
    : crearEnviadorTelegram({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, base: env.TELEGRAM_API_BASE || undefined });

  const { estado, resumen } = await ejecutar({
    busquedas, estado: leerEstado(), cliente: Secop.crearCliente(), enviar,
    appUrl: env.ALERTAS_APP_URL || "", enviarTodo: env.ALERTAS_ENVIAR_TODO === "1", manual, simulacion,
    registrar: (texto) => console.log(simulacion ? texto : `::warning::${texto}`),
  });

  fs.writeFileSync(ARCHIVO_ESTADO, JSON.stringify(estado));
  console.log(
    `Búsquedas: ${resumen.busquedas}. Procesos nuevos avisados: ${resumen.nuevos}. Mensajes: ${resumen.mensajes}. ` +
      `Búsquedas sembradas sin avisar: ${resumen.sembradas}. Fallos de Telegram: ${resumen.fallos_telegram}. ` +
      `Fallos de consulta a SECOP II: ${resumen.fallos_consulta}.`
  );
  // Si Telegram falla, las alertas no llegan: la ejecución debe quedar en rojo para que GitHub avise.
  // Si SECOP falla en algunas búsquedas, se reintenta en la siguiente ejecución; solo es grave si fallan todas.
  return resumen.fallos_telegram > 0 || resumen.fallos_consulta >= resumen.busquedas ? 1 : 0;
}

principal().then(
  (codigo) => process.exit(codigo),
  (error) => {
    console.log(`::error::${error instanceof ErrorDeAlertas ? error.message : "Error inesperado en las alertas."}`);
    process.exit(1);
  }
);
