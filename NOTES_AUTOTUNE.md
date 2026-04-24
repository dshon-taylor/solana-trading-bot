Candle Carl autotune notes (2026-04-24)

- SCAN_EVERY_MS increased 300000 -> 600000 to lower scan frequency and CPU pressure.
- BIRDEYE_LITE was previously causing repeated startup errors (missing BIRDEYE_API_KEY) earlier in the morning, but current .env has BIRDEYE_LITE_ENABLED=false.
- Observability: snapshotFailures remain elevated; activeRunners=0 — follow-up: investigate why runners are not launching (likely disabled features or upstream snapshot service issues).
- Commit: local commit exists on branch tune/candle-carl-2026-04-23; push requires remote setup.
