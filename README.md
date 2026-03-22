# Solana Momentum Bot (scaffold)

This bot is being built to your spec:
- Trade Solana tokens with liquidity + safety filters
- Execute on Jupiter
- Enforce strict risk rules + trailing stop
- Persistent daemon + state + Telegram alerts

## Production docs

- Operator runbook: `RUNBOOK.md`
- Full hardening checklist + evidence: `PROD_HARDENING.md`
- Rolling log: `PROD_HARDENING_STATUS.md`
- Strategy notes / trade ledger: `trading.md`

## Momentum rules (single place to change)
Primary knobs live in `.env` / `.env.example` under **MOMENTUM RULES**:
- Entry thresholds: `PAPER_ENTRY_*` (live momo uses the SAME thresholds)
- Risk rules: `LIVE_MOMO_*` (paper risk defaults derive from LIVE risk)

Quick sanity checks:
- `npm run check`
- `npm run dryrun:rules`

## Aggressive entry profile (maximize attempt/fill throughput)
Use a single toggle:

```bash
AGGRESSIVE_MODE=true
```

What it changes automatically:
- Enables conversion profile behavior.
- Optional *force-attempt-on-confirm-pass* policy (aggressive-only, default ON): after confirm gate passes, the bot can attempt immediately instead of waiting for the next watchlist eval tick. Guarded by per-mint cooldown + per-mint hourly cap + global per-minute cap (see envs below).
- Expands quote fanout and candidate shortlist width.
- Reduces no-pair cooldown/revisit timings.
- Enables multi-pass fast route rechecks for quote/route misses.
- Enables momentum fallback trigger by default (can still force off via `MOMENTUM_FALLBACK_ENABLED=false`).
- Uses a moderately looser aggressive confirm impact cap (`AGGRESSIVE_CONFIRM_MAX_PRICE_IMPACT_PCT`, bounded to `<=8`).
- Slightly loosens aggressive momentum paper thresholds/cooldown defaults.
- Early shortlist prefilter defaults to `minimal` anti-spam floor in aggressive mode (`AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_*`: liq=1200, tx1h=1, boostUsd=5).
- Supports explicit prefilter mode override (`EARLY_SHORTLIST_PREFILTER_MODE=off|minimal|standard`; aggressive override: `AGGRESSIVE_EARLY_SHORTLIST_PREFILTER_MODE`).
- Prioritizes routeable candidates earlier in evaluation order.
- Keeps hard safety gates (wallet/rpc sanity, capital/risk guardrails, circuit/playbook).

Rollback (single click):

```bash
AGGRESSIVE_MODE=false
```

Force-attempt rollback/switch-off (keep aggressive mode but disable forced confirm-pass attempts):

```bash
FORCE_ATTEMPT_ON_CONFIRM_PASS=false
```

Throughput-tuning rollback (keep aggressive mode, revert pair-fetch tuning only):

```bash
PAIR_FETCH_CONCURRENCY=3
NO_PAIR_RETRY_ATTEMPTS=6
NO_PAIR_RETRY_BASE_MS=225
NO_PAIR_RETRY_MAX_BACKOFF_MS=2000
NO_PAIR_RETRY_TOTAL_BUDGET_MS=2500
```

Then restart the process (PM2/systemd) and verify with `/config` + `/diag`.
`/diag` now shows funnel split by standard vs fallback-trigger attempts/fills.
`/diag` historical retention defaults to 90 days and is tunable via `DIAG_RETENTION_DAYS` (legacy override: `DIAG_MAX_WINDOW_MS`).

Watchlist eviction controls (dead-token buildup protection):
- `WATCHLIST_EVICT_MAX_AGE_HOURS` — evict watchlist entries once mint age crosses this threshold.
- `WATCHLIST_EVICT_STALE_CYCLES` — evict entries with no trigger progress after N watchlist eval cycles.
- `/diag` watchlist line includes eviction reason breakdown: `age`, `stale`, `ttl`.
- Aggressive profile uses tighter defaults automatically when these are unset.

Audit helpers:
- `npm run summarize:attempts`
- `npm run summarize:lifecycle -- --since-hours 168`

## Replay + optimization over captured history (Pass 2)
Use historical `state/track/YYYY-MM-DD/*.jsonl` captures to re-simulate outcomes with rule overrides.

Replay last 7 days with explicit rules:
```bash
npm run replay:historical -- \
  --days 7 \
  --trail-activate-pct 0.10 \
  --trail-distance-pct 0.12 \
  --stop-entry-buffer-pct 0.0005
```

Replay last 7 days with 24h per-trade window and JSON output:
```bash
npm run replay:historical -- --days 7 --window-hours 24 --json
```

Optimize trailing/activation/stop-entry-buffer over last 7 days (stability-ranked):
```bash
npm run optimize:replay -- \
  --days 7 \
  --trail-distance-range 0.08:0.20:0.02 \
  --trail-activate-range 0.05:0.20:0.01 \
  --stop-entry-buffer-range 0.0003:0.003:0.0003 \
  --rolling-windows 4 \
  --top 10
```

Weekly propose-only optimizer report (Telegram):
```bash
# generate + send now
npm run report:weekly:optimizer

# preview without sending
npm run report:weekly:optimizer -- --dry-run

# install Sunday 9:00 AM America/Chicago cron delivery
npm run cron:install:weekly:optimizer
```

Report output includes:
- top 3 rule tweak proposals
- confidence per proposal
- expected delta range vs current rules
- weekly trend framing (primary) + daily context notes (secondary)
- explicit propose-only wording (no automatic parameter changes)


Build durable outcome labels from candidate ledger + tracked/paper outcomes:
```bash
npm run label:outcomes -- \
  --candidate-dir ./state/candidates \
  --track-dir ./state/track \
  --paper-trades ./state/paper_trades.jsonl \
  --out-dir ./state/outcome_labels
```

Trade lifecycle analytics (Feature #7):
- Breakdowns: `entry quality`, `hold time`, `exit reason`, `slippage` bucket.
- Slippage bucket uses `slippageBps` when available; otherwise falls back to a volatility proxy (`ret15` for paper, `pc1h` for live).
- Data sources reused: `state/paper_trades.jsonl`, `state/paper_live_attempts.jsonl`, `state/state.json` closed positions, and `state/outcome_labels/labels.jsonl` (coverage reference).

Example:
```bash
npm run summarize:lifecycle -- --since-hours 168
npm run summarize:lifecycle -- --json
```

Determinism/assumptions:
- Input series are sorted by timestamp, files/day dirs are processed lexicographically.
- Replay uses tracked snapshots as price points (no slippage/fees/liquidity impact model).
- Entry is anchored to the tracked `entryPrice` (or first observed price if missing).
- Exit reasons are `stopAtEntry`, `trailingStop`, `horizon`.
- Optimizer ranking is deterministic and now prioritizes rolling-window consistency (`consistencyScore`) before aggregate return.
- Outcome labels are persisted as `state/outcome_labels/labels.jsonl` + `labels_summary.json` for downstream optimizer/model consumption.

### Feature #5 / #6 operator notes
- Generate labels after enough tracked/paper exits accumulate: `npm run label:outcomes -- --json`
- Optimizer now ranks by rolling-window consistency first, then aggregate return.
- Use `--rolling-windows` (default `4`) to control stability horizon granularity.

## Wallet secret handling (NO plaintext on disk)

The bot **does not need** to write the private key to disk.

### Option A: Environment variable (fastest)
Set **one** of:
- `WALLET_SECRET_KEY_JSON` = JSON array of bytes (Solana keypair secretKey)
- `WALLET_SECRET_KEY_B64` = base64 of the same bytes

Run:
```bash
cp .env.example .env
# edit .env, then:
npm start
```

### Option B: Encrypted secret file (recommended)
Use `sops` + `age` to keep an **encrypted** file in the repo, and decrypt only in memory at runtime.

High-level:
1) Install `sops` + `age`
2) Create an age key (stored outside the repo)
3) Encrypt `secrets/wallet.enc.json`
4) Run with `SOPS_WALLET_FILE=./secrets/wallet.enc.json`

The bot will run: `sops -d <file>` and load the keypair from the decrypted JSON.

## Status
This repo is now a **running PM2 daemon** with hardening work tracked in:
- `RUNBOOK.md`
- `PROD_HARDENING.md`
- `PROD_HARDENING_STATUS.md`

Key capabilities are implemented (scanner/filters, state, Telegram alerts, risk engine + trailing stop, paper/live guardrails, health endpoint, log rotation).

Market-data reliability (Phase 3):
- `src/market_data_router.mjs` provides normalized snapshots (`priceUsd`, `liquidityUsd`, tx/volume, source/timestamp/freshness, confidence).
- Provider order (feature-flagged): Birdseye Lite (paid, optional) → DexScreener (free primary fallback) → Jupiter price (free secondary fallback) → bounded last-known-good cache.
- Birdseye knobs: `BIRDEYE_LITE_ENABLED`, `BIRDEYE_API_KEY`, `BIRDEYE_LITE_MAX_RPS` (keep <=15; default 12), `BIRDEYE_LITE_CHAIN`.
- Adaptive provider-health cooldown and confidence/freshness gates protect entries from low-confidence data.
- Tracker ingest guardrail warns on replay-data integrity gaps (zero/abnormally low sample writes) and exposes explicit write counters (`hour`/`day`) via `/diag`, `/health`, and heartbeat snapshot/alerts.

Capital efficiency + incident automation (Feature #8/#9):
- Soft reserve sizing guardrails (`MIN_SOL_FOR_FEES` + `CAPITAL_SOFT_RESERVE_SOL` + `CAPITAL_RETRY_BUFFER_PCT`) cap new entries before quote/submit.
- Optional per-hour entry throttle (`MAX_NEW_ENTRIES_PER_HOUR`) limits bursty new exposure.
- Incident playbook auto-enters degraded mode on restart/error patterns and auto-recovers after stable criteria.

Next (remaining hardening blocker):
- Complete key hygiene: once the bot has a 24h no-flap window, archive `keys/bot-keypair.json` offline via `./scripts/archive_plaintext_key_if_stable.sh`, then safely deploy the pending code-only patches (Telegram cooldown log rate-limit + config validation) via `./scripts/deploy_pending_after_key_archive.sh`.
