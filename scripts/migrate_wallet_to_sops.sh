#!/usr/bin/env bash
set -euo pipefail

# Migrate a plaintext Solana keypair JSON (e.g. keys/wallet.json) to an encrypted SOPS file.
#
# Usage:
#   ./scripts/migrate_wallet_to_sops.sh /path/to/wallet.json [./secrets/wallet.enc.json]
#
# Notes:
# - This script does NOT modify your .env.
# - It will generate an age keypair at ~/.config/sops/age/keys.txt if one does not exist.
# - The output file path is gitignored by default (see .gitignore: secrets/).

IN_WALLET_JSON="${1:-}"
OUT_ENC_JSON="${2:-./secrets/wallet.enc.json}"

if [[ -z "$IN_WALLET_JSON" ]]; then
  echo "Missing input wallet JSON."
  echo "Usage: $0 /path/to/wallet.json [./secrets/wallet.enc.json]"
  exit 2
fi

if [[ ! -f "$IN_WALLET_JSON" ]]; then
  echo "Input wallet JSON not found: $IN_WALLET_JSON"
  exit 2
fi

command -v sops >/dev/null 2>&1 || { echo "sops not found in PATH"; exit 1; }
command -v age-keygen >/dev/null 2>&1 || { echo "age-keygen not found in PATH"; exit 1; }

AGE_DIR="$HOME/.config/sops/age"
AGE_KEYS_FILE="$AGE_DIR/keys.txt"

mkdir -p "$AGE_DIR"
chmod 700 "$HOME/.config" "$HOME/.config/sops" "$AGE_DIR" 2>/dev/null || true

if [[ ! -f "$AGE_KEYS_FILE" ]]; then
  echo "Generating age keypair at: $AGE_KEYS_FILE"
  umask 077
  age-keygen -o "$AGE_KEYS_FILE" >/dev/null
fi

chmod 600 "$AGE_KEYS_FILE" 2>/dev/null || true

AGE_RECIPIENT="$(age-keygen -y "$AGE_KEYS_FILE" | head -n 1)"
if [[ -z "$AGE_RECIPIENT" ]]; then
  echo "Failed to derive age recipient public key from $AGE_KEYS_FILE"
  exit 1
fi

mkdir -p "$(dirname "$OUT_ENC_JSON")"

# Encrypt wallet json -> sops json (still json, but with sops metadata)
# SOPS expects a top-level JSON object; Solana keypair files are often a top-level array.
# We normalize to an object shape: {"keypair": [...]} when needed.
# We avoid printing secrets; only metadata and paths are echoed.
echo "Encrypting wallet JSON to: $OUT_ENC_JSON"
TMP_OUT="${OUT_ENC_JSON}.tmp"
TMP_NORM="${OUT_ENC_JSON}.norm.tmp"

command -v jq >/dev/null 2>&1 || { echo "jq not found in PATH (required for array->object normalization)"; exit 1; }

jq 'if type=="array" then {keypair:.} else . end' "$IN_WALLET_JSON" > "$TMP_NORM"

sops --encrypt --age "$AGE_RECIPIENT" --input-type json --output-type json \
  "$TMP_NORM" > "$TMP_OUT"

rm -f "$TMP_NORM"

mv "$TMP_OUT" "$OUT_ENC_JSON"
chmod 600 "$OUT_ENC_JSON" 2>/dev/null || true

echo "Done. Next steps:"
echo "  1) Set: SOPS_WALLET_FILE=$OUT_ENC_JSON"
echo "  2) Remove WALLET_SECRET_KEY_JSON / WALLET_SECRET_KEY_B64 from env"
echo "  3) Remove ALLOW_WALLET_SECRET_KEY_ENV from env (set to false or delete)"
echo "  4) Smoke test: node -e \"import('./src/wallet.mjs').then(m=>m.loadKeypairFromEnv()).then(()=>console.log('ok')).catch(e=>{console.error(e.message);process.exit(1)})\""
