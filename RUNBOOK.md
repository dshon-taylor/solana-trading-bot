# RUNBOOK — Candle Carl (trading-bot)

This is the operator runbook for running Candle Carl in production.

**Safety model:**
- **Entries are disabled by default** (`state.tradingEnabled=false` unless `FORCE_TRADING_ENABLED=true`).
- Prefer enabling/disabling entries via Telegram commands (`/resume`, `/halt`) so you don’t need to restart the process.
- If the process is unstable or rate-limited, keep entries halted and let it recover.

---

## 0) Quick commands (copy/paste)

### Health + stability
```bash
cd ~/trading-bot
pm2 status
curl -sS http://127.0.0.1:8787/healthz | jq

# Safe PM2 snapshot (avoids leaking pm2_env secrets)
./scripts/pm2_snapshot_safe.sh solana-momentum-bot | jq
```

### Preflight (before enabling live)
```bash
cd ~/trading-bot
./scripts/preflight_live.sh
```

### Logs
```bash
pm2 logs solana-momentum-bot --lines 200
# Or tail persisted log files (paths can vary by pm2)
ls -la state | head
```

### LaserStream devnet staging smoke/soak
```bash
cd ~/trading-bot
LASERSTREAM_SOAK_MINUTES=10 npm run soak:laserstream:staging
```
See `LASERSTREAM_STAGING_RUNBOOK.md` for staging-only env gates, rollback switch, and interpretation.

### Historical replay / optimization (7-day examples)
```bash
cd ~/trading-bot

# Replay with concrete overrides
npm run replay:historical -- \
  --days 7 \
  --trail-activate-pct 0.10 \
  --trail-distance-pct 0.12 \
  --stop-entry-buffer-pct 0.0005

# Optimize ranges and show top parameter sets (ranked by stability + return)
npm run optimize:replay -- \
  --days 7 \
  --trail-distance-range 0.08:0.20:0.02 \
  --trail-activate-range 0.05:0.20:0.01 \
  --stop-entry-buffer-range 0.0003:0.003:0.0003 \
  --rolling-windows 4 \
  --top 10

# Build durable candidate outcome labels for optimizer/model input
npm run label:outcomes -- \
  --candidate-dir ./state/candidates \
  --track-dir ./state/track \
  --paper-trades ./state/paper_trades.jsonl \
  --out-dir ./state/outcome_labels

# Trade lifecycle analytics (Feature #7)
npm run summarize:lifecycle -- --since-hours 168

# Weekly propose-only optimizer report to Telegram (D'Shon)
npm run report:weekly:optimizer -- --dry-run
npm run cron:install:weekly:optimizer
```

Feature #5/#6 notes:
- Labeling output is written to `state/outcome_labels/labels.jsonl` and `labels_summary.json`.
- Replay optimizer output now includes `consistency`, `pnlDisp`, and `winWindowRate`.
- Ranking is deterministic with tie-breaks on rule JSON serialization.

### Safe entry controls (no restart)
From Telegram (allowed chat only):
- `/status`
- `/positions`
- `/diag` (throughput rates + top reject buckets + tracker ingest integrity line)
- `/halt` (pause new entries; exits/stops continue)
- `/resume`

Throughput tuning quick-read (target ~25 opportunities/day):
- `opportunities/day est` should trend around ~25 (derived from scan cycles/hour × 24).
- `candidates/h` should rise/fall as filter looseness changes.
- `entries/h attempts` vs `success` shows execution quality (quote/slippage/capital failures suppress success).
- `top rejects` tells you which gate is currently dominating losses in funnel throughput.
- `tracker ingest` line should normally stay `ok`; `LOW_INGEST`/`ZERO_INGEST` means replay sample writes are lagging or stalled.
- Tracker counters are explicit: `hour=<pointsLastHour>` and `day=<pointsToday>`.

Pair-fetch throughput tuning (aggressive profile):
- Target effective fanout: `PAIR_FETCH_CONCURRENCY=5` (still safety-capped to 8 in code).
- Reduced retry dwell defaults: `NO_PAIR_RETRY_BASE_MS=90`, `NO_PAIR_RETRY_MAX_BACKOFF_MS=900`, `NO_PAIR_RETRY_TOTAL_BUDGET_MS=1500`.
- Rollback-only these changes (keep aggressive mode):
  - `PAIR_FETCH_CONCURRENCY=3`
  - `NO_PAIR_RETRY_ATTEMPTS=6`
  - `NO_PAIR_RETRY_BASE_MS=225`
  - `NO_PAIR_RETRY_MAX_BACKOFF_MS=2000`
  - `NO_PAIR_RETRY_TOTAL_BUDGET_MS=2500`

### New operator knobs (Feature #8/#9)
- Capital guardrails:
  - `MIN_SOL_FOR_FEES`
  - `CAPITAL_SOFT_RESERVE_SOL`
  - `CAPITAL_RETRY_BUFFER_PCT`
  - `MAX_NEW_ENTRIES_PER_HOUR` (`0` disables)
- Incident playbook:
  - `PLAYBOOK_ENABLED`
  - `PLAYBOOK_RESTART_THRESHOLD` + `PLAYBOOK_RESTART_WINDOW_MS`
  - `PLAYBOOK_ERROR_THRESHOLD` + `PLAYBOOK_ERROR_WINDOW_MS`
  - `PLAYBOOK_STABLE_RECOVERY_MS`
- Tracker ingest guardrail:
  - `TRACK_INGEST_WINDOW_MINUTES`
  - `TRACK_INGEST_MIN_POINTS`
  - `TRACK_INGEST_EXPECTED_FRACTION`

---

## 1) Daily operator checklist (5 minutes)

1. **Process stable**
   - `pm2 status`: `online`, `unstable_restarts=0`
   - `/healthz`: `ok=true`, loopDtMs looks sane, `openPositions` matches expectations.

2. **Trading posture is what you intend**
   - `/healthz` shows `tradingEnabled=false` unless you intend otherwise.
   - If you’re unsure: Telegram `/halt`.

3. **Rate limits are calm**
   - Ensure no recurring fatal errors.
   - Occasional Telegram 429 cooldown is acceptable; repeated 429 spam is not (should be suppressed).

4. **Key hygiene**
   - Use `SOPS_WALLET_FILE=./secrets/wallet.enc.json` (encrypted).
   - Plaintext key material should be archived offline after the stability window (see `PROD_HARDENING.md`).
   - After archiving plaintext key material, deploy pending code changes with: `./scripts/deploy_pending_after_key_archive.sh` (safe PM2 reload).

---

## 2) Enabling LIVE momentum trading (controlled)

This bot intentionally requires **two independent “yes” signals**:

1) **Config allows live momentum mode**: `LIVE_MOMO_ENABLED=true`

2) **Explicit operator override**: `FORCE_TRADING_ENABLED=true`

Additionally, at runtime **entries can still be halted** via `state.tradingEnabled=false` (Telegram `/halt`).

### Suggested launch sequence

1. Start with **entries halted**
   - Telegram: `/halt`
   - Confirm `/healthz` says `tradingEnabled=false`.

2. Verify everything else looks correct
   - Filters, liquidity/mcap/age thresholds
   - SOLUSD feed stable
   - Candidate scanning loop healthy

3. Enable config (requires restart/reload)
   - Set `LIVE_MOMO_ENABLED=true`
   - Set `FORCE_TRADING_ENABLED=true`
   - Then: `pm2 reload ecosystem.config.cjs --only solana-momentum-bot --update-env`

4. Keep entries halted for 1–2 scan cycles
   - Confirm no new warnings/fatals.

5. Resume entries
   - Telegram: `/resume`

### Emergency stop
- Telegram: `/halt`
- If Telegram is down: stop the process (entries stop by default on restart)
  ```bash
  pm2 stop solana-momentum-bot
  ```

---

## 3) Investigations / common issues

### A) DexScreener 429 at boot / during scan
Expected behavior:
- Bot **should not crash**.
- Market-data router should fail over: **DexScreener → Jupiter free price path → bounded last-known-good cache**.
- Provider health state (`state.marketData.providers`) should show increasing cooldown on repeated failures.

If you see repeated fatal exits:
- Keep entries halted.
- Inspect `pm2-err` logs for `[fatal]` lines.

### A.1) Confidence / freshness gates (Phase 3)
- Scanner entries only proceed when market snapshot confidence is high enough and fresh enough.
- Low-confidence snapshots (typically Jupiter-only or stale cache) are allowed for observability but are rejected for risky entries.
- Open-position stop updates/exits require usable snapshot confidence + freshness to avoid panic exits on stale prices.
- Useful state paths:
  - `state.marketData.providers.*` → fail/success streaks + adaptive cooldown
  - `state.marketData.lastKnownGood` → bounded fallback cache

### B) Telegram 429
Expected behavior:
- Bot should respect `retry_after` and suppress repeated sends during cooldown.

### D) Incident playbook degraded mode
Expected behavior:
- On restart bursts / error bursts / circuit-open conditions, bot logs and notifies:
  - `Playbook degraded mode ON ... Entries paused`
- In degraded mode, existing stop/exit management continues; only new entries are blocked.
- Bot runs self-recovery (resets transient backoff/cooldown state) and auto-reopens execution after:
  - errors/restarts fall below thresholds, and
  - stable window (`PLAYBOOK_STABLE_RECOVERY_MS`) elapsed.

If spammy:
- It’s noisy but not dangerous; address by deploying the log-noise rate-limit patch on next safe reload.

### C) “bigint-buffer failed to load bindings”
- This is a startup warning from `bigint-buffer`.
- We intentionally **do not rebuild** native bindings due to an upstream advisory (see `PROD_HARDENING.md`).

---

## 4) File layout (operator-relevant)

- `state/` — runtime state, ledgers (permission-hardened)
- `secrets/` — encrypted wallet file (`wallet.enc.json`) (0700/0600)
- `keys/offline/` — archived plaintext key material (offline storage target)
- `PROD_HARDENING.md` — full checklist + rationale
- `PROD_HARDENING_STATUS.md` — rolling log
