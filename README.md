# Solana Trading Bot

Live Solana momentum bot with staged gating, WS-first confirm, and operator diagnostics.

## Current architecture

`source discovery -> watchlist -> momentum -> confirm continuation -> attempt/execute -> position manager`

- **Momentum**: weighted score + hard safety guards (proposal stage).
- **Confirm continuation**: truth gate; short window, runup + trend validation, live-source preference.
- **Execution**: quote/impact/capital/risk checks before swap.
- **Position manager**: stop/trailing/exit management.

## WebSocket model

- BirdEye WS is a **single runtime client** with multiplexed mint subscriptions.
- Confirm and late-pipeline mints are prioritized via `birdeye:sub:priority:*`.
- Confirm continuation reads price in this order:
  1. `ws_trade`
  2. `ws_ohlcv`
  3. snapshot fallback
- If `CONFIRM_CONTINUATION_PASS_REQUIRES_LIVE_SOURCE=true`, a pass requires live WS source.

## Key runtime docs

- [docs/RUNBOOK.md](docs/RUNBOOK.md)
- [docs/DEPLOY_WORKFLOW.md](docs/DEPLOY_WORKFLOW.md)
- [docs/LASERSTREAM_STAGING_RUNBOOK.md](docs/LASERSTREAM_STAGING_RUNBOOK.md)
- [docs/TRADING_LEARNINGS.md](docs/TRADING_LEARNINGS.md)

## Root folder map

- [src/](src/) — runtime code
- [docs/](docs/) — operator and architecture docs
- [scripts/](scripts/) — operational/research tooling
- [state/](state/) — runtime mutable files and ledgers
- [analysis/](analysis/) — generated analysis artifacts

## Quick start

```bash
npm install
cp .env.example .env
npm run check
npm run test
npm start
```

## Operator quick checks

```bash
npm run print:config
npm run summarize:attempts
npm run summarize:lifecycle -- --since-hours 168
```

## Canonical ops commands

```bash
npm run deploy:live
npm run push:dev -- "your commit message"
npm run devnet:swap:test
```

Telegram controls: `/status`, `/positions`, `/diag`, `/halt`, `/resume`.

## Security note

Prefer encrypted wallet loading (`SOPS_WALLET_FILE`) over plaintext env secrets.
