2026-04-21 - avoid --no-warnings in start_with_mock.sh
- Rationale: pm2 was forwarding node flags to bash leading to repeated "/bin/bash: --no-warnings: invalid option" errors. Replaced explicit flag with environment variable NODE_NO_WARNINGS.
- Commit: acabf33
