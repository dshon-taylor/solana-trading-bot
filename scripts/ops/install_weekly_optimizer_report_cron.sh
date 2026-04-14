#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
JOB_TAG="# candle-carl-weekly-propose-only"
CRON_TZ_LINE='CRON_TZ=America/Chicago'
CRON_EXPR='0 9 * * 0'
CMD="cd ${REPO_DIR} && /usr/bin/env node scripts/research/weekly_optimizer_report.mjs >> state/weekly_optimizer_report.log 2>&1 ${JOB_TAG}"

current="$(crontab -l 2>/dev/null || true)"

# Remove prior tagged job line(s)
filtered="$(printf '%s\n' "$current" | grep -v "${JOB_TAG}" || true)"

# Ensure timezone line exists once
if ! printf '%s\n' "$filtered" | grep -q '^CRON_TZ=America/Chicago$'; then
  filtered="${filtered}\n${CRON_TZ_LINE}"
fi

updated="${filtered}\n${CRON_EXPR} ${CMD}"

printf '%b\n' "$updated" | sed '/^$/N;/^\n$/D' | crontab -

echo "Installed weekly report cron: ${CRON_EXPR} (${CRON_TZ_LINE})"
crontab -l | grep -n "${JOB_TAG}" || true
