# LaserStream Devnet Staging Runbook

## Purpose
Use Helius devnet LaserStream to harden stream reliability architecture **without switching production trading to devnet**.

## Safety gates (must all be true)
- `STREAMING_PROVIDER_MODE=laserstream-devnet`
- `LASERSTREAM_ENABLED=true`
- `LASERSTREAM_STAGING_MODE=true`

Rollback switch (instant):
- `LASERSTREAM_ENABLED=false` (or `STREAMING_PROVIDER_MODE=existing`)

## Env knobs
- `STREAMING_PROVIDER_MODE` = `existing|laserstream-devnet`
- `LASERSTREAM_ENABLED` = `true|false`
- `LASERSTREAM_STAGING_MODE` = `true|false`
- `LASERSTREAM_DEVNET_WS_URL`
- `LASERSTREAM_DEVNET_RPC_URL`
- `LASERSTREAM_PROGRAM_IDS` (comma-separated)
- `LASERSTREAM_RECONNECT_BASE_MS`
- `LASERSTREAM_RECONNECT_MAX_MS`
- `LASERSTREAM_REPLAY_LOOKBACK_SECONDS`
- `LASERSTREAM_HEARTBEAT_STALE_MS`
- `LASERSTREAM_BUFFER_MAX`

## Staging smoke / soak
```bash
cd ~/trading-bot

# 10-minute smoke
LASERSTREAM_SOAK_MINUTES=10 npm run soak:laserstream:staging

# 30-minute soak
LASERSTREAM_SOAK_MINUTES=30 npm run soak:laserstream:staging
```

Artifacts are written to:
- `analysis/laserstream_soak_<timestamp>.json`
- `analysis/laserstream_soak_<timestamp>.md`

## Metrics interpretation
Healthy baseline:
- `status=healthy`
- `lastMessageAgeMs < LASERSTREAM_HEARTBEAT_STALE_MS`
- `disconnects` low and reconnect recovers quickly
- `replayedMessages > 0` after at least one reconnect/backfill event
- `queueDepth` comfortably below `LASERSTREAM_BUFFER_MAX`

Warning signs:
- `status=stale` repeatedly
- `reconnectsPerHour > 6`
- `queueDepth` near buffer cap (consumer can’t keep up)
- `replayedMessages=0` even with disconnects (backfill path misconfigured)

## Production policy
Keep production in current mode (`STREAMING_PROVIDER_MODE=existing`) until:
1. At least 3 successful staging soaks (10–30 min)
2. reconnect/backfill behavior is stable
3. lag remains bounded under expected load
