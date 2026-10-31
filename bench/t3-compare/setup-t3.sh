#!/bin/sh
# Builds the T3 Code bench page in production mode. Usage: T3CODE_DIR=/path/to/t3code sh setup-t3.sh
set -eu
: "${T3CODE_DIR:?set T3CODE_DIR to a t3code checkout}"
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$T3CODE_DIR/apps/web/zbench"
cp "$here"/t3/* "$T3CODE_DIR/apps/web/zbench/"
cd "$T3CODE_DIR/apps/web"
NODE_ENV=production T3CODE_WEB_SOURCEMAP=0 ./node_modules/.bin/vp build --mode production --config zbench/vite.bench.config.ts
echo "built $T3CODE_DIR/apps/web/dist-bench (serve: cd \$T3CODE_DIR/apps/web && ./node_modules/.bin/vp preview --config zbench/vite.bench.config.ts --port 4174 --strictPort)"
