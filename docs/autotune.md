Autotune notes (Candle Carl)

2026-04-25 CT: Changes applied by autonomous optimization cycle (cron:96e58c71...)
- MARKETDATA_MIN_ENTRY_CONFIDENCE_SCORE: 0.55 -> 0.60
- MAX_NEW_ENTRIES_PER_HOUR: 2 -> 1
- Commit: dfc7341d50c3cdf5e1699242590ac9dbfb35e901 (branch: tune/candle-carl-autotune-2026-04-23)
- Reasoning: Tighten entry confidence and reduce new entry rate to favor trade quality over volume without architectural changes.
- Verification: pm2 restart executed; process online. Monitor event-loop p95 and entry metrics.

Revert policy: If trade quality metrics worsen for 2 consecutive runs, the latest change set will be auto-reverted and recorded.
