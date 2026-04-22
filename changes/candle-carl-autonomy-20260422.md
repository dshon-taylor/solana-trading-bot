Autonomous Candle Carl run 2026-04-22
- Ensured KEYPAIR_PATH and HEALTH_PORT present in .env (KEYPAIR_PATH=/home/dshontaylor/wallet-setup/keys/keypair.json)
- Observed missing env exposure in process; restarted PM2 process with updated env
- Verified process online and metrics healthy
Rationale: runtime showed startup validation errors for missing KEYPAIR_PATH and SOPS_WALLET_FILE; adding/ensuring these in .env and restarting with --update-env is low-risk and restores normal operation.
