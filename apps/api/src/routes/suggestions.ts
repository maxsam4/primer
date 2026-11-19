import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import { decideSuggestion, listSuggestions, type Decision, type SuggestionResult } from '../live/suggest.ts';

/** Suggestions on live documents (live/suggest.ts). */
export function registerSuggestionRoutes(app: Hono<{ Variables: AppVariables }>): void {
  const send = <T>(c: { json: (body: unknown, status: number) => Response }, out: SuggestionResult<T>) =>
    out.ok ? c.json(out.value, 200) : c.json({ error: out.refusal.code, refusal: out.refusal }, out.status);

  // The open suggestions, each edit with the block now and as proposed.
  app.get('/api/documents/:docId/suggestions', async (c) => {
    const out = await listSuggestions(c.get('user'), c.req.param('docId'));
    return out.ok ? c.json({ suggestions: out.value }, 200) : send(c as never, out);
  });

  // accept and reject: people who own or edit the document; withdraw: the
  // author. Each returns a Reconciliation (accept: the applied edit).
  for (const decision of ['accept', 'reject', 'withdraw'] as const satisfies readonly Decision[]) {
    app.post(`/api/suggestions/:id/${decision}`, async (c) =>
      send(c as never, await decideSuggestion(c.req.param('id'), c.get('user'), decision)),
    );
  }
}
