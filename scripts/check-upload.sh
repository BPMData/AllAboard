#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
probe=$(mktemp ./gha-creds-XXXXXXXX)
mv "$probe" "$probe.json"
manifest=$(mktemp)
trap 'rm -f "$probe.json" "$manifest"' EXIT
gcloud meta list-files-for-upload . > "$manifest"
grep -Eq '^([.]/)?server[.]ts$' "$manifest"
if grep -Eq '(^|/)gha-creds-[^/]*[.]json$' "$manifest"; then
  echo 'Deployment credentials are included in the source manifest.' >&2
  exit 1
fi
