Candle Carl autotune notes (append-only)

2026-04-25: Initial run performed. No code/config changes applied. Restarted solana-momentum-bot to refresh environment. Observed:
- restarts: 722
- snapshotFailures: 2498
- entries/hour: ≈0
- event-loop p95 spikes (~502ms)
- memory RSS ~200MB
- TELEGRAM_DISABLED=true

Recommendations:
- Investigate SIGINT source and snapshotFailure reasons before any tuning.
- Monitor for 24-48h; if stable, consider incremental low-risk tunings (adjust SOURCE_RPS or WATCHLIST_EVAL_EVERY_MS) one at a time.
