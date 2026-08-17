#!/usr/bin/env sh
set -eu
SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIRECTORY/services/reseller-gateway"
command -v node >/dev/null 2>&1 || { echo "Voice-ish requires Node.js 20 or newer."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "Voice-ish requires npm."; exit 1; }
npm install
npm run setup
