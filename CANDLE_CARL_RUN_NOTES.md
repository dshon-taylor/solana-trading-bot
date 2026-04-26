2026-04-26: Tuned env to fix scan backoff timing mismatch.
- SCAN_BACKOFF_MAX_MS set to 1200000 (previously 600000) to be >= SCAN_EVERY_MS (900000).
- Reason: startup fatal validation 'SCAN_BACKOFF_MAX_MS must be >= SCAN_EVERY_MS' observed in logs (2026-04-24).
- Restarted pm2 solana-momentum-bot; verified online and stable logs.
- Commit: e4a38c8 (local)
