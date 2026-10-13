# Alertas por Telegram

Dos veces al día (7:00 a. m. y 5:00 p. m., hora de Colombia) GitHub busca en SECOP II los procesos **nuevos y todavía abiertos** que coinciden con las búsquedas de tu equipo y los manda a un chat o grupo de Telegram. Cada aviso trae la entidad, el presupuesto, la fecha de cierre, el porcentaje de coincidencia y el enlace al proceso.

No hay servidor que mantener: lo ejecuta GitHub Actions con el flujo `.github/workflows/alertas.yml`. Solo tienes que crear un bot y guardar tres datos como secretos del repositorio.

> **Sobre WhatsApp.** No está incluido a propósito. WhatsApp solo permite mensajes automáticos a través de la API de Meta (o de un proveedor como Twilio): exige una cuenta de empresa verificada, un número dedicado y plantillas de mensaje aprobadas, y cada aviso se cobra. Telegram es gratis y se configura en 10 minutos. Si más adelante quieres WhatsApp, el motor ya separa «qué avisar» de «cómo enviarlo»: solo habría que agregar otro enviador en `alertas/lib.js`.

## Paso a paso (unos 10 minutos)

### 1. Crear el bot

1. En Telegram abre una conversación con **@BotFather** (el oficial, con la marca azul de verificado).
2. Envía `/newbot` y responde con un nombre (por ejemplo «Radar SECOP») y un usuario que termine en `bot` (por ejemplo `radar_secop_miempresa_bot`).
3. BotFather te responde con un **token** parecido a `123456789:AAH...`. Es la llave del bot: no la pegues en el chat de tu equipo, ni en un correo, ni en el código. Cualquiera con ese token puede escribir como tu bot.

### 2. Elegir dónde llegan los avisos y obtener el `chat id`

**Para ti solo:** abre tu bot en Telegram y envíale cualquier mensaje (por ejemplo «hola»).

**Para el equipo (recomendado):** crea un grupo, agrega al bot como miembro y escribe un mensaje en el grupo. Si el bot no «ve» los mensajes del grupo no importa: solo necesita poder *enviar*.

Luego abre esta dirección en el navegador, cambiando `TU_TOKEN` por el token del paso 1:

```
https://api.telegram.org/botTU_TOKEN/getUpdates
```

Busca en la respuesta `"chat":{"id": ...`. Ese número es el `chat id`. En los grupos suele ser negativo (por ejemplo `-1001234567890`); consérvalo completo, con el signo. Si la respuesta sale vacía (`"result":[]`), escribe otro mensaje en el chat y recarga.

### 3. Guardar los secretos en GitHub

Ve a **Settings → Secrets and variables → Actions → New repository secret** del repositorio y crea:

| Nombre | Qué poner |
|---|---|
| `TELEGRAM_BOT_TOKEN` | El token del paso 1. |
| `TELEGRAM_CHAT_ID` | El `chat id` del paso 2. |
| `ALERTAS_BUSQUEDAS` | Las búsquedas que quieres vigilar (ver el paso 4). |
| `ALERTAS_APP_URL` | *(Opcional)* La dirección de la página, `https://variosisrael-ctrl.github.io/Claude/`. Con ella, cada búsqueda trae el enlace «Abrir esta búsqueda en el Radar», que la abre ya cargada. |

### 4. Generar `ALERTAS_BUSQUEDAS` desde la página

1. Abre el Radar y, en **Mis búsquedas**, guarda cada búsqueda que quieras vigilar (palabras clave, códigos UNSPSC, departamento y presupuesto).
2. Pulsa **Copiar para alertas de Telegram**. Si el navegador no deja usar el portapapeles, la página muestra el texto en un campo para que lo copies con Ctrl+C.
3. Pega ese texto como valor del secreto `ALERTAS_BUSQUEDAS`.

El texto es una lista JSON de una sola línea, por ejemplo:

```json
[{"nombre":"Mantenimiento TI","palabras":"mantenimiento, software","codigos":"8011","departamento":"","min":"","max":"","competitivos":"1","dias":"15","minimo":40}]
```

Campos de cada búsqueda:

| Campo | Significado |
|---|---|
| `nombre` | Cómo se llama la búsqueda en los avisos. No se repite entre búsquedas. |
| `palabras` | Palabras clave separadas por comas (letras, números, espacios y guiones). |
| `codigos` | Códigos UNSPSC de 4 a 8 dígitos, separados por comas. Hace falta al menos palabras o códigos. |
| `departamento`, `min`, `max` | Filtros opcionales: departamento y presupuesto mínimo y máximo en pesos. |
| `competitivos` | `"1"` deja fuera contratación directa y régimen especial (allí la entidad ya eligió a quién contratar); `"0"` los incluye. |
| `dias` | Ventana de publicación hacia atrás: `"15"` mira los procesos publicados en los últimos 15 días. |
| `minimo` | Coincidencia mínima (0 a 100) para que un proceso se avise. Por defecto 40. |

Se admiten hasta 20 búsquedas. Si más adelante cambias, agregas o quitas búsquedas, vuelve a copiar el texto y **reemplaza** el valor del secreto (GitHub no permite ver un secreto, solo reemplazarlo).

### 5. Probar

En el repositorio ve a **Actions → Alertas de Telegram → Run workflow**.

- La **primera ejecución** manda un mensaje de bienvenida y «siembra» en silencio lo que ya estaba abierto, para no inundar el chat con decenas de procesos antiguos. A partir de la siguiente solo se avisan los nuevos.
- Si quieres ver avisos reales de inmediato, ejecuta el flujo marcando **Avisar también los procesos que ya están abiertos**. Con eso llegan los que hoy coinciden (hasta 20 por búsqueda y por ejecución).
- Si falta algún secreto, una ejecución manual falla con un mensaje que lo nombra, y una ejecución programada solo deja una advertencia.

## Cómo funciona (y qué no hace)

- **Sin repeticiones.** El flujo recuerda qué procesos ya avisó en la caché de GitHub Actions (el archivo `alertas/estado.json`, que no se sube al repositorio). Olvida los que llevan más de 120 días. Una búsqueda nueva se siembra en silencio la primera vez.
- **Una ejecución en rojo es una señal.** Si Telegram rechaza un mensaje, la ejecución termina en error y GitHub te avisa por correo. Si SECOP II falla en algunas búsquedas, se reintentan en la siguiente ejecución, y solo queda en rojo si fallan todas.
- **Mensajes largos.** Cada mensaje agrupa hasta 8 procesos y respeta el límite de Telegram; si Telegram responde «demasiadas solicitudes», el programa espera y reintenta.
- **Solo procesos abiertos.** Se consideran los que aún reciben ofertas (fecha de cierre futura y sin adjudicar). Lo ya adjudicado se consulta en la pestaña *Adjudicados y ejecución* de la página.
- **La coincidencia es una guía, no un veredicto.** Mide cuánto se parece el proceso a tus palabras y códigos; no dice si te conviene ni si lo vas a ganar. Abre el proceso y lee el pliego antes de decidir.
- **Las ejecuciones programadas pueden retrasarse** unos minutos cuando GitHub está saturado, y **GitHub las desactiva si el repositorio pasa 60 días sin actividad**. Si un día dejan de llegar los avisos, entra a la pestaña Actions y pulsa «Enable workflow».
- **Solo corre desde `main`.** GitHub únicamente ejecuta los flujos programados del repositorio desde su rama principal, así que las alertas arrancan cuando se fusiona el cambio que las trae.

## Privacidad

Este repositorio es **público**, y los registros de las ejecuciones de GitHub Actions también. Por eso:

- Las búsquedas (que revelan en qué contratos estás interesado) viven solo en el secreto `ALERTAS_BUSQUEDAS`, que GitHub enmascara en los registros.
- El programa nunca escribe en los registros nombres de procesos, de entidades ni de búsquedas: solo conteos («3 procesos nuevos, 1 mensaje»). Los nombres solo viajan hacia Telegram.
- Si una búsqueda tiene un error de escritura, el mensaje de error no repite lo que escribiste.
- El token del bot y el `chat id` también son secretos. Si el token se filtra, entra a @BotFather, envía `/revoke` y genera uno nuevo.

## Probarlo en tu computador (sin enviar nada)

Con Node 22 (el mismo que usa GitHub), desde la raíz del repositorio:

```bash
ALERTAS_SIMULACION=1 \
ALERTAS_BUSQUEDAS='[{"nombre":"Prueba","palabras":"software"}]' \
node alertas/alertas.js
```

En modo simulación no se necesita token: se consulta SECOP II de verdad, se imprimen los mensajes que se enviarían y no se manda nada. Las pruebas automáticas (`npm test`) usan un Telegram falso y no tocan la red.

## Archivos

| Archivo | Para qué sirve |
|---|---|
| `alertas.js` | Punto de entrada: lee los secretos del entorno y fija el código de salida. |
| `lib.js` | Validación de la configuración, formato de los mensajes, envío a Telegram y la lógica de «qué es nuevo». |
| `test/alertas.test.js` | Pruebas automáticas, incluida la compatibilidad con el texto que genera la página. |
| `../.github/workflows/alertas.yml` | El flujo programado de GitHub Actions. |
