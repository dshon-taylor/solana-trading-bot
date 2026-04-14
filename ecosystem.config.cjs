const path = require('path');
const ROOT = process.env.BOT_ROOT || __dirname;

module.exports = {
  apps: [
    {
      name: 'solana-momentum-bot',
      cwd: ROOT,
      script: 'scripts/start_with_mock.sh',
      interpreter: '/bin/bash',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,

      // Crash-loop / flapping protection:
      // - If the process exits before min_uptime repeatedly, PM2 will stop restarting after max_restarts.
      // - exp_backoff_restart_delay increases restart delay after each crash (reduces dependency hammering).
      min_uptime: 10000,
      max_restarts: 20,
      restart_delay: 5000,
      exp_backoff_restart_delay: 1000,

      // BirdEye WS feature toggles (safe rollback via env)
      env: {
        BIRDEYE_WS_ENABLED: process.env.BIRDEYE_WS_ENABLED||'true',
        BIRDEYE_WS_HOT_CAP: process.env.BIRDEYE_WS_HOT_CAP||'15',
        BIRDEYE_WS_HOT_K: process.env.BIRDEYE_WS_HOT_K||'4',
        BIRDEYE_WS_STALE_MS: process.env.BIRDEYE_WS_STALE_MS||'1200',
        BIRDEYE_WS_TRAILING_CONFIRM_MS: process.env.BIRDEYE_WS_TRAILING_CONFIRM_MS||'300',
        BIRDEYE_WS_IMPACT_THRESHOLD_PCT: process.env.BIRDEYE_WS_IMPACT_THRESHOLD_PCT||'3',
        BIRDEYE_SUB_POLL_MS: process.env.BIRDEYE_SUB_POLL_MS||'500',
        BIRDEYE_WATCHLIST_SUB_TTL_MS: process.env.BIRDEYE_WATCHLIST_SUB_TTL_MS||'120000',
        BIRDEYE_WS_MAX_SUBS: process.env.BIRDEYE_WS_MAX_SUBS||'500',
        BIRDEYE_WS_FRESHNESS_BYPASS_MS: process.env.BIRDEYE_WS_FRESHNESS_BYPASS_MS||'10000',
        BIRDEYE_EARLY_SUB_TTL_MS: process.env.BIRDEYE_EARLY_SUB_TTL_MS||'90000'
      },

      env_file: path.join(ROOT, '.env'),
      out_file: path.join(ROOT, 'state/pm2-out.log'),
      error_file: path.join(ROOT, 'state/pm2-err.log'),
      time: true,
    },
  ],
};
