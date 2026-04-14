#!/usr/bin/env bash
set -euo pipefail

APP_NAME="${1:-solana-momentum-bot}"
OUT_DIR="${OUT_DIR:-./analysis}"
PM2_LOG="${PM2_LOG:-$HOME/.pm2/pm2.log}"

mkdir -p "$OUT_DIR"
TS="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUT="$OUT_DIR/pm2_restart_context_${TS}.txt"

{
  echo "# PM2 restart context capture"
  echo "ts_utc=$TS"
  echo "app=$APP_NAME"
  echo

  echo "## pm2 status"
  pm2 status "$APP_NAME" || true
  echo

  echo "## pm2 describe (redacted via pm2_snapshot_safe.sh)"
  if [[ -x "./scripts/ops/pm2_snapshot_safe.sh" ]]; then
    ./scripts/ops/pm2_snapshot_safe.sh "$APP_NAME" || true
  else
    echo "(missing ./scripts/ops/pm2_snapshot_safe.sh)"
  fi
  echo

  echo "## last 200 lines of app stderr (state/pm2-err-0.log or state/pm2-err.log)"
  if [[ -f "./state/pm2-err-0.log" ]]; then
    tail -n 200 "./state/pm2-err-0.log" || true
  elif [[ -f "./state/pm2-err.log" ]]; then
    tail -n 200 "./state/pm2-err.log" || true
  else
    echo "(missing ./state/pm2-err-0.log and ./state/pm2-err.log)"
  fi
  echo

  echo "## last 200 lines of app stdout (state/pm2-out-0.log if present)"
  if [[ -f "./state/pm2-out-0.log" ]]; then
    tail -n 200 "./state/pm2-out-0.log" || true
  else
    echo "(missing ./state/pm2-out-0.log)"
  fi
  echo

  echo "## last 200 lines of pm2 daemon log (~/.pm2/pm2.log)"
  if [[ -f "$PM2_LOG" ]]; then
    tail -n 200 "$PM2_LOG" || true
  else
    echo "(missing $PM2_LOG)"
  fi
  echo

  echo "## last 200 lines of syslog (if present)"
  if [[ -f /var/log/syslog ]]; then
    tail -n 200 /var/log/syslog || true
  else
    echo "(no /var/log/syslog)"
  fi
  echo

  echo "## journalctl window helper"
  echo "If you have sudo:"
  echo "  sudo journalctl --no-pager -S '2026-02-19 02:04:00' -U '2026-02-19 02:07:00'"
} > "$OUT"

echo "wrote: $OUT"
