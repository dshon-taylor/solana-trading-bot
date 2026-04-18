RunID: d2feac6d-b989-43b5-94f4-edeb3232011e
Timestamp (CT): 2026-04-17 07:40:13 AM CDT
Summary: Low-risk tuning applied to reduce BirdEye request pressure after repeated BirdEye WS closures and SIGINT-driven shutdowns. Goal: reduce feed instability without affecting execution profile.
Changes:
- Edited trading-bot/.env (local, gitignored) to set BIRDEYE_LITE_PER_MINT_MIN_INTERVAL_MS=40000 (was 20000)
- Edited trading-bot/.env to set BIRDEYE_WS_FALLBACK_POLL_MS=5000 (was 3000)
Notes:
- Cannot commit .env (gitignored). Recorded change in docs/ops and committed that record.
- Restarted process: pm2 restart solana-momentum-bot --update-env
Observations post-restart:
- BirdEye WS connected and stable in immediate window; no fresh "fetch failed" errors observed in last ~2 minutes.
- Process status: online. Restart count remains elevated historically (↺ 91) but no flapping in current window.
Next steps / recommendations:
- Monitor for 2 consecutive runs for metric regressions; auto-revert if metrics worsen after tuning (per policy) — will revert if triggered.
- If WS closures resume, consider medium-risk changes: switch to fallback polling-only mode or throttle live execution (reduce MAX_ACTIVE_RUNNERS) to lower pressure.
Logs examined:
- pm2 logs (last ~200 lines) at time of run
Git commit: docs/ops/candle-carl-run-1776429602.md (ops: record Candle Carl low-risk BirdEye tuning)
