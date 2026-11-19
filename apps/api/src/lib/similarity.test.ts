import { describe, expect, it } from 'vitest';
import { levenshtein, similarity } from './similarity.ts';

describe('similarity', () => {
  it('normalizes and scores by edit distance, exactly at or over a minimum', () => {
    expect(similarity('  Hello   World ', 'hello world')).toBe(1);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(similarity('kitten', 'sitting')).toBeCloseTo(1 - 3 / 7);
    expect(similarity('kitten', 'sitting', 0.8)).toBe(0);
    for (const [a, b] of [['kitten', 'sitting'], ['abcdef', 'azced'], ['', 'abc'], ['flaw', 'lawn'], ['a'.repeat(50), 'a'.repeat(30) + 'b'.repeat(20)]]) {
      const full = similarity(a!, b!);
      for (const min of [0.3, 0.5, 0.7]) expect(similarity(a!, b!, min)).toBe(full >= min ? full : 0);
    }
  });
});
