// Pid matching across republishes (M6.4).
//
// When an agent republishes a page, each new text element takes the pid of the
// old element it continues, so people's text and comments stay on it. Stages,
// in order, each pid used once and each stage greedy by descending score:
//   1. the agent kept the element's `data-pid`;
//   2. same tag and same path, similarity >= 0.6;
//   3. same tag anywhere, similarity >= 0.8;
//   4. otherwise a fresh pid.
// A stage-2 or stage-3 match is `uncertain` when its text repeats among the
// same-tag elements on either side ("Learn more" ×3) or when a runner-up
// scores within 0.1 of it. People's text on an uncertain match is never
// carried silently: it becomes a suggestion (carry.ts).
import { normalizeText as norm, similarity, similarityCost } from '../lib/similarity.ts';
import type { PageElement, PidInfo } from './stamp.ts';

export type PidMatch = { pid: string; uncertain: boolean };

const STAGES = [
  { samePath: true, min: 0.6 },
  { samePath: false, min: 0.8 },
];
const RUNNER_UP = 0.1;
/** Work the similarity stages may do in one republish (the page is untrusted
 *  input): character pairs compared, and at least 1 for every pair examined,
 *  rejected or not. Once spent, matching stops and the remaining elements
 *  get fresh pids. */
export const MATCH_BUDGET = 20_000_000;
/** Elements per side the similarity stages consider; later ones get fresh pids. */
export const MAX_MATCHED = 3000;
/** Candidate pairs kept per stage. */
export const MAX_PAIRS = 100_000;

/** The pid of each element of `next` (same order). */
export function matchPids(previous: PidInfo[], next: PageElement[], budget = MATCH_BUDGET, taken: string[] = []): PidMatch[] {
  let spent = 0;
  const result: (PidMatch | null)[] = next.map(() => null);
  const used = new Set<string>();
  const prevByPid = new Map(previous.map((p) => [p.pid, p]));

  // 1. Kept pids. A kept pid unknown to `previous` is simply the element's id.
  next.forEach((e, i) => {
    if (e.keptPid === undefined) return;
    result[i] = { pid: e.keptPid, uncertain: false };
    if (prevByPid.has(e.keptPid)) used.add(e.keptPid);
  });

  const repeats = (items: { tag: string; text: string }[]) => {
    const counts = new Map<string, number>();
    for (const it of items) {
      const key = `${it.tag}\u0000${norm(it.text)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return (it: { tag: string; text: string }) => (counts.get(`${it.tag}\u0000${norm(it.text)}`) ?? 0) > 1;
  };
  const repeatedNext = repeats(next);
  const repeatedPrev = repeats(previous);

  // Candidates by tag and by tag + path, from the first MAX_MATCHED previous elements.
  const byTag = new Map<string, number[]>();
  const byPath = new Map<string, number[]>();
  previous.slice(0, MAX_MATCHED).forEach((p, j) => {
    const key = `${p.tag}\u0000${p.path}`;
    if (!byTag.has(p.tag)) byTag.set(p.tag, []);
    if (!byPath.has(key)) byPath.set(key, []);
    byTag.get(p.tag)!.push(j);
    byPath.get(key)!.push(j);
  });

  // 2 and 3. Similarity stages.
  for (const stage of STAGES) {
    const pairs: { i: number; j: number; s: number }[] = [];
    examine: for (let i = 0; i < Math.min(next.length, MAX_MATCHED); i++) {
      const e = next[i]!;
      if (result[i]) continue;
      const candidates = (stage.samePath ? byPath.get(`${e.tag}\u0000${e.path}`) : byTag.get(e.tag)) ?? [];
      for (const j of candidates) {
        if (spent >= budget || pairs.length >= MAX_PAIRS) break examine;
        const p = previous[j]!;
        spent += 1;
        if (used.has(p.pid)) continue;
        const [x, y] = [p.text.length, e.text.length];
        // Edit distance is at least the length difference: skip hopeless pairs.
        if (Math.min(x, y) < stage.min * Math.max(x, y)) continue;
        const cost = similarityCost(p.text, e.text, stage.min);
        if (spent + cost > budget) break examine;
        spent += cost;
        const s = similarity(p.text, e.text, stage.min);
        if (s >= stage.min) pairs.push({ i, j, s });
      }
    }
    // The two best scores of each element on either side, for the runner-up test.
    const top = new Map<string, [number, number]>();
    const note = (key: string, s: number) => {
      const t = top.get(key) ?? [0, 0];
      if (s > t[0]) top.set(key, [s, t[0]]);
      else if (s > t[1]) top.set(key, [t[0], s]);
      else top.set(key, t);
    };
    for (const p of pairs) {
      note(`n${p.i}`, p.s);
      note(`p${p.j}`, p.s);
    }
    const runnerUpOf = (key: string, s: number) => {
      const [a, b] = top.get(key)!;
      return a === s ? b : a;
    };
    const ordered = [...pairs].sort((a, b) => b.s - a.s || a.i - b.i || a.j - b.j);
    for (const pair of ordered) {
      const prev = previous[pair.j];
      if (result[pair.i] || used.has(prev.pid)) continue;
      const runnerUp = Math.max(runnerUpOf(`n${pair.i}`, pair.s), runnerUpOf(`p${pair.j}`, pair.s));
      const uncertain =
        repeatedNext(next[pair.i]) || repeatedPrev(prev) || (runnerUp > 0 && pair.s - runnerUp <= RUNNER_UP);
      result[pair.i] = { pid: prev.pid, uncertain };
      used.add(prev.pid);
    }
  }

  // 4. Fresh pids, numbered above every pid in use or still holding a fragment.
  let n = 0;
  for (const pid of [...previous.map((p) => p.pid), ...taken, ...next.flatMap((e) => (e.keptPid ? [e.keptPid] : []))]) {
    const m = /^p(\d+)$/.exec(pid);
    if (m) n = Math.max(n, Number(m[1]));
  }
  return result.map((r) => r ?? { pid: `p${++n}`, uncertain: false });
}
