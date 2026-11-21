// Choice blocks and the decision register over REST. Thin: every route calls
// live/choices.ts, which checks access and validates; the MCP tools call the
// same functions.
import type { Context, Hono } from 'hono';
import type { Refusal } from '@polygonlabs/primer-api-types';
import type { AppVariables } from '../app.ts';
import type { Result } from '../live/blockTools.ts';
import { addChoice, choiceTally, clearDecision, listDecisions, pick, proposePick, vote } from '../live/choices.ts';

type C = Context<{ Variables: AppVariables }>;

const STATUS: Record<string, 400 | 403 | 404 | 409> = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  choice_decided: 409,
};

/** A route's result: the value, or the refusal with its status. */
export function respond<T>(c: C, out: Result<T>, okStatus: 200 | 201 = 200) {
  if (out.ok) return c.json(out.value as object, okStatus);
  const refusal: Refusal = out.refusal;
  return c.json({ error: refusal.code, refusal }, STATUS[refusal.code] ?? 400);
}

/** The JSON object body, or null. */
export async function jsonBody(c: C): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const badBody = (c: C) => c.json({ error: 'bad_request', message: 'body must be a JSON object' }, 400);

export function registerChoiceRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.post('/api/documents/:docId/choices', async (c) => {
    const body = await jsonBody(c);
    if (!body) return badBody(c);
    return respond(c, await addChoice(c.get('user'), c.req.param('docId'), body as never), 201);
  });

  app.get('/api/documents/:docId/decisions', async (c) => respond(c, await listDecisions(c.get('user'), c.req.param('docId'))));

  app.get('/api/documents/:docId/choices/:blockId/votes', async (c) =>
    respond(c, await choiceTally(c.get('user'), c.req.param('docId'), c.req.param('blockId'))),
  );

  app.post('/api/documents/:docId/choices/:blockId/vote', async (c) => {
    const body = await jsonBody(c);
    if (!body) return badBody(c);
    // Withdrawing is an explicit `optionId: null`; a missing or misspelled field is a bad request.
    if (!('optionId' in body)) return c.json({ error: 'bad_request', message: 'Send { optionId } (an option id, or null to withdraw).' }, 400);
    return respond(c, await vote(c.get('user'), c.req.param('docId'), c.req.param('blockId'), body.optionId));
  });

  app.post('/api/documents/:docId/choices/:blockId/pick', async (c) => {
    const body = await jsonBody(c);
    if (!body) return badBody(c);
    return respond(c, await pick(c.get('user'), c.req.param('docId'), c.req.param('blockId'), body as never));
  });

  // Clearing a decision: people with edit rights only (checked in live/choices.ts).
  app.delete('/api/documents/:docId/choices/:blockId/decision', async (c) =>
    respond(c, await clearDecision(c.get('user'), c.req.param('docId'), c.req.param('blockId'))),
  );

  app.post('/api/documents/:docId/choices/:blockId/propose', async (c) => {
    const body = await jsonBody(c);
    if (!body) return badBody(c);
    return respond(c, await proposePick(c.get('user'), c.req.param('docId'), c.req.param('blockId'), body as never));
  });
}
