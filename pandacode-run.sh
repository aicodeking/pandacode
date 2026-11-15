#!/bin/sh
# pandacode-preview: http://127.0.0.1:15388
set -eu
unset LD_LIBRARY_PATH
cd "$(dirname "$0")"
exec ./node_modules/.bin/vite --host 127.0.0.1 --port 15388 --strictPort
