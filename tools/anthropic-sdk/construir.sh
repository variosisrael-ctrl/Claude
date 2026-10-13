#!/usr/bin/env bash
# Regenera secop_radar/site/vendor/anthropic-sdk.js: el SDK oficial de Anthropic empaquetado como un único script
# para el navegador (así el sitio no depende de un CDN en tiempo de ejecución y funciona abriendo index.html).
#
# Uso:  tools/anthropic-sdk/construir.sh [versión]     (por defecto, la que está fijada abajo)
set -euo pipefail

VERSION="${1:-0.129.0}"
RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cp "$RAIZ/tools/anthropic-sdk/entry.mjs" "$TMP/entry.mjs"
cd "$TMP"
npm init -y >/dev/null
npm install --silent --no-audit --no-fund "@anthropic-ai/sdk@$VERSION" esbuild
npx esbuild entry.mjs --bundle --minify --format=iife --platform=browser --target=es2020 \
  --legal-comments=none --outfile="$RAIZ/secop_radar/site/vendor/anthropic-sdk.js"
cp node_modules/@anthropic-ai/sdk/LICENSE "$RAIZ/secop_radar/site/vendor/anthropic-sdk.LICENSE"
echo "SDK $VERSION empaquetado en secop_radar/site/vendor/anthropic-sdk.js"
