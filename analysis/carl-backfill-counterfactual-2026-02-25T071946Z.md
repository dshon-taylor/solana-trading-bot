# Candle Carl backfill + 7-day counterfactual (best-effort)

Generated: 2026-02-25T07:19:46.303Z
Window start: 2026-02-18T07:19:44.687Z
Window end: 2026-02-25T07:19:44.687Z

## Profile used (current loose momentum intent)
- entry: ret15 >= 3.00%, ret5 >= 1.00%, greensLast5 >= 2
- cooldown: 180s
- exit: stop-at-entry buffer 0.05%, trail activate 12.00%, trail distance 12.00%
- simulation horizon per entry: 24h

## Backfill / reconstruction coverage
- candidates files scanned: 2
- candidate rows scanned/usable: 90,391 / 19,284
- candidate days with usable data: 2026-02-24, 2026-02-25
- track files scanned: 162
- track rows usable: 60
- track days with usable data: 2026-02-25
- unique mints with candidate time-series in window: 128
- mints with enough samples for momentum check: 115

## 7-day should-have-entered summary (counterfactual)
- candidate entries triggered: 520
- proxy PnL sum: 4791.41% | avg/trade: 9.21% | hit-rate: 12.9%
- exits: {"stopAtEntry":451,"trailingStop":52,"horizon":17}

### First 50 candidate entries (timestamp, mint, symbol, est pnl, exit)
| entryT | mint | symbol | ret15 | ret5 | pnl | exitReason |
|---|---|---:|---:|---:|---:|---|
| 2026-02-24T06:16:45.877Z | BwUrTqcaoJUVnKTGPZk7k4iiSdTUeFSQKBh7f8rtpump | RIZZTER | 3.31% | 3.31% | -0.05% | stopAtEntry |
| 2026-02-24T09:41:39.129Z | GFAnZrFVCEqe4CDrabgANk2u8bik4YAEemMngMA2pump | Gaper | 8.79% | 8.79% | 40.57% | trailingStop |
| 2026-02-24T09:41:39.466Z | 2kTe6pJn9d2kANXYmQch16NvzBmA2xpPzJoMFHrwpump | Octpus | 14.82% | 14.82% | 98.99% | trailingStop |
| 2026-02-24T09:57:39.637Z | 2kTe6pJn9d2kANXYmQch16NvzBmA2xpPzJoMFHrwpump | Octpus | 18.04% | 18.04% | -0.05% | stopAtEntry |
| 2026-02-24T10:13:23.459Z | CrgunuokrSoXBUiAUaqnWFUHefBgAStqdtQK9jMYpump | Zoe | 94.88% | 94.88% | -0.05% | stopAtEntry |
| 2026-02-24T10:29:19.053Z | 3reTzfqE1LkGsXFmi3oNtGSsYwnXZs6sPYtQapTvpump | MARIOCOIN | 3.62% | 3.62% | 69.15% | trailingStop |
| 2026-02-24T10:29:19.400Z | 84yCF7hyUuRNAra9BjFHVDpnRdGXmfsV2emyZwLjpump | house | 3.07% | 3.07% | -0.05% | stopAtEntry |
| 2026-02-24T10:45:07.956Z | 3reTzfqE1LkGsXFmi3oNtGSsYwnXZs6sPYtQapTvpump | MARIOCOIN | 8.08% | 8.08% | -0.05% | stopAtEntry |
| 2026-02-24T10:45:08.380Z | GFAnZrFVCEqe4CDrabgANk2u8bik4YAEemMngMA2pump | Gaper | 6.01% | 6.01% | -0.05% | stopAtEntry |
| 2026-02-24T11:01:08.404Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | 4.17% | 4.17% | 120.86% | trailingStop |
| 2026-02-24T11:17:07.100Z | J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump | TripleT | 6.22% | 6.22% | -0.05% | stopAtEntry |
| 2026-02-24T11:17:07.210Z | YPkpfqP2JcECcRFkoennoQ2e75ancC2MzGEBZdmpump | Volume | 4.44% | 4.44% | -0.05% | stopAtEntry |
| 2026-02-24T11:33:04.242Z | 6y27p6n9XiD3BTqDbJXcpUUJ96K57wjgwgknitgwpump | GIKO | 5.88% | 5.88% | 5.10% | horizon |
| 2026-02-24T12:04:45.787Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | 3.03% | 3.03% | 82.33% | trailingStop |
| 2026-02-24T12:20:49.523Z | J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump | TripleT | 7.48% | 7.48% | -0.05% | stopAtEntry |
| 2026-02-24T13:07:59.150Z | AGj48tqewsFL8fr7cRuqCQCY26oK89VsSMY7XWk8pump | Bits | 5.19% | 5.19% | -0.05% | stopAtEntry |
| 2026-02-24T13:23:47.754Z | 84yCF7hyUuRNAra9BjFHVDpnRdGXmfsV2emyZwLjpump | house | 4.62% | 4.62% | -0.05% | stopAtEntry |
| 2026-02-24T14:26:55.820Z | H7noGdq7WnvbfdgnZzwYtRdZFCADe5rivUjuiofKpump | RETURN | 4.78% | 4.78% | 0.00% | stopAtEntry |
| 2026-02-24T14:26:56.657Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | 6.03% | 6.03% | 20.69% | trailingStop |
| 2026-02-24T14:42:41.571Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 5.10% | 5.10% | 341.08% | trailingStop |
| 2026-02-24T15:30:07.058Z | AGj48tqewsFL8fr7cRuqCQCY26oK89VsSMY7XWk8pump | Bits | 12.03% | 12.03% | -0.05% | stopAtEntry |
| 2026-02-24T15:46:10.567Z | BKwSZd5tUFC1SudnHbhjmqJ6Nk8n5vz1wVphb7Mupump | SEAGULL | 3.29% | 3.29% | -0.05% | stopAtEntry |
| 2026-02-24T15:46:32.084Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | 3.44% | 3.44% | -0.05% | stopAtEntry |
| 2026-02-24T15:46:32.084Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 4.18% | 4.18% | -0.05% | stopAtEntry |
| 2026-02-24T15:46:32.084Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 4.00% | 4.00% | -0.05% | stopAtEntry |
| 2026-02-24T15:46:49.916Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | 6.12% | 6.12% | -0.05% | stopAtEntry |
| 2026-02-24T15:47:30.630Z | 46WHMi7xeQbYocfot9MQLG2gdVQj56bC1JQwJ5kfpump | Nori | 4.19% | 4.19% | -0.05% | stopAtEntry |
| 2026-02-24T15:49:32.752Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 12.55% | 12.55% | -0.05% | stopAtEntry |
| 2026-02-24T15:49:32.754Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 14.10% | 14.10% | -0.05% | stopAtEntry |
| 2026-02-24T15:49:32.755Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | 5.64% | 5.64% | -0.05% | stopAtEntry |
| 2026-02-24T15:50:14.046Z | 6YF3vQtLRC4CGgwbu8DLGDVoWohPuQ5P1YYvK7au5twg | MENCHO | 29.30% | 29.30% | 0.00% | horizon |
| 2026-02-24T15:50:32.756Z | BKwSZd5tUFC1SudnHbhjmqJ6Nk8n5vz1wVphb7Mupump | SEAGULL | 12.66% | 12.66% | -0.05% | stopAtEntry |
| 2026-02-24T15:50:56.431Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | 6.62% | 5.40% | -0.05% | stopAtEntry |
| 2026-02-24T15:51:37.851Z | 4fSWEw2wbYEUCcMtitzmeGUfqinoafXxkhqZrA9Gpump | Pigeon | 3.36% | 1.77% | -0.05% | stopAtEntry |
| 2026-02-24T15:52:00.331Z | 46WHMi7xeQbYocfot9MQLG2gdVQj56bC1JQwJ5kfpump | Nori | 23.05% | 31.45% | -0.05% | stopAtEntry |
| 2026-02-24T15:52:41.793Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 9.57% | 2.90% | -0.05% | stopAtEntry |
| 2026-02-24T15:53:42.413Z | GFAnZrFVCEqe4CDrabgANk2u8bik4YAEemMngMA2pump | Gaper | 6.31% | 6.31% | -0.05% | stopAtEntry |
| 2026-02-24T15:54:01.906Z | GPMKmRaHAiDt7a4Ys7xZ4P66xQHnqWeXuGTShySKpump | Duck | 3.24% | 3.24% | -0.05% | stopAtEntry |
| 2026-02-24T15:55:07.079Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | 6.78% | 2.62% | -0.05% | stopAtEntry |
| 2026-02-24T15:55:32.236Z | EahUihCyvsJVg8wWafXc5ytxaReFXms514wKvmBQcLAw | CLAW | 4.57% | 2.88% | -0.05% | stopAtEntry |
| 2026-02-24T15:55:54.761Z | 41HpD32jdC3JRVWDoD3j8rjHdNM4mjqmoSaCSZwdpump | NIGSOM | 17.06% | 17.06% | -0.05% | stopAtEntry |
| 2026-02-24T15:56:14.685Z | 4fSWEw2wbYEUCcMtitzmeGUfqinoafXxkhqZrA9Gpump | Pigeon | 10.37% | 8.78% | -0.05% | stopAtEntry |
| 2026-02-24T15:57:06.445Z | GPMKmRaHAiDt7a4Ys7xZ4P66xQHnqWeXuGTShySKpump | Duck | 27.76% | 24.26% | -0.05% | stopAtEntry |
| 2026-02-24T15:57:06.446Z | GDmSzyg3F3CqgusT4CcxhjaKKfaucN98L4EUePeqpump | PETAH | 4.37% | 4.37% | -0.05% | stopAtEntry |
| 2026-02-24T15:57:15.363Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 58.00% | 51.51% | -0.05% | stopAtEntry |
| 2026-02-24T15:57:15.363Z | ByPRjYBLskAca3sRhfaAA7ZYumG5bFLvE9xETWVdpump | ADHD | 52.69% | 52.69% | -0.05% | stopAtEntry |
| 2026-02-24T15:57:15.364Z | GFAnZrFVCEqe4CDrabgANk2u8bik4YAEemMngMA2pump | Gaper | 7.73% | 7.73% | 0.00% | stopAtEntry |
| 2026-02-24T15:57:51.629Z | 6ydMmFRaNt4AHBjgvSogbBvcxnTrX3QzUe2AEzVppump | Pippkin | 7.42% | 7.89% | -0.05% | stopAtEntry |
| 2026-02-24T16:00:05.043Z | EahUihCyvsJVg8wWafXc5ytxaReFXms514wKvmBQcLAw | CLAW | 10.73% | 9.19% | -0.05% | stopAtEntry |
| 2026-02-24T16:00:05.043Z | H7noGdq7WnvbfdgnZzwYtRdZFCADe5rivUjuiofKpump | RETURN | 12.36% | 29.32% | -0.05% | stopAtEntry |

### Best 10 estimated outcomes
| entryT | mint | symbol | pnl | maxRunup | exitReason |
|---|---|---:|---:|---:|---|
| 2026-02-24T18:50:42.501Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 1144.77% | 1314.52% | trailingStop |
| 2026-02-24T18:58:24.292Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | 1032.44% | 1186.87% | trailingStop |
| 2026-02-24T14:42:41.571Z | J6hFzNZ1yFFtwW4EPVejHJuSfWzpBq5msJfyhL55pump | Go-chan | 341.08% | 401.23% | trailingStop |
| 2026-02-25T02:11:03.605Z | G4933wUYH4SdUzS1UDwCx6kXRPFJPuV9dUDrH9FCpump | Clawcoin | 327.84% | 386.18% | trailingStop |
| 2026-02-25T02:08:25.223Z | 6dQD8ALWdkFiD77D34qzUHFuifpaCnoWAEGRgvcZpump | GOLDENERA | 143.89% | 177.15% | trailingStop |
| 2026-02-25T02:13:37.216Z | 6dQD8ALWdkFiD77D34qzUHFuifpaCnoWAEGRgvcZpump | GOLDENERA | 129.20% | 160.45% | trailingStop |
| 2026-02-24T11:01:08.404Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | 120.86% | 150.97% | trailingStop |
| 2026-02-24T09:41:39.466Z | 2kTe6pJn9d2kANXYmQch16NvzBmA2xpPzJoMFHrwpump | Octpus | 98.99% | 126.12% | trailingStop |
| 2026-02-25T02:08:25.220Z | 2JSSDkmY1m9A5kLtB2tDGMhcFEfWsq8ZpmVQzcFtpump | SPAWN | 94.80% | 121.37% | trailingStop |
| 2026-02-24T16:34:57.759Z | ByPRjYBLskAca3sRhfaAA7ZYumG5bFLvE9xETWVdpump | ADHD | 86.87% | 112.35% | trailingStop |

### Worst 10 estimated outcomes
| entryT | mint | symbol | pnl | maxDrawdown | exitReason |
|---|---|---:|---:|---:|---|
| 2026-02-25T04:15:23.817Z | J5yRdGvVc9GTC6YgebYidfF3ZPNjJKgd7ao2VbwUpump | Buppin | -0.05% | -28.06% | stopAtEntry |
| 2026-02-24T17:03:12.019Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | -0.05% | -0.28% | stopAtEntry |
| 2026-02-24T18:23:51.780Z | Br34SVc9DPCJtasCquNNcWznCNXp65NgMzpPP7i2pump | Adam | -0.05% | -3.04% | stopAtEntry |
| 2026-02-24T17:16:27.405Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | -0.05% | -2.62% | stopAtEntry |
| 2026-02-24T16:54:02.992Z | 4KVGATyKJNhm8y8afj5314rNAkB9MZGJVDE5cCKTpump | KOL | -0.05% | -11.25% | stopAtEntry |
| 2026-02-25T04:35:55.526Z | Ccybm77FoAV3aQE2ngfvLhTbsqq63YYwV1WbBNGeLRQk | load | -0.05% | -19.02% | stopAtEntry |
| 2026-02-24T16:27:04.012Z | BKwSZd5tUFC1SudnHbhjmqJ6Nk8n5vz1wVphb7Mupump | SEAGULL | -0.05% | -1.31% | stopAtEntry |
| 2026-02-25T06:35:02.207Z | 7CWLxXfjRZ8WP8HVWBSHoti9pVP9FfN5UwZ71JyXpump | Limited | -0.05% | -8.48% | stopAtEntry |
| 2026-02-24T16:51:47.494Z | H7noGdq7WnvbfdgnZzwYtRdZFCADe5rivUjuiofKpump | RETURN | -0.05% | -14.96% | stopAtEntry |
| 2026-02-24T17:20:07.830Z | 8jiVXftnn2ZG6bugK7HAH5j2G3D6TpsG521gqsWwpump | AUTISM | -0.05% | -0.32% | stopAtEntry |

## Limitations / caveats
- Uses sampled candidate snapshots and track artifacts only; no full tick/trade tape.
- Missing days in the 7-day window reduce continuity; results are best-effort, not complete market coverage.
- Entry trigger inferred from sampled cadence, so trigger timing can drift vs live.
- PnL is proxy (paper stop/trail logic) and excludes fees, slippage, liquidity constraints, failed fills, and execution latency.
- Exit simulation uses observed future samples up to horizon; sparse series can over/under-estimate stop/trail interactions.
