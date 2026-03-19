#!/usr/bin/env node
import 'dotenv/config';

import { getConfig, summarizeConfigForBoot } from '../src/config.mjs';

try {
  const cfg = getConfig();
  // Print the same boot-time summary (intentionally redacted).
  console.log(summarizeConfigForBoot(cfg));
  process.exit(0);
} catch (err) {
  console.error('[print_effective_config] ERROR:', err?.stack || err);
  process.exit(1);
}
