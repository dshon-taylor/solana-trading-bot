#!/usr/bin/env bash
set -euo pipefail

# Preflight checks before enabling LIVE trading.
# Safe: does not mutate running PM2 process, does not print secrets.

cd "$(dirname "$0")/.."

red() { printf "\033[31m%s\033[0m\n" "$*"; }
grn() { printf "\033[32m%s\033[0m\n" "$*"; }
ylw() { printf "\033[33m%s\033[0m\n" "$*"; }

have() { command -v "$1" >/dev/null 2>&1; }

fail=0
warn=0

step() { printf "\n== %s ==\n" "$*"; }

step "Repo + node"
if ! have node; then red "missing: node"; fail=1; else echo "node: $(node -v)"; fi
if ! have npm; then red "missing: npm"; fail=1; else echo "npm:  $(npm -v)"; fi

step "Unit/lint checks"
if npm run -s check; then grn "npm run check: OK"; else red "npm run check: FAILED"; fail=1; fi

step "Secrets posture"
if [[ -f "./keys/bot-keypair.json" ]]; then
  ylw "plaintext key present: ./keys/bot-keypair.json (should be archived offline after stability window)"
  warn=1
else
  grn "no plaintext key at ./keys/bot-keypair.json"
fi

if [[ -d "./keys/offline" ]]; then
  echo "keys/offline perms: $(stat -c '%a %U:%G %n' ./keys/offline 2>/dev/null || true)"
fi

if [[ -d "./secrets" ]]; then
  echo "secrets perms:      $(stat -c '%a %U:%G %n' ./secrets 2>/dev/null || true)"
fi

# Encrypted wallet file check (non-leaky)
enc="./secrets/wallet.enc.json"
if [[ -f "$enc" ]]; then
  if have sops; then
    if sops -d "$enc" >/dev/null; then
      grn "SOPS wallet decrypt: OK (${enc})"
    else
      red "SOPS wallet decrypt: FAILED (${enc})"
      fail=1
    fi
  else
    ylw "sops not found; cannot verify decrypt (${enc})"
    warn=1
  fi
else
  red "missing encrypted wallet file: ${enc}"
  fail=1
fi

step "Runtime sanity (optional)"
if have curl; then
  if curl -fsS http://127.0.0.1:8787/healthz >/dev/null; then
    grn "healthz reachable: OK"
  else
    ylw "healthz not reachable (is bot running on this host?)"
    warn=1
  fi
else
  ylw "curl not found; cannot probe /healthz"
  warn=1
fi

step "Summary"
if [[ "$fail" -ne 0 ]]; then
  red "PRECHECK FAILED — fix errors before enabling live trading."
  exit 1
fi

if [[ "$warn" -ne 0 ]]; then
  ylw "PRECHECK OK with warnings. Review warnings before enabling live trading."
else
  grn "PRECHECK OK"
fi
