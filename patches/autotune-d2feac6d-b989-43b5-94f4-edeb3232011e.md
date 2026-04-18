run_id: d2feac6d-b989-43b5-94f4-edeb3232011e
timestamp_ct: 2026-04-18T18:08:00-05:00
changes:
  - file: .env
    edits:
      - WATCHLIST_HOT_QUEUE_MAX: 24 -> 18
      - WATCHLIST_EVAL_EVERY_MS: 1500 -> 2000
      - HOT_EVAL_MAX_MS: 1000 -> 1500
reason: Reduce hot-path eval parallelism and cadence to lower RPC/provider pressure and reduce momentum repeat failures observed in logs.
risk: low (non-invasive parameter tweaks)
notes: .env is gitignored; change recorded here for audit and manual sync into deployment environment if desired.
