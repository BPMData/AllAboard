#!/usr/bin/env bash
set -euo pipefail
work_dir=$(mktemp -d)
export DATA_DIR="$work_dir/data" BACKUP_DIR="$work_dir/backup" BACKUP_BUCKET=off NODE_ENV=production
unset K_SERVICE
node server.ts &
server_pid=$!
cleanup() {
  kill -TERM "$server_pid" 2>/dev/null || true
  wait "$server_pid" || true
  rm -rf "$work_dir"
}
trap cleanup EXIT
trap 'exit' TERM INT
wait "$server_pid"
