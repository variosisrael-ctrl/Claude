# Radar SECOP II

App web para encontrar oportunidades de contratación pública en Colombia, entender cuánta competencia hay, evaluar los pliegos con IA y recibir avisos de procesos nuevos. Usa los datos abiertos de SECOP II publicados en [datos.gov.co](https://www.datos.gov.co).

Es un sitio estático (HTML, CSS y JavaScript, sin paso de compilación): el navegador consulta directamente a datos.gov.co, que permite ese acceso. No hay servidor propio, base de datos ni cuentas. Lo que cada persona escribe y guarda se queda en su navegador.

## Cómo abrirla

**Sin instalar nada:** abre `secop_radar/site/index.html` con doble clic. Funciona desde el disco, solo necesita internet.

**Como página web (GitHub Pages):** el flujo `.github/workflows/pages.yml` publica la carpeta `secop_radar/site` en cada cambio a `main`. La dirección es `https://variosisrael-ctrl.github.io/Claude/`. Una página de GitHub Pages es pública en internet; no pongas allí nada que no quieras publicar (las búsquedas y el perfil de la empresa no se suben: viven en cada navegador).

## Qué hace

### Oportunidades
Con tu perfil (palabras clave, códigos UNSPSC, departamento, rango de presupuesto, días de publicación) busca procesos **abiertos**: con fecha de cierre de ofertas futura y sin adjudicar. Cada resultado muestra los días que faltan para el cierre (resaltado cuando faltan 3 días o menos), por qué coincide con tu perfil y el enlace al proceso oficial. Se ordena por coincidencia o por cierre más próximo y se pagina de 25 en 25. Se puede exportar a CSV (se abre directo en Excel en español) y guardar la búsqueda para repetirla o compartirla con un enlace.

### Adjudicados y ejecución
Los procesos ya adjudicados de tu perfil: quién ganó, por cuánto, qué descuento hubo frente al presupuesto y, cuando el contrato está publicado, su estado, lo pagado, la fecha de fin y los días adicionados. Sirve para ver qué precios ganan y quién se lleva los contratos. Los documentos de personas naturales (cédulas) aparecen enmascarados.

### Competencia e índice de dificultad
En el detalle de un proceso se revisa el historial de la entidad (últimos 2 años): cuántos oferentes se presentan, quién gana de forma recurrente y con qué descuento. Con eso se calcula un **índice de dificultad de 0 (fácil) a 100 (difícil)**: Baja (menos de 35), Media (de 35 a 59) o Alta (60 o más). Es una heurística explicable, **no una probabilidad de ganar**:

| Factor | Peso | Qué mide |
| --- | --- | --- |
| Oferentes por proceso | 40 % | Mediana de oferentes (1 → 15 puntos; más de 5 → 90) |
| Ganador recurrente | 35 % | Parte de los procesos que gana el proveedor más frecuente (menos de 25 % → 20 puntos; 60 % o más → 90) |
| Competencia por precio | 25 % | Descuento mediano de la adjudicación frente al presupuesto (menos de 5 % → 20 puntos; 30 % o más → 85) |

Si la entidad tiene menos de 5 procesos en el historial, se usa el mercado nacional de la misma categoría y la pantalla lo dice. Con menos de 5 procesos o menos de 2 factores calculables se muestra «Sin datos suficientes» en vez de un número engañoso. Cada factor muestra los datos que lo respaldan.

### Mercado y competencia
Para tu sector: qué entidades contratan más, qué proveedores ganan más contratos (agrupados por NIT o cédula) y qué modalidades se usan.

### Mi seguimiento
Guarda procesos con su estado (por revisar, preparando oferta, ofertada, ganada…), notas y una lista de requisitos típicos de una oferta. Se puede exportar a CSV.

### IA con tu propia clave de Anthropic (pestaña «Empresa e IA»)
Cada persona del equipo usa **su propia clave** de la API de Anthropic. La clave nunca pasa por un servidor nuestro: se queda en el navegador y las llamadas van directo a `api.anthropic.com`. Por defecto se borra al cerrar la pestaña; si marcas «recordar» queda en ese navegador (no lo hagas en un computador compartido).

- **Análisis del pliego.** Subes el PDF del pliego (hasta 24 MB) y la IA resume el objeto, los plazos, los requisitos habilitantes, los criterios de evaluación y los riesgos. Cada dato trae un número de página entre corchetes que lleva a la cita exacta del PDF.
- **Evaluación contra tu empresa.** Con el perfil de tu empresa (experiencia, capacidad financiera, certificaciones…) la IA indica qué requisitos cumples, cuáles no y qué falta. Es una orientación basada solo en lo que escribiste.
- **Triaje de muchos procesos.** Un modelo económico pone una nota y una razón corta a los procesos de la lista, para decidir cuáles leer primero.
- **Costos.** Antes de cada análisis se muestra una estimación en dólares según el tamaño del PDF y el modelo elegido (precios de lista por millón de tokens: Opus 4 de entrada y 20 de salida, Sonnet 2 y 10, Haiku 0,1 y 0,5). El cobro real es el de tu cuenta de Anthropic.
- **Privacidad.** El PDF del pliego y el perfil de tu empresa viajan a Anthropic cuando usas la IA. Esos mensajes se rigen por los términos de Anthropic para la API. La IA puede equivocarse: confirma cada punto en el pliego.

### Alertas por Telegram
Dos veces al día (7:00 a. m. y 5:00 p. m., hora de Colombia) GitHub busca procesos nuevos con las búsquedas del equipo y los manda a un chat o grupo de Telegram. Se configura una vez; la guía paso a paso está en [`../alertas/README.md`](../alertas/README.md).

## Cómo se calcula el porcentaje de coincidencia

| Criterio | Puntos |
| --- | --- |
| La categoría UNSPSC coincide con alguno de tus códigos | 40 |
| Cada palabra clave en el nombre del proceso (máx. 2) | 20 |
| Cada palabra clave solo en la descripción (máx. 2) | 10 |
| El presupuesto está dentro de tu rango (si lo definiste) | 20 |

El máximo es 100. Mide relevancia para tu perfil, no la probabilidad de ganar.

## Solo procesos competitivos

Viene activado por defecto. En contratación directa, régimen especial, solicitudes de información y subastas de prueba no se compite (la entidad ya eligió a quién contratar, o no es un proceso real); en los datos son la gran mayoría de los registros. El filtro los excluye de las oportunidades, de los adjudicados y de la lista de competidores. La tabla de modalidades siempre muestra el mercado completo para que veas esa proporción.

## Limitaciones que debes conocer

- **La fecha de cierre es la de recepción de ofertas** (`fecha_de_recepcion_de`), sin hora. La hora exacta, las adendas y los requisitos habilitantes están en el proceso oficial: confírmalos siempre antes de ofertar. Las fechas se muestran en hora de Colombia.
- **El estado «Abierto» de la fuente no es confiable en procesos viejos** (hay procesos de años atrás que siguen marcados así). Por eso «abierto» aquí se define por fecha de cierre futura y proceso sin adjudicar, y además se filtra por fecha de publicación.
- **Se revisan hasta 1.000 procesos** que cumplen tu filtro (los que cierran primero) en oportunidades y 300 en adjudicados. Si la búsqueda es muy amplia la app te avisa: estrecha el perfil.
- **Las palabras clave se comparan tal como las escribes**, sin distinguir mayúsculas pero sí tildes: escribe «capacitación», no «capacitacion».
- **Algunos procesos no traen código UNSPSC**; se encuentran solo por palabras clave. No hay un catálogo UNSPSC en los datos abiertos, así que los códigos se escriben a mano.
- **Los oferentes salen del dataset de proponentes**, que tiene retraso y vacíos: el conteo es una aproximación. Los valores de contratos con errores de digitación (por ejemplo `104249364104249364`) vienen en la fuente; se excluyen los mayores a 100 billones de COP y los contratos sin NIT o cédula no cuentan como competidores.
- **El análisis de mercado puede tardar** (20 segundos o más la primera vez) porque recorre millones de contratos. Las consultas repetidas se guardan en memoria 10 minutos mientras la página siga abierta.
- **datos.gov.co puede limitar las consultas** hechas sin token de aplicación. Si aparece un error de la fuente, espera un momento y reintenta.
- La lista de requisitos de la oferta es una **plantilla general**; cada proceso tiene los suyos en el pliego de condiciones.
- **El equipo no comparte datos dentro de la página.** Las búsquedas guardadas y el seguimiento viven en cada navegador; se comparten con enlaces o con el CSV. Un tablero compartido con inicio de sesión requeriría una base de datos y es la mejora pendiente más grande.

Esta herramienta ayuda a encontrar y priorizar oportunidades; no presenta ofertas ni garantiza adjudicaciones.

## Seguridad

La página lleva una política de contenido (CSP) que solo permite cargar scripts propios y conectarse a `www.datos.gov.co` y `api.anthropic.com`. Todo texto que viene de SECOP II se escapa antes de mostrarse, las exportaciones CSV neutralizan fórmulas (`=`, `+`, `-`, `@`) y no se sube nada de tu perfil a ningún servidor propio.

## Pruebas

Requieren Node 22; la app en sí no necesita Node. Desde la raíz del repositorio:

```bash
npm test
```

Son pruebas unitarias de la lógica (consultas, puntuación, índice de dificultad, IA, alertas) y no usan la red: simulan las respuestas de datos.gov.co, de Anthropic y de Telegram. GitHub las ejecuta en cada PR con el flujo `Pruebas`.

## Estructura

- `site/secop.js`: validación de entradas, consultas SoQL, puntuación, cliente de datos.gov.co y mercado. Funciona en el navegador y en Node.
- `site/analisis.js`: resumen de competencia, índice de dificultad, enmascarado de documentos y CSV.
- `site/ia.js`: solicitudes a la API de Anthropic (pliego con citas, evaluación, triaje), costos y errores.
- `site/js/`: la interfaz, un archivo por pestaña (`oportunidades.js`, `adjudicados.js`, `mercado.js`, `seguimiento.js`, `empresa.js`…).
- `site/index.html`, `site/styles.css`: página y estilos.
- `site/vendor/`: SDK oficial de Anthropic empaquetado en un solo archivo (se carga solo cuando se usa la IA). Para regenerarlo: `tools/anthropic-sdk/construir.sh [versión]`.
- `test/`: pruebas de `secop.js`, `analisis.js` e `ia.js`.
- `../alertas/`: motor de alertas por Telegram y su guía.
- `../.github/workflows/`: `pages.yml` (publicación), `tests.yml` (pruebas) y `alertas.yml` (avisos programados).

## Pendiente

- Tablero compartido para el equipo con inicio de sesión (necesita una base de datos, por ejemplo Supabase).
- Alertas por WhatsApp (requiere la API de WhatsApp Business de Meta o un proveedor como Twilio; ver `alertas/README.md`).
- Búsqueda de códigos UNSPSC por nombre (hace falta cargar el catálogo oficial) y búsqueda de palabras sin distinguir tildes.
