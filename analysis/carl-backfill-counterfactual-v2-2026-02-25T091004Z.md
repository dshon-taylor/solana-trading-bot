# Candle Carl backfill counterfactual v2 (non-fill reason inference)

Generated: 2026-02-25T09:10:04.559Z
Window start: 2026-02-18T09:10:02.409Z
Window end: 2026-02-25T09:10:02.409Z

## Profile used (same trigger as v1)
- entry: ret15 >= 3.00%, ret5 >= 1.00%, greensLast5 >= 2
- cooldown considered for collision flag: 180s
- exit proxy (for context only): stop-at-entry 0.05%, trail activate 12.00%, trail distance 12.00%
- horizon: 24h

## Coverage
- candidate files scanned: 2
- candidate rows scanned / usable-price rows: 94,622 / 21,120
- candidate days in window: 2026-02-24, 2026-02-25
- track files scanned: 162 | usable track rows: 3,120
- track days in window: 2026-02-25
- unique mints with candidate price series: 139
- mints with enough samples for momentum check: 126
- would-enter events (raw, before skipping cooldown): 1,406

## Non-fill reason summary (inferred)
| reason | count | confidence split (H/M/L) |
|---|---:|---|
| cooldown collision | 929 | 929/0/0 |
| momentum gate not live at tick (sampling drift) | 317 | 0/0/317 |
| data insufficiency/unknown | 91 | 0/36/55 |
| slippage/impact constraint likely | 40 | 0/21/19 |
| route/quote unavailable | 29 | 0/0/29 |
| execution gate/risk gate paused | 0 | 0/0/0 |

### Confidence notes
- **High**: direct rule evidence (e.g., cooldown collision, explicit gate-disabled record near timestamp).
- **Medium**: nearby candidate reason hints (e.g., noPair/momentum(false)/marketData low confidence) or strong adverse micro-move evidence.
- **Low**: heuristic fallback (sampling gaps, missing track artifact, limited contextual records).

## First 60 would-enter events with inferred non-fill reason
| entryT | mint | symbol | ret15 | ret5 | cooldown? | inferred reason | conf | notes |
|---|---|---:|---:|---:|---:|---|---|---|
| 2026-02-24T06:16:45.877Z | BwUrTqcaoJUVnKTGPZk7k4iiSdTUeFSQKBh7f8rtpump | RIZZTER | 3.31% | 3.31% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=16s next=939s |
| 2026-02-24T09:41:39.129Z | GFAnZrFVCEqe4CDrabgANk2u8bik4YAEemMngMA2pump | Gaper | 8.79% | 8.79% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=940s |
| 2026-02-24T09:41:39.466Z | 2kTe6pJn9d2kANXYmQch16NvzBmA2xpPzJoMFHrwpump | Octpus | 14.82% | 14.82% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=940s |
| 2026-02-24T09:57:39.637Z | 2kTe6pJn9d2kANXYmQch16NvzBmA2xpPzJoMFHrwpump | Octpus | 18.04% | 18.04% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=923s |
| 2026-02-24T10:13:23.459Z | CrgunuokrSoXBUiAUaqnWFUHefBgAStqdtQK9jMYpump | Zoe | 94.88% | 94.88% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=936s |
| 2026-02-24T10:29:19.053Z | 3reTzfqE1LkGsXFmi3oNtGSsYwnXZs6sPYtQapTvpump | MARIOCOIN | 3.62% | 3.62% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=929s |
| 2026-02-24T10:29:19.400Z | 84yCF7hyUuRNAra9BjFHVDpnRdGXmfsV2emyZwLjpump | house | 3.07% | 3.07% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=929s |
| 2026-02-24T10:45:07.956Z | 3reTzfqE1LkGsXFmi3oNtGSsYwnXZs6sPYtQapTvpump | MARIOCOIN | 8.08% | 8.08% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=940s |
| 2026-02-24T10:45:08.380Z | GFAnZrFVCEqe4CDrabgANk2u8bik4YAEemMngMA2pump | Gaper | 6.01% | 6.01% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=941s |
| 2026-02-24T11:01:08.404Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | 4.17% | 4.17% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=937s |
| 2026-02-24T11:17:07.100Z | J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump | TripleT | 6.22% | 6.22% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=938s |
| 2026-02-24T11:17:07.210Z | YPkpfqP2JcECcRFkoennoQ2e75ancC2MzGEBZdmpump | Volume | 4.44% | 4.44% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=938s |
| 2026-02-24T11:33:04.242Z | 6y27p6n9XiD3BTqDbJXcpUUJ96K57wjgwgknitgwpump | GIKO | 5.88% | 5.88% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=21s next=940s |
| 2026-02-24T12:04:45.787Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | 3.03% | 3.03% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=943s |
| 2026-02-24T12:20:49.523Z | J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump | TripleT | 7.48% | 7.48% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=19s next=925s |
| 2026-02-24T13:07:59.150Z | AGj48tqewsFL8fr7cRuqCQCY26oK89VsSMY7XWk8pump | Bits | 5.19% | 5.19% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=928s |
| 2026-02-24T13:23:47.754Z | 84yCF7hyUuRNAra9BjFHVDpnRdGXmfsV2emyZwLjpump | house | 4.62% | 4.62% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=939s |
| 2026-02-24T14:26:55.820Z | H7noGdq7WnvbfdgnZzwYtRdZFCADe5rivUjuiofKpump | RETURN | 4.78% | 4.78% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=923s |
| 2026-02-24T14:26:56.657Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | 6.03% | 6.03% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=20s next=922s |
| 2026-02-24T14:42:41.571Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 5.10% | 5.10% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=22s next=940s |
| 2026-02-24T15:30:07.058Z | AGj48tqewsFL8fr7cRuqCQCY26oK89VsSMY7XWk8pump | Bits | 12.03% | 12.03% | no | momentum gate not live at tick (sampling drift) | low | large sample gap prev=21s next=930s |
| 2026-02-24T15:46:10.567Z | BKwSZd5tUFC1SudnHbhjmqJ6Nk8n5vz1wVphb7Mupump | SEAGULL | 3.29% | 3.29% | no | route/quote unavailable | low | candidate reason=marketData(lowConfidence); no track artifact for mint/day |
| 2026-02-24T15:46:32.084Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | 3.44% | 3.44% | no | data insufficiency/unknown | medium | candidate reason=marketData(lowConfidence) |
| 2026-02-24T15:46:32.084Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 4.18% | 4.18% | no | data insufficiency/unknown | medium | candidate reason=marketData(lowConfidence) |
| 2026-02-24T15:46:32.084Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 4.00% | 4.00% | no | data insufficiency/unknown | medium | candidate reason=marketData(lowConfidence) |
| 2026-02-24T15:46:32.085Z | BKwSZd5tUFC1SudnHbhjmqJ6Nk8n5vz1wVphb7Mupump | SEAGULL | 3.29% | 3.29% | yes | cooldown collision | high | prev event 22s ago (< cooldown 180s) |
| 2026-02-24T15:46:49.916Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | 6.12% | 6.12% | no | data insufficiency/unknown | medium | candidate reason=marketData(lowConfidence) |
| 2026-02-24T15:46:49.916Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 5.89% | 5.89% | yes | cooldown collision | high | prev event 18s ago (< cooldown 180s) |
| 2026-02-24T15:46:49.917Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | 3.74% | 3.74% | yes | cooldown collision | high | prev event 18s ago (< cooldown 180s) |
| 2026-02-24T15:46:49.917Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 5.47% | 5.47% | yes | cooldown collision | high | prev event 18s ago (< cooldown 180s) |
| 2026-02-24T15:47:11.500Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | 5.71% | 5.71% | yes | cooldown collision | high | prev event 22s ago (< cooldown 180s) |
| 2026-02-24T15:47:11.500Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 5.47% | 5.47% | yes | cooldown collision | high | prev event 22s ago (< cooldown 180s) |
| 2026-02-24T15:47:11.500Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 5.89% | 5.89% | yes | cooldown collision | high | prev event 22s ago (< cooldown 180s) |
| 2026-02-24T15:47:11.501Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | 3.74% | 3.74% | yes | cooldown collision | high | prev event 22s ago (< cooldown 180s) |
| 2026-02-24T15:47:11.501Z | BKwSZd5tUFC1SudnHbhjmqJ6Nk8n5vz1wVphb7Mupump | SEAGULL | 4.55% | 4.55% | yes | cooldown collision | high | prev event 39s ago (< cooldown 180s) |
| 2026-02-24T15:47:30.628Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 6.48% | 6.48% | yes | cooldown collision | high | prev event 19s ago (< cooldown 180s) |
| 2026-02-24T15:47:30.628Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 7.00% | 7.00% | yes | cooldown collision | high | prev event 19s ago (< cooldown 180s) |
| 2026-02-24T15:47:30.629Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | 8.22% | 8.22% | yes | cooldown collision | high | prev event 19s ago (< cooldown 180s) |
| 2026-02-24T15:47:30.630Z | 46WHMi7xeQbYocfot9MQLG2gdVQj56bC1JQwJ5kfpump | Nori | 4.19% | 4.19% | no | route/quote unavailable | low | candidate reason=marketData(lowConfidence); no track artifact for mint/day |
| 2026-02-24T15:47:50.559Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 6.48% | 6.48% | yes | cooldown collision | high | prev event 20s ago (< cooldown 180s) |
| 2026-02-24T15:47:50.559Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 7.00% | 7.00% | yes | cooldown collision | high | prev event 20s ago (< cooldown 180s) |
| 2026-02-24T15:47:50.560Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | 8.22% | 8.22% | yes | cooldown collision | high | prev event 20s ago (< cooldown 180s) |
| 2026-02-24T15:47:50.561Z | 46WHMi7xeQbYocfot9MQLG2gdVQj56bC1JQwJ5kfpump | Nori | 4.63% | 4.63% | yes | cooldown collision | high | prev event 20s ago (< cooldown 180s) |
| 2026-02-24T15:48:10.095Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 7.46% | 7.46% | yes | cooldown collision | high | prev event 20s ago (< cooldown 180s) |
| 2026-02-24T15:48:10.097Z | 46WHMi7xeQbYocfot9MQLG2gdVQj56bC1JQwJ5kfpump | Nori | 4.63% | 4.63% | yes | cooldown collision | high | prev event 20s ago (< cooldown 180s) |
| 2026-02-24T15:48:29.142Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | 8.22% | 8.22% | yes | cooldown collision | high | prev event 39s ago (< cooldown 180s) |
| 2026-02-24T15:48:29.142Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 10.74% | 10.74% | yes | cooldown collision | high | prev event 19s ago (< cooldown 180s) |
| 2026-02-24T15:48:29.142Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 4.00% | 4.00% | yes | cooldown collision | high | prev event 39s ago (< cooldown 180s) |
| 2026-02-24T15:48:29.144Z | 46WHMi7xeQbYocfot9MQLG2gdVQj56bC1JQwJ5kfpump | Nori | 9.03% | 9.03% | yes | cooldown collision | high | prev event 19s ago (< cooldown 180s) |
| 2026-02-24T15:48:51.069Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | 7.53% | 7.53% | yes | cooldown collision | high | prev event 100s ago (< cooldown 180s) |
| 2026-02-24T15:48:51.069Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 10.74% | 10.74% | yes | cooldown collision | high | prev event 22s ago (< cooldown 180s) |
| 2026-02-24T15:48:51.070Z | 46WHMi7xeQbYocfot9MQLG2gdVQj56bC1JQwJ5kfpump | Nori | 9.03% | 9.03% | yes | cooldown collision | high | prev event 22s ago (< cooldown 180s) |
| 2026-02-24T15:49:11.108Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | 7.53% | 7.53% | yes | cooldown collision | high | prev event 20s ago (< cooldown 180s) |
| 2026-02-24T15:49:11.108Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 9.02% | 9.02% | yes | cooldown collision | high | prev event 20s ago (< cooldown 180s) |
| 2026-02-24T15:49:32.752Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 12.55% | 12.55% | yes | cooldown collision | high | prev event 64s ago (< cooldown 180s) |
| 2026-02-24T15:49:32.754Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 14.10% | 14.10% | yes | cooldown collision | high | prev event 22s ago (< cooldown 180s) |
| 2026-02-24T15:49:32.755Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | 5.64% | 5.64% | yes | cooldown collision | high | prev event 64s ago (< cooldown 180s) |
| 2026-02-24T15:50:14.046Z | 6YF3vQtLRC4CGgwbu8DLGDVoWohPuQ5P1YYvK7au5twg | MENCHO | 29.30% | 29.30% | no | route/quote unavailable | low | candidate reason=marketData(lowConfidence); no track artifact for mint/day |
| 2026-02-24T15:50:14.047Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | 5.77% | 5.77% | yes | cooldown collision | high | prev event 41s ago (< cooldown 180s) |
| 2026-02-24T15:50:14.047Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 13.44% | 13.44% | yes | cooldown collision | high | prev event 41s ago (< cooldown 180s) |

## Context: proxy best/worst outcomes (not fill-realized)
### Best 10 by proxy PnL
| entryT | mint | symbol | proxy pnl | inferred reason | conf |
|---|---|---:|---:|---|---|
| 2026-02-24T18:50:42.501Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 1144.77% | momentum gate not live at tick (sampling drift) | low |
| 2026-02-24T18:58:24.292Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 1032.44% | momentum gate not live at tick (sampling drift) | low |
| 2026-02-24T14:42:41.571Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 341.08% | momentum gate not live at tick (sampling drift) | low |
| 2026-02-25T02:11:03.605Z | G4933wUYH4SdUzS1UDwCx6kXRPFJPuV9dUDrH9FCpump | Clawcoin | 327.84% | momentum gate not live at tick (sampling drift) | low |
| 2026-02-25T02:13:37.217Z | G4933wUYH4SdUzS1UDwCx6kXRPFJPuV9dUDrH9FCpump | Clawcoin | 265.95% | cooldown collision | high |
| 2026-02-25T02:08:25.223Z | 6dQD8ALWdkFiD77D34qzUHFuifpaCnoWAEGRgvcZpump | GOLDENERA | 143.89% | momentum gate not live at tick (sampling drift) | low |
| 2026-02-25T02:11:03.604Z | 6dQD8ALWdkFiD77D34qzUHFuifpaCnoWAEGRgvcZpump | GOLDENERA | 133.08% | cooldown collision | high |
| 2026-02-25T02:13:37.216Z | 6dQD8ALWdkFiD77D34qzUHFuifpaCnoWAEGRgvcZpump | GOLDENERA | 129.20% | cooldown collision | high |
| 2026-02-24T11:01:08.404Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | 120.86% | momentum gate not live at tick (sampling drift) | low |
| 2026-02-25T02:16:11.413Z | 6dQD8ALWdkFiD77D34qzUHFuifpaCnoWAEGRgvcZpump | GOLDENERA | 119.46% | cooldown collision | high |

### Worst 10 by proxy PnL
| entryT | mint | symbol | proxy pnl | inferred reason | conf |
|---|---|---:|---:|---|---|
| 2026-02-24T15:47:30.628Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | -0.05% | cooldown collision | high |
| 2026-02-24T15:47:50.559Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | -0.05% | cooldown collision | high |
| 2026-02-25T07:53:53.321Z | H7noGdq7WnvbfdgnZzwYtRdZFCADe5rivUjuiofKpump | RETURN | -0.05% | cooldown collision | high |
| 2026-02-25T04:15:23.817Z | J5yRdGvVc9GTC6YgebYidfF3ZPNjJKgd7ao2VbwUpump | Buppin | -0.05% | momentum gate not live at tick (sampling drift) | low |
| 2026-02-25T08:17:26.720Z | NV2RYH954cTJ3ckFUpvfqaQXU4ARqqDH3562nFSpump | Punch | -0.05% | momentum gate not live at tick (sampling drift) | low |
| 2026-02-25T08:19:42.623Z | NV2RYH954cTJ3ckFUpvfqaQXU4ARqqDH3562nFSpump | Punch | -0.05% | cooldown collision | high |
| 2026-02-24T17:03:12.019Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | -0.05% | data insufficiency/unknown | low |
| 2026-02-24T17:03:29.215Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | -0.05% | cooldown collision | high |
| 2026-02-24T16:50:23.522Z | H7noGdq7WnvbfdgnZzwYtRdZFCADe5rivUjuiofKpump | RETURN | -0.05% | cooldown collision | high |
| 2026-02-25T08:34:40.217Z | H7noGdq7WnvbfdgnZzwYtRdZFCADe5rivUjuiofKpump | RETURN | -0.05% | cooldown collision | high |

## Reproducibility
```bash
cd /home/dshontaylor/.openclaw/workspace/trading-bot
CARL_LOOKBACK_DAYS=7 node scripts/carl_backfill_counterfactual_v2.mjs
```

## Caveats
- Inference is best-effort from sampled candidate/track artifacts; no full orderbook or exact quote/fill telemetry.
- Reason assignment is single-label per event for readability; multiple contributing factors can coexist.
- execution gate/risk gate paused only reaches high confidence when explicit nearby gate-disabled records exist.
- Slippage/impact category is heuristic and may over/under-tag highly volatile tokens.
