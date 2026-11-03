#!/bin/sh
# pandacode-preview: http://127.0.0.1:1420
cd "$(dirname "$0")" || exit 1
exec npm run dev
