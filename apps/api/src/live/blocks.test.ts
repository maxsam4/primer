import { describe, expect, it } from 'vitest';
import { Transform } from '@tiptap/pm/transform';
import { blockVersion, findBlock } from './blocks.ts';
import { serverEditor } from './editor.ts';

describe('blockVersion', () => {
  it("editing a child changes the parent's version", () => {
    const editor = serverEditor();
    const build = (childText: string) =>
      editor._blocksToProsemirrorNode([
        {
          id: 'parent',
          type: 'bulletListItem',
          content: 'Parent',
          children: [{ id: 'child', type: 'bulletListItem', content: childText }],
        },
      ]);
    const before = build('Child');
    const after = build('Child, edited');
    const version = (doc: typeof before, id: string) => blockVersion(findBlock(doc, id)!.node);

    expect(version(before, 'parent')).toMatch(/^[0-9a-f]{16}$/);
    expect(version(after, 'parent')).not.toBe(version(before, 'parent'));
    expect(version(after, 'child')).not.toBe(version(before, 'child'));

    // A comment on the child annotates it; it doesn't change any version.
    const child = findBlock(before, 'child')!;
    const tr = new Transform(before).addMark(
      child.pos + 2,
      child.pos + 2 + 'Child'.length,
      editor.editor.pmSchema.marks.comment!.create({ threadId: 't1' }),
    );
    expect(tr.docChanged).toBe(true);
    expect(version(tr.doc, 'child')).toBe(version(before, 'child'));
    expect(version(tr.doc, 'parent')).toBe(version(before, 'parent'));
  });

  it('a comment on part of a run does not change the version', () => {
    const editor = serverEditor();
    const doc = editor._blocksToProsemirrorNode([{ id: 'b', type: 'paragraph', content: 'Hello brave world' }]);
    const block = findBlock(doc, 'b')!;
    const from = block.pos + 2 + 'Hello '.length;
    const tr = new Transform(doc).addMark(
      from,
      from + 'brave'.length,
      editor.editor.pmSchema.marks.comment!.create({ threadId: 't1' }),
    );
    expect(tr.doc.toJSON()).not.toEqual(doc.toJSON());
    expect(blockVersion(findBlock(tr.doc, 'b')!.node)).toBe(blockVersion(block.node));
  });
});

describe('layout blocks', () => {
  it('findBlock finds a column and the blocks inside it', () => {
    const doc = serverEditor()._blocksToProsemirrorNode([
      {
        id: 'cols',
        type: 'columnList',
        children: [
          { id: 'left', type: 'column', children: [{ id: 'l1', type: 'paragraph', content: 'Left' }] },
          { id: 'right', type: 'column', children: [{ id: 'r1', type: 'paragraph', content: 'Right' }] },
        ],
      },
    ] as never);
    for (const id of ['cols', 'left', 'right', 'l1', 'r1']) expect(findBlock(doc, id), id).not.toBeNull();
    // Editing a block inside a column changes the column's and the list's version.
    const edited = serverEditor()._blocksToProsemirrorNode([
      {
        id: 'cols',
        type: 'columnList',
        children: [
          { id: 'left', type: 'column', children: [{ id: 'l1', type: 'paragraph', content: 'Left, edited' }] },
          { id: 'right', type: 'column', children: [{ id: 'r1', type: 'paragraph', content: 'Right' }] },
        ],
      },
    ] as never);
    const version = (d: typeof doc, id: string) => blockVersion(findBlock(d, id)!.node);
    expect(version(edited, 'left')).not.toBe(version(doc, 'left'));
    expect(version(edited, 'cols')).not.toBe(version(doc, 'cols'));
    expect(version(edited, 'right')).toBe(version(doc, 'right'));
  });
});
