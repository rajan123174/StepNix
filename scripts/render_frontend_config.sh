#!/usr/bin/env bash

set -euo pipefail

API_BASE_URL_VALUE="${API_BASE_URL:-}"
WS_BASE_URL_VALUE="${WS_BASE_URL:-}"

cat > static/app-config.js <<EOF
window.APP_CONFIG = {
  API_BASE_URL: "${API_BASE_URL_VALUE}",
  WS_BASE_URL: "${WS_BASE_URL_VALUE}"
};
EOF
