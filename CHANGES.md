2026-04-22 - Candle Carl tuning
- Increase LIVE_CONFIRM_MIN_LIQ_USD to 80,000 to avoid entering low-liquidity trades.
- Slow hot monitor cadence (min 1200ms, max 2000ms) to reduce churn and rate pressure.
- Lower HOT_LIMIT_PER_MIN to 2 to limit potential overtrading from hot queue.
Commit: 913dcac
2026-04-22 b8965d3: autonomy(candle-carl) reduce MAX_NEW_ENTRIES_PER_HOUR to 30 (low-risk) to limit entry rate
