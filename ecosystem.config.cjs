const path = require('path');
const ROOT = process.env.BOT_ROOT || __dirname;

module.exports = {
  apps: [
    {
      name: 'solana-momentum-bot',
      cwd: ROOT,
      // Start script is a shell script; run it under bash. Pass node flags via NODE_OPTIONS to avoid bash parsing node flags.
      // Run Node directly to avoid bash parsing node flags (low-risk change).
      script: 'src/index.mjs',
      interpreter: '/usr/bin/node',
      node_args: ['--no-warnings','--max-old-space-size=4096'],
      // Preserve env passthrough
      // (removed automatic passthrough of host process.env to allow env_file to be authoritative for bot config)
      // env: Object.assign({}, process.env),
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // Auto-restart when process uses too much memory (soft safeguard).
      max_memory_restart: '2048M',

      // Crash-loop / flapping protection:
      // - If the process exits before min_uptime repeatedly, PM2 will stop restarting after max_restarts.
      // - exp_backoff_restart_delay increases restart delay after each crash (reduces dependency hammering).
      min_uptime: 10000,
      max_restarts: 5,
      restart_delay: 60000,
      exp_backoff_restart_delay: 5000,

      // BirdEye WS feature toggles (safe rollback via env)
      env: {
        // Enforce conservative runtime defaults (hard-coded to ensure pm2 picks them up)
        BIRDEYE_WS_ENABLED: 'false',
        // Reduce hot cap to lower simultaneous active subscriptions (low-risk)
        BIRDEYE_WS_HOT_CAP: '4',
        BIRDEYE_WS_HOT_K: '4',
        BIRDEYE_WS_STALE_MS: '1500',
        BIRDEYE_WS_TRAILING_CONFIRM_MS: '300',
        BIRDEYE_WS_IMPACT_THRESHOLD_PCT: '3',
        BIRDEYE_SUB_POLL_MS: '800',
        BIRDEYE_WATCHLIST_SUB_TTL_MS: '120000',
        BIRDEYE_WS_FRESHNESS_BYPASS_MS: '10000',
        BIRDEYE_EARLY_SUB_TTL_MS: '90000',
        // Reduce watchlist eval frequency to lower CPU and memory pressure (low-risk).
        WATCHLIST_EVAL_EVERY_MS: '600000',
        // Reduce max WS subs to lower memory/FD usage (low-risk).
        BIRDEYE_WS_MAX_SUBS: '1',
        // Default to disabling Telegram in production unless explicitly enabled (prevents unhandled fetch errors).
        TELEGRAM_DISABLED: 'true'
      },



      env_file: path.join(ROOT, '.env'),
      out_file: path.join(ROOT, 'state/pm2-out.log'),
      error_file: path.join(ROOT, 'state/pm2-err.log'),
      time: true,
    },
  ],
};
