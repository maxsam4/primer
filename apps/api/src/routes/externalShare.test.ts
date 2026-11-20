// apps/api/src/routes/externalShare.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier, type NotifyExternalOtpArgs, type NotifyExternalFirstViewArgs } from '../notifications/notifier.ts';
import { db } from '../db/client.ts';
import {
  externalShares, externalRecipients, externalViews,
} from '../db/schema.ts';
import { generateShareToken } from '../external/tokens.ts';
import { _resetRateLimiterForTests } from '../lib/rateLimiter.ts';
import { artifactCsp } from '../lib/pagePolicy.ts';
import { CSRF_HEADERS } from '../test/harness.ts';
import { MOCK_USER } from '../auth/resolver.ts';
import { publishDocument } from '../lib/publish.ts';
import { readBlocks } from '../live/editor.ts';
import { withLiveDoc } from '../live/live.testlib.ts';
import { originFor } from '../live/origin.ts';
import { applyPlan } from '../live/pipeline.ts';
import { applyOps } from '../live/ops.ts';
import { recordsApi } from '../records/store.ts';
import { flushDataChanged } from '../records/changed.ts';

class CaptureNotifier extends NoopNotifier {
  override readonly emailEnabled = true;
  otps: NotifyExternalOtpArgs[] = [];
  firstViews: NotifyExternalFirstViewArgs[] = [];
  override async notifyExternalOtp(a: NotifyExternalOtpArgs): Promise<void> { this.otps.push(a); }
  override async notifyExternalFirstView(a: NotifyExternalFirstViewArgs): Promise<void> { this.firstViews.push(a); }
}

const JSON_HEADERS = { ...CSRF_HEADERS, 'content-type': 'application/json' };

interface Fixture {
  app: ReturnType<typeof createApp>;
  notifier: CaptureNotifier;
  root: string;
  docId: string;
  versionId: string;
  shareToken: string;
  recipientId: string;
}

/** Upload a doc as mock-user-1, then wire share + recipient + publish directly. */
async function fixture(opts: { publish?: boolean } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'primer-ext-test-'));
  const notifier = new CaptureNotifier();
  const app = createApp({ storage: new FilesystemStorage(root), notifier });
  const fd = new FormData();
  fd.append('file', new Blob(['<html><body><h1>External Deck</h1></body></html>'], { type: 'text/html' }), 'd.html');
  fd.append('title', 'External Deck');
  const up = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
  const { documentId, versionId } = (await up.json()) as { documentId: string; versionId: string };
  const shareToken = generateShareToken();
  const shareId = uuidv7();
  await db.insert(externalShares).values({
    id: shareId, documentId, shareToken, createdBy: 'mock-user-1',
    publishedVersionId: opts.publish === false ? null : versionId,
  });
  const recipientId = uuidv7();
  await db.insert(externalRecipients).values({
    id: recipientId, shareId, email: 'client@example.com', addedBy: 'mock-user-1',
    expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
  });
  return { app, notifier, root, docId: documentId, versionId, shareToken, recipientId };
}

async function requestCode(f: Fixture, email: string) {
  return f.app.request(`/api/share/${f.shareToken}/request-code`, {
    method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email }),
  });
}

/** Full happy path up to an authenticated cookie. */
async function authenticate(f: Fixture): Promise<string> {
  await requestCode(f, 'client@example.com');
  const code = f.notifier.otps.at(-1)!.code;
  const res = await f.app.request(`/api/share/${f.shareToken}/verify`, {
    method: 'POST', headers: JSON_HEADERS,
    body: JSON.stringify({ email: 'client@example.com', code }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie')!;
  expect(setCookie).toContain('primer_ext_sid=');
  expect(setCookie).toContain('HttpOnly');
  return setCookie.split(';')[0]; // "primer_ext_sid=<id>"
}

describe('external share public routes', () => {
  beforeEach(() => _resetRateLimiterForTests());

  it('request-code returns byte-identical bodies for allowlisted and unknown emails', async () => {
    const f = await fixture();
    try {
      const known = await requestCode(f, 'client@example.com');
      const unknown = await requestCode(f, 'stranger@example.com');
      expect(known.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(await known.text()).toBe(await unknown.text());
      expect(f.notifier.otps.length).toBe(1); // only the real recipient got a code
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('request-code returns 503 when the notifier cannot send email', async () => {
    const f = await fixture();
    try {
      const noEmail = new CaptureNotifier();
      Object.defineProperty(noEmail, 'emailEnabled', { value: false });
      const app2 = createApp({ storage: new FilesystemStorage(f.root), notifier: noEmail });
      const res = await app2.request(`/api/share/${f.shareToken}/request-code`, {
        method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ email: 'client@example.com' }),
      });
      expect(res.status).toBe(503);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('request-code rate-limits repeated sends for the same email', async () => {
    const f = await fixture();
    try {
      expect((await requestCode(f, 'client@example.com')).status).toBe(200);
      expect((await requestCode(f, 'client@example.com')).status).toBe(200);
      expect((await requestCode(f, 'client@example.com')).status).toBe(429);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('verify rate-limits repeated attempts for the same email', async () => {
    const f = await fixture();
    try {
      // Request a code so the OTP exists (subsequent verifies use wrong code,
      // which still count against the per-email rate limit).
      await requestCode(f, 'client@example.com');
      const attemptVerify = () =>
        f.app.request(`/api/share/${f.shareToken}/verify`, {
          method: 'POST', headers: JSON_HEADERS,
          body: JSON.stringify({ email: 'client@example.com', code: '000000' }),
        });
      // 10 attempts should all be non-429 (400 wrong-code)
      for (let i = 0; i < 10; i++) {
        const res = await attemptVerify();
        expect(res.status).toBe(400);
      }
      // 11th attempt should be rate-limited
      const res = await attemptVerify();
      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'rate_limited' });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('verify returns the identical error for unknown email vs wrong code', async () => {
    const f = await fixture();
    try {
      await requestCode(f, 'client@example.com');
      const wrongCode = await f.app.request(`/api/share/${f.shareToken}/verify`, {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ email: 'client@example.com', code: '000000' }),
      });
      const unknownEmail = await f.app.request(`/api/share/${f.shareToken}/verify`, {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ email: 'stranger@example.com', code: '123456' }),
      });
      expect(wrongCode.status).toBe(400);
      expect(unknownEmail.status).toBe(400);
      expect(await wrongCode.text()).toBe(await unknownEmail.text());
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('happy path: verify sets cookie; content serves published version with CSP + noindex; audit row + first-view fire once', async () => {
    const f = await fixture();
    try {
      const cookie = await authenticate(f);

      const content = await f.app.request(`/api/share/${f.shareToken}/content`, { headers: { cookie } });
      expect(content.status).toBe(200);
      expect(content.headers.get('content-security-policy')).toBe(artifactCsp('standard'));
      expect(content.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      expect(content.headers.get('x-content-type-options')).toBe('nosniff');
      expect(content.headers.get('referrer-policy')).toBe('no-referrer');
      expect(content.headers.get('x-robots-tag')).toBe('noindex');
      expect(content.headers.get('cache-control')).toBe('private, no-store');
      expect(await content.text()).toContain('<h1 data-pid="p1">External Deck</h1>');

      const views = await db.select().from(externalViews).where(eq(externalViews.recipientId, f.recipientId));
      expect(views.length).toBe(1);
      expect(views[0].versionId).toBe(f.versionId);
      expect(f.notifier.firstViews.length).toBe(1);
      expect(f.notifier.firstViews[0].viewerEmail).toBe('client@example.com');

      // Second view: another audit row, but no second first-view notification.
      await f.app.request(`/api/share/${f.shareToken}/content`, { headers: { cookie } });
      expect((await db.select().from(externalViews).where(eq(externalViews.recipientId, f.recipientId))).length).toBe(2);
      expect(f.notifier.firstViews.length).toBe(1);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('share link of a live doc serves the published checkpoint, not live state', async () => {
    const f = await fixture();
    try {
      const storage = new FilesystemStorage(f.root);
      const published = await publishDocument(storage, {
        actor: MOCK_USER,
        title: 'Live plan',
        filename: 'plan.md',
        format: 'markdown',
        content: new TextEncoder().encode('# Plan\n\nShip the editor first.\n'),
      });
      if (!published.ok) throw new Error('publish refused');
      const checkpoint = await f.app.request(`/api/documents/${published.documentId}/checkpoints`, { method: 'POST', headers: CSRF_HEADERS });
      const { versionId } = (await checkpoint.json()) as { versionId: string };

      // The document moves on after the share was published.
      const blockId = await withLiveDoc(published.documentId, (doc) => readBlocks(doc, 'main').find((b) => JSON.stringify(b.content).includes('Ship'))!.id);
      await applyPlan(published.documentId, originFor(MOCK_USER), {
        onConflict: 'refuse',
        edits: [{
          target: { tabId: 'main', blockId },
          inverse: false,
          build: (tr, at) => {
            tr.replaceWith(at!.pos + 2, at!.pos + at!.node.firstChild!.nodeSize, tr.doc.type.schema.text('Secret draft change.'));
          },
        }],
      });

      const shareToken = generateShareToken();
      const shareId = uuidv7();
      await db.insert(externalShares).values({ id: shareId, documentId: published.documentId, shareToken, createdBy: 'mock-user-1', publishedVersionId: versionId });
      await db.insert(externalRecipients).values({
        id: uuidv7(), shareId, email: 'client@example.com', addedBy: 'mock-user-1',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      });
      const cookie = await authenticate({ ...f, shareToken });
      const content = await f.app.request(`/api/share/${shareToken}/content`, { headers: { cookie } });
      expect(content.status).toBe(200);
      const html = await content.text();
      expect(html).toContain('Ship the editor first.');
      expect(html).not.toContain('Secret draft change.');
      expect(content.headers.get('content-security-policy')).toBe(artifactCsp('standard'));
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('external share reads the frozen snapshot', async () => {
    const f = await fixture();
    try {
      const storage = new FilesystemStorage(f.root);
      const share = async (documentId: string, versionId: string) => {
        const shareToken = generateShareToken();
        const shareId = uuidv7();
        await db.insert(externalShares).values({ id: shareId, documentId, shareToken, createdBy: 'mock-user-1', publishedVersionId: versionId });
        await db.insert(externalRecipients).values({
          id: uuidv7(), shareId, email: 'client@example.com', addedBy: 'mock-user-1',
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
        const cookie = await authenticate({ ...f, shareToken });
        return f.app.request(`/api/share/${shareToken}/content`, { headers: { cookie } });
      };

      // A live document with a data table over `metrics`.
      const doc = await publishDocument(storage, {
        actor: MOCK_USER, title: 'Metrics', filename: 'm.md', format: 'markdown',
        content: new TextEncoder().encode('# Metrics\n\nWeekly numbers.\n'),
      });
      if (!doc.ok) throw new Error('publish refused');
      const intro = await withLiveDoc(doc.documentId, (d) => readBlocks(d, 'main').find((b) => JSON.stringify(b.content).includes('Weekly'))!.id);
      const columns = JSON.stringify([{ key: 'week', label: 'Week', type: 'text' }, { key: 'signups', label: 'Signups', type: 'number' }]);
      const added = await applyOps(doc.documentId, MOCK_USER, {
        ops: [{ op: 'add', at: { tabId: 'main', blockId: intro }, position: 'after', blocks: [{ json: { type: 'dataTable', props: { collection: 'metrics', columns, scope: 'shared' } } }] }],
      });
      expect(added.ok).toBe(true);
      const records = recordsApi(MOCK_USER, doc.documentId);
      await records.set({ collection: 'metrics', scope: 'shared', recordId: 'w1', data: { week: 'W1', signups: 240 } });
      await records.set({ collection: 'metrics', scope: 'shared', recordId: 'w2', data: { week: 'W2 <b>bold</b>', signups: 410 } });
      await records.set({ collection: 'payroll', scope: 'shared', recordId: 'p1', data: { amount: 'unbound-in-markdown' } });
      const checkpoint = await f.app.request(`/api/documents/${doc.documentId}/checkpoints`, { method: 'POST', headers: CSRF_HEADERS });
      const { versionId } = (await checkpoint.json()) as { versionId: string };
      // Live data moves on after publish.
      await records.update({ collection: 'metrics', scope: 'shared', recordId: 'w2', data: { signups: 731905 } });

      const table = await (await share(doc.documentId, versionId)).text();
      expect(table).toContain('<th>Week</th><th>Signups</th>');
      expect(table).toContain('<td>W1</td><td>240</td>');
      expect(table).toContain('<td>W2 &lt;b&gt;bold&lt;/b&gt;</td><td>410</td>');
      expect(table).not.toContain('<td>731905</td>');
      expect(table).not.toContain('unbound-in-markdown');

      // A record-reading page reads the same frozen records, under the records lockdown.
      const page = await publishDocument(storage, {
        actor: MOCK_USER, title: 'Board', filename: 'b.html', format: 'html',
        content: new TextEncoder().encode('<!doctype html><html><head><meta name="primer-records" content="read"><meta name="primer-records-collections" content="votes primer.choice/c1"><title>Board</title></head><body><h1>Board</h1></body></html>'),
      });
      if (!page.ok) throw new Error('publish refused');
      const pageRecords = recordsApi(MOCK_USER, page.documentId);
      await pageRecords.set({ collection: 'votes', scope: 'shared', recordId: 'a', data: { note: '</script><script>alert(1)</script>' } });
      await pageRecords.set({ collection: 'mine', scope: 'personal', recordId: 'p', data: { secret: 'personal-only' } });
      await recordsApi(MOCK_USER, page.documentId, { reserved: true }).set({ collection: 'primer.choice/c1', scope: 'shared', recordId: 'mock-user-1', data: { optionId: 'o1' } });
      await pageRecords.set({ collection: 'salaries', scope: 'shared', recordId: 's', data: { amount: 'unbound-collection' } });
      const pageCheckpoint = await f.app.request(`/api/documents/${page.documentId}/checkpoints`, { method: 'POST', headers: CSRF_HEADERS });
      const pageVersion = ((await pageCheckpoint.json()) as { versionId: string }).versionId;
      await pageRecords.set({ collection: 'votes', scope: 'shared', recordId: 'b', data: { note: 'after publish' } });

      const res = await share(page.documentId, pageVersion);
      expect(res.headers.get('content-security-policy')).toBe(artifactCsp('records'));
      const html = await res.text();
      const frozen = /<script type="application\/json" id="primer-records-frozen">(.*?)<\/script>/s.exec(html);
      expect(frozen).not.toBeNull();
      // Only the collection the page declares, each record only its id and data.
      expect(JSON.parse(frozen![1]!)).toEqual({ collections: { votes: [{ recordId: 'a', data: { note: '</script><script>alert(1)</script>' } }] } });
      expect(html).not.toContain('unbound-collection');
      expect(html).not.toContain('writtenBy');
      expect(html).not.toContain('mock-user-1'); // nor a vote, keyed by the voter's id
      expect(html).not.toContain('after publish');
      expect(html).not.toContain('personal-only');
      await flushDataChanged();
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('content without a session 302s to the branded landing page', async () => {
    const f = await fixture();
    try {
      const res = await f.app.request(`/api/share/${f.shareToken}/content`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/share/${f.shareToken}`);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('content with a session but nothing published 302s back to the landing page', async () => {
    const f = await fixture({ publish: false });
    try {
      const cookie = await authenticate(f);
      const res = await f.app.request(`/api/share/${f.shareToken}/content`, { headers: { cookie } });
      expect(res.status).toBe(302);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('session endpoint: identical unauthenticated response for valid and invalid tokens; title only after auth', async () => {
    const f = await fixture();
    try {
      const invalid = await f.app.request(`/api/share/${generateShareToken()}/session`);
      const valid = await f.app.request(`/api/share/${f.shareToken}/session`);
      expect(await invalid.text()).toBe(await valid.text());

      const cookie = await authenticate(f);
      const authed = await f.app.request(`/api/share/${f.shareToken}/session`, { headers: { cookie } });
      expect(await authed.json()).toEqual({ authenticated: true, documentTitle: 'External Deck', published: true });
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('revoking the share kills an existing session immediately', async () => {
    const f = await fixture();
    try {
      const cookie = await authenticate(f);
      await db.update(externalShares).set({ revokedAt: new Date() })
        .where(eq(externalShares.shareToken, f.shareToken));
      const res = await f.app.request(`/api/share/${f.shareToken}/content`, { headers: { cookie } });
      expect(res.status).toBe(302);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('share routes are reachable without internal auth (no Okta redirect)', async () => {
    const f = await fixture();
    try {
      // No x-mock-user-id header at all → would 401/302-to-login on internal routes.
      const res = await f.app.request(`/api/share/${f.shareToken}/session`);
      expect(res.status).toBe(200);
    } finally { await rm(f.root, { recursive: true, force: true }); }
  });

  it('verify sets Secure flag on cookie when AUTH_BASE_URL is https', async () => {
    const prev = process.env.AUTH_BASE_URL;
    process.env.AUTH_BASE_URL = 'https://primer.example.com';
    const f = await fixture();
    try {
      await requestCode(f, 'client@example.com');
      const code = f.notifier.otps.at(-1)!.code;
      const res = await f.app.request(`/api/share/${f.shareToken}/verify`, {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ email: 'client@example.com', code }),
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie')!;
      expect(setCookie.toLowerCase()).toContain('secure');
    } finally {
      if (prev === undefined) delete process.env.AUTH_BASE_URL;
      else process.env.AUTH_BASE_URL = prev;
      await rm(f.root, { recursive: true, force: true });
    }
  });

  it('verify omits Secure flag on cookie when AUTH_BASE_URL is http', async () => {
    const prev = process.env.AUTH_BASE_URL;
    const prevSecure = process.env.COOKIE_SECURE;
    process.env.AUTH_BASE_URL = 'http://primer.example.com';
    delete process.env.COOKIE_SECURE;
    const f = await fixture();
    try {
      await requestCode(f, 'client@example.com');
      const code = f.notifier.otps.at(-1)!.code;
      const res = await f.app.request(`/api/share/${f.shareToken}/verify`, {
        method: 'POST', headers: JSON_HEADERS,
        body: JSON.stringify({ email: 'client@example.com', code }),
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie')!;
      // Split on ';' and check no standalone 'secure' attribute is present
      const attrs = setCookie.split(';').map((s) => s.trim().toLowerCase());
      expect(attrs).not.toContain('secure');
    } finally {
      if (prev === undefined) delete process.env.AUTH_BASE_URL;
      else process.env.AUTH_BASE_URL = prev;
      if (prevSecure === undefined) delete process.env.COOKIE_SECURE;
      else process.env.COOKIE_SECURE = prevSecure;
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
