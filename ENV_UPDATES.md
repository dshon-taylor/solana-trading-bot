Candle Carl optimization run — 2026-04-22

Changes applied (low-risk):
- Set RPC env (RPC) to https://api.mainnet-beta.solana.com in PM2 process environment.
- Added RPC_URL and KEYPAIR_PATH variables to PM2 environment for fallback and clarity.

Rationale:
- Agent observed rpc unset (config showed rpc=set) which can cause fetch errors and degraded operation. Setting RPC restores expected RPC endpoint.
- KEYPAIR_PATH ensures bot can find local keypair if required.

Notes:
- TELEGRAM_DISABLED remains true (deliberate). Telegram-related fetch failures still appear in logs; investigate separately.
- No code changes made.

Next steps:
- Monitor for 2 consecutive degraded runs; revert if metrics worsen.
- Consider addressing telegram.commands fetch failures and investigate why TELEGRAM_DISABLED=true yet telegram errors appear.

---
Candle Carl optimization run — 2026-04-22 07:05 UTC

Changes applied (low-risk):
- Disabled LIVE_PROBE_CONFIRM_ENABLED so watchlist probe gating no longer drops nearly every candidate when tx1h < 20; conversion profile still enabled but now uses standard shortlist.
- Added TELEGRAM_DISABLED-aware guard in src/telegram/index.mjs so tgSend/tgSetMyCommands short-circuit when Telegram is intentionally disabled, halting noisy fetch failures.
- Startup validation now inspects process.env KEYPAIR_PATH/SOPS_WALLET_FILE so we only warn when both wallet sources are actually missing.

Rationale:
- /diag compact showed ~90% of shortlist drops were probeMinTx1h or probeMinLiq; relaxing probe gating restores throughput without increasing attempt risk (still enforces liquidity filters).
- TELEGRAM_DISABLED=true was still attempting setMyCommands/send, generating fetch failed errors and potential watchdog restarts; guard keeps ops logs quiet while Telegram remains intentionally offline.
- Previous validation falsely warned KEYPAIR_PATH|SOPS even though envs existed, obscuring real boot issues.

Notes:
- Restarted pm2 solana-momentum-bot --update-env to pick up env + runtime changes.
- pm2 env confirms TELEGRAM_DISABLED=true and runtime logs now show "probeConfirm=false" under conversionProfile.
