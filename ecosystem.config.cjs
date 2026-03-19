module.exports = {
  apps: [
    {
      name: 'solana-momentum-bot',
      cwd: '/home/dshontaylor/.openclaw/workspace/trading-bot',
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
        BIRDEYE_WS_IMPACT_THRESHOLD_PCT: process.env.BIRDEYE_WS_IMPACT_THRESHOLD_PCT||'3'
      },

      env_file: '/home/dshontaylor/.openclaw/workspace/trading-bot/.env',
      out_file: '/home/dshontaylor/.openclaw/workspace/trading-bot/state/pm2-out.log',
      error_file: '/home/dshontaylor/.openclaw/workspace/trading-bot/state/pm2-err.log',
      time: true,
    },
  ],
};
