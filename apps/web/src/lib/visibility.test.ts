import { describe, it, expect } from 'vitest';
import { becameVisible } from './visibility.ts';

describe('becameVisible', () => {
  it('is true on the hidden → visible transition', () => {
    expect(becameVisible(true, false)).toBe(true);
  });

  it('is false when already visible', () => {
    expect(becameVisible(false, false)).toBe(false);
  });

  it('is false on the visible → hidden transition', () => {
    expect(becameVisible(false, true)).toBe(false);
  });

  it('is false when staying hidden', () => {
    expect(becameVisible(true, true)).toBe(false);
  });
});
