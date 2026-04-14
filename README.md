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

- [RUNBOOK.md](RUNBOOK.md)
- [DEPLOY_WORKFLOW.md](DEPLOY_WORKFLOW.md)
- [LASERSTREAM_STAGING_RUNBOOK.md](LASERSTREAM_STAGING_RUNBOOK.md)
- [TRADING_LEARNINGS.md](TRADING_LEARNINGS.md)

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

Telegram controls: `/status`, `/positions`, `/diag`, `/halt`, `/resume`.

## Security note

Prefer encrypted wallet loading (`SOPS_WALLET_FILE`) over plaintext env secrets.
