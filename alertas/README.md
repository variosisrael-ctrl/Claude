# Alertas por Telegram

Dos veces al día (7:00 a. m. y 5:00 p. m., hora de Colombia) GitHub busca en SECOP II los procesos **nuevos y todavía abiertos** que coinciden con las búsquedas de tu equipo y los manda a un chat o grupo de Telegram. Cada aviso trae la entidad, el presupuesto, la fecha de cierre, el porcentaje de coincidencia y el enlace al proceso. Además puedes recibir cada mañana un **resumen de todo el país** (ver más abajo) para estar atento a todo tipo de proceso sin recibir cientos de avisos.

No hay servidor que mantener: lo ejecuta GitHub Actions con el flujo `.github/workflows/alertas.yml`. Se configura una sola vez (crear un bot y guardar algunos secretos) y después **creas, editas, pausas y borras alertas desde la página**, en la pestaña **Mis alertas**, sin volver a tocar GitHub. Además de las alertas por tema, te avisa si cambia un proceso de **Mi seguimiento** (nueva fecha de cierre, adjudicación o cancelación).

> **Sobre WhatsApp.** No está incluido a propósito. WhatsApp solo permite mensajes automáticos a través de la API de Meta (o de un proveedor como Twilio): exige una cuenta de empresa verificada, un número dedicado y plantillas de mensaje aprobadas, y cada aviso se cobra. Telegram es gratis y se configura en 10 minutos. Si más adelante quieres WhatsApp, el motor ya separa «qué avisar» de «cómo enviarlo»: solo habría que agregar otro enviador en `alertas/lib.js`.

## Paso a paso (unos 10 minutos)

### 1. Crear el bot

1. En Telegram abre una conversación con **@BotFather** (el oficial, con la marca azul de verificado).
2. Envía `/newbot` y responde con un nombre (por ejemplo «Radar SECOP») y un usuario que termine en `bot` (por ejemplo `radar_secop_miempresa_bot`).
3. BotFather te responde con un **token** parecido a `123456789:AAH...`. Es la llave del bot: no la pegues en el chat de tu equipo, ni en un correo, ni en el código. Cualquiera con ese token puede escribir como tu bot.

### 2. Elegir dónde llegan los avisos y obtener el `chat id`

**Para ti solo:** abre tu bot en Telegram y envíale cualquier mensaje (por ejemplo «hola»).

**Para el equipo (recomendado):** crea un grupo, agrega al bot como miembro y escribe en el grupo `/start@` seguido del usuario del bot (por ejemplo `/start@radar_secop_miempresa_bot`). Los bots no ven los mensajes normales de un grupo, pero sí los comandos dirigidos a ellos; sin ese mensaje la respuesta del paso siguiente sale vacía.

Luego abre esta dirección en el navegador, cambiando `TU_TOKEN` por el token del paso 1:

```
https://api.telegram.org/botTU_TOKEN/getUpdates
```

Busca en la respuesta `"chat":{"id": ...`. Ese número es el `chat id`. En los grupos suele ser negativo (por ejemplo `-1001234567890`); consérvalo completo, con el signo. Si la respuesta sale vacía (`"result":[]`), escribe otro mensaje en el chat y recarga.

### 3. Guardar los secretos del bot en GitHub

Ve a **Settings → Secrets and variables → Actions → New repository secret** del repositorio y crea:

| Nombre | Qué poner |
|---|---|
| `TELEGRAM_BOT_TOKEN` | El token del paso 1. |
| `TELEGRAM_CHAT_ID` | El `chat id` del paso 2. |
| `ALERTAS_APP_URL` | *(Opcional)* La dirección de la página, `https://variosisrael-ctrl.github.io/Claude/`. Con ella, cada aviso de una alerta trae el enlace «Abrir esta búsqueda en el Radar». |

Los secretos de las alertas (paso 4) se agregan igual.

### 4. Conectar las alertas con la página

Las alertas que creas en la página se guardan en un archivo privado (un *gist secreto*) de tu cuenta de GitHub, y el flujo programado lo lee desde allí. Para eso:

1. Abre la página y entra a la pestaña **Mis alertas**.
2. Pulsa el enlace **github.com/settings/tokens/new**. Se abre la creación de un token «classic» que ya trae marcada la casilla **gist**; **no marques ninguna otra**. En «Expiration» elige el plazo que prefieras y pulsa **Generate token**. Copia el token (empieza por `ghp_`).
3. Pégalo en la página y pulsa **Conectar** (marca «Recordar el token en este navegador» si es tu propio computador). La página crea el gist y te muestra su **identificador**.
4. Pulsa **Crear el secreto en GitHub** (o ve a *Settings → Secrets and variables → Actions → New repository secret*) y guarda un secreto llamado `ALERTAS_GIST_ID` cuyo valor es ese identificador. Es el único paso que se hace en GitHub, y solo una vez.

Desde ese momento todo se maneja en la pestaña **Mis alertas**:

- **Crear alerta:** nombre, palabras clave, códigos UNSPSC, departamento y presupuesto. También puedes pulsar **Crear alerta con mi búsqueda actual** o, en el panel «Mis búsquedas», **Crear alerta con esta búsqueda**.
- **Editar, pausar o borrar** cada alerta. Puedes tener hasta 50. Si editas las palabras, los códigos, el departamento o el presupuesto de una alerta, empieza de nuevo en silencio (no te suelta de golpe lo que ya estaba abierto); cambiar solo el nombre o la coincidencia mínima no reinicia nada.
- **Resumen diario de todo el país** (ver más abajo) y **avisos de cambios en los procesos que sigues**.
- Los cambios se guardan solos en tu gist y se aplican en la próxima revisión (7:00 a. m. y 5:00 p. m.).

Sobre el token: solo se usa desde tu navegador y solo se envía a GitHub. Con el permiso «gist» únicamente se pueden leer y escribir tus gists, no tus repositorios. Si lo pierdes o quieres cambiarlo, crea otro y conéctalo de nuevo con el mismo gist (en «Ya creé mis alertas antes» pegas el identificador). Un gist secreto no aparece en buscadores ni en tu perfil, pero **no está cifrado**: lo ve quien tenga su dirección larga.

#### Alternativa sin token: escribir las alertas a mano

Si prefieres no usar un token, puedes dejar las alertas en un secreto llamado `ALERTAS_BUSQUEDAS` y reemplazarlo cada vez que quieras cambiarlas. En la página, en **Mis búsquedas → Alertas sin token (avanzado)**, el botón **Copiar para alertas de Telegram** genera el texto con tus búsquedas guardadas. Es una lista JSON de una sola línea, por ejemplo:

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

Si existen los dos (`ALERTAS_GIST_ID` y `ALERTAS_BUSQUEDAS`), manda el gist; el secreto se usa solo como respaldo si GitHub no deja leer el gist en una ejecución. Esta vía no incluye avisos de cambios en procesos que sigues.

### Resumen diario de todo el país

Si quieres estar atento a *todo* tipo de proceso, no tiene sentido recibir un aviso por cada uno: en SECOP II se publican unos 270 procesos competitivos al día. Para eso existe el **resumen**: una búsqueda sin palabras clave que, cada mañana, manda un solo mensaje con cuántos procesos nuevos hubo, cómo se reparten por modalidad y los de mayor presupuesto, cada uno con su enlace.

En la pestaña **Mis alertas** se activa y se ajusta en el panel **Resumen diario de todo el país** (viene activo al conectar). Si usas la alternativa manual, deja marcada la casilla **Incluir un resumen diario de todo el país** al copiar el texto, o escríbelo a mano como una entrada más de la lista:

```json
{"nombre":"Resumen nacional","resumen":true,"departamento":"","min":"","max":"","competitivos":"1","dias":"3","top":15}
```

| Campo | Significado |
|---|---|
| `resumen` | Debe ser `true`. Con eso no se piden palabras clave ni códigos. |
| `top` | Cuántos procesos detalla el mensaje, de 1 a 30 (por defecto 15), de mayor a menor presupuesto. |
| `min`, `max`, `departamento` | Opcionales: para resumir solo lo que supere un presupuesto, o de una región. Por ejemplo `"min":"100000000"` deja fuera lo menor a 100 millones. |
| `dias` | Hasta cuántos días atrás mira lo publicado (por defecto 3). Cubre fines de semana y el retraso con que SECOP II publica sus datos. |

Cómo se comporta:

- **Sale una vez al día**, en la ejecución de las 7:00 a. m. (hora de Colombia). La de la tarde no lo manda, pero lo publicado en la tarde entra en el resumen del día siguiente. Una ejecución manual desde Actions siempre lo manda.
- **No repite procesos**: cada resumen incluye solo lo que no estuvo en los anteriores. Si no hay nada nuevo, no manda nada.
- **El primer resumen sí se envía** (a diferencia de las búsquedas por tema, que la primera vez se siembran en silencio), con lo publicado en los últimos `dias` días.
- Puedes tener un resumen nacional y otros con filtros (por ejemplo uno por departamento), siempre que cada uno tenga un nombre distinto.
- Si hay más de 1.000 procesos en la ventana, el mensaje lo avisa: la consulta tiene un tope y el resumen puede estar incompleto. Estrecha `dias` o agrega un presupuesto mínimo.
- El resumen cuenta como una de las 20 búsquedas permitidas.

Se admiten hasta 20 búsquedas. Si más adelante cambias, agregas o quitas búsquedas, vuelve a copiar el texto y **reemplaza** el valor del secreto (GitHub no permite ver un secreto, solo reemplazarlo).

### Avisos de cambios en los procesos que sigues

Cuando sigues un proceso en **Mi seguimiento**, la página lo anota en tu configuración (excepto los marcados «Perdida» o «Descartada») y el programa lo revisa en SECOP II dos veces al día. Te avisa por Telegram cuando:

- **cambia la fecha de cierre** de recepción de ofertas (por ejemplo, por una adenda);
- **se adjudica**: el aviso dice a quién y por cuánto cuando hay un único ganador; si hay varios, solo avisa que se adjudicó;
- **se cancela o se suspende**.

No repite un aviso ya enviado. Se activa o se apaga con la casilla «Avisarme si cambia su fecha de cierre, se adjudica o se cancela» de la pestaña **Mis alertas**. Los datos abiertos de SECOP II pueden tardar en reflejar un cambio, así que el aviso puede llegar con algún retraso respecto al portal. Esta función solo existe con las alertas conectadas por la página (no con `ALERTAS_BUSQUEDAS`).

### 5. Probar

En el repositorio ve a **Actions → Alertas de Telegram → Run workflow**.

- La **primera ejecución** manda un mensaje de bienvenida y «siembra» en silencio lo que ya estaba abierto en las búsquedas por tema, para no inundar el chat con decenas de procesos antiguos. A partir de la siguiente solo se avisan los nuevos. Si configuraste un resumen diario, también lo manda en esa primera ejecución cuando es manual o es la de la mañana.
- Si quieres ver avisos reales de inmediato, ejecuta el flujo marcando **Avisar también los procesos que ya están abiertos**. Con eso llegan los que hoy coinciden (hasta 20 por búsqueda y por ejecución).
- Si falta algún secreto, una ejecución manual falla con un mensaje que lo nombra, y una ejecución programada solo deja una advertencia.
- Si no tienes ninguna alerta activa ni procesos en seguimiento, la ejecución termina bien con el mensaje «No hay alertas activas».

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

- Las búsquedas (que revelan en qué contratos estás interesado) viven en tu gist secreto o en el secreto `ALERTAS_BUSQUEDAS`, nunca en el repositorio. Los secretos de Actions se enmascaran en los registros; el gist, en cambio, no está cifrado y lo ve quien tenga su dirección, que solo conoces tú y el secreto `ALERTAS_GIST_ID`.
- El programa nunca escribe en los registros nombres de procesos, de entidades ni de búsquedas: solo conteos («3 procesos nuevos, 1 mensaje»). Los nombres solo viajan hacia Telegram.
- Si una alerta tiene un error, el programa solo informa cuántas entradas ignoró, sin repetir lo que escribiste.
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
| `alertas.js` | Punto de entrada: lee los secretos y el gist, y fija el código de salida. |
| `lib.js` | Formato de los mensajes, envío a Telegram, la lógica de «qué es nuevo» y los cambios en procesos seguidos. |
| `test/alertas.test.js` | Pruebas automáticas, incluida la compatibilidad con lo que guarda la página. |
| `../secop_radar/site/config-alertas.js` | Validación de la configuración de alertas, compartida por la página y el programa. |
| `../secop_radar/site/gist.js` | Lectura y escritura del gist de alertas (API de GitHub). |
| `../secop_radar/site/js/alertas.js` | La pestaña **Mis alertas** de la página. |
| `../.github/workflows/alertas.yml` | El flujo programado de GitHub Actions. |
