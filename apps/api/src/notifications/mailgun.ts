import { inArray } from 'drizzle-orm';
import type { CollaboratorRole } from '@polygonlabs/primer-api-types';
import { db } from '../db/client.ts';
import { actorName as actorNameColumn } from '../lib/actors.ts';
import { users } from '../db/schema.ts';
import { logger } from '../logger.ts';
import type {
  Notifier,
  NotifyCommentArgs,
  NotifyCollaboratorAddedArgs,
  NotifyExternalOtpArgs,
  NotifyDocumentMentionArgs,
  NotifyDigestArgs,
  NotifyExternalFirstViewArgs,
} from './notifier.ts';

export interface MailgunConfig {
  apiKey: string;
  domain: string; // sending domain, e.g. dashboard.polygon.technology
  fromAddress: string; // e.g. primer@dashboard.polygon.technology
  appBaseUrl: string; // e.g. https://primer.polygon.tools
  apiBaseUrl?: string; // defaults to https://api.mailgun.net
}

interface UserRow {
  id: string;
  displayName: string;
  email: string;
  kind?: 'person' | 'agent';
}

const SUBJECT_TITLE_LIMIT = 50;
const BODY_EXCERPT_LIMIT = 280;
const DEFAULT_API_BASE_URL = 'https://api.mailgun.net';

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function signalLead(actorName: string, mention: boolean, reply: boolean, uploaded: boolean): string {
  if (mention && reply) {
    return uploaded
      ? `${actorName} mentioned you and replied to a thread on a document you uploaded.`
      : `${actorName} mentioned you and replied to a thread you're in.`;
  }
  if (mention) {
    return uploaded
      ? `${actorName} mentioned you in a comment on a document you uploaded.`
      : `${actorName} mentioned you in a comment.`;
  }
  if (reply) {
    return uploaded
      ? `${actorName} replied to a thread on a document you uploaded.`
      : `${actorName} replied to a thread you're in.`;
  }
  // uploaded-only: no mention, not in the thread, but they uploaded the doc.
  return `${actorName} commented on a document you uploaded.`;
}

function renderSubject(actorName: string, docTitle: string): string {
  return `${actorName} commented on '${truncate(docTitle, SUBJECT_TITLE_LIMIT)}'`;
}

function renderText(
  actorName: string,
  docTitle: string,
  commentExcerpt: string,
  url: string,
  mention: boolean,
  reply: boolean,
  uploaded: boolean,
): string {
  return [
    signalLead(actorName, mention, reply, uploaded),
    '',
    `Doc: ${docTitle}`,
    '',
    commentExcerpt,
    '',
    `Open thread: ${url}`,
    '',
    'You received this because you were mentioned, are a participant in this thread, or uploaded this document.',
  ].join('\n');
}

function renderHtml(
  actorName: string,
  docTitle: string,
  commentExcerpt: string,
  url: string,
  mention: boolean,
  reply: boolean,
  uploaded: boolean,
): string {
  const lead = escapeHtml(signalLead(actorName, mention, reply, uploaded));
  const safeTitle = escapeHtml(docTitle);
  const safeExcerpt = escapeHtml(commentExcerpt).replace(/\n/g, '<br/>');
  return `<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;color:#171717;background:#fafafa;margin:0;padding:24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;">
  <tr><td style="padding:24px;">
    <p style="margin:0 0 12px;font-size:14px;color:#525252;">${lead}</p>
    <p style="margin:0 0 8px;font-size:13px;color:#737373;">Doc: <strong style="color:#171717;">${safeTitle}</strong></p>
    <blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #fbbf24;background:#fef9c3;font-size:14px;line-height:1.5;color:#262626;">${safeExcerpt}</blockquote>
    <p style="margin:24px 0;">
      <a href="${url}" style="display:inline-block;padding:10px 18px;background:#171717;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;">Open thread</a>
    </p>
    <p style="margin:24px 0 0;font-size:11px;color:#a3a3a3;">You received this because you were mentioned, are a participant in this thread, or uploaded this document.</p>
  </td></tr>
</table>
</body></html>`;
}

function renderCollabSubject(docTitle: string): string {
  return `You were added to '${truncate(docTitle, SUBJECT_TITLE_LIMIT)}' on Primer`;
}

function renderCollabText(
  actorName: string,
  role: CollaboratorRole,
  docTitle: string,
  url: string,
): string {
  const article = role === 'editor' ? 'an' : 'a';
  return [
    `${actorName} added you as ${article} ${role} on '${docTitle}'.`,
    '',
    `Open the doc: ${url}`,
    '',
    'You received this because you were added as a collaborator on this document.',
  ].join('\n');
}

function renderCollabHtml(
  actorName: string,
  role: CollaboratorRole,
  docTitle: string,
  url: string,
): string {
  const safeActor = escapeHtml(actorName);
  const safeTitle = escapeHtml(docTitle);
  const article = role === 'editor' ? 'an' : 'a';
  return `<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;color:#171717;background:#fafafa;margin:0;padding:24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;">
  <tr><td style="padding:24px;">
    <p style="margin:0 0 12px;font-size:14px;color:#525252;">${safeActor} added you as ${article} <strong>${role}</strong> on '<strong style="color:#171717;">${safeTitle}</strong>'.</p>
    <p style="margin:24px 0;">
      <a href="${url}" style="display:inline-block;padding:10px 18px;background:#171717;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;">Open the doc</a>
    </p>
    <p style="margin:24px 0 0;font-size:11px;color:#a3a3a3;">You received this because you were added as a collaborator on this document.</p>
  </td></tr>
</table>
</body></html>`;
}

export class MailgunNotifier implements Notifier {
  constructor(private readonly cfg: MailgunConfig) {}

  readonly emailEnabled = true;

  /** Whether Mailgun accepted the message (failures are logged, never thrown). */
  private async send(to: string, subject: string, text: string, html: string): Promise<boolean> {
    const apiBase = (this.cfg.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(/\/$/, '');
    const endpoint = `${apiBase}/v3/${encodeURIComponent(this.cfg.domain)}/messages`;
    const authHeader = `Basic ${Buffer.from(`api:${this.cfg.apiKey}`).toString('base64')}`;
    const form = new URLSearchParams();
    form.set('from', this.cfg.fromAddress);
    form.set('to', to);
    form.set('subject', subject);
    form.set('text', text);
    form.set('html', html);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: authHeader, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        logger.error({ status: res.status, to, errBody: errBody.slice(0, 300) }, 'mailgun send failed');
        return false;
      }
      return true;
    } catch (err) {
      logger.error({ err, to }, 'mailgun fetch threw');
      return false;
    }
  }

  async notifyComment(args: NotifyCommentArgs): Promise<void> {
    const mentionSet = new Set(args.mentionedUserIds);
    const participantSet = new Set(args.participantUserIds);
    const recipientIds = new Set<string>([...mentionSet, ...participantSet]);
    if (args.uploaderUserId !== null) recipientIds.add(args.uploaderUserId);
    recipientIds.delete(args.actorUserId);
    if (recipientIds.size === 0) return;

    const rows = (await db
      .select({ id: users.id, displayName: actorNameColumn, email: users.email, kind: users.kind })
      .from(users)
      .where(inArray(users.id, [...recipientIds, args.actorUserId]))) as UserRow[];
    const actor = rows.find((u) => u.id === args.actorUserId);
    const actorName = actor?.displayName ?? 'Someone';

    const base = `${this.cfg.appBaseUrl.replace(/\/$/, '')}/d/${args.doc.id}`;
    const url = `${args.version ? `${base}/v/${args.version.versionNumber}` : base}#thread-${args.thread.id}`;
    const excerpt = truncate(args.comment.body, BODY_EXCERPT_LIMIT);
    const subject = renderSubject(actorName, args.doc.title);

    for (const recipientId of recipientIds) {
      const recipient = rows.find((u) => u.id === recipientId);
      if (!recipient) {
        logger.warn({ recipientId }, 'recipient not found in users table, skipping');
        continue;
      }
      // Agents have no mailbox (auth/agents.ts).
      if (recipient.kind === 'agent') continue;
      const mention = mentionSet.has(recipientId);
      const reply = participantSet.has(recipientId);
      const uploaded = args.uploaderUserId !== null && recipientId === args.uploaderUserId;
      const html = renderHtml(actorName, args.doc.title, excerpt, url, mention, reply, uploaded);
      const text = renderText(actorName, args.doc.title, excerpt, url, mention, reply, uploaded);
      await this.send(recipient.email, subject, text, html);
    }
  }

  async notifyCollaboratorAdded(args: NotifyCollaboratorAddedArgs): Promise<void> {
    if (args.addedUserId === args.addedByUserId) return;

    const rows = (await db
      .select({ id: users.id, displayName: actorNameColumn, email: users.email })
      .from(users)
      .where(inArray(users.id, [args.addedUserId, args.addedByUserId]))) as UserRow[];
    const recipient = rows.find((u) => u.id === args.addedUserId);
    if (!recipient) {
      logger.warn({ addedUserId: args.addedUserId }, 'collab: added user not in users table, skipping');
      return;
    }
    const actor = rows.find((u) => u.id === args.addedByUserId);
    const actorName = actor?.displayName ?? 'Someone';

    const url = `${this.cfg.appBaseUrl.replace(/\/$/, '')}/d/${args.docId}`;
    const subject = renderCollabSubject(args.docTitle);
    const text = renderCollabText(actorName, args.role, args.docTitle, url);
    const html = renderCollabHtml(actorName, args.role, args.docTitle, url);

    await this.send(recipient.email, subject, text, html);
  }

  async notifyExternalOtp(args: NotifyExternalOtpArgs): Promise<void> {
    // Deliberately: no doc title (recipient is unverified), no links (the
    // recipient is already on the page; links in OTP mail train bad habits
    // and get eaten by corporate link-scanners).
    const subject = 'Your Primer verification code';
    const text = [
      'Someone requested a verification code for a document shared with you on Primer.',
      '',
      `Your code: ${args.code}`,
      '',
      'The code expires in 10 minutes. If you did not request it, ignore this email.',
    ].join('\n');
    const html = `<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;color:#171717;background:#fafafa;margin:0;padding:24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;">
  <tr><td style="padding:24px;">
    <p style="margin:0 0 12px;font-size:14px;color:#525252;">Someone requested a verification code for a document shared with you on Primer.</p>
    <p style="margin:16px 0;font-size:28px;font-weight:700;letter-spacing:6px;color:#171717;">${escapeHtml(args.code)}</p>
    <p style="margin:24px 0 0;font-size:11px;color:#a3a3a3;">The code expires in 10 minutes. If you did not request it, ignore this email.</p>
  </td></tr>
</table>
</body></html>`;
    await this.send(args.toEmail, subject, text, html);
  }

  async notifyDocumentMention(args: NotifyDocumentMentionArgs): Promise<void> {
    if (args.mentionedUserId === args.actorUserId) return;
    const rows = (await db
      .select({ id: users.id, displayName: actorNameColumn, email: users.email, kind: users.kind })
      .from(users)
      .where(inArray(users.id, [args.mentionedUserId, args.actorUserId]))) as UserRow[];
    const recipient = rows.find((u) => u.id === args.mentionedUserId);
    // Agents have no mailbox (auth/agents.ts).
    if (!recipient || recipient.kind === 'agent') return;
    const actorName = rows.find((u) => u.id === args.actorUserId)?.displayName ?? 'Someone';
    const url = `${this.cfg.appBaseUrl.replace(/\/$/, '')}/d/${args.doc.id}`;
    const subject = `${actorName} mentioned you in '${truncate(args.doc.title, SUBJECT_TITLE_LIMIT)}'`;
    const text = [`${actorName} mentioned you in '${args.doc.title}'.`, '', `Open the doc: ${url}`].join('\n');
    const html = `<!doctype html><html><body style="font-family:-apple-system,system-ui,sans-serif;color:#171717;">
<p>${escapeHtml(actorName)} mentioned you in '<strong>${escapeHtml(args.doc.title)}</strong>'.</p>
<p><a href="${url}">Open the doc</a></p></body></html>`;
    await this.send(recipient.email, subject, text, html);
  }

  async notifyDigest(args: NotifyDigestArgs): Promise<void> {
    const [recipient] = (await db
      .select({ id: users.id, displayName: actorNameColumn, email: users.email, kind: users.kind })
      .from(users)
      .where(inArray(users.id, [args.userId]))) as UserRow[];
    // Agents have no mailbox (auth/agents.ts).
    if (!recipient || recipient.kind === 'agent') return;
    const { subject, text, html } = await args.render(this.cfg.appBaseUrl);
    // The on-demand digest reports delivery, so a refusal here is an error.
    if (!(await this.send(recipient.email, subject, text, html))) throw new Error('Mailgun did not accept the digest.');
  }

  async notifyExternalFirstView(args: NotifyExternalFirstViewArgs): Promise<void> {
    const rows = (await db
      .select({ id: users.id, displayName: actorNameColumn, email: users.email })
      .from(users)
      .where(inArray(users.id, [args.sharerUserId]))) as UserRow[];
    const sharer = rows[0];
    if (!sharer) {
      logger.warn({ sharerUserId: args.sharerUserId }, 'first-view: sharer not found, skipping');
      return;
    }
    const url = `${this.cfg.appBaseUrl.replace(/\/$/, '')}/d/${args.docId}`;
    const subject = `${args.viewerEmail} viewed '${truncate(args.docTitle, SUBJECT_TITLE_LIMIT)}'`;
    const text = [
      `${args.viewerEmail} opened '${args.docTitle}' for the first time.`,
      '',
      `Open the doc: ${url}`,
      '',
      'You received this because you shared this document externally.',
    ].join('\n');
    const html = `<!doctype html>
<html><body style="font-family:-apple-system,system-ui,sans-serif;color:#171717;background:#fafafa;margin:0;padding:24px;">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e5e5;border-radius:8px;">
  <tr><td style="padding:24px;">
    <p style="margin:0 0 12px;font-size:14px;color:#525252;"><strong>${escapeHtml(args.viewerEmail)}</strong> opened '<strong style="color:#171717;">${escapeHtml(args.docTitle)}</strong>' for the first time.</p>
    <p style="margin:24px 0;">
      <a href="${url}" style="display:inline-block;padding:10px 18px;background:#171717;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;">Open the doc</a>
    </p>
    <p style="margin:24px 0 0;font-size:11px;color:#a3a3a3;">You received this because you shared this document externally.</p>
  </td></tr>
</table>
</body></html>`;
    await this.send(sharer.email, subject, text, html);
  }
}
