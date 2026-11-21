import * as Y from 'yjs';
import type { CatchUpDTO, DigestResponse } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { logger } from '../logger.ts';
import type { Notifier } from '../notifications/notifier.ts';
import { getDigest } from './catchup.ts';
import { serverEditor } from './editor.ts';
import { exportHtml, exportText } from './export.ts';
import { tabFragmentName, MAIN_TAB } from './reach.ts';

type Block = Record<string, unknown>;

/**
 * Emails a person their digest (M10b.1, M10d.5): the same data as
 * `GET /api/me/digest`, laid out as BlockNote blocks and rendered by
 * `exportHtml`, the static renderer shares and print use, so the email
 * looks like a Primer page. Everything people wrote goes in as plain text
 * (never parsed as Markdown or HTML). Nothing is sent when nothing changed,
 * and agents have no mailbox. Slack and Telegram are AidenHQ's: it reads the
 * digest and sends it itself.
 */
export async function sendDigestEmail(notifier: Notifier, actor: AuthUser, since: Date): Promise<{ sent: boolean; documents: number }> {
  if (actor.kind !== 'person') return { sent: false, documents: 0 };
  const digest = await getDigest(actor, since);
  if (digest.documents.length === 0) return { sent: false, documents: 0 };
  try {
    await notifier.notifyDigest({
      userId: actor.id,
      render: async (appBaseUrl) => {
        const doc = digestDoc(digest, appBaseUrl.replace(/\/$/, ''));
        const subject = `What changed in ${digest.documents.length} document${digest.documents.length === 1 ? '' : 's'}`;
        return { subject, html: await exportHtml(doc, subject), text: exportText(doc, '') };
      },
    });
  } catch (err) {
    logger.error({ err, userId: actor.id }, 'digest email not delivered');
    return { sent: false, documents: digest.documents.length };
  }
  return { sent: true, documents: digest.documents.length };
}

/** The digest as a throwaway Y.Doc of plain blocks. */
export function digestDoc(digest: DigestResponse, baseUrl: string): Y.Doc {
  const blocks: Block[] = [heading(1, `Since ${new Date(digest.since).toUTCString()}`)];
  for (const doc of digest.documents) blocks.push(...documentBlocks(doc, baseUrl));
  const ydoc = new Y.Doc();
  serverEditor().blocksToYXmlFragment(blocks as never, ydoc.getXmlFragment(tabFragmentName(MAIN_TAB)));
  return ydoc;
}

function documentBlocks(c: CatchUpDTO, baseUrl: string): Block[] {
  const url = `${baseUrl}/d/${encodeURIComponent(c.documentId)}`;
  const out: Block[] = [
    { type: 'heading', props: { level: 2 }, content: [{ type: 'link', href: url, content: c.title || 'Untitled' }] },
  ];
  for (const p of c.people) {
    const parts = [
      count(p.edits, 'edit'),
      count(p.comments, 'comment'),
      count(p.resolved, 'resolved thread'),
      count(p.decisions, 'decision'),
      count(p.suggestions, 'suggestion'),
      count(p.tasks, 'task change'),
    ].filter(Boolean);
    if (parts.length > 0) out.push(bullet(`${p.displayName}: ${parts.join(', ')}`));
  }
  const name = (id: string) => c.people.find((p) => p.id === id)?.displayName ?? 'Someone';
  for (const d of c.decisions) {
    out.push(bullet(d.event === 'cleared' ? `${name(d.by)} cleared a decision` : d.optionLabel ? `${name(d.by)} decided "${d.question}": ${d.optionLabel}` : `${name(d.by)} picked an option`));
  }
  for (const t of c.threads) {
    const what = t.event === 'started' ? 'commented on' : t.event === 'replied' ? 'replied on' : 'resolved';
    out.push(bullet(`${name(t.by)} ${what} "${t.quote}"${t.excerpt ? `: ${t.excerpt}` : ''}`));
  }
  for (const s of c.suggestions) out.push(bullet(`${name(s.by)} ${s.event === 'created' ? 'suggested a change' : `${s.event} a suggestion`}`));
  for (const t of c.tasks) if (t.title) out.push(bullet(`Task ${t.event}: ${t.title}${t.status ? ` (${t.status})` : ''}`));
  for (const v of c.versions) out.push(bullet(`${name(v.by)} published version ${v.number}`));
  for (const b of c.changedBlocks) if (b.markdown) out.push({ type: 'quote', content: b.markdown });
  if (c.moreChangedBlocks > 0) out.push(paragraph(`and ${c.moreChangedBlocks} more changed blocks`));
  return out;
}

const heading = (level: number, text: string): Block => ({ type: 'heading', props: { level }, content: text });
const bullet = (text: string): Block => ({ type: 'bulletListItem', content: text });
const paragraph = (text: string): Block => ({ type: 'paragraph', content: text });
const count = (n: number, word: string) => (n > 0 ? `${n} ${word}${n === 1 ? '' : 's'}` : '');
