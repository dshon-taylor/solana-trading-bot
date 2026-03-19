#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createLaserstreamDevnetClient } from '../src/laserstream_devnet.mjs';

const durationMin = Math.max(1, Number(process.env.LASERSTREAM_SOAK_MINUTES || process.argv[2] || 10));
const durationMs = durationMin * 60_000;

const client = createLaserstreamDevnetClient({
  wsUrl: process.env.LASERSTREAM_DEVNET_WS_URL,
  rpcUrl: process.env.LASERSTREAM_DEVNET_RPC_URL,
  programIds: String(process.env.LASERSTREAM_PROGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
  reconnectBaseMs: Number(process.env.LASERSTREAM_RECONNECT_BASE_MS || 1000),
  reconnectMaxMs: Number(process.env.LASERSTREAM_RECONNECT_MAX_MS || 15000),
  replayLookbackSeconds: Number(process.env.LASERSTREAM_REPLAY_LOOKBACK_SECONDS || 120),
  heartbeatStaleMs: Number(process.env.LASERSTREAM_HEARTBEAT_STALE_MS || 15000),
  bufferMax: Number(process.env.LASERSTREAM_BUFFER_MAX || 2000),
  log: (...args) => console.log(...args),
});

function summarize(result) {
  const m = result.metrics || {};
  const h = result.health || {};
  const reconnectRate = m.uptimeMs ? (m.reconnects / (m.uptimeMs / 3_600_000)) : 0;
  return {
    status: h.status,
    lastMessageAgeMs: h.lastMessageAgeMs,
    disconnects: m.disconnects,
    reconnects: m.reconnects,
    replayedMessages: m.replayedMessages,
    liveMessages: m.liveMessages,
    receivedCandidates: m.receivedCandidates,
    queueDepth: m.queueDepth,
    lagMs: m.lagMs,
    reconnectsPerHour: Number(reconnectRate.toFixed(3)),
  };
}

const start = Date.now();
console.log(`[laserstream-soak] start durationMin=${durationMin}`);
client.start();
await new Promise((resolve) => setTimeout(resolve, durationMs));
const result = { health: client.getHealth(), metrics: client.getMetrics() };
client.stop();
const end = Date.now();

const payload = {
  startedAt: new Date(start).toISOString(),
  endedAt: new Date(end).toISOString(),
  durationMin,
  summary: summarize(result),
  health: result.health,
  metrics: result.metrics,
};

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve('analysis');
fs.mkdirSync(outDir, { recursive: true });
const jsonPath = path.join(outDir, `laserstream_soak_${stamp}.json`);
const mdPath = path.join(outDir, `laserstream_soak_${stamp}.md`);

fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

const md = [
  `# LaserStream Devnet Soak (${stamp})`,
  '',
  `- durationMin: ${durationMin}`,
  `- status: ${payload.summary.status}`,
  `- lastMessageAgeMs: ${payload.summary.lastMessageAgeMs}`,
  `- disconnects: ${payload.summary.disconnects}`,
  `- reconnects: ${payload.summary.reconnects}`,
  `- replayedMessages: ${payload.summary.replayedMessages}`,
  `- liveMessages: ${payload.summary.liveMessages}`,
  `- receivedCandidates: ${payload.summary.receivedCandidates}`,
  `- queueDepth: ${payload.summary.queueDepth}`,
  `- lagMs: ${payload.summary.lagMs}`,
  `- reconnectsPerHour: ${payload.summary.reconnectsPerHour}`,
  '',
  'Interpretation:',
  '- healthy if status=healthy and lastMessageAgeMs < LASERSTREAM_HEARTBEAT_STALE_MS',
  '- reconnect churn warning if reconnectsPerHour > 6',
  '- replayedMessages > 0 indicates backfill path exercised',
  '- queueDepth near LASERSTREAM_BUFFER_MAX means downstream consumer is too slow',
  '',
  `Raw JSON: ${path.relative(process.cwd(), jsonPath)}`,
].join('\n');

fs.writeFileSync(mdPath, `${md}\n`, 'utf8');

console.log(`[laserstream-soak] wrote ${path.relative(process.cwd(), jsonPath)}`);
console.log(`[laserstream-soak] wrote ${path.relative(process.cwd(), mdPath)}`);
console.log(JSON.stringify(payload.summary, null, 2));

setTimeout(() => process.exit(0), 100).unref();
