# Production Hardening Checklist — trading-bot (Candle Carl)

_Last updated: 2026-02-19 (UTC)_

## 0) Current focus / active issue
- **Unexpected clean PM2 restart (~02:05Z):** recurring *clean* stop/restart (SIGINT, exit 0) observed at `2026-02-19T02:05:38Z` (and similar on `2026-02-15`), source still unknown.
  - Impact: resets the “24h no-flap” timer needed before archiving plaintext key material.
  - Current plan: **do not** manually `pm2 reload/restart`; wait for scheduled one-shots on **2026-02-20** (02:04Z pre-capture, 02:15Z key-archive + safe deploy) if still stable.
  - Evidence-capture: `./scripts/capture_pm2_restart_context.sh` writes safe snapshots under `./analysis/`.

- **429 retry storms (log-noise + loop lag):** `@solana/web3.js` retries-on-429 are spamming stderr and (in practice) pushing `loopDtMs~8m` due to await-stalls during the internal retry chain.
  - Evidence: `pm2-err-0.log` shows continuous `Server responded with 429 Too Many Requests. Retrying...` at 2026-02-19 ~16:02–16:09Z; `/healthz` showed `loopDtMs≈499s`.
  - Patch is prepared but **not deployed** yet (to avoid resetting the 24h stability timer): disable web3.js retry-on-429 + add our own exponential backoff w/ jitter.

- **Crash-loop risk (verify fix):** bot *used to* crash at boot if DexScreener is 429’ing during initial SOLUSD fetch (PM2 restarts spiked).
  - Status @ 2026-02-18T09:07Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=17739 (~4.93h).
  - Status @ 2026-02-18T09:10Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=17860 (~4.96h), `dexCooldownUntilMs=null`, `loopDtMs=316`.
  - Status @ 2026-02-18T09:12Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=17978 (~4.99h), `dexCooldownUntilMs=null`, `loopDtMs=315`.
  - Status @ 2026-02-18T09:13Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=18099 (~5.03h), `dexCooldownUntilMs=null`, `loopDtMs=328`.
  - Status @ 2026-02-18T09:15Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=18217 (~5.06h), `dexCooldownUntilMs=null`, `loopDtMs=329`.
  - Status @ 2026-02-18T09:19Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=18462 (~5.13h), `dexCooldownUntilMs=null`, `loopDtMs=333`.
  - Status @ 2026-02-18T09:30Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=19062 (~5.29h), `dexCooldownUntilMs=null`, `loopDtMs=320`.
  - Status @ 2026-02-18T09:34Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=19294 (~5.36h), `dexCooldownUntilMs=null`, `loopDtMs=319`.
  - Status @ 2026-02-18T09:48Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=20146 (~5.60h), `dexCooldownUntilMs=null`, `loopDtMs=335`.
  - Status @ 2026-02-18T09:59Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=20862 (~5.80h), `dexCooldownUntilMs=null`, `loopDtMs=332`.
  - Status @ 2026-02-18T10:04Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=21110 (~5.86h), `dexCooldownUntilMs=null`, `loopDtMs=320`.
  - Status @ 2026-02-18T10:11Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=21579 (~5.99h), `dexCooldownUntilMs=null`, `loopDtMs=324`.
  - Status @ 2026-02-18T10:20Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=22066 (~6.13h), `dexCooldownUntilMs=null`, `loopDtMs=316`.
  - Status @ 2026-02-18T10:23Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=22296 (~6.19h), `dexCooldownUntilMs=null`, `loopDtMs=351`.
  - Status @ 2026-02-18T10:34Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=22899 (~6.36h), `dexCooldownUntilMs=null`, `loopDtMs=310`.
  - Status @ 2026-02-18T10:46Z: still stable; `unstable_restarts=0`; `/healthz ok=true` uptimeSec=23622 (~6.56h), `dexCooldownUntilMs=null`, `loopDtMs=331`.
  - Status @ 2026-02-18T10:47Z: still stable; `/healthz ok=true` uptimeSec=23738 (~6.59h), `dexCooldownUntilMs=null`, `loopDtMs=325`, `tradingEnabled=false`, `openPositions=0`.
  - Status @ 2026-02-18T10:50Z: still stable; `/healthz ok=true` uptimeSec=23871 (~6.63h), `dexCooldownUntilMs=null`, `loopDtMs=434`, `tradingEnabled=false`, `openPositions=0`.
  - Status @ 2026-02-18T10:56Z: still stable; `/healthz ok=true` uptimeSec=24227 (~6.73h), `dexCooldownUntilMs=null`, `loopDtMs=332`, `tradingEnabled=false`, `openPositions=0`.
  - Status @ 2026-02-18T10:58Z: still stable; `/healthz ok=true` uptimeSec=24343 (~6.76h), `dexCooldownUntilMs=null`, `loopDtMs=331`, `tradingEnabled=false`, `openPositions=0`.
  - Status @ 2026-02-18T11:01Z: still stable; `/healthz ok=true` uptimeSec=24582 (~6.83h), `dexCooldownUntilMs=null`, `loopDtMs=327`, `tradingEnabled=false`, `openPositions=0`.
  - Fix shipped in `src/index.mjs`: boot-time SOLUSD fetch now cools down + retries instead of throwing and killing the process.
  - Status (2026-02-18): bot last reloaded **2026-02-18T04:12:14Z** (PM2 `created at`, applying flapping-protection via `pm2 reload ... --update-env`). Currently stable, but needs longer runtime to be confident.
  - Evidence:
    - Prior to the restart, `pm2-err-0.log` showed repeated `[fatal] ... 'DEXSCREENER_429'` around 02:14Z.
    - After the restart, the bot is online and emitting heartbeats + health listener startup; no new fatal 429s observed yet (needs more runtime to be confident).
    - Check @ **2026-02-18T03:57Z**: PM2 process `solana-momentum-bot` uptime ~3–4m; `pm2-err-0.log` shows only the expected `bigint-buffer` warning after 03:54:30Z (no new `[fatal]` lines).
    - Check @ **2026-02-18T04:10Z**: PM2 shows **status=online, uptime~15m, unstable restarts=0**; `pm2-err-0.log` has **no new** `[fatal] DEXSCREENER_429` lines after the 03:54Z restart. Telegram 429s are being suppressed via cooldown (expected).
    - Check @ **2026-02-18T04:23Z**: PM2 shows **status=online, uptime~11m since 04:12 reload, unstable_restarts=0**; `pm2-err-0.log` shows only expected Telegram cooldown logs + the `bigint-buffer` startup warning (no crash/fatal traces).
    - Check @ **2026-02-18T04:25Z**: PM2 shows **online, uptime~13m, unstable_restarts=0**; latest Telegram 429 is handled as `rate limited (429); entering cooldown ...` (no repeated per-send error spam after cooldown begins).
    - Check @ **2026-02-18T04:31Z**: PM2 shows **online, uptime~19m**; `/healthz` returns `ok=true` + loop dt ~573ms; Telegram 429 suppression still working (cooldown logs only).
    - Check @ **2026-02-18T04:34Z**: PM2 shows **online, uptime~21m, unstable_restarts=0**; `/healthz` returns `ok=true` + loop dt ~595ms.
    - Check @ **2026-02-18T04:38Z**: PM2 shows **online, uptime~26m, unstable_restarts=0**; `/healthz` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs~580`.
    - Check @ **2026-02-18T04:40Z**: PM2 shows **online, uptime~28m, unstable_restarts=0** (started `2026-02-18T04:12:14Z`); `/healthz` at `2026-02-18T04:39:59Z` returns `ok=true`, `dexCooldownUntilMs=null`, `loopDtMs=574`.
    - Check @ **2026-02-18T04:44Z**: PM2 shows **online, uptime~31m, unstable_restarts=0**; `pm2 jlist` confirms flapping protection still set (`min_uptime=10000`, `max_restarts=20`, `exp_backoff_restart_delay=1000`). `/healthz` at `2026-02-18T04:43:49Z` returns `ok=true`, `dexCooldownUntilMs=null`, `loopDtMs=334`.
    - Check @ **2026-02-18T04:48Z**: PM2 shows **online, uptime~35m, unstable_restarts=0** (created at `2026-02-18T04:12:14Z`, `restart_time=141` historical); `/healthz` at `2026-02-18T04:48:05Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=318`.
    - Check @ **2026-02-18T04:50Z**: PM2 shows **online, uptime~38m, unstable_restarts=0**; `/healthz` at `2026-02-18T04:50:12Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=391`.
    - Check @ **2026-02-18T04:52Z**: PM2 shows **online, uptime~39m, unstable_restarts=0**; `/healthz` at `2026-02-18T04:51:53Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=332`.
    - Check @ **2026-02-18T04:54Z**: PM2 shows **online, uptime~41m, unstable_restarts=0** (created at `2026-02-18T04:12:14Z`); `/healthz` at `2026-02-18T04:53:55Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=329`.
    - Check @ **2026-02-18T04:58Z**: PM2 shows **online, uptime~45m, unstable_restarts=0**; `/healthz` at `2026-02-18T04:58:10Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=331`.
    - Check @ **2026-02-18T05:01Z**: PM2 shows **online, uptime~48m, unstable_restarts=0**; `/healthz` at `2026-02-18T05:00:55Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=340`.
    - Check @ **2026-02-18T05:03Z**: PM2 shows **online, uptime~51m, unstable_restarts=0** (created at `2026-02-18T04:12:14Z`); `/healthz` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=340`.
    - Check @ **2026-02-18T05:06Z**: PM2 shows **online, uptime~53–54m, unstable_restarts=0**; `/healthz` at `2026-02-18T05:06:14Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=331`. (Telegram is currently in cooldown from a 429 at ~04:40Z; expected, no crash/fatal.)
    - Check @ **2026-02-18T05:08Z**: PM2 shows **online, uptime~55m, unstable_restarts=0**; `/healthz` at `2026-02-18T05:08:04Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=322`.
    - Check @ **2026-02-18T05:10Z**: PM2 shows **online, uptime~57m, unstable_restarts=0**; `/healthz` at `2026-02-18T05:09:56Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=324`.
    - Check @ **2026-02-18T05:12Z**: PM2 shows **online, uptime~59m, unstable_restarts=0**; `/healthz` at `2026-02-18T05:12:05Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=329`.
    - Check @ **2026-02-18T05:16Z**: PM2 shows **online, uptime~63m, unstable_restarts=0**; `/healthz` at `2026-02-18T05:15:58Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=440`.
    - Check @ **2026-02-18T05:18Z**: PM2 shows **online, uptime~65m, unstable_restarts=0**; `/healthz` at `2026-02-18T05:18:01Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=687`.
    - Check @ **2026-02-18T05:19Z**: PM2 shows **online, uptime~67m, unstable_restarts=0**; `/healthz` at `2026-02-18T05:19:47Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=566`.
    - Check @ **2026-02-18T05:22Z**: PM2 shows **online, uptime~69m, unstable_restarts=0**; `/healthz` at `2026-02-18T05:21:55Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=581`.
    - Check @ **2026-02-18T05:24Z**: PM2 shows **online, uptime~71m, unstable_restarts=0**; `/healthz` at `2026-02-18T05:23:53Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=584`.
    - Check @ **2026-02-18T05:26Z**: PM2 shows **online, uptime~73m, unstable_restarts=0**; `/healthz` at `2026-02-18T05:25:55Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=329`.
    - Check @ **2026-02-18T05:28Z**: PM2 shows **online, uptime~75m, unstable_restarts=0**; `/healthz` at `2026-02-18T05:28:06Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=326`.
    - Check @ **2026-02-18T05:30Z**: PM2 shows **online, uptime~77m, unstable_restarts=0**; `/healthz` at `2026-02-18T05:29:47Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=321`.
    - Check @ **2026-02-18T05:32Z**: PM2 `jlist` shows **online, uptime~80m, unstable_restarts=0** (created at `2026-02-18T04:12:14Z`); `/healthz` at `2026-02-18T05:32:18Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=625`.
    - Check @ **2026-02-18T05:34Z**: PM2 `jlist` shows **online, uptime~82m, unstable_restarts=0** (created at `2026-02-18T04:12:14Z`); `/healthz` at `2026-02-18T05:34:04Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=573`.
    - Check @ **2026-02-18T05:36Z**: PM2 `jlist` shows **online, uptime~84m, unstable_restarts=0**; flapping-protection fields still present (`max_restarts=20`, `min_uptime=10000`, `exp_backoff_restart_delay=1000`).
    - Check @ **2026-02-18T05:38Z**: PM2 `jlist` shows **online, uptime~86m, unstable_restarts=0** (created at `2026-02-18T04:12:14Z`); `/healthz` at `2026-02-18T05:37:57Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=567`.
    - Check @ **2026-02-18T05:40Z**: PM2 shows **online, uptime~87m, unstable_restarts=0** (created at `2026-02-18T04:12:14Z`); `/healthz` at `2026-02-18T05:39:53Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=575`.
    - Check @ **2026-02-18T05:42Z**: PM2 shows **online, uptime~90m, unstable_restarts=0** (created at `2026-02-18T04:12:14Z`); `/healthz` at `2026-02-18T05:41:59Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=335`.
    - Check @ **2026-02-18T05:45Z**: PM2 `jlist` shows **online, uptime~94m, unstable_restarts=0**; `restart_time=141` (historical).
    - Check @ **2026-02-18T05:47Z**: PM2 `jlist` shows **online, uptime~96m, unstable_restarts=0**; `/healthz` at `2026-02-18T05:47:54Z` returns `ok=true`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=330`.
    - Check @ **2026-02-18T05:49Z**: `/healthz` at `2026-02-18T05:49:49Z` returns `ok=true`, `uptimeSec=5855` (~97.6m), `dexCooldownUntilMs=null`, `loopDtMs=324`.
    - Check @ **2026-02-18T05:50Z**: PM2 `jlist` still **online**, `unstable_restarts=0`; flapping-protection fields still present (`max_restarts=20`, `min_uptime=10000`, `exp_backoff_restart_delay=1000`).
    - Check @ **2026-02-18T05:52Z**: `/healthz` at `2026-02-18T05:52:02Z` returns `ok=true`, `uptimeSec=5988` (~99.8m), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=431`.
    - Check @ **2026-02-18T05:54Z**: `/healthz` at `2026-02-18T05:54:01Z` returns `ok=true`, `uptimeSec=6107` (~101.8m), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=321`.
    - Note: PM2 flapping-protection is **active** (applied via reload at ~04:12Z): `max_restarts=20`, `min_uptime=10000`, `exp_backoff_restart_delay=1000`; `unstable_restarts=0` so far.

## Operator checklist (quick)
Before you consider enabling any live trading toggles, do a quick sanity pass:
- [x] Run preflight: `./scripts/preflight_live.sh` (safe: no restarts, no secret output) — ran 2026-02-18T11:36Z (OK; only warning was plaintext key still present, expected until 24h window).
- [x] Confirm bot is stable: `pm2 status` shows **online** with no flapping; `/healthz` returns `ok=true` (confirmed repeatedly on 2026-02-18).
- [x] Confirm startup config summary looks correct (emitted once at boot): `[config] effective ...` (no secrets).
  - Confirmed via: `npm run print:config` (2026-02-18T15:37Z).
- [x] Confirm `tradingEnabled=false` unless you intentionally enabled. (Observed `tradingEnabled=false` in `/healthz` throughout 2026-02-18.)
- [ ] Confirm key hygiene: `SOPS_WALLET_FILE` in use; plaintext key archived/offline. (Prep done: generated `./secrets/wallet.enc.json` from `./keys/bot-keypair.json`; switch-over + archive happen after the 24h stability window.)
- [ ] Confirm no unexpected Telegram 429 spam (cooldown logs should be low-frequency).

## 1) Crash-loop prevention (must-have)
- [x] **Do not crash on DexScreener 429 at boot** (SOLUSD fetch)
- [x] Treat **DEXSCREENER_429** as a *transient* error everywhere (no `process.exit(1)`), and ensure scan loop enters cooldown instead.
- [x] Add process-level handlers:
  - [x] `process.on('unhandledRejection', ...)` log + continue (or classify fatal vs transient)
  - [x] `process.on('uncaughtException', ...)` log + exit (programming error)
- [x] Graceful shutdown handlers (`SIGTERM`/`SIGINT`) to persist state and close the local health listener (improves PM2 reload/restart safety)
- [x] PM2 flapping protection configured **and applied** (`min_uptime`, `max_restarts`, `exp_backoff_restart_delay`) to prevent infinite dependency-hammer crash loops.
  - Applied via: `pm2 reload ecosystem.config.cjs --only solana-momentum-bot --update-env`
  - Verification (2026-02-18 ~04:12Z): `pm2 jlist` shows `max_restarts=20`, `min_uptime=10000`, `exp_backoff_restart_delay=1000`.

## 2) Rate-limits & backoff
- [x] Centralize DexScreener backoff/cooldown (single place)
- [x] Add jittered exponential backoff + max wait
- [x] Persist “cooldown until” to state so restarts don’t instantly hammer again
- [x] Telegram 429 handling: respect `retry_after` and suppress repeated send attempts during cooldown (prevents stderr spam)
  - 2026-02-18: hardened parsing by reading body text once + `JSON.parse` fallback; on 429 we now enter cooldown even if parsing fails (default 60s) — prevents spammy per-send 429 logs.
  - 2026-02-18: extra hardening: treat *either* HTTP status 429 *or* JSON body `{error_code:429}` as a rate-limit signal (some responses can be inconsistent).
- [ ] **RPC/Jupiter 429 mitigation (pending deploy):** web3.js has an internal retry-on-429 loop that logs on each retry.
  - Implemented (code, not deployed yet):
    - `disableRetryOnRateLimit: true` in our `makeConnection()`.
    - `withRetry()` uses exponential backoff + jitter + longer waits on 429.
    - **NEW:** `withRetry()` wraps each await in a `Promise.race()` timeout (default 30s) so one stalled RPC call can’t freeze the main loop.
  - **Do not deploy** until after plaintext key archive window completes (to avoid resetting the 24h stability timer).

## 3) State safety / data integrity
- [x] Ensure atomic state writes (write temp + rename)
- [x] Ensure state schema versioning + migrations
- [x] Add a startup sanity check: if `state.positions` says open, reconcile balances before trading

## 4) Observability
- [x] Health endpoint (local only) includes: uptime, loop lag, last scan time, last dex cooldown, open positions (`GET /healthz` via `HEALTH_HOST=127.0.0.1`, `HEALTH_PORT=8787`)
- [x] Durable paper->live decision ledger (`./state/paper_live_attempts.jsonl`) written on each PAPER entry signal (signal + decision stages). Summary helper: `npm run summarize:attempts`.
- [x] Log rotation / retention for PM2 logs (installed `pm2-logrotate`; configured max_size=10M, retain=14, compress=true, daily rotate).
- [x] Safe PM2 snapshot helper (`./scripts/pm2_snapshot_safe.sh`) to capture operational fields without leaking `pm2_env` (which can contain secrets).
- [x] JSONL ledger retention/rotation (best-effort): prune by age + rotate by size for `cost.jsonl`, `trades.jsonl`, `candidates.jsonl`, `paper_trades.jsonl` (defaults: 30d, 25MB).
- [x] Harden local runtime state perms (`./state/**`) to prevent other local users reading logs/ledgers/state:
  - `./state` + subdirs: `0700`
  - files: `0600`
  - helper: `./scripts/harden_state_perms.sh`

## 5) Key & secret hygiene
- [x] Confirm `.env` never committed; ensure `keys/` never committed
  - Verified: `.env` and `keys/` are in `trading-bot/.gitignore` and do not appear in `git ls-files`.
- [x] Make raw `WALLET_SECRET_KEY_*` env keys **explicitly opt-in**
  - Implemented: `ALLOW_WALLET_SECRET_KEY_ENV=true` required; otherwise bot refuses env-based keys.
- [x] Prefer `SOPS_WALLET_FILE` + remove raw secret key from env
  - [x] Generate `age` keypair at `~/.config/sops/age/keys.txt` (0600)
  - [x] Encrypt wallet secret into `./secrets/wallet.enc.json` (gitignored)
  - [x] Smoke test decrypt + keypair load via `SOPS_WALLET_FILE` succeeded
  - [x] Prod `.env` updated to use `SOPS_WALLET_FILE=./secrets/wallet.enc.json`; removed `WALLET_SECRET_KEY_*` + `ALLOW_WALLET_SECRET_KEY_ENV`.
  - [x] PM2 restarted with updated env_file.
  - [x] Validation: SOPS wallet public key matches plaintext `keys/bot-keypair.json`: `GZ4DYkMNm7vLdsHAAqhTv6hPY847eiFQxwKhVn2bT3uY`.
  - [ ] After a quiet period / confirm bot stable (**target: 24h uptime** without restart storms; i.e. after ~`2026-02-19T04:12Z` if no restarts): remove (or move offline) any remaining plaintext key material (`keys/bot-keypair.json`). (Current perms: `0600`; not removed yet.)
    - Status @ 2026-02-18T05:36Z: uptime ~84m since `2026-02-18T04:12Z` reload; waiting.
    - Status @ 2026-02-18T05:45Z: uptime ~94m; still waiting for 24h no-flap window before archiving plaintext key.
    - Status @ 2026-02-18T05:52Z: uptime ~100m (`/healthz uptimeSec=5988`); `unstable_restarts=0`; still waiting.
    - Status @ 2026-02-18T05:54Z: uptime ~102m (`/healthz uptimeSec=6107`); `unstable_restarts=0`; still waiting.
    - Status @ 2026-02-18T05:56Z: `/healthz` returns `ok=true`, `uptimeSec=6235` (~103.9m), `dexCooldownUntilMs=null`, `loopDtMs=330`; PM2 `unstable_restarts=0`.
    - Status @ 2026-02-18T05:57Z: `/healthz` returns `ok=true`, `uptimeSec=6329` (~105.5m), `dexCooldownUntilMs=null`, `loopDtMs=454`; PM2 uptime ~105m, `unstable_restarts=0`.
    - Status @ 2026-02-18T06:01Z: `/healthz` returns `ok=true`, `uptimeSec=6592` (~109.9m), `dexCooldownUntilMs=null`, `loopDtMs=343`; PM2 `unstable_restarts=0`.
    - Status @ 2026-02-18T06:06Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=6830` (~113.8m), `dexCooldownUntilMs=null`, `loopDtMs=326`.
    - Status @ 2026-02-18T06:07Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=6929` (~115.5m), `dexCooldownUntilMs=null`, `loopDtMs=343`.
    - Status @ 2026-02-18T06:11Z: `/healthz ok=true`, `uptimeSec=7174` (~119.6m), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=443`; PM2 `unstable_restarts=0`.
    - Status @ 2026-02-18T06:14Z: `/healthz ok=true`, `uptimeSec=7302` (~121.7m), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=318`; PM2 `unstable_restarts=0`.
    - Status @ 2026-02-18T06:16Z: PM2 `status=online`, `unstable_restarts=0`, uptime ~2.06h since `2026-02-18T04:12Z`; `/healthz ok=true`, `uptimeSec=7423`, `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=321`.
    - Status @ 2026-02-18T06:18Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=7541` (~2.10h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=674`. (Still waiting for 24h no-flap window.)
    - Status @ 2026-02-18T06:20Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=7661` (~2.13h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=640`.
    - Status @ 2026-02-18T06:21Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=7778` (~2.16h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=791`. (Still waiting for 24h no-flap window.)
    - Status @ 2026-02-18T06:24Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=7895` (~2.19h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=690`. (Still waiting.)
    - Status @ 2026-02-18T06:26Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=8034` (~2.23h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=326`. (Still waiting.)
    - Status @ 2026-02-18T06:28Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=8135` (~2.26h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=328`. (Still waiting.)
    - Status @ 2026-02-18T06:29Z: PM2 `status=online`, `unstable_restarts=0` (created_at `2026-02-18T04:12:14Z`); `/healthz ok=true`, `uptimeSec=8252` (~2.29h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=333`. (Still waiting.)
    - Status @ 2026-02-18T06:31Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=8375` (~2.33h), `dexCooldownUntilMs=null`, `loopDtMs=562`. (Still waiting for 24h no-flap window.)
    - Status @ 2026-02-18T06:33Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=8493` (~2.36h), `dexCooldownUntilMs=null`, `loopDtMs=579`. (Still waiting.)
    - Status @ 2026-02-18T06:38Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=8740` (~2.43h), `dexCooldownUntilMs=null`, `loopDtMs=771`. (Still waiting.)
    - Status @ 2026-02-18T06:42Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=8984` (~2.50h), `dexCooldownUntilMs=null`, `loopDtMs=459`.
    - Status @ 2026-02-18T06:46Z: PM2 `status=online`, `unstable_restarts=0` (created_at `2026-02-18T04:12:14Z`, `max_restarts=20`, `min_uptime=10000`, `exp_backoff_restart_delay=1000`); `/healthz ok=true`, `uptimeSec=9221` (~2.56h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=443`.
    - Status @ 2026-02-18T06:47Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=9329` (~2.59h), `dexCooldownUntilMs=null`, `loopDtMs=335`. `./scripts/archive_plaintext_key_if_stable.sh` correctly refused (needs 24h; exit 6).
    - Status @ 2026-02-18T06:49Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=9457` (~2.63h), `dexCooldownUntilMs=null`, `loopDtMs=450`. Still waiting.
    - Status @ 2026-02-18T06:58Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=9936` (~2.76h), `dexCooldownUntilMs=null`, `loopDtMs=325`. Still waiting for 24h no-flap window.
    - Status @ 2026-02-18T07:02Z: PM2 `status=online`, `unstable_restarts=0` (created_at `2026-02-18T04:12:14Z`); `/healthz ok=true`, `uptimeSec=10195` (~2.83h), `dexCooldownUntilMs=null`, `loopDtMs=442`. Still waiting for 24h no-flap window.
    - Status @ 2026-02-18T07:08Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=10543` (~2.93h), `dexCooldownUntilMs=null`, `loopDtMs=330`. Still waiting for 24h no-flap window.
    - Status @ 2026-02-18T07:09Z: PM2 `status=online`, `unstable_restarts=0` (created_at `2026-02-18T04:12:14Z`, flapping-protection still set: `max_restarts=20`, `min_uptime=10000`, `exp_backoff_restart_delay=1000`); `/healthz ok=true`, `uptimeSec=10651` (~2.96h), `dexCooldownUntilMs=null`, `loopDtMs=329`. Still waiting.
    - Status @ 2026-02-18T07:11Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=10774` (~2.99h), `dexCooldownUntilMs=null`, `loopDtMs=327`. Still waiting.
    - Status @ 2026-02-18T07:18Z: PM2 `status=online`, `unstable_restarts=0` (created_at `2026-02-18T04:12:14Z`, flapping-protection still set); `/healthz ok=true`, `uptimeSec=11136` (~3.09h), `dexCooldownUntilMs=null`, `loopDtMs=587`. Still waiting for 24h no-flap window.
    - Status @ 2026-02-18T07:20Z: PM2 `status=online`, `unstable_restarts=0` (created_at `2026-02-18T04:12:14Z`); `/healthz ok=true`, `uptimeSec=11257` (~3.13h), `dexCooldownUntilMs=null`, `loopDtMs=569`. Still waiting for 24h no-flap window.
    - Status @ 2026-02-18T07:25Z: PM2 `status=online`, `unstable_restarts=0` (created_at `2026-02-18T04:12:14Z`, flapping-protection still set); `/healthz ok=true`, `uptimeSec=11617` (~3.23h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=332`. Still waiting for 24h no-flap window.
    - Status @ 2026-02-18T07:46Z: PM2 `status=online`, `unstable_restarts=0` (flapping-protection still set: `max_restarts=20`, `min_uptime=10000`, `exp_backoff_restart_delay=1000`); `/healthz ok=true`, `uptimeSec=12825` (~3.56h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=322`.
    - Status @ 2026-02-18T07:52Z: PM2 `unstable_restarts=0` (still flapping-protected); `/healthz ok=true`, `uptimeSec=13176` (~3.66h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=321`.
    - Status @ 2026-02-18T07:59Z: PM2 `status=online`, `unstable_restarts=0`, uptime ~3.79h since `2026-02-18T04:12Z`; `/healthz ok=true`, `uptimeSec=13655` (~3.79h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=329`. (Still waiting for 24h no-flap window; next decision point ~`2026-02-19T04:12Z`.)
    - Status @ 2026-02-18T08:03Z: PM2 `status=online`, `unstable_restarts=0` (flapping-protection still set: `max_restarts=20`, `min_uptime=10000`, `exp_backoff_restart_delay=1000`); `/healthz ok=true`, `uptimeSec=13894` (~3.86h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=325`. Still waiting for 24h no-flap window.
    - Status @ 2026-02-18T08:12Z: PM2 `status=online`, `unstable_restarts=0` (created_at `2026-02-18T04:12:14Z`); `/healthz ok=true`, `uptimeSec=14382` (~4.00h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=322`. Still waiting.
    - Status @ 2026-02-18T08:15Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=14616` (~4.06h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=329`. Still waiting.
    - Status @ 2026-02-18T08:26Z: PM2 `status=online`, `unstable_restarts=0`, uptime ~4.23h; `/healthz ok=true`, `uptimeSec=15224` (~4.23h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=328`. Still waiting.
    - Status @ 2026-02-18T08:28Z: PM2 `status=online`, `unstable_restarts=0`, uptime ~4.26h; `/healthz ok=true`, `uptimeSec=15343` (~4.26h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=322`. Still waiting.
    - Status @ 2026-02-18T08:43Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=16297` (~4.53h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=435`. Still waiting.
    - Status @ 2026-02-18T08:47Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=16537` (~4.59h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=329`. `./scripts/archive_plaintext_key_if_stable.sh` refused (needs 24h; exit 6).
    - Status @ 2026-02-18T08:49Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=16653` (~4.63h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=317`. Still waiting for 24h no-flap window.
    - Status @ 2026-02-18T09:10Z: PM2 `status=online`, `unstable_restarts=0` (flapping-protection still set); `/healthz ok=true`, `uptimeSec=17860` (~4.96h), `dexCooldownUntilMs=null`, `loopDtMs=316`. Still waiting for 24h no-flap window (decision point ~`2026-02-19T04:12Z`).
    - Status @ 2026-02-18T09:12Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=17978` (~4.99h), `dexCooldownUntilMs=null`, `loopDtMs=315`. Still waiting.
    - Status @ 2026-02-18T09:19Z: PM2 `status=online`, `unstable_restarts=0` (created_at `2026-02-18T04:12:14Z`); `/healthz ok=true`, `uptimeSec=18462` (~5.13h), `dexCooldownUntilMs=null`, `loopDtMs=333`. `./scripts/archive_plaintext_key_if_stable.sh` refused (needs 24h; exit 6).
    - Status @ 2026-02-18T09:48Z: PM2 `status=online`, `unstable_restarts=0`; `/healthz ok=true`, `uptimeSec=20146` (~5.60h), `dexCooldownUntilMs=null`, `loopDtMs=335`. Still waiting.
    - Status @ 2026-02-18T15:44Z: PM2 `status=online`, `unstable_restarts=0` (created_at `2026-02-18T04:12:14Z`; flapping-protection intact). `/healthz ok=true`, `uptimeSec=41504` (~11.53h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=328`. Still waiting for the 24h no-flap window (~`2026-02-19T04:12Z`).
    - Status @ 2026-02-18T18:18Z: PM2 `status=online`, `unstable_restarts=0` (created_at `2026-02-18T04:12:14Z`; flapping-protection intact). `/healthz ok=true`, `uptimeSec=50741` (~14.09h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=352`. Still waiting for the 24h no-flap window (~`2026-02-19T04:12Z`).
    - Status @ 2026-02-18T20:15Z: PM2 `status=online`, `unstable_restarts=0` (created_at `2026-02-18T04:12:14Z`; flapping-protection intact). `/healthz ok=true`, `uptimeSec=57818` (~16.06h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=351`. Still waiting for the 24h no-flap window (~`2026-02-19T04:12Z`).
    - Status @ 2026-02-18T21:58Z: PM2 `status=online`, `unstable_restarts=0`, uptime ~17.8h since `2026-02-18T04:12Z`. `/healthz ok=true`, `uptimeSec=63992` (~17.78h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=362`. Still waiting for the 24h no-flap window (~`2026-02-19T04:12Z`).
    - Status @ 2026-02-18T23:38Z: PM2 `status=online`, `unstable_restarts=0`, uptime ~19.4h since `2026-02-18T04:12Z`. `/healthz ok=true`, `uptimeSec=69976` (~19.44h), `tradingEnabled=false`, `openPositions=0`, `dexCooldownUntilMs=null`, `loopDtMs=343`. Still waiting for the 24h no-flap window (~`2026-02-19T04:12Z`).
    - Helper (safe, archives only; does **not** delete): `./scripts/archive_plaintext_key_if_stable.sh` (also `chmod 700 keys/offline`)
    - After archive (safe deploy): `./scripts/deploy_pending_after_key_archive.sh` (runs `npm run check`, then `pm2 reload … --update-env`)
    - Helper (safe): `./scripts/harden_state_perms.sh`
    - Follow-up hardening (optional): tighten directory perms for `./secrets/` to `0700` so other local users can’t list filenames.
      - [x] Executed `./scripts/harden_secret_perms.sh` @ 2026-02-18T06:01Z → `./secrets` now `0700`, `./secrets/*` `0600`.
  - Helper script (does **not** edit `.env`): `./scripts/migrate_wallet_to_sops.sh /path/to/wallet.json [./secrets/wallet.enc.json]`

## 6) Operational guardrails
- [x] Safe-mode flag: entries disabled by default unless explicitly enabled (`state.tradingEnabled` defaults to `FORCE_TRADING_ENABLED`)
- [x] Daily “I’m alive” ping, rate-limited (requires `ALIVE_PING_URL`; e.g., healthchecks.io)
- [x] Circuit breaker: pause entries after N consecutive failures (RPC/Jupiter/Dex) + cooldown

## 7) Runtime / build hygiene (nice-to-have)
- [x] Identify source of recurring PM2 stderr warning: `bigint: Failed to load bindings, pure JS will be used (try npm run rebuild?)`.
  - Source: `node_modules/bigint-buffer/dist/node.js` (it tries `require('bindings')('bigint_buffer')`, then `console.warn(...)` on failure).
  - Dependency chain: `@solana/spl-token -> @solana/buffer-layout-utils -> bigint-buffer@1.1.5`.
  - Notes:
    - This is a **startup-time warning**; execution falls back to pure JS BigInt conversions.
    - **Security tie-in (important):** `npm audit` flags `bigint-buffer` (GHSA-3gc7-fjrx-p6mg). That advisory is about a buffer overflow in `toBigIntLE()`; the risk likely applies to the **native binding** implementation. On this host, the binding is **not** loading, so we’re using the JS fallback.
  - Decision (2026-02-18): **do not rebuild** `bigint-buffer` native bindings until upstream ships a patched release / advisory is resolved. Treat the warning as acceptable log-noise for now.
  - Next actions (optional, later):
    - Silence warning (if desired) by filtering startup stderr lines in PM2 logs, or upstream PR (not urgent).
    - If we *must* rebuild for performance, do it only after verifying the advisory is fixed (or by patching/forking), because rebuilding could re-enable the vulnerable native path.

## 8) Dependency security (audit)
- [x] Run `npm audit --omit=dev` and triage findings.
  - 2026-02-18: **3 high** findings, all via `bigint-buffer@1.1.5` (GHSA-3gc7-fjrx-p6mg) pulled in by `@solana/buffer-layout-utils` → `@solana/spl-token`.
  - `npm` reports **no non-breaking fix available** (suggests a semver-major change to `@solana/spl-token@0.1.8`, which is not acceptable for this codebase).
  - 2026-02-18: checked published `bigint-buffer` versions; latest is still **1.1.5** (no patched release available on npm).
  - Evidence: `analysis/npm_audit_omit_dev_2026-02-18.json` (raw audit output).
  - Added helper: `./scripts/audit_snapshot.sh` to capture timestamped audits (latest: `analysis/npm_audit_omit_dev_2026-02-18T05-12-34Z.json`).
  - Mitigation (current):
    - Stay on JS fallback (do **not** rebuild native bindings) until patched.
    - Monitor upstream and revisit when a fixed `bigint-buffer` is published.
    - If risk posture changes: fork+patch `bigint-buffer` and use `package.json#overrides` (or replace bigint conversion usage upstream) — document before doing.

## Notes / evidence
- Patch: `src/index.mjs` boot-time SOLUSD fetch loop w/ 60s cooldown.
- Patch: `src/index.mjs` centralized `isDexScreener429()` + scan/positions loop now enters cooldown when pairs fetch hits 429; process-level rejection/exception handlers added.
- Patch: `src/dex_cooldown.mjs` centralizes DexScreener 429 detection + jittered exponential cooldown and persists `state.dex.cooldownUntilMs`.
- Patch: `src/index.mjs` now uses centralized Dex cooldown module, runs a startup reconcile when positions are open, and defaults `state.tradingEnabled` to safe-mode (false unless `FORCE_TRADING_ENABLED=true`).
- Patch: `src/state.mjs` now includes `STATE_SCHEMA_VERSION` + `migrateState()` and ensures state defaults (incl. `dex`), while keeping atomic temp+rename writes.
- Ops: installed PM2 module `pm2-logrotate` and set:
  - `pm2-logrotate:max_size=10M`
  - `pm2-logrotate:retain=14`
  - `pm2-logrotate:compress=true`
  - `pm2-logrotate:rotateInterval='0 0 * * *'`
- Patch: `src/alive_ping.mjs` + `src/index.mjs` now support a daily alive ping to `ALIVE_PING_URL` (rate-limited, best-effort).
- Patch: `src/circuit_breaker.mjs` + `src/index.mjs` track consecutive dependency failures and pause entries during a cooldown.
- Patch: `src/ledger_retention.mjs` + `src/index.mjs` prune/rotate JSONL ledgers to prevent unbounded growth.
- 2026-02-18: verified host has `sops` and `age` installed (ready to proceed with SOPS_WALLET_FILE migration).
