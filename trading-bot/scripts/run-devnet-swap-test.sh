#!/usr/bin/env bash
set -euo pipefail

export HOME=/home/dshontaylor
export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

NODE_OPTIONS="--no-warnings" node trading-bot/scripts/jupiter_devnet_swap_test.cjs
