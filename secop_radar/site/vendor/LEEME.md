# Dependencias empaquetadas

`anthropic-sdk.js` es el [SDK oficial de Anthropic para TypeScript](https://github.com/anthropics/anthropic-sdk-typescript)
(versión 0.129.0, licencia MIT, ver `anthropic-sdk.LICENSE`) empaquetado como un único script con esbuild. Define la
variable global `Anthropic`. Es un archivo generado: no se edita a mano.

Para regenerarlo o actualizarlo: `tools/anthropic-sdk/construir.sh [versión]`.

Solo se carga cuando alguien usa una función de IA (ver `js/empresa.js`).
