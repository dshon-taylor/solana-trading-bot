# RUNBOOK

Operator guide for production runtime.

## 1) Health commands

```bash
cd /Users/dshontaylor/solana-trading-bot
pm2 status
curl -sS http://127.0.0.1:8787/healthz | jq
npm run print:config
```

## 2) Trading controls (no restart)

Telegram:

- `/status`
- `/positions`
- `/diag`
- `/halt` (pause new entries)
- `/resume` (allow new entries)

Keep entries halted whenever stability is unclear.

## 3) Current pipeline behavior

`scanner -> watchlist -> momentum -> confirm continuation -> attempt -> position manager`

- Momentum is proposal stage.
- Confirm continuation is truth gate.
- Confirm is WS-first (`ws_trade`, then `ws_ohlcv`, then snapshot fallback).
- With `CONFIRM_CONTINUATION_PASS_REQUIRES_LIVE_SOURCE=true`, pass requires live source.

## 4) Confirm-stage WS checks

If confirm pass rate drops unexpectedly:

1. Check config:
   - `CONFIRM_CONTINUATION_ACTIVE=true`
   - `BIRDEYE_WS_ENABLED=true`
   - `CONFIRM_CONTINUATION_PASS_REQUIRES_LIVE_SOURCE=true`
2. Check diag counters:
   - `continuationSelectedTradeReads`
   - `continuationSelectedOhlcvReads`
   - `continuationLiveSourceBlockedAtRunup`
   - `continuationLiveSourceBlockCount`
3. If `liveSourceBlockCount` is high, review WS freshness (`CONFIRM_CONTINUATION_WS_FRESH_MS`) and subscription saturation (`BIRDEYE_WS_MAX_SUBS`).

## 5) Common recovery steps

```bash
pm2 logs solana-momentum-bot --lines 200
./scripts/preflight_live.sh
```

If unstable and you need to pause entries immediately:

```bash
pm2 stop solana-momentum-bot
```

## 6) Replay / analytics quick commands

```bash
npm run summarize:attempts
npm run summarize:lifecycle -- --since-hours 168
npm run replay:historical -- --days 7
```

## 7) Security note

Prefer encrypted wallet loading (`SOPS_WALLET_FILE`) and avoid plaintext key material.
