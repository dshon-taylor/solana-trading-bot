# Aggressive Autotune Controller (10–15m loop)

Script: `scripts/aggressive_autotune_controller.mjs`

## What it does each run
1. Reads current diagnostics proxy from:
   - `state/state.json` (`debug.last` rejection taxonomy)
   - `state/pm2-out-0.log` and `state/pm2-err-0.log` (recent rate-limit/swap-error signals)
2. Computes bounded step decision:
   - **Escalate +1 step** if attempts appear near-zero and failures are not spiking.
   - **Backoff -1 step** if swap errors / rate limits spike.
   - Else hold.
3. Tunes aggressive knobs (bounded ladders):
   - `LIVE_PARALLEL_QUOTE_FANOUT_N`
   - `NO_PAIR_RETRY_ATTEMPTS`
   - `NO_PAIR_RETRY_BASE_MS`
   - `PAPER_ENTRY_COOLDOWN_MS`
   - `PAPER_ENTRY_RET_15M_PCT`
   - `PAPER_ENTRY_RET_5M_PCT`
   - `PAPER_ENTRY_GREEN_LAST5`
   - `LIVE_REJECT_RECHECK_BURST_ATTEMPTS`
   - `LIVE_REJECT_RECHECK_BURST_DELAY_MS`
4. Appends decision + Telegram-ready summary block to:
   - `analysis/aggressive_autotune_log.md`

## Modes
- Dry run (no `.env` changes):
  - `node scripts/aggressive_autotune_controller.mjs --mode dry-run --window-min 20`
- Apply (writes `.env`):
  - `node scripts/aggressive_autotune_controller.mjs --mode apply --window-min 20`

NPM aliases:
- `npm run autotune:aggressive`
- `npm run autotune:aggressive:apply`

## Manual run now (apply)
```bash
cd /home/dshontaylor/.openclaw/workspace/trading-bot
node scripts/aggressive_autotune_controller.mjs --mode apply --window-min 20
# then restart process to pick up env changes
pm2 restart solana-momentum-bot
```

## Proposed-only cron snippet (every 15 min)
> Optional; only while running aggressive push.

```cron
*/15 * * * * cd /home/dshontaylor/.openclaw/workspace/trading-bot && /usr/bin/node scripts/aggressive_autotune_controller.mjs --mode apply --window-min 20 >> analysis/aggressive_autotune_cron.log 2>&1 && /usr/bin/pm2 restart solana-momentum-bot >/dev/null 2>&1
```

## First 60-minute recommended sequence
- **T+0 min:** run apply once, restart PM2.
- **T+15 min:** run apply again. If still near-zero attempts and no error spike, it will escalate one more step.
- **T+30 min:** run apply again. Expect another +1 step only if still near-zero.
- **T+45 min:** run apply again. If rate-limit/swap-error spikes, controller backoffs by 1 step.
- **T+60 min:** run apply, review `analysis/aggressive_autotune_log.md` top rejects + safety signals, decide whether to continue aggressive push.
