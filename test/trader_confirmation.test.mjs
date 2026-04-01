import { describe, it, expect, vi } from 'vitest';
import { confirmSignatureRobust } from '../src/trading/trader.mjs';

describe('confirmSignatureRobust', () => {
  it('falls back to HTTP status polling when websocket confirm times out', async () => {
    const conn = {
      confirmTransaction: vi.fn(() => new Promise(() => {})),
      getSignatureStatuses: vi
        .fn()
        .mockResolvedValueOnce({ value: [null] })
        .mockResolvedValueOnce({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
      getTransaction: vi.fn().mockResolvedValue(null),
    };

    const res = await confirmSignatureRobust(conn, 'sig-1', {
      wsTimeoutMs: 5,
      pollMaxMs: 80,
      pollStartMs: 5,
      pollMaxIntervalMs: 10,
    });

    expect(res.ok).toBe(true);
    expect(res.reason).toBe('http_status_confirmed');
    expect(conn.getSignatureStatuses).toHaveBeenCalled();
  });

  it('falls back to getTransaction when websocket is unsupported', async () => {
    const conn = {
      confirmTransaction: vi.fn().mockRejectedValue(new Error('Method not found: signatureSubscribe')),
      getSignatureStatuses: vi.fn().mockResolvedValue({ value: [null] }),
      getTransaction: vi.fn().mockResolvedValue({ meta: { err: null } }),
    };

    const res = await confirmSignatureRobust(conn, 'sig-2', {
      wsTimeoutMs: 5,
      pollMaxMs: 80,
      pollStartMs: 5,
      pollMaxIntervalMs: 10,
    });

    expect(res.ok).toBe(true);
    expect(res.reason).toBe('http_tx_found');
  });

  it('returns bounded timeout failure when neither websocket nor HTTP confirms', async () => {
    const conn = {
      confirmTransaction: vi.fn().mockRejectedValue(new Error('websocket unavailable')),
      getSignatureStatuses: vi.fn().mockResolvedValue({ value: [null] }),
      getTransaction: vi.fn().mockResolvedValue(null),
    };

    const res = await confirmSignatureRobust(conn, 'sig-3', {
      wsTimeoutMs: 5,
      pollMaxMs: 30,
      pollStartMs: 5,
      pollMaxIntervalMs: 10,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe('http_timeout');
    expect(res.signature).toBe('sig-3');
  });
});
