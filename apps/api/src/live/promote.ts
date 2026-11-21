import { sql } from 'drizzle-orm';
import type { PromoteConversationRequest, PromoteConversationResponse, Refusal } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { actorNameOf } from '../lib/actors.ts';
import { canRead, loadEffectiveRole, type Visibility } from '../lib/permissions.ts';
import { publishDocument } from '../lib/publish.ts';
import type { Storage } from '../storage/types.ts';
import { MAX_TITLE } from '../upload/validate.ts';
import { applyOps } from './ops.ts';
import { getLiveDoc } from './read.ts';

const MAX_MESSAGES = 200;
const MAX_AUTHOR = 200;
const MAX_TEXT = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PromoteResult = { ok: true; value: PromoteConversationResponse } | { ok: false; status: 400 | 403 | 404 | 409; refusal: Refusal };

const bad = (message: string, fix: string): PromoteResult => ({ ok: false, status: 400, refusal: { code: 'bad_request', message, fix } });

/**
 * Text as literal Markdown: every ASCII punctuation character escaped and
 * leading spaces dropped, so nothing in a message (Slack, Telegram and comment
 * text is untrusted) can become a heading, link, image, HTML, code block or
 * anything but the words it is.
 */
function literal(text: string): string {
  return text.replace(/^[ \t]+/, '').replace(/[!-/:-@[-`{-~]/g, '\\$&');
}

/** One quote block: the author in bold, then the message, hard line breaks. */
function quote(m: { author: string; text: string }): string {
  const lines = [`**${literal(m.author.replace(/\s+/g, ' ').trim()) || 'Unknown'}**`];
  for (const line of m.text.replace(/\r\n?/g, '\n').split('\n')) if (line.trim() !== '') lines.push(literal(line));
  return lines.map((l) => `> ${l}`).join('\\\n');
}

/**
 * A conversation becomes a document (M10b.5): one quote block per message,
 * through the one publish path (a new private document) or, with
 * `documentId`, through the ops pipeline at the end of that live document
 * (so an agent on a document it doesn't own suggests, as with any edit).
 */
export async function promoteConversation(storage: Storage, actor: AuthUser, req: PromoteConversationRequest): Promise<PromoteResult> {
  const title = typeof req.title === 'string' ? req.title.trim() : '';
  if (title.length === 0 || title.length > MAX_TITLE) return bad(`title must be 1–${MAX_TITLE} characters.`, 'Send a short title.');
  if (!Array.isArray(req.messages) || req.messages.length === 0 || req.messages.length > MAX_MESSAGES) {
    return bad(`messages must be a list of 1–${MAX_MESSAGES} messages.`, 'Send [{ author, text }].');
  }
  for (const m of req.messages) {
    if (!m || typeof m.author !== 'string' || typeof m.text !== 'string' || m.author.length > MAX_AUTHOR || m.text.trim() === '' || m.text.length > MAX_TEXT) {
      return bad(`Each message needs an author (≤ ${MAX_AUTHOR} characters) and text (1–${MAX_TEXT}).`, 'Send [{ author, text }].');
    }
  }
  const markdown = req.messages.map(quote).join('\n\n') + '\n';

  if (req.documentId !== undefined) {
    if (typeof req.documentId !== 'string' || !UUID.test(req.documentId)) return { ok: false, status: 404, refusal: notFound };
    const read = await getLiveDoc(req.documentId, actor, { format: 'json' });
    if (!read.ok) return read;
    const last = read.value.blocks.filter((b) => b.depth === 0).at(-1);
    if (!last) return bad('The document has no blocks to add after.', 'Promote into a new document instead.');
    const out = await applyOps(req.documentId, actor, { ops: [{ op: 'add', at: last.target, position: 'after', blocks: [markdown] }] });
    if (!out.ok) return { ok: false, status: out.status, refusal: out.refusal };
    return { ok: true, value: { documentId: req.documentId, reconciliation: out.value } };
  }

  const published = await publishDocument(storage, {
    actor,
    title,
    filename: 'conversation.md',
    format: 'markdown',
    content: new TextEncoder().encode(markdown),
    // Conversations are often private: the new document is private to its owner from its first row.
    visibility: 'private',
  });
  if (!published.ok) return published;
  return { ok: true, value: { documentId: published.documentId, versionId: published.versionId } };
}

const notFound: Refusal = { code: 'not_found', message: 'Not found.', fix: 'Check the id.' };

/** "Promote thread": a comment thread the caller can read, as a new document. */
export async function promoteThread(storage: Storage, actor: AuthUser, threadId: string): Promise<PromoteResult> {
  if (!UUID.test(threadId)) return { ok: false, status: 404, refusal: notFound };
  const [thread] = (await db.execute(sql`
    SELECT t.anchor, d.id AS "documentId", d.title, d.uploader_id AS "uploaderId", d.visibility, d.deleted_at AS "deletedAt"
      FROM threads t JOIN documents d ON d.id = t.document_id WHERE t.id = ${threadId}
  `)) as unknown as { anchor: unknown; documentId: string; title: string; uploaderId: string; visibility: Visibility; deletedAt: Date | null }[];
  if (!thread || thread.deletedAt !== null) return { ok: false, status: 404, refusal: notFound };
  const role = await loadEffectiveRole({ id: thread.documentId, uploaderId: thread.uploaderId, visibility: thread.visibility }, actor);
  if (!canRead(thread.visibility, role)) return { ok: false, status: 404, refusal: notFound };
  const messages = (await db.execute(sql`
    SELECT ${actorNameOf('u')} AS author, c.body AS text
      FROM comments c JOIN users u ON u.id = c.author_id
     WHERE c.thread_id = ${threadId} AND c.deleted_at IS NULL
     ORDER BY c.created_at, c.id
  `)) as unknown as { author: string; text: string }[];
  if (messages.length > MAX_MESSAGES) {
    return bad(`This thread has ${messages.length} comments; a promoted conversation holds at most ${MAX_MESSAGES}.`, 'Copy the part you want into a new document by hand.');
  }
  const anchor = (typeof thread.anchor === 'string' ? JSON.parse(thread.anchor) : thread.anchor) as { quote?: string; selectorText?: string };
  const about = (anchor.quote ?? anchor.selectorText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return promoteConversation(storage, actor, {
    title: (about ? `${thread.title}: “${about}”` : thread.title).slice(0, MAX_TITLE),
    messages,
  });
}
