2026-04-17 - tuning
- Reduced HOT_MONITOR_MS (800-1600ms), CONFIRM_MONITOR_MS (300-600ms) and HOT_LIMIT_PER_MIN (80) to lower CPU usage and reduce rate of external calls. Low-risk change applied after observing sustained high CPU and memory usage prior to restart. Monitor for 2 runs; auto-revert if metrics worsen twice.
