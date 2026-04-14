#!/usr/bin/env bash
set -euo pipefail

# Snapshot npm audit (prod deps only) to a timestamped JSON file.
# Usage: ./scripts/ops/audit_snapshot.sh [out_dir]

OUT_DIR="${1:-./analysis}"
mkdir -p "$OUT_DIR"

TS="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
OUT_FILE="$OUT_DIR/npm_audit_omit_dev_${TS}.json"

npm audit --omit=dev --json > "$OUT_FILE" || true

echo "Wrote: $OUT_FILE"
