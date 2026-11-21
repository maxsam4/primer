// @vitest-environment jsdom
//
// The real v1.js, run in jsdom: the page-text bridge reports stamped
// elements and sets only their text.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'src/companion/v1.js'), 'utf8');

/** Loads the bridge into the current page and inits it with `features`;
 *  returns what it posts to the host and a way to send it messages. */
async function boot(features: string[]) {
  const posted: Record<string, unknown>[] = [];
  const port = {
    onmessage: null as ((e: { data: unknown }) => void) | null,
    postMessage: (msg: Record<string, unknown>) => void posted.push(msg),
    start: () => undefined,
    close: () => undefined,
  };
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
  new Function(src)();
  const event = new MessageEvent('message', { data: { type: 'init', anchors: [], theme: 'light', features } });
  Object.defineProperty(event, 'ports', { value: [port] });
  Object.defineProperty(event, 'source', { value: window.parent });
  window.dispatchEvent(event);
  await new Promise((r) => setTimeout(r, 10));
  const send = (data: unknown) => port.onmessage!({ data });
  return { posted, send };
}

describe('page text bridge', () => {
  it('a hard-wrapped paragraph reads as the server reads it', async () => {
    document.body.innerHTML = '<p data-pid="p1">\n  A long paragraph wrapped\n  across lines.<br>\n  Second line.\n</p>';
    const { posted } = await boot(['page-text']);
    const report = posted.find((m) => m.type === 'page_elements') as { elements: { pid: string; text: string }[] };
    expect(report.elements.map(({ text }) => text)).toEqual(['A long paragraph wrapped across lines.\nSecond line.']);
  });

  it('set_page_texts only touches stamped nodes', async () => {
    document.body.innerHTML = [
      '<h1 data-pid="p1">Roadmap</h1>',
      '<p data-pid="p2">Ship <!-- c -->in May.</p>',
      '<p id="plain">Not stamped</p>',
      '<primer-table data-embed-id="t"><p data-pid="p9">inside</p></primer-table>',
      '<p data-pid="p3">Drawn</p>',
    ].join('');
    // A page script drew p3's text before the bridge reported.
    document.querySelector('[data-pid="p3"]')!.textContent = 'Q3: $1.2M';
    const { posted, send } = await boot(['page-text']);

    const report = posted.find((m) => m.type === 'page_elements') as { elements: { pid: string; text: string }[] };
    expect(report.elements.map(({ pid, text }) => [pid, text])).toEqual([
      ['p1', 'Roadmap'],
      ['p2', 'Ship in May.'],
      ['p3', 'Q3: $1.2M'],
    ]);

    send({ type: 'set_page_texts', texts: { p1: 'Roadmap <b>2027</b>\nnext', p9: 'hijack', plain: 'x', 'p2"],[id': 'x' } });
    expect(document.querySelector('[data-pid="p1"]')!.innerHTML).toBe('Roadmap &lt;b&gt;2027&lt;/b&gt;<br>next');
    expect(document.querySelector('[data-pid="p9"]')!.textContent).toBe('inside');
    expect(document.getElementById('plain')!.textContent).toBe('Not stamped');
    expect(document.querySelector('[data-pid="p2"]')!.textContent).toBe('Ship in May.');
  });
});
