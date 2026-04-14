#!/usr/bin/env bash
set -euo pipefail

# Safe PM2 snapshot helper.
# PM2's `jlist` includes full `pm2_env` (which can contain secrets). This script
# whitelists only non-secret operational fields.

APP_NAME="${1:-solana-momentum-bot}"

have() { command -v "$1" >/dev/null 2>&1; }

if ! have pm2; then
  echo "missing: pm2" >&2
  exit 1
fi

if ! have jq; then
  echo "missing: jq (needed to safely filter pm2 output)" >&2
  exit 1
fi

pm2 jlist \
  | jq -c --arg name "$APP_NAME" '.[]
      | select(.name==$name)
      | {
          name,
          pm_id,
          pid,
          monit,
          pm2_version,
          created_at: (.pm2_env.created_at // null),
          restart_time: (.pm2_env.restart_time // null),
          unstable_restarts: (.pm2_env.unstable_restarts // null),
          status: (.pm2_env.status // null),
          pm_uptime: (.pm2_env.pm_uptime // null),
          uptime_ms: (if (.pm2_env.pm_uptime|type)=="number" then ((now*1000) - .pm2_env.pm_uptime) else null end),
          min_uptime: (.pm2_env.min_uptime // null),
          max_restarts: (.pm2_env.max_restarts // null),
          exp_backoff_restart_delay: (.pm2_env.exp_backoff_restart_delay // null)
        }'
