# Candle Carl counterfactual v3 (intuitive PnL view)

Generated: 2026-02-25T09:24:15.756Z
Window: 2026-02-18T09:24:14.323Z → 2026-02-25T09:24:14.323Z (7d)

## Live-rule profile used
- Entry trigger: ret15 >= 3.00%, ret5 >= 1.00%, greensLast5 >= 2
- Exit proxy: stop-at-entry 0.05%, trail activate 12.00%, trail distance 12.00%, horizon 24h
- Position sizing source: LIVE_MOMO_SIZE_MODE=percent
- Assumed SOLUSD for conversion: $82.52 (state/last_sol_price.json (coingecko))
- Assumed position used on each event: $20.00 (0.242365 SOL) [mode=percent => min((STARTING_CAPITAL_USDC/solUsd)*LIVE_MOMO_PCT_OF_PORTFOLIO, LIVE_MOMO_MAX_SOL_PER_TRADE)]
- Starting assumed capital: $100.00 (STARTING_CAPITAL_USDC)

## Summary totals
- Total entries: 1,433
- Wins / Losses / Flat: 158 / 1225 / 50
- Total PnL % (portfolio-style, vs starting capital): +1386.82%
- Total PnL % (sum of trade %s): +6934.10%
- Avg PnL % per trade: +4.84%
- Total PnL in USD: +$1386.82
- Total PnL in SOL: +16.805853 SOL
- Ending balance (assumed): $1486.82 (net +$1386.82)

## First 60 would-enter events (money terms)
| entryT | mint | symbol | pnl % | pnl USD | pnl SOL | assumed size | exit | inferred non-fill |
|---|---|---:|---:|---:|---:|---:|---|---|
| 2026-02-24T06:16:45.877Z | BwUrTqcaoJUVnKTGPZk7k4iiSdTUeFSQKBh7f8rtpump | RIZZTER | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T09:41:39.129Z | GFAnZrFVCEqe4CDrabgANk2u8bik4YAEemMngMA2pump | Gaper | +40.57% | +$8.11 | +0.098330 SOL | $20.00 / 0.2424 SOL | trailingStop | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T09:41:39.466Z | 2kTe6pJn9d2kANXYmQch16NvzBmA2xpPzJoMFHrwpump | Octpus | +98.99% | +$19.80 | +0.239911 SOL | $20.00 / 0.2424 SOL | trailingStop | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T09:57:39.637Z | 2kTe6pJn9d2kANXYmQch16NvzBmA2xpPzJoMFHrwpump | Octpus | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T10:13:23.459Z | CrgunuokrSoXBUiAUaqnWFUHefBgAStqdtQK9jMYpump | Zoe | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T10:29:19.053Z | 3reTzfqE1LkGsXFmi3oNtGSsYwnXZs6sPYtQapTvpump | MARIOCOIN | +69.15% | +$13.83 | +0.167589 SOL | $20.00 / 0.2424 SOL | trailingStop | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T10:29:19.400Z | 84yCF7hyUuRNAra9BjFHVDpnRdGXmfsV2emyZwLjpump | house | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T10:45:07.956Z | 3reTzfqE1LkGsXFmi3oNtGSsYwnXZs6sPYtQapTvpump | MARIOCOIN | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T10:45:08.380Z | GFAnZrFVCEqe4CDrabgANk2u8bik4YAEemMngMA2pump | Gaper | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T11:01:08.404Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | +120.86% | +$24.17 | +0.292914 SOL | $20.00 / 0.2424 SOL | trailingStop | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T11:17:07.100Z | J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump | TripleT | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T11:17:07.210Z | YPkpfqP2JcECcRFkoennoQ2e75ancC2MzGEBZdmpump | Volume | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T11:33:04.242Z | 6y27p6n9XiD3BTqDbJXcpUUJ96K57wjgwgknitgwpump | GIKO | +5.10% | +$1.02 | +0.012350 SOL | $20.00 / 0.2424 SOL | horizon | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T12:04:45.787Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | +82.33% | +$16.47 | +0.199537 SOL | $20.00 / 0.2424 SOL | trailingStop | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T12:20:49.523Z | J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump | TripleT | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T13:07:59.150Z | AGj48tqewsFL8fr7cRuqCQCY26oK89VsSMY7XWk8pump | Bits | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T13:23:47.754Z | 84yCF7hyUuRNAra9BjFHVDpnRdGXmfsV2emyZwLjpump | house | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T14:26:55.820Z | H7noGdq7WnvbfdgnZzwYtRdZFCADe5rivUjuiofKpump | RETURN | +0.00% | +$0.00 | +0.000000 SOL | $20.00 / 0.2424 SOL | stopAtEntry | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T14:26:56.657Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | +20.69% | +$4.14 | +0.050147 SOL | $20.00 / 0.2424 SOL | trailingStop | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T14:42:41.571Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | +341.08% | +$68.22 | +0.826670 SOL | $20.00 / 0.2424 SOL | trailingStop | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T15:30:07.058Z | AGj48tqewsFL8fr7cRuqCQCY26oK89VsSMY7XWk8pump | Bits | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | momentum gate not live at tick (sampling drift) (low) |
| 2026-02-24T15:46:10.567Z | BKwSZd5tUFC1SudnHbhjmqJ6Nk8n5vz1wVphb7Mupump | SEAGULL | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | route/quote unavailable (low) |
| 2026-02-24T15:46:32.084Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | data insufficiency/unknown (medium) |
| 2026-02-24T15:46:32.084Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | data insufficiency/unknown (medium) |
| 2026-02-24T15:46:32.084Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | data insufficiency/unknown (medium) |
| 2026-02-24T15:46:32.085Z | BKwSZd5tUFC1SudnHbhjmqJ6Nk8n5vz1wVphb7Mupump | SEAGULL | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:46:49.916Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | data insufficiency/unknown (medium) |
| 2026-02-24T15:46:49.916Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:46:49.917Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:46:49.917Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:47:11.500Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:47:11.500Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:47:11.500Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:47:11.501Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:47:11.501Z | BKwSZd5tUFC1SudnHbhjmqJ6Nk8n5vz1wVphb7Mupump | SEAGULL | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:47:30.628Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:47:30.628Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:47:30.629Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:47:30.630Z | 46WHMi7xeQbYocfot9MQLG2gdVQj56bC1JQwJ5kfpump | Nori | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | route/quote unavailable (low) |
| 2026-02-24T15:47:50.559Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:47:50.559Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:47:50.560Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:47:50.561Z | 46WHMi7xeQbYocfot9MQLG2gdVQj56bC1JQwJ5kfpump | Nori | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:48:10.095Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:48:10.097Z | 46WHMi7xeQbYocfot9MQLG2gdVQj56bC1JQwJ5kfpump | Nori | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:48:29.142Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:48:29.142Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:48:29.142Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | +0.00% | +$0.00 | +0.000000 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:48:29.144Z | 46WHMi7xeQbYocfot9MQLG2gdVQj56bC1JQwJ5kfpump | Nori | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:48:51.069Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:48:51.069Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:48:51.070Z | 46WHMi7xeQbYocfot9MQLG2gdVQj56bC1JQwJ5kfpump | Nori | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:49:11.108Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:49:11.108Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:49:32.752Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:49:32.754Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:49:32.755Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:50:14.046Z | 6YF3vQtLRC4CGgwbu8DLGDVoWohPuQ5P1YYvK7au5twg | MENCHO | +0.00% | +$0.00 | +0.000000 SOL | $20.00 / 0.2424 SOL | horizon | route/quote unavailable (low) |
| 2026-02-24T15:50:14.047Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |
| 2026-02-24T15:50:14.047Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | -0.05% | -$0.01 | -0.000121 SOL | $20.00 / 0.2424 SOL | stopAtEntry | cooldown collision (high) |

## Reproducibility
```bash
cd /home/dshontaylor/.openclaw/workspace/trading-bot
CARL_LOOKBACK_DAYS=7 node scripts/backfill/carl_backfill_counterfactual_v3.mjs
# optional override for conversion basis: CARL_SOL_USD=<price>
```

## Caveats (short)
- Counterfactual only: sampled candidate/track data, no exact orderbook/fill telemetry.
- USD/SOL PnL uses one assumed position size from current env rules; real live size can vary per-wallet balance and runtime checks.
- Fees, latency, route failures, and slippage are not applied to PnL math (reason labels remain best-effort inference).
