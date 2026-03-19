import { describe, it, expect } from 'vitest';
import { didEntryFill } from '../src/entry_reliability.mjs';

describe('didEntryFill', () => {
  it('treats modern swap result signature as a fill', () => {
    expect(didEntryFill({ signature: 'abc123' })).toBe(true);
  });

  it('supports legacy entryTx field for compatibility', () => {
    expect(didEntryFill({ entryTx: 'legacySig' })).toBe(true);
  });

  it('returns false when no tx marker exists', () => {
    expect(didEntryFill({})).toBe(false);
    expect(didEntryFill(null)).toBe(false);
  });
});
