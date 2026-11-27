#!/usr/bin/env bash
# Run after npm run build, using the Node version that starts the Cloud Run container.
set -euo pipefail
cd "$(dirname "$0")/.."
node -e "import('./server.ts').then(() => console.log('Production imports OK'))"

work_dir="$(mktemp -d)"
port="${SMOKE_PORT:-3456}"
base_url="http://127.0.0.1:$port"
NODE_ENV=production PORT="$port" DATA_DIR="$work_dir/data" BACKUP_DIR="$work_dir/backup" BACKUP_BUCKET=off \
  node server.ts >"$work_dir/server.log" 2>&1 &
server_pid=$!
cleanup() {
  if [[ "$?" != 0 ]]; then cat "$work_dir/server.log" >&2; fi
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  rm -rf "$work_dir"
}
trap cleanup EXIT

for _ in {1..30}; do
  kill -0 "$server_pid" 2>/dev/null || exit 1
  if grep -Fq "Server running on http://localhost:$port" "$work_dir/server.log"; then break; fi
  sleep 1
done
grep -Fq "Server running on http://localhost:$port" "$work_dir/server.log"
curl -fsS --max-time 5 "$base_url/healthz" | grep -q '"status":"ok"'
curl -fsS --max-time 5 "$base_url/" | grep -q '<div id="root">'
echo 'Production health check and app page passed.'
