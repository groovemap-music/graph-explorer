#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
vendor="${repo_root}/explore/static/vendor"
mkdir -p "${vendor}"
find "${vendor}" -mindepth 1 -depth -delete
cp "${repo_root}/explore/node_modules/d3/dist/d3.min.js" "${vendor}/d3.min.js"
cp "${repo_root}/explore/node_modules/plotly.js-dist-min/plotly.min.js" "${vendor}/plotly.min.js"
cp "${repo_root}/explore/node_modules/alpinejs/dist/cdn.min.js" "${vendor}/alpine.min.js"
cp "${repo_root}/explore/node_modules/qrcodejs/qrcode.min.js" "${vendor}/qrcode.min.js"
cp "${repo_root}/explore/node_modules/dompurify/dist/purify.es.mjs" "${vendor}/dompurify.mjs"
cp "${repo_root}/explore/node_modules/marked/lib/marked.esm.js" "${vendor}/marked.mjs"
mkdir -p "${vendor}/fonts/inter/files" "${vendor}/fonts/jetbrains-mono/files" "${vendor}/fonts/space-grotesk/files" "${vendor}/fonts/material-symbols"
cp "${repo_root}"/explore/node_modules/@fontsource/inter/latin-{400,500,600,700}.css "${vendor}/fonts/inter/"
cp "${repo_root}"/explore/node_modules/@fontsource/inter/files/inter-latin-{400,500,600,700}-normal.woff* "${vendor}/fonts/inter/files/"
cp "${repo_root}"/explore/node_modules/@fontsource/jetbrains-mono/latin-{400,500}.css "${vendor}/fonts/jetbrains-mono/"
cp "${repo_root}"/explore/node_modules/@fontsource/jetbrains-mono/files/jetbrains-mono-latin-{400,500}-normal.woff* "${vendor}/fonts/jetbrains-mono/files/"
cp "${repo_root}"/explore/node_modules/@fontsource/space-grotesk/latin-{400,500,600,700}.css "${vendor}/fonts/space-grotesk/"
cp "${repo_root}"/explore/node_modules/@fontsource/space-grotesk/files/space-grotesk-latin-{400,500,600,700}-normal.woff* "${vendor}/fonts/space-grotesk/files/"
cp "${repo_root}/explore/node_modules/material-symbols/outlined.css" "${vendor}/fonts/material-symbols/"
cp "${repo_root}/explore/node_modules/material-symbols/material-symbols-outlined.woff2" "${vendor}/fonts/material-symbols/"
test "$(find "${vendor}" -maxdepth 1 -type f | wc -l | tr -d ' ')" = "6"
node "${repo_root}/explore/scripts/vendor-licenses.mjs" build
