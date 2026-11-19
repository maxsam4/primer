// Spike: suggestions as @handlewithcare/prosemirror-suggest-changes marks,
// written through the one server write path (applyPlan).
import { EditorState } from '@tiptap/pm/state';
import type { Transform } from '@tiptap/pm/transform';
import {
  applySuggestion,
  revertSuggestion,
  transformToSuggestionTransaction,
} from '@handlewithcare/prosemirror-suggest-changes';
import type { Target } from '@polygonlabs/primer-api-types';
import type { PlannedEdit } from './pipeline.ts';

/**
 * The same edit, written as suggestion `id`: the edit's steps run on a scratch
 * EditorState of the fragment's current doc, the library turns them into
 * tracked steps (deleted text gets a `deletion` mark, inserted text an
 * `insertion` mark, both with `id`), and those steps go onto the pipeline's
 * transform, so they reach the Y.Doc through the same `updateYFragment` write.
 */
export function asSuggestion(edit: PlannedEdit, id: string): PlannedEdit {
  return {
    ...edit,
    build: (tr, at) => {
      const state = EditorState.create({ doc: tr.doc });
      const original = state.tr;
      edit.build(original, at);
      if (!original.docChanged) return;
      const tracked = transformToSuggestionTransaction(original, state, () => id);
      for (const step of tracked.steps) tr.step(step);
    },
  };
}

/** Accepts (`applySuggestion`) or rejects (`revertSuggestion`) suggestion `id`
 *  in one fragment. A no-op when the fragment has no mark with that id. */
export function settleSuggestion(target: Target, id: string, how: 'accept' | 'reject'): PlannedEdit {
  return {
    target,
    inverse: false,
    build: (tr: Transform) => {
      const state = EditorState.create({ doc: tr.doc });
      const command = how === 'accept' ? applySuggestion(id) : revertSuggestion(id);
      command(state, (settled) => {
        for (const step of settled.steps) tr.step(step);
      });
    },
  };
}
