import { describe, it, expect } from 'vitest';
import { toNumber, toPositiveNumber, normalizeMarketSnapshot, normalizeBirdEyeSignals, normalizeDexPair } from '../src/lib/normalize.mjs';

describe('normalize.mjs', () => {
  describe('toNumber', () => {
    it('converts valid numbers', () => {
      expect(toNumber(42)).toBe(42);
      expect(toNumber('123')).toBe(123);
      expect(toNumber(3.14)).toBe(3.14);
    });

    it('handles edge cases', () => {
      expect(toNumber(null)).toBe(0);
      expect(toNumber(undefined)).toBe(0);
      expect(toNumber('')).toBe(0);
      expect(toNumber('invalid')).toBe(0);
      expect(toNumber(NaN)).toBe(0);
      expect(toNumber(Infinity)).toBe(0); // Infinity treated as invalid
      expect(toNumber(-Infinity)).toBe(0); // -Infinity treated as invalid
    });

    it('respects custom default', () => {
      expect(toNumber(null, 99)).toBe(0); // Number(null) = 0 which is finite
      expect(toNumber(undefined, -1)).toBe(-1); // Number(undefined) = NaN, use default
      expect(toNumber('', 42)).toBe(0); // Number('') = 0 which is finite
      expect(toNumber('invalid', 99)).toBe(99);
      expect(toNumber(NaN, 50)).toBe(50);
    });

    it('preserves negative numbers', () => {
      expect(toNumber(-5)).toBe(-5);
      expect(toNumber('-10')).toBe(-10);
    });
  });

  describe('toPositiveNumber', () => {
    it('converts valid positive numbers', () => {
      expect(toPositiveNumber(42)).toBe(42);
      expect(toPositiveNumber('123')).toBe(123);
      expect(toPositiveNumber(3.14)).toBe(3.14);
    });

    it('converts negatives to default', () => {
      expect(toPositiveNumber(-5)).toBe(0);
      expect(toPositiveNumber('-10')).toBe(0);
      expect(toPositiveNumber(-5, 99)).toBe(99);
    });

    it('handles edge cases', () => {
      expect(toPositiveNumber(null)).toBe(0);
      expect(toPositiveNumber(undefined)).toBe(0);
      expect(toPositiveNumber('')).toBe(0);
      expect(toPositiveNumber('invalid')).toBe(0);
      expect(toPositiveNumber(NaN)).toBe(0);
      expect(toPositiveNumber(Infinity)).toBe(0); // Infinity treated as invalid
      expect(toPositiveNumber(-Infinity)).toBe(0);
    });
  });

  describe('normalizeMarketSnapshot', () => {
    it('normalizes complete market data', () => {
      const raw = {
        price: '1.234',
        mcap: '1000000',
        liquidity: { usd: '50000' },
        volume: { h24: '100000' },
        priceChange: { h24: '15.5' },
        txns: { h24: { buys: '150', sells: '100' } }
      };
      const result = normalizeMarketSnapshot(raw);
      expect(result.price).toBe(1.234);
      expect(result.mcap).toBe(1000000);
      expect(result.liquidity.usd).toBe(50000);
      expect(result.volume.h24).toBe(100000);
      expect(result.priceChange.h24).toBe(15.5);
      expect(result.txns.h24.buys).toBe(150);
      expect(result.txns.h24.sells).toBe(100);
    });

    it('handles missing fields gracefully', () => {
      const result = normalizeMarketSnapshot({});
      expect(result.price).toBe(0);
      expect(result.mcap).toBe(0);
      expect(result.liquidity.usd).toBe(0);
      expect(result.volume.h24).toBe(0);
      expect(result.priceChange.h24).toBe(0);
      expect(result.txns.h24.buys).toBe(0);
      expect(result.txns.h24.sells).toBe(0);
    });

    it('handles null input', () => {
      const result = normalizeMarketSnapshot(null);
      expect(result.price).toBe(0);
      expect(result.mcap).toBe(0);
    });
  });

  describe('normalizeBirdEyeSignals', () => {
    it('normalizes BirdEye data', () => {
      const raw = {
        price: '2.5',
        volume_5m: '10000',
        volume_30m_avg: '8000',
        buy_sell_ratio: '1.5',
        tx_1m: '10',
        tx_5m_avg: '8',
        tx_1h: '200',
        rolling_high_5m: '2.6'
      };
      const result = normalizeBirdEyeSignals(raw);
      expect(result.price).toBe(2.5);
      expect(result.volume_5m).toBe(10000);
      expect(result.volume_30m_avg).toBe(8000);
      expect(result.buy_sell_ratio).toBe(1.5);
      expect(result.tx_1m).toBe(10);
      expect(result.tx_5m_avg).toBe(8);
      expect(result.tx_1h).toBe(200);
      expect(result.rolling_high_5m).toBe(2.6);
    });

    it('handles missing fields', () => {
      const result = normalizeBirdEyeSignals({});
      expect(result.price).toBe(0);
      expect(result.volume_5m).toBe(0);
    });
  });

  describe('normalizeDexPair', () => {
    it('normalizes DEX pair data', () => {
      const raw = {
        priceUsd: '1.5',
        liquidity: { usd: '100000' },
        volume: { h1: '50000', h24: '200000' },
        priceChange: { h1: '5', h24: '10' },
        txns: { h1: { buys: '50', sells: '40' }, h24: { buys: '500', sells: '400' } }
      };
      const result = normalizeDexPair(raw);
      expect(result.priceUsd).toBe(1.5);
      expect(result.liquidity.usd).toBe(100000);
      expect(result.volume.h1).toBe(50000);
      expect(result.volume.h24).toBe(200000);
      expect(result.priceChange.h1).toBe(5);
      expect(result.priceChange.h24).toBe(10);
      expect(result.txns.h1.buys).toBe(50);
      expect(result.txns.h1.sells).toBe(40);
    });

    it('handles missing nested fields', () => {
      const result = normalizeDexPair({ priceUsd: '1.0' });
      expect(result.priceUsd).toBe(1.0);
      expect(result.liquidity.usd).toBe(0);
      expect(result.volume.h1).toBe(0);
      expect(result.txns.h1.buys).toBe(0);
    });
  });
});
