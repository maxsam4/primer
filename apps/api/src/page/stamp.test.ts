import { describe, expect, it } from 'vitest';
import { readPids, stampPage } from './stamp.ts';
import { splicePage } from './splice.ts';
import { preparePage } from './publish.ts';

const strip = (html: string) => html.replace(/ data-pid="[^"]*"/g, '');

const PAGE = `<!doctype html>
<html><head><title>Report</title><style>p { color: red }</style></head>
<body>
  <h1 class="title">Quarterly &amp; yearly</h1>
  <div>
    <p>
      First paragraph,
      indented in the source.
    </p>
    <p>Has <b>markup</b> inside.</p>
    <p>Line one<br>Line two</p>
    <ul><li>One</li><li>Two</li></ul>
    <p>Implied end
  </div>
  <button onclick="go()">Learn more</button>
  <svg viewBox="0 0 10 10"><text x="1" y="1">Label</text></svg>
  <script>document.write('<p>drawn</p>')</script>
  <textarea>not text</textarea>
</body></html>`;

describe('stampPage', () => {
  it('stamping only inserts data-pid attributes', () => {
    const { stamped, pids } = stampPage(PAGE);
    expect(strip(stamped)).toBe(PAGE);
    expect(pids.map((p) => p.text)).toEqual([
      'Quarterly & yearly',
      'First paragraph, indented in the source.',
      'markup',
      'Line one\nLine two',
      'One',
      'Two',
      'Learn more',
      'Label',
    ]);
    expect(pids.map((p) => p.pid)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8']);
    expect(pids[1]!.path).toBe('div[0]/p[0]');
    // Stamping a stamped page changes nothing.
    expect(stampPage(stamped, pids).stamped).toBe(stamped);
    expect(splicePage(stamped, new Map(pids.map((p) => [p.pid, p.text])))).toBe(stamped);
  });

  it('script, style and nested-markup elements are not stamped', () => {
    const { pids } = stampPage(PAGE);
    const texts = pids.map((p) => p.text).join('|');
    // The <p> holding <b> is not page text; the <b> itself is.
    expect(texts).not.toContain('Has');
    expect(texts).not.toContain('drawn');
    expect(texts).not.toContain('not text');
    expect(texts).not.toContain('Report');
    expect(texts).not.toContain('Implied end');
  });

  it('br becomes a newline in text', () => {
    const { pids } = stampPage('<p>a<br>b<br/>c</p>');
    expect(pids[0]!.text).toBe('a\nb\nc');
  });

  it('existing data-pid is kept', () => {
    const page = '<h1 data-pid="intro">Hi</h1><p data-pid="intro">Dup</p><p data-pid="bad id">X</p><div data-pid="box"><p>Y</p></div>';
    const { stamped, pids } = stampPage(page);
    expect(pids.map((p) => [p.pid, p.text])).toEqual([
      ['intro', 'Hi'],
      ['p1', 'Dup'],
      ['p2', 'X'],
      ['p3', 'Y'],
    ]);
    // A pid on an element that isn't page text is removed: the bridge would wipe its children.
    expect(stamped).toBe('<h1 data-pid="intro">Hi</h1><p data-pid="p1">Dup</p><p data-pid="p2">X</p><div><p data-pid="p3">Y</p></div>');
  });

  it('offsets hold on a BOM, CRLF and astral characters', () => {
    const page = '﻿<p>a\r\nb 😀</p>\r\n<p>c</p>';
    const { stamped, pids } = stampPage(page);
    expect(strip(stamped)).toBe(page);
    expect(readPids(stamped).map((p) => stamped.slice(...p.span))).toEqual(['a\r\nb 😀', 'c']);
    expect(splicePage(stamped, new Map([['p2', 'd < e']]))).toBe('﻿<p data-pid="p1">a\r\nb 😀</p>\r\n<p data-pid="p2">d &lt; e</p>');
    expect(pids[0]!.text).toBe('a b 😀');
  });

  it('pre keeps its whitespace; embeds are never page text', () => {
    const { pids } = stampPage('<pre>a\n  b</pre><primer-table data-embed-id="t"><table><tr><td>cell</td></tr></table></primer-table>');
    expect(pids.map((p) => p.text)).toEqual(['a\n  b']);
  });
});

describe('splicePage', () => {
  it('untouched page exports the original byte for byte (with pid attributes)', () => {
    const { stamped } = stampPage(PAGE);
    expect(splicePage(stamped, new Map())).toBe(stamped);
  });

  it('editing one pid changes only its span', () => {
    const { stamped, pids } = stampPage(PAGE);
    const out = splicePage(stamped, new Map([['p2', 'New <text> & more\nnext line']]));
    const span = pids[1]!.span;
    expect(out.slice(0, span[0])).toBe(stamped.slice(0, span[0]));
    expect(out.slice(out.length - (stamped.length - span[1]))).toBe(stamped.slice(span[1]));
    expect(out.slice(span[0], out.length - (stamped.length - span[1]))).toBe('New &lt;text&gt; &amp; more<br>next line');
    expect(readPids(out)[1]!.text).toBe('New <text> & more\nnext line');
  });

  it('a pid on a script or embed element is removed', () => {
    const { stamped } = stampPage('<body><p>Text</p><script data-pid="p9">1</script><primer-code data-embed-id="c" data-pid="p8">x</primer-code></body>');
    expect(stamped).not.toContain('p9');
    expect(stamped).not.toContain('p8');
  });

  it('a page nested too deeply is refused, not a server error', () => {
    const out = preparePage(`<body>${'<div>'.repeat(5000)}text${'</div>'.repeat(5000)}</body>`);
    expect(out).toMatchObject({ refusal: { code: 'bad_request' } });
  });

  it('a fresh pid never reuses one that still holds a fragment', () => {
    const { pids } = stampPage('<body><p>Brand new</p></body>', [], ['p1', 'p7']);
    expect(pids.map((p) => p.pid)).toEqual(['p8']);
  });
});
