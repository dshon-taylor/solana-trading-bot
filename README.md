# Solana Trading Bot (runner-capture mode)

This repository runs a live daemon with Telegram controls and first-class diagnostics.

## Pipeline (current truth)

`scanner → watchlist/snapshot → momentum gate → confirm continuation audition → attempt/execute → position manager`

- Scanner discovers routeable candidates.
- Watchlist tracks them with refreshed market snapshots.
- Momentum is a fast detector, not final truth.
- Confirm is the truth gate for immediate continuation.
- Attempt executes through Jupiter route sanity + capital checks.
- Position manager handles stops/trailing/exits.

## Strategy intent (current)

This system is tuned for runner capture, not “clean setup perfection”.

### Momentum stage

- Purpose: surface potential bursts early.
- Uses weighted score + hard safety guards.
- Weak tx/wallet/volume generally influence score more than hard-fail.
- Hard guards still reject thin/chaotic/risk conditions.

### Confirm stage (most important)

- 15-second continuation audition.
- WS-first tracking with snapshot fallback.
- Pass on immediate runup (~+1.5%).
- Fail on hard dip (~-1.5%).
- Fail at timeout if no continuation burst (`windowExpiredStall` / `windowExpiredWeak`).
- Retry only after cooldown + measurable improvement for stall failures.

Net: momentum proposes; confirm proves.

## Risk and execution controls

Safety rails remain enabled:

- liquidity/impact/route sanity
- capital reserve checks
- non-tradable token handling
- position stop/trailing enforcement

In runner mode, confirm liquidity checks are biased toward relative degradation (avoid over-blocking already-qualified names unless liquidity materially worsens).

## Observability philosophy

Diagnostics are first-class and compact.

- `/diag`, `/diag momentum`, `/diag confirm`, `/diag execution`, `/diag scanner` are operator truth views.
- Durability source: `state/diag_events.jsonl` with compact runtime window hydration.
- Default retention: 90 days, configurable.

Diag retention knobs:

- `DIAG_RETENTION_DAYS`
- `DIAG_MAX_WINDOW_MS` (legacy override)
- `DIAG_HYDRATE_MAX_LINES`

After config changes, restart and verify using `/config` and `/diag`.

## Runtime docs

- [RUNBOOK.md](RUNBOOK.md)
- [DEPLOY_WORKFLOW.md](DEPLOY_WORKFLOW.md)
- [PROD_HARDENING.md](PROD_HARDENING.md)
- [PROD_HARDENING_STATUS.md](PROD_HARDENING_STATUS.md)
- [trading.md](trading.md)

## Quick checks

- `npm run check`
- `npm run test`
- `npm run print:config`
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

This bot is operating as a PM2-managed daemon with:

- scanner/watchlist/confirm/attempt pipeline in production
- position manager + trailing/exit safety
- route/capital/risk guardrails
- Telegram controls + compact diagnostic views
- durable diagnostics and retention controls

For active operational status and procedures, use:

- [RUNBOOK.md](RUNBOOK.md)
- [PROD_HARDENING_STATUS.md](PROD_HARDENING_STATUS.md)
