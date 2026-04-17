Summary: Applied three low-risk runtime tunings to reduce BirdEye request pressure and overall polling cadence.

Changes (applied via local .env override file - not checked into .env):
- BIRDEYE_LITE_MAX_RPS: 12 -> 8
- BIRDEYE_LITE_CACHE_TTL_MS: 30000 -> 60000
- SCAN_EVERY_MS: 15000 -> 20000

Rationale: Reduce external API 429s from BirdEye/DexScreener and lower CPU/network pressure by slightly increasing scan cadence.

Risk: Low — passive throttling and cache TTL changes. No change to execution/risk gates.

Files modified:
- trading-bot/.env (local override)
- trading-bot/docs/ops/TUNING_CHANGESET-2026-04-17.md (this file)

Operator: Autonomous Candle Carl run (cron:b467335b...)
Timestamp: 2026-04-17T12:30:00Z
