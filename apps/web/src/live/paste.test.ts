// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { primerSchema } from '@primer/blocks';
import { routeMarkdownPasteToServer } from './paste.ts';

afterEach(() => vi.unstubAllGlobals());

function mounted() {
  const editor = BlockNoteEditor.create({ schema: primerSchema, initialContent: [{ type: 'paragraph', content: 'Before' }, { type: 'paragraph' }] as never });
  editor.mount(document.body.appendChild(document.createElement('div')));
  routeMarkdownPasteToServer(editor);
  return editor;
}

const blocks = [
  { type: 'heading', props: { level: 2 }, content: [{ type: 'text', text: 'Pasted', styles: {} }], children: [] },
  { type: 'paragraph', content: [{ type: 'text', text: 'body', styles: {} }], children: [] },
];

describe('Markdown paste', () => {
  it('lands the server\'s blocks where the cursor was, replacing an empty paragraph', async () => {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return Response.json({ blocks });
    });
    const editor = mounted();
    editor.setTextCursorPosition(editor.document[1]!, 'start');
    await editor.pasteMarkdown('## Pasted\n\nbody');
    expect(calls).toEqual([{ markdown: '## Pasted\n\nbody' }]);
    expect(editor.document.map((b) => b.type)).toEqual(['paragraph', 'heading', 'paragraph']);
    expect(new Set(editor.document.map((b) => b.id)).size).toBe(3);
  });

  it('inserts after the cursor when the target block was removed while the server answered', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', async () => {
      await gate;
      return Response.json({ blocks });
    });
    const editor = mounted();
    editor.setTextCursorPosition(editor.document[1]!, 'start');
    const pending = editor.pasteMarkdown('## Pasted\n\nbody');
    editor.removeBlocks([editor.document[1]!]);
    release();
    await pending;
    expect(editor.document.map((b) => b.type)).toEqual(['paragraph', 'heading', 'paragraph']);
  });

  it('pastes plain text when the server cannot be reached', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const editor = mounted();
    const pasteText = vi.spyOn(editor, 'pasteText').mockReturnValue(true);
    await editor.pasteMarkdown('# kept');
    expect(pasteText).toHaveBeenCalledWith('# kept');
  });
});
