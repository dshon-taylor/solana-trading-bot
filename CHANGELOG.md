2026-04-24 - tune/candle-carl-2026-04-23 (d42e683)
- Lowered PM2 max_memory_restart from 768M -> 512M (to reduce memory pressure and force controlled restarts).
- Increased LOG_LEVEL from error -> warn to capture additional diagnostics while remaining conservative.

Notes: These are low-risk tuning changes made during an autonomous optimization cycle. Monitor snapshotFailures and entries/hour metrics; revert if system metrics degrade.
