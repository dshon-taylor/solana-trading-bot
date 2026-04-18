2026-04-18 CDT - run d2feac6d-b989-43b5-94f4-edeb3232011e
- Applied low-risk tunings to reduce memory/WS pressure:
  - TOP_N_HOT: 5 -> 4
  - HOT_LIMIT_PER_MIN: 40 -> 30
  - MAX_WS_CONNECTIONS: 50 -> 30
- Reason: observed elevated RSS and websocket pool usage; aim to reduce concurrent tracked items and WS connections.
- Actions: edited config/defaults.js, committed locally (no remote), restarted pm2 process.
- Verification: bot restarted and is online; key env vars present (HELIUS, JUPITER, BIRDEYE, OPENAI).
- Follow-up: monitor next 2 cycles for regressions; revert if performance degrades twice.
