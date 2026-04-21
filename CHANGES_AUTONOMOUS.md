2026-04-19T12:30:57Z — PM2 interpreter fix
- Issue: PM2 process 'solana-momentum-bot' was launched with interpreter `/bin/bash` while node flags were provided, causing bash to error on `--max-old-space-size`.
- Change: Restarted process with interpreter `/usr/bin/node` and node args `--max-old-space-size=1536`.
- Risk level: Medium (runtime process reconfiguration). Monitoring: watch next 2 autonomous runs; auto-revert if metrics worsen twice consecutively.
