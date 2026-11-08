#!/bin/sh
# Runs the PandaCode desktop browser preview in the foreground; Ctrl-C stops it.
# pandacode-preview: http://127.0.0.1:1447
set -eu

cd "$(dirname "$0")"
exec ./node_modules/.bin/vite --port 1447 --strictPort --host 127.0.0.1
