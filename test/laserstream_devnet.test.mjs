import { describe, it, expect } from 'vitest';
import { createLaserstreamDevnetClient } from '../src/providers/laserstream_devnet.mjs';

class FakeSocket {
  constructor() {
    this.sent = [];
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
  }

  send(msg) {
    this.sent.push(msg);
  }

  close() {
    this.onclose?.();
  }
}

describe('laserstream devnet client', () => {
  it('ingests messages and exposes candidates', async () => {
    let sock = null;
    const client = createLaserstreamDevnetClient({
      wsUrl: 'wss://example.invalid',
      rpcUrl: 'https://example.invalid',
      programIds: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
      reconnectBaseMs: 10,
      reconnectMaxMs: 20,
      replayLookbackSeconds: 10,
      heartbeatStaleMs: 500,
      socketFactory: () => {
        sock = new FakeSocket();
        return sock;
      },
      rpcCall: async (method) => {
        if (method === 'getSignaturesForAddress') return [];
        return null;
      },
    });

    client.start();
    sock.onopen?.();

    sock.onmessage?.({
      data: JSON.stringify({
        params: {
          result: {
            value: {
              signature: 'abc',
              logs: ['Program log: mint So11111111111111111111111111111111111111112'],
            },
          },
        },
      }),
    });

    const rows = client.drainCandidates(10);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]._source).toBe('laserstream-devnet');
    expect(client.getHealth().status).toMatch(/healthy|warming/);
    client.stop();
  });

  it('tracks disconnect and reconnect metrics', async () => {
    const sockets = [];
    const client = createLaserstreamDevnetClient({
      wsUrl: 'wss://example.invalid',
      rpcUrl: 'https://example.invalid',
      programIds: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
      reconnectBaseMs: 5,
      reconnectMaxMs: 10,
      heartbeatStaleMs: 200,
      socketFactory: () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
      rpcCall: async () => [],
    });

    client.start();
    sockets[0].onopen?.();
    sockets[0].onclose?.();
    await new Promise((r) => setTimeout(r, 25));
    const m = client.getMetrics();
    expect(m.disconnects).toBeGreaterThanOrEqual(1);
    expect(m.reconnects).toBeGreaterThanOrEqual(1);
    client.stop();
  });
});
