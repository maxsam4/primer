import {
  BLOCK_LEVEL_SUGGESTION_GROUP,
  BlockNoteSchema,
  NON_FORMATTING_MARK_GROUP,
  createCodeBlockSpec,
  createExtension,
  defaultBlockSpecs,
} from '@blocknote/core';
import { Mark } from '@tiptap/core';
import { CommentMark } from '@blocknote/core/comments';
import { codeBlockOptions } from '@blocknote/code-block';
import { createReactMathBlockSpec } from '@blocknote/math-block';
import { createReactDiagramBlockSpec } from '@blocknote/diagram-block';
import { sourceBlock } from './source.tsx';

/**
 * Primer's document model: every stock BlockNote block, code with languages,
 * math, Mermaid, and Primer's own blocks as they land. The API's server editor
 * and the web editor both use it, so a document reads the same everywhere.
 */
export const primerSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    mathBlock: createReactMathBlockSpec(),
    diagram: createReactDiagramBlockSpec(),
    source: sourceBlock(),
  },
});

export type PrimerSchema = typeof primerSchema;

/**
 * BlockNote's `comment` mark, registered without the comments UI. Comment
 * marks are part of the document (they anchor threads), so every editor that
 * opens a Y.Doc must know the mark: y-prosemirror deletes text whose marks the
 * schema doesn't know. The web editor swaps this for BlockNote's
 * CommentsExtension, which registers the same mark, once comments ship.
 */
export const commentMarkExtension = createExtension({
  key: 'primerCommentMark',
  tiptapExtensions: [CommentMark],
});

/**
 * The suggestion marks of @handlewithcare/prosemirror-suggest-changes
 * (`insertion`, `deletion`, `modification`: same names, attrs, `inclusive` and
 * `excludes`) as Tiptap marks, as BlockNote's xl-ai declares them. `id` is a
 * suggestion's UUID. Like comments they are document content: every editor
 * that opens a Y.Doc must register them, or y-prosemirror deletes the text
 * they mark. Inline, `insertion` and `deletion` exclude themselves, so
 * y-prosemirror stores each as one plain Y.Text formatting attribute keyed by
 * its name; `modification` does not exclude itself and would be keyed
 * `modification--<hash>`, but the library only puts it on nodes. Node marks
 * (whole-block suggestions, `modification`) are not stored by y-prosemirror
 * 1.3.7 at all; see apps/api/src/live/suggest.spike.test.ts.
 */
function suggestionMark(name: 'insertion' | 'deletion' | 'modification', excludes: string, tag: string) {
  return Mark.create({
    name,
    inclusive: false,
    excludes,
    // Allowed on block nodes (a whole inserted/deleted block) and in plain blocks (code).
    group: `${BLOCK_LEVEL_SUGGESTION_GROUP} ${NON_FORMATTING_MARK_GROUP}`,
    addAttributes() {
      const id = { id: { default: null } };
      if (name !== 'modification') return id;
      return {
        ...id,
        type: { default: null },
        attrName: { default: null },
        previousValue: { default: null },
        newValue: { default: null },
      };
    },
    renderHTML: ({ mark }) => [tag, { 'data-suggestion': name, 'data-id': String(mark.attrs.id) }, 0],
    parseHTML: () => [{ tag: `${tag}[data-suggestion="${name}"]`, getAttrs: (el) => ({ id: (el as HTMLElement).dataset.id }) }],
    // Not a BlockNote style: blocks read through the marked text.
    extendMarkSchema: (extension) => (extension.name === name ? { blocknoteIgnore: true } : {}),
  });
}

export const suggestionMarksExtension = createExtension({
  key: 'primerSuggestionMarks',
  tiptapExtensions: [
    suggestionMark('insertion', 'deletion modification insertion', 'ins'),
    suggestionMark('deletion', 'insertion modification deletion', 'del'),
    suggestionMark('modification', 'deletion insertion', 'span'),
  ],
});
