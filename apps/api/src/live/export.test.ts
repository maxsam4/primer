import { readFileSync, readdirSync } from 'node:fs';
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import type { PlannedEdit } from './pipeline.ts';
import { applyPlan } from './pipeline.ts';
import { SYSTEM_ORIGIN } from './origin.ts';
import { buildLiveDoc, importMarkdown, importText } from './import.ts';
import { exportHtml, exportMarkdown, exportText } from './export.ts';
import { readBlocks } from './editor.ts';
import { createLiveDoc, seedBlocks, withLiveDoc } from './live.testlib.ts';

const fixtures = new URL('./__fixtures__/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, fixtures), 'utf8');

/** A stored live document holding `source`, imported. */
async function storedImport(source: string): Promise<string> {
  const id = await createLiveDoc();
  const built = buildLiveDoc(await importMarkdown(source), 'markdown', id);
  await withLiveDoc(id, (doc) => Y.applyUpdate(doc, Y.encodeStateAsUpdate(built)));
  return id;
}

const blockWithText = (id: string, text: string) =>
  withLiveDoc(id, (doc) => {
    const all = (blocks: ReturnType<typeof readBlocks>): ReturnType<typeof readBlocks> => blocks.flatMap((b) => [b, ...all(b.children as never)]);
    return all(readBlocks(doc, 'main')).find((b) => JSON.stringify(b.content ?? b.props).includes(text))!.id;
  });

/** Replaces a text block's text through the pipeline. */
function setText(blockId: string, text: string): PlannedEdit {
  return {
    target: { tabId: 'main', blockId },
    inverse: false,
    build: (tr, at) => {
      const content = at!.node.firstChild!;
      tr.replaceWith(at!.pos + 2, at!.pos + 1 + content.nodeSize - 1, tr.doc.type.schema.text(text));
    },
  };
}

const exportOf = (id: string) => withLiveDoc(id, (doc) => exportMarkdown(doc, id));

/** The [first, last] input lines that differ from the output, or null. */
function changedLines(input: string, output: string): [number, number] | null {
  const a = input.split('\n');
  const b = output.split('\n');
  let start = 0;
  while (start < a.length && a[start] === b[start]) start++;
  if (start === a.length && a.length === b.length) return null;
  let end = 0;
  while (end < a.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return [start, a.length - 1 - end];
}

describe('export', () => {
  it('untouched round trip is byte-identical', async () => {
    for (const name of readdirSync(fixtures).filter((f) => f.endsWith('.md'))) {
      // Every sample as written, and with Windows line endings.
      for (const source of [fixture(name), fixture(name).replace(/\n/g, '\r\n')]) {
        expect(await exportMarkdown(buildLiveDoc(await importMarkdown(source), 'markdown', 'doc-1'), 'doc-1'), name).toBe(source);
      }
    }
  });

  it('.txt round trip is byte-identical', () => {
    const source = fixture('plain.txt');
    expect(exportText(buildLiveDoc(importText(source), 'text', 'doc-1'), 'doc-1')).toBe(source);
  });

  it('editing one block changes only its lines', async () => {
    const source = fixture('changelog.md');
    const id = await storedImport(source);
    const block = await blockWithText(id, 'All notable changes');
    await applyPlan(id, SYSTEM_ORIGIN, { onConflict: 'refuse', edits: [setText(block, 'Every notable change is listed here.')] });
    const out = await exportOf(id);
    expect(out).toContain('Every notable change is listed here.');
    const line = source.split('\n').indexOf('All notable changes to this project are documented in this file.');
    expect(changedLines(source, out)).toEqual([line, line]);
  });

  it('editing a child item re-serialises its list group', async () => {
    const source = fixture('readme.md');
    const id = await storedImport(source);
    const child = await blockWithText(id, 'threads survive edits');
    await applyPlan(id, SYSTEM_ORIGIN, { onConflict: 'refuse', edits: [setText(child, 'threads survive every edit')] });
    const out = await exportOf(id);
    expect(out).toContain('threads survive every edit');
    const lines = source.split('\n');
    const first = lines.findIndex((l) => l.startsWith('- **Live documents**'));
    const last = lines.findIndex((l) => l.includes('~~approximate~~'));
    const [from, to] = changedLines(source, out)!;
    expect(from).toBeGreaterThanOrEqual(first);
    expect(to).toBeLessThanOrEqual(last);
    // Groups before and after the list are still verbatim.
    expect(out).toContain('> Primer keeps the original file of every upload.\n');
    expect(out.startsWith(source.slice(0, source.indexOf('- **Live documents**')))).toBe(true);
  });

  it('editing a reference definition re-serialises the groups that use it', async () => {
    const source = fixture('readme.md');
    const id = await storedImport(source);
    const definition = await blockWithText(id, '[contrib]: ');
    await applyPlan(id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: [
        {
          target: { tabId: 'main', blockId: definition },
          inverse: false,
          build: (tr, at) => {
            const content = at!.node.firstChild!;
            tr.setNodeMarkup(at!.pos + 1, undefined, { ...content.attrs, markdown: '[contrib]: https://example.com/contributing\n' });
          },
        },
      ],
    });
    const out = await exportOf(id);
    expect(out).toContain('[contrib]: https://example.com/contributing\n');
    // The paragraph that used the label no longer relies on it.
    expect(out).not.toContain('[contributing guide][contrib]');
    expect(out).toContain('[contributing guide](');
    // Unrelated groups stay verbatim.
    expect(out).toContain('## Quick start\n');
  });

  it('a source slice or front matter rewritten by a client never reaches the export', async () => {
    const source = fixture('adr.md');
    const id = await storedImport(source);
    const heading = await blockWithText(id, 'ADR 7: One apply pipeline');
    // What any editor's socket could write: the maps live in the Y.Doc.
    await withLiveDoc(id, (doc) => {
      const sources = doc.getMap<Record<string, unknown>>('sources');
      const entry = sources.get(heading)!;
      sources.set(heading, { ...entry, slice: '# ADR 7: One apply pipeline\n\nHIDDEN-SLICE-TEXT\n' });
      doc.getMap('meta').set('frontMatter', '---\nnote: HIDDEN-FRONT-MATTER\n---\n');
    });
    const out = await exportOf(id);
    expect(out).not.toContain('HIDDEN');
    // The heading is serialised from its block instead, and the rest stays verbatim.
    expect(out).toContain('# ADR 7: One apply pipeline\n');
    expect(out).toContain('| Agent ops | agent | block version |');
    // An entry copied from another document doesn't verify either.
    const other = await storedImport(source);
    const copied = await withLiveDoc(other, (doc) => doc.getMap('sources').toJSON());
    await withLiveDoc(id, (doc) => {
      for (const [key, value] of Object.entries(copied)) doc.getMap('sources').set(key, value);
    });
    expect(await exportOf(id)).not.toContain('HIDDEN');
  });

  it('embeds export as text and columns export in reading order', async () => {
    const id = await createLiveDoc();
    await seedBlocks(id, [
      { id: 'e1', type: 'embed', props: { url: 'https://example.com/page' } } as never,
      { id: 'e2', type: 'embed', props: { url: 'javascript:alert(1)' } } as never,
      {
        id: 'cols',
        type: 'columnList',
        children: [
          { id: 'c1', type: 'column', children: [{ id: 'a', type: 'paragraph', content: 'Left' }] },
          { id: 'c2', type: 'column', children: [{ id: 'b', type: 'paragraph', content: 'Right' }] },
        ],
      } as never,
    ]);
    const text = await withLiveDoc(id, (doc) => exportText(doc, id));
    expect(text).toContain('https://example.com/page');
    expect(text).not.toContain('javascript:');
    const markdown = await withLiveDoc(id, (doc) => exportMarkdown(doc, id));
    expect(markdown.indexOf('Left')).toBeGreaterThanOrEqual(0);
    expect(markdown.indexOf('Left')).toBeLessThan(markdown.indexOf('Right'));
  });

  it('static HTML inlines the document images', async () => {
    const png = 'primer-blob://01900000-0000-7000-8000-0000000000aa';
    const doc = buildLiveDoc(await importMarkdown(`![pic](${png})\n`), 'markdown', 'doc-img');
    const html = await exportHtml(doc, 'T', new Map(), async () => ({ contentType: 'image/png', bytes: Uint8Array.from([1, 2, 3]) }));
    expect(html).toContain('data:image/png;base64,AQID');
    expect(html).not.toContain(png);
  });
});
