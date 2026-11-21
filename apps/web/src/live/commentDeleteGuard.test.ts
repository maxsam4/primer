import { describe, expect, it } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Transaction } from '@tiptap/pm/state';
import { commentDeleteGuard, type HeldDelete } from './commentDeleteGuard.ts';

const schema = new Schema({
  nodes: { doc: { content: 'paragraph+' }, paragraph: { content: 'text*' }, text: {} },
  marks: { comment: { attrs: { threadId: { default: '' }, orphan: { default: false } }, excludes: '' } },
});

function setup(open: string[]) {
  let held: HeldDelete | null = null;
  let state: EditorState;
  const dispatch = (tr: Transaction) => (state = state.apply(tr));
  const plugin = commentDeleteGuard({
    openThreadIds: () => new Set(open),
    quoteOf: (id) => (id === 't1' ? 'brave' : id),
    onHold: (h) => (held = h),
    dispatch,
    currentDoc: () => state.doc,
  });
  const mark = schema.marks.comment.create({ threadId: 't1' });
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('Hello '), schema.text('brave', [mark]), schema.text(' world')]),
  ]);
  state = EditorState.create({ doc, plugins: [plugin] });
  return { get state() { return state; }, apply: (tr: Transaction) => (state = state.apply(tr)), get held() { return held; } };
}

describe('commentDeleteGuard', () => {
  it('deleting or replacing commented text is held for confirmation and passes with the override', () => {
    const ed = setup(['t1']);
    // Typing over a selection that covers the commented word.
    const replace = ed.state.tr.setSelection(TextSelection.create(ed.state.doc, 5, 13)).insertText('x');
    ed.apply(replace);
    expect(ed.state.doc.textContent).toBe('Hello brave world');
    expect(ed.held!.quotes).toEqual(['brave']);
    // Unrelated edits pass.
    ed.apply(ed.state.tr.insertText('!', 18));
    expect(ed.state.doc.textContent).toBe('Hello brave world!');
    // The held change no longer matches the document, so it isn't applied.
    expect(ed.held!.confirm()).toBe(false);
    expect(ed.state.doc.textContent).toBe('Hello brave world!');
    // Deleting the word, then "Delete anyway".
    ed.apply(ed.state.tr.delete(7, 12));
    expect(ed.state.doc.textContent).toBe('Hello brave world!');
    expect(ed.held!.confirm()).toBe(true);
    expect(ed.state.doc.textContent).toBe('Hello  world!');
  });

  it('resolved threads never hold a delete', () => {
    const ed = setup([]);
    ed.apply(ed.state.tr.delete(7, 12));
    expect(ed.state.doc.textContent).toBe('Hello  world');
    expect(ed.held).toBeNull();
  });
});
