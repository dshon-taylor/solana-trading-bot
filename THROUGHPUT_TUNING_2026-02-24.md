# High-throughput tuning profile (2026-02-24)

Goal: increase daily opportunity volume while preserving stop/trailing risk and reliability failovers.

## Changes applied

- `SCAN_EVERY_MS`: `30000` -> `15000`
- `NO_PAIR_RETRY_ATTEMPTS`: `3` -> `4`
- `NO_PAIR_RETRY_BASE_MS`: set to `275`
- `NO_PAIR_TEMP_TTL_MS`: `90000` -> `60000`
- `TRACK_MAX_ACTIVE`: `25` -> `60`
- `TRACK_CANDIDATES_PER_CYCLE`: `5` -> `12`
- `MARKETDATA_MIN_ENTRY_CONFIDENCE_SCORE`: `0.65` -> `0.62` (new env override)
- `MARKETDATA_MAX_FRESHNESS_MS_FOR_ENTRY`: `90000` -> `120000` (new env override)

## Safety constraints preserved

- Stop/trailing risk behavior unchanged (`LIVE_MOMO_STOP_*`, `LIVE_MOMO_TRAIL_*` untouched).
- Reliability failovers unchanged (circuit breaker + playbook + provider cooldowns untouched).

## Revert snippet

```bash
cd /home/dshontaylor/.openclaw/workspace/trading-bot

# revert tuning env values
sed -i 's/^SCAN_EVERY_MS=.*/SCAN_EVERY_MS=30000/' .env
sed -i 's/^NO_PAIR_RETRY_ATTEMPTS=.*/NO_PAIR_RETRY_ATTEMPTS=3/' .env
sed -i 's/^NO_PAIR_RETRY_BASE_MS=.*/NO_PAIR_RETRY_BASE_MS=250/' .env
sed -i 's/^NO_PAIR_TEMP_TTL_MS=.*/NO_PAIR_TEMP_TTL_MS=90000/' .env
sed -i 's/^TRACK_MAX_ACTIVE=.*/TRACK_MAX_ACTIVE=25/' .env
sed -i 's/^TRACK_CANDIDATES_PER_CYCLE=.*/TRACK_CANDIDATES_PER_CYCLE=5/' .env
sed -i 's/^MARKETDATA_MIN_ENTRY_CONFIDENCE_SCORE=.*/MARKETDATA_MIN_ENTRY_CONFIDENCE_SCORE=0.65/' .env
sed -i 's/^MARKETDATA_MAX_FRESHNESS_MS_FOR_ENTRY=.*/MARKETDATA_MAX_FRESHNESS_MS_FOR_ENTRY=90000/' .env

# restart
pm2 restart solana-momentum-bot --update-env
```
