/** Text as similarity compares it: trimmed, whitespace collapsed, lowercase. */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * How alike two texts are, from 0 to 1 (plan M6.4):
 * `1 - levenshtein(norm(a), norm(b)) / max(len, 1)`, over normalized text.
 * Used for Markdown republish alignment (M5.3), page pid matching (M6.4) and
 * re-anchoring (M10b).
 *
 * With `min`, only scores ≥ `min` are computed exactly: the edit distance is
 * banded and stops once it can't reach `min`, and anything below returns 0.
 * The work is then at most `len × (2·(1 − min)·len + 1)` character pairs
 * (`similarityCost`), so callers comparing untrusted text can budget it.
 */
export function similarity(a: string, b: string, min = 0): number {
  const x = normalizeText(a);
  const y = normalizeText(b);
  const len = Math.max(x.length, y.length);
  if (len === 0) return 1;
  const limit = Math.floor((1 - min) * len);
  const distance = boundedLevenshtein(x, y, limit);
  if (distance === null) return 0;
  const score = 1 - distance / len;
  return score >= min ? score : 0;
}

/** Character pairs `similarity(a, b, min)` compares at most. */
export function similarityCost(a: string, b: string, min = 0): number {
  const len = Math.max(a.length, b.length);
  return Math.min(a.length, b.length) * (2 * Math.floor((1 - min) * len) + 1);
}

/** Edit distance (insertions, deletions, substitutions). */
export function levenshtein(a: string, b: string): number {
  return boundedLevenshtein(a, b, Math.max(a.length, b.length))!;
}

/**
 * Edit distance if it is at most `limit`, else null. Only cells within
 * `limit` of the diagonal can stay under it, so only those are computed, and
 * a row whose every cell is over `limit` ends the search.
 */
function boundedLevenshtein(a: string, b: string, limit: number): number | null {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > limit) return null;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const over = limit + 1;
  let prev = new Array<number>(b.length + 1).fill(over);
  let row = new Array<number>(b.length + 1).fill(over);
  // Each row computes only its band, O(len × limit) in all.
  for (let j = 0; j <= Math.min(b.length, limit); j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const from = Math.max(1, i - limit);
    const to = Math.min(b.length, i + limit);
    // Cells just outside the band read as over the limit.
    row[0] = i <= limit ? i : over;
    if (from > 1) row[from - 1] = over;
    if (to < b.length) row[to + 1] = over;
    let best = row[0];
    for (let j = from; j <= to; j++) {
      const cell = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      row[j] = Math.min(cell, over);
      if (row[j]! < best) best = row[j]!;
    }
    if (best > limit) return null;
    [prev, row] = [row, prev];
  }
  return prev[b.length]! <= limit ? prev[b.length]! : null;
}
