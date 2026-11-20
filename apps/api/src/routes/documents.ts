import type * as Y from 'yjs';
import type { Hono } from 'hono';
import { and, eq, desc, sql } from 'drizzle-orm';
import type { AppVariables, AppDeps } from '../app.ts';
import type { Context } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import type {
  AgentMode,
  DocumentDetailResponse, DocumentDetail, AddVersionResponse, DocumentSummary,
  CheckpointResponse, DocFileUploadResponse, ExportFormat, Refusal, RestoreCheckpointResponse,
} from '@polygonlabs/primer-api-types';
import { docFiles, documents, versions, users } from '../db/schema.ts';
import { exportFileOf, printable, readBundleFile, renderStatic } from '../live/bundle.ts';
import { currentPageHtml } from '../page/publish.ts';
import { contentUnchangedSince, createCheckpoint, restoreCheckpoint } from '../live/checkpoint.ts';
import { exportHtml, exportMarkdown, exportText } from '../live/export.ts';
import { exportDecisions } from '../live/choices.ts';
import { withLiveDocument } from '../live/instance.ts';
import { ensureSigningKey } from '../live/signing.ts';
import { MAX_BYTES } from '../upload/validate.ts';
import { db } from '../db/client.ts';
import { actorName } from '../lib/actors.ts';
import { artifactCsp } from '../lib/pagePolicy.ts';
import { logger } from '../logger.ts';
import { validateUpload } from '../upload/validate.ts';
import {
  canRead, canEdit, canManage, loadEffectiveRole,
  type Visibility,
} from '../lib/permissions.ts';
import { tokenScopes } from '../auth/scopes.ts';
import { publishDocument } from '../lib/publish.ts';
import { proposeBranch } from '../live/branch.ts';
import { copyDocument } from '../live/copy.ts';
import { decideChangeSet } from '../live/suggest.ts';
import { recheckAccess } from '../auth/revocation.ts';
import { refusalResponse } from './upload.ts';
import { bundleWidgets } from '../widgets/bundle.ts';
import { snapshotRecords } from '../records/snapshot.ts';
import { embedTables } from '../records/table.ts';

export function registerDocumentRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps
): void {
  app.get('/api/documents/:docId', async (c) => {
    const docId = c.req.param('docId');

    const docRows = await db
      .select({
        id: documents.id,
        title: documents.title,
        description: documents.description,
        uploaderId: documents.uploaderId,
        visibility: documents.visibility,
        createdAt: documents.createdAt,
        deletedAt: documents.deletedAt,
        format: documents.format,
        agentMode: documents.agentMode,
        branchOf: documents.branchOf,
        forkedFrom: documents.forkedFrom,
        isTemplate: documents.isTemplate,
        uploaderDisplayName: actorName,
      })
      .from(documents)
      .innerJoin(users, eq(users.id, documents.uploaderId))
      .where(eq(documents.id, docId))
      .limit(1);

    if (docRows.length === 0) {
      return c.json({ error: 'not_found' }, 404);
    }

    if (docRows[0].deletedAt !== null) {
      return c.json({ error: 'not_found' }, 404);
    }

    const user = c.get('user');
    const eff = await loadEffectiveRole({ id: docId, uploaderId: docRows[0].uploaderId, visibility: docRows[0].visibility as Visibility }, user);
    if (!canRead(docRows[0].visibility as Visibility, eff)) {
      return c.json({ error: 'not_found' }, 404);
    }

    const versionRows = await db
      .select()
      .from(versions)
      .where(eq(versions.documentId, docId))
      .orderBy(desc(versions.versionNumber))
      .limit(1);

    if (versionRows.length === 0) {
      return c.json({ error: 'not_found' }, 404);
    }

    const doc = docRows[0];
    const v = versionRows[0];

    const [ext] = (await db.execute(sql`
      SELECT EXISTS(
        SELECT 1 FROM external_shares
        WHERE document_id = ${docId} AND revoked_at IS NULL
      ) AS "externallyShared"
    `)) as unknown as Array<{ externallyShared: boolean }>;

    const body: DocumentDetailResponse = {
      document: {
        id: doc.id,
        title: doc.title,
        description: doc.description,
        uploaderId: doc.uploaderId,
        uploaderDisplayName: doc.uploaderDisplayName,
        visibility: doc.visibility as 'org' | 'private',
        createdAt: doc.createdAt.toISOString(),
        externallyShared: Boolean(ext?.externallyShared),
        format: doc.format,
        agentMode: doc.agentMode,
        branchOf: doc.branchOf,
        forkedFrom: doc.forkedFrom,
        isTemplate: doc.isTemplate,
      } satisfies DocumentDetail,
      latestVersion: {
        id: v.id,
        versionNumber: v.versionNumber,
        versionNote: v.versionNote,
        sizeBytes: v.sizeBytes,
        createdAt: v.createdAt.toISOString(),
      },
      myRole: eff,
      lastView: null,
    };
    // Records this visit, returning the previous one for catch-up (read in
    // the same statement, so a second open can't lose it in between).
    try {
      const [prev] = (await db.execute(sql`
        WITH prev AS (
          SELECT viewed_at, last_doc_version FROM document_views WHERE user_id = ${user.id} AND document_id = ${docId}
        ), up AS (
          INSERT INTO document_views (user_id, document_id, last_doc_version)
          VALUES (${user.id}, ${docId}, (SELECT max(id) FROM doc_updates WHERE document_id = ${docId}))
          ON CONFLICT (user_id, document_id) DO UPDATE
            SET viewed_at = excluded.viewed_at, last_doc_version = excluded.last_doc_version
        )
        SELECT viewed_at AS "at", last_doc_version AS "docVersion" FROM prev
      `)) as unknown as { at: Date | string; docVersion: number | string | null }[];
      if (prev) {
        body.lastView = {
          at: new Date(prev.at).toISOString(),
          docVersion: prev.docVersion === null ? null : Number(prev.docVersion),
        };
      }
    } catch (err) {
      logger.warn({ err, docId, userId: user.id }, 'failed to upsert document_views');
    }

    return c.json(body, 200);
  });

  app.patch('/api/documents/:docId', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');

    let payload: { title?: unknown; description?: unknown; visibility?: unknown; agentMode?: unknown; isTemplate?: unknown };
    try {
      payload = (await c.req.json()) as typeof payload;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }

    const hasTitle = Object.prototype.hasOwnProperty.call(payload, 'title');
    const hasDescription = Object.prototype.hasOwnProperty.call(payload, 'description');

    const updates: { title?: string; description?: string | null; visibility?: 'org' | 'private'; agentMode?: AgentMode; isTemplate?: boolean } = {};

    if (hasTitle) {
      if (typeof payload.title !== 'string') {
        return c.json({ error: 'invalid_body', message: 'title must be a string' }, 400);
      }
      const trimmed = payload.title.trim();
      if (trimmed.length === 0 || trimmed.length > 200) {
        return c.json({ error: 'invalid_body', message: 'title must be 1–200 chars' }, 400);
      }
      updates.title = trimmed;
    }

    if (hasDescription) {
      if (payload.description === null) {
        updates.description = null;
      } else if (typeof payload.description === 'string') {
        const trimmed = payload.description.trim();
        if (trimmed.length > 2000) {
          return c.json({ error: 'invalid_body', message: 'description must be ≤2000 chars' }, 400);
        }
        updates.description = trimmed.length === 0 ? null : trimmed;
      } else {
        return c.json({ error: 'invalid_body', message: 'description must be string or null' }, 400);
      }
    }

    const hasVisibility = Object.prototype.hasOwnProperty.call(payload, 'visibility');
    if (hasVisibility) {
      if (payload.visibility !== 'org' && payload.visibility !== 'private') {
        return c.json(
          { error: 'invalid_body', message: "visibility must be 'org' or 'private'" },
          400,
        );
      }
      updates.visibility = payload.visibility;
      // A scoped token may narrow a doc to private (so a client can create
      // then restrict it) but never widen one to org: no scope grants
      // re-sharing (see auth/scopes.ts). canManage below still applies.
      if (tokenScopes(c) !== null && payload.visibility !== 'private') {
        return c.json(
          { error: 'insufficient_scope', message: 'API tokens with scopes can only make documents private.' },
          403,
        );
      }
    }

    // Whether agents edit or suggest here: the owner's call, made by a
    // person in a session (never by an agent, nor through a scoped token).
    const hasAgentMode = Object.prototype.hasOwnProperty.call(payload, 'agentMode');
    if (hasAgentMode) {
      if (payload.agentMode !== 'auto' && payload.agentMode !== 'edit' && payload.agentMode !== 'suggest') {
        return c.json({ error: 'invalid_body', message: "agentMode must be 'auto', 'edit' or 'suggest'" }, 400);
      }
      if (user.kind !== 'person' || tokenScopes(c) !== null) {
        return c.json({ error: 'forbidden', message: 'Only the owner, as a person, can change the agent mode.' }, 403);
      }
      updates.agentMode = payload.agentMode;
    }

    // Listed under Templates: the owner's call.
    const hasTemplate = Object.prototype.hasOwnProperty.call(payload, 'isTemplate');
    if (hasTemplate) {
      if (typeof payload.isTemplate !== 'boolean') return c.json({ error: 'invalid_body', message: 'isTemplate must be a boolean' }, 400);
      updates.isTemplate = payload.isTemplate;
    }

    if (!hasTitle && !hasDescription && !hasVisibility && !hasAgentMode && !hasTemplate) {
      return c.json({ error: 'invalid_body', message: 'Provide title, description, visibility, agentMode or isTemplate.' }, 400);
    }

    const [existing] = await db
      .select({ uploaderId: documents.uploaderId, visibility: documents.visibility, deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, docId));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.deletedAt !== null) return c.json({ error: 'not_found' }, 404);

    const eff = await loadEffectiveRole({ id: docId, uploaderId: existing.uploaderId, visibility: existing.visibility as Visibility }, user);
    if (!canRead(existing.visibility as Visibility, eff)) {
      return c.json({ error: 'not_found' }, 404);
    }
    // Sub 1 wired this to canEdit. Sub 2: if the body includes any manage-only
    // field, require canManage instead.
    const requiresManage = hasVisibility || hasAgentMode || hasTemplate;
    if (requiresManage) {
      if (!canManage(eff)) return c.json({ error: 'forbidden' }, 403);
    } else {
      if (!canEdit(eff)) return c.json({ error: 'forbidden' }, 403);
    }

    await db.update(documents).set(updates).where(eq(documents.id, docId));
    if (updates.visibility !== undefined) await recheckAccess({ documentId: docId });

    const [updated] = await db
      .select({
        id: documents.id,
        title: documents.title,
        description: documents.description,
        uploaderId: documents.uploaderId,
        visibility: documents.visibility,
        createdAt: documents.createdAt,
        agentMode: documents.agentMode,
        isTemplate: documents.isTemplate,
      })
      .from(documents)
      .where(eq(documents.id, docId));

    const [uploader] = await db
      .select({ displayName: actorName })
      .from(users)
      .where(eq(users.id, updated.uploaderId));

    return c.json(
      {
        id: updated.id,
        title: updated.title,
        description: updated.description,
        uploaderId: updated.uploaderId,
        uploaderDisplayName: uploader?.displayName ?? '',
        visibility: updated.visibility as 'org' | 'private',
        createdAt: updated.createdAt.toISOString(),
        agentMode: updated.agentMode,
        isTemplate: updated.isTemplate,
      },
      200
    );
  });

  app.delete('/api/documents/:docId', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');

    const [existing] = await db
      .select({ uploaderId: documents.uploaderId, visibility: documents.visibility, deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, docId));
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const eff = await loadEffectiveRole({ id: docId, uploaderId: existing.uploaderId, visibility: existing.visibility as Visibility }, user);
    if (!canRead(existing.visibility as Visibility, eff)) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (!canManage(eff)) return c.json({ error: 'forbidden' }, 403);

    let deletedAt: Date;
    if (existing.deletedAt !== null) {
      deletedAt = existing.deletedAt;
    } else {
      deletedAt = new Date();
      await db.update(documents).set({ deletedAt }).where(eq(documents.id, docId));
      await recheckAccess({ documentId: docId });
    }

    return c.json({ id: docId, deletedAt: deletedAt.toISOString() }, 200);
  });

  app.post('/api/documents/:docId/restore', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');

    const [existing] = await db
      .select({
        id: documents.id,
        title: documents.title,
        description: documents.description,
        uploaderId: documents.uploaderId,
        visibility: documents.visibility,
        createdAt: documents.createdAt,
        deletedAt: documents.deletedAt,
      })
      .from(documents)
      .where(eq(documents.id, docId));
    if (!existing) return c.json({ error: 'not_found' }, 404);

    const eff = await loadEffectiveRole({ id: docId, uploaderId: existing.uploaderId, visibility: existing.visibility as Visibility }, user);
    if (!canRead(existing.visibility as Visibility, eff)) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (!canManage(eff)) return c.json({ error: 'forbidden' }, 403);

    if (existing.deletedAt !== null) {
      const ageMs = Date.now() - existing.deletedAt.getTime();
      const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
      if (ageMs > THIRTY_DAYS_MS) {
        return c.json({ error: 'restore_window_expired', message: 'Restore window has expired.' }, 409);
      }
      await db.update(documents).set({ deletedAt: null }).where(eq(documents.id, docId));
    }

    const [uploader] = await db
      .select({ displayName: actorName })
      .from(users)
      .where(eq(users.id, existing.uploaderId));

    return c.json(
      {
        id: existing.id,
        title: existing.title,
        description: existing.description,
        uploaderId: existing.uploaderId,
        uploaderDisplayName: uploader?.displayName ?? '',
        visibility: existing.visibility as 'org' | 'private',
        createdAt: existing.createdAt.toISOString(),
      } satisfies DocumentSummary,
      200
    );
  });

  app.get('/api/documents/:docId/versions', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');

    const [existingDoc] = await db
      .select({ uploaderId: documents.uploaderId, visibility: documents.visibility, deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, docId));
    if (!existingDoc) return c.json({ error: 'not_found' }, 404);
    if (existingDoc.deletedAt !== null) return c.json({ error: 'not_found' }, 404);

    const eff = await loadEffectiveRole({ id: docId, uploaderId: existingDoc.uploaderId, visibility: existingDoc.visibility as Visibility }, user);
    if (!canRead(existingDoc.visibility as Visibility, eff)) {
      return c.json({ error: 'not_found' }, 404);
    }

    const rows = await db
      .select({
        id: versions.id,
        versionNumber: versions.versionNumber,
        versionNote: versions.versionNote,
        sizeBytes: versions.sizeBytes,
        createdAt: versions.createdAt,
        bundleKey: versions.bundleKey,
        docVersion: versions.docVersion,
        automatic: versions.automatic,
      })
      .from(versions)
      .where(eq(versions.documentId, docId))
      .orderBy(sql`${versions.versionNumber} DESC`);

    return c.json(
      {
        versions: rows.map((r) => ({
          id: r.id,
          versionNumber: r.versionNumber,
          versionNote: r.versionNote,
          sizeBytes: r.sizeBytes,
          createdAt: r.createdAt.toISOString(),
          bundled: r.bundleKey !== null,
          ...(r.docVersion !== null ? { docVersion: r.docVersion } : {}),
          ...(r.automatic ? { automatic: true } : {}),
        })),
      },
      200
    );
  });

  app.post('/api/documents/:docId/versions', async (c) => {
    const docId = c.req.param('docId');

    const form = await c.req.parseBody();
    const file = form['file'];
    const versionNoteRaw = form['versionNote'];
    const baseRaw = form['baseVersionNumber'];

    let baseVersionNumber: number | undefined;
    if (typeof baseRaw === 'string' && baseRaw.trim().length > 0) {
      baseVersionNumber = Number(baseRaw);
      if (!Number.isInteger(baseVersionNumber) || baseVersionNumber < 1) {
        return c.json({ error: 'invalid_body', message: 'baseVersionNumber must be a positive integer' }, 400);
      }
    }

    let bytes: Uint8Array | undefined;
    let filename = '';
    let contentType: string | undefined;
    if (file instanceof File) {
      bytes = new Uint8Array(await file.arrayBuffer());
      filename = file.name;
      contentType = file.type === '' ? undefined : file.type;
    }

    const validated = validateUpload({
      file: bytes ? { filename, contentType, bytes } : undefined,
      title: 'unused-but-validator-needs-it',
      description: undefined,
    });
    if (!validated.ok) {
      return c.json({ error: validated.error, message: validated.message }, 400);
    }

    const result = await publishDocument(deps.storage, {
      actor: c.get('user'),
      documentId: docId,
      content: validated.file.bytes,
      filename: validated.file.filename,
      format: validated.format,
      versionNote: typeof versionNoteRaw === 'string' ? versionNoteRaw : null,
      baseVersionNumber,
    });
    if (!result.ok) return refusalResponse(c, result);

    if (result.versionId === undefined) {
      const suggested: AddVersionResponse = { url: `/d/${docId}`, reconciliation: result.reconciliation };
      return c.json(suggested, 200);
    }
    const response: AddVersionResponse = {
      versionId: result.versionId,
      versionNumber: result.versionNumber,
      url: `/d/${docId}`,
      ...(result.reconciliation ? { reconciliation: result.reconciliation } : {}),
    };
    return c.json(response, 201);
  });

  // ─────────────── Live documents: checkpoints, export, files ───────────────

  app.post('/api/documents/:docId/checkpoints', async (c) => {
    const docId = c.req.param('docId');
    const access = await docAccess(docId, c.get('user'));
    if (!access) return c.json({ error: 'not_found' }, 404);
    if (!canEdit(access.role)) return c.json({ error: 'forbidden' }, 403);
    if (!access.format) return notLive(c);
    let note: string | null = null;
    const raw = await c.req.text();
    if (raw.trim().length > 0) {
      let body: { note?: unknown };
      try {
        body = JSON.parse(raw) as { note?: unknown };
      } catch {
        return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
      }
      if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
        return c.json({ error: 'invalid_body', message: 'note must be a string' }, 400);
      }
      note = typeof body.note === 'string' && body.note.trim().length > 0 ? body.note.trim().slice(0, 500) : null;
    }
    await ensureSigningKey(deps.storage);
    // A save is always a checkpoint (it also freezes records and comments);
    // the answer says when no one edited the content since the previous one.
    const unchangedSince = await contentUnchangedSince(docId);
    const checkpoint: CheckpointResponse = await createCheckpoint(deps.storage, docId, c.get('user'), note);
    return c.json(unchangedSince === null ? checkpoint : { ...checkpoint, unchangedSince }, 201);
  });

  app.post('/api/versions/:versionId/restore', async (c) => {
    const version = await checkpointOf(c.req.param('versionId'));
    if (!version) return c.json({ error: 'not_found' }, 404);
    const access = await docAccess(version.documentId, c.get('user'));
    if (!access) return c.json({ error: 'not_found' }, 404);
    if (!canEdit(access.role)) return c.json({ error: 'forbidden' }, 403);
    const result: RestoreCheckpointResponse = await restoreCheckpoint(deps.storage, version, c.get('user'));
    return c.json(result, 200);
  });

  // The frozen Y.Doc state of a checkpoint (BlockNote's version preview).
  app.get('/api/versions/:versionId/ydoc', async (c) => {
    const version = await checkpointOf(c.req.param('versionId'));
    if (!version) return c.json({ error: 'not_found' }, 404);
    if (!(await docAccess(version.documentId, c.get('user')))) return c.json({ error: 'not_found' }, 404);
    const bytes = await readBundleFile(deps.storage, version.bundleKey, 'state.ydoc');
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' },
    });
  });

  // ?format=markdown|text|html (default: the document's own), and
  // ?version=<n> for a checkpoint's bundle instead of the live state.
  app.get('/api/documents/:docId/export', async (c) => {
    const docId = c.req.param('docId');
    const access = await docAccess(docId, c.get('user'));
    if (!access) return c.json({ error: 'not_found' }, 404);
    if (!access.format) return notLive(c);
    const format = (c.req.query('format') ?? (access.format === 'markdown' ? 'markdown' : access.format)) as ExportFormat;
    if (format !== 'markdown' && format !== 'text' && format !== 'html') {
      return c.json({ error: 'invalid_query', message: 'format must be markdown, text or html' }, 400);
    }
    if (access.format === 'html' && format !== 'html') {
      return c.json({ error: 'invalid_query', message: 'a page exports as html' }, 400);
    }
    const versionParam = c.req.query('version');
    let body: string | Uint8Array<ArrayBuffer>;
    if (versionParam !== undefined) {
      const number = Number(versionParam);
      const [version] = Number.isInteger(number)
        ? await db
            .select({ bundleKey: versions.bundleKey })
            .from(versions)
            .where(sql`${versions.documentId} = ${docId} AND ${versions.versionNumber} = ${number}`)
        : [];
      if (!version?.bundleKey) return c.json({ error: 'not_found' }, 404);
      const own = exportFileOf(access.format);
      const file = format === 'html' ? 'export.html' : own;
      if (format !== 'html' && file !== (format === 'text' ? 'export.txt' : 'export.md')) {
        return c.json({ error: 'invalid_query', message: `checkpoints keep ${own} and export.html` }, 400);
      }
      body = await readBundleFile(deps.storage, version.bundleKey, file);
    } else {
      await ensureSigningKey(deps.storage);
      const decisions = await exportDecisions(docId);
      body = await withLiveDocument(docId, async (doc) =>
        access.format === 'html'
          ? ((await currentPageHtml(deps.storage, docId, doc)) ?? '')
          : format === 'html'
          ? exportHtml(doc, access.title, decisions)
          : format === 'text'
            ? exportText(doc, docId)
            : exportMarkdown(doc, docId, decisions),
      );
    }
    const ext = format === 'html' ? 'html' : format === 'text' ? 'txt' : 'md';
    const type = format === 'html' ? 'text/html' : format === 'text' ? 'text/plain' : 'text/markdown';
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': `${type}; charset=utf-8`,
        'content-disposition': `attachment; filename="${fileName(access.title)}.${ext}"`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    });
  });

  // The page behind "Print / PDF" (M10d): the static rendering, made printable
  // and served like any version's content (sandboxed frame, artifact CSP).
  // Without `?version=<n>` it renders the live state now, by the same code that
  // renders a checkpoint's `static.html`; with it, that checkpoint's bundle.
  /** The live state's widgets and data tables, drawn from the records now. */
  const liveEmbeds = async (doc: Y.Doc, docId: string) => {
    const records = await snapshotRecords(docId);
    const widgets = await bundleWidgets(doc, docId, records);
    const tables = embedTables(doc, records);
    return (html: string) => tables(widgets.embed(html));
  };

  app.get('/api/documents/:docId/print', async (c) => {
    const docId = c.req.param('docId');
    const access = await docAccess(docId, c.get('user'));
    if (!access) return c.json({ error: 'not_found' }, 404);
    if (!access.format) return notLive(c);
    const versionParam = c.req.query('version');
    let html: string;
    if (versionParam !== undefined) {
      const number = Number(versionParam);
      const [version] = Number.isInteger(number)
        ? await db
            .select({ bundleKey: versions.bundleKey })
            .from(versions)
            .where(and(eq(versions.documentId, docId), eq(versions.versionNumber, number)))
        : [];
      if (!version?.bundleKey) return c.json({ error: 'not_found' }, 404);
      html = new TextDecoder().decode(await readBundleFile(deps.storage, version.bundleKey, 'static.html'));
    } else {
      await ensureSigningKey(deps.storage);
      const decisions = await exportDecisions(docId);
      html = (
        await withLiveDocument(docId, async (doc) =>
          renderStatic(
            doc,
            access.title,
            decisions,
            access.format === 'html' ? await currentPageHtml(deps.storage, docId, doc) : null,
            await liveEmbeds(doc, docId),
          ),
        )
      ).served;
    }
    return new Response(printable(html), {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': artifactCsp('standard'),
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'private, no-store',
      },
    });
  });

  // A private branch of a live document, and a fork (a remix, or a new
  // document from a template): copies per C12 (live/copy.ts), owned by the
  // caller. Reading the source is enough.
  for (const kind of ['branch', 'fork'] as const) {
    app.post(`/api/documents/:docId/${kind}`, async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { title?: unknown };
      const out = await copyDocument(deps.storage, c.get('user'), c.req.param('docId'), kind, body?.title);
      return out.ok ? c.json({ documentId: out.documentId }, 201) : c.json({ error: out.refusal.code, refusal: out.refusal }, out.status);
    });
  }

  // A branch proposed back to its parent as one change set of suggestions.
  app.post('/api/documents/:docId/propose', async (c) => {
    const out = await proposeBranch(deps.storage, c.get('user'), c.req.param('docId'));
    return out.ok ? c.json(out.value, 200) : c.json({ error: out.refusal.code, refusal: out.refusal }, out.status);
  });

  // Every non-conflict suggestion of a change set, decided at once by a person.
  for (const decision of ['accept', 'reject'] as const) {
    app.post(`/api/change-sets/:id/${decision}`, async (c) => {
      const out = await decideChangeSet(c.req.param('id'), c.get('user'), decision);
      return out.ok ? c.json(out.value, 200) : c.json({ error: out.refusal.code, refusal: out.refusal }, out.status);
    });
  }

  // A file placed in a live document (image, video, audio, file blocks). The
  // document stores the opaque `primer-blob://<id>`, never a link.
  app.post('/api/documents/:docId/files', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');
    const access = await docAccess(docId, user);
    if (!access) return c.json({ error: 'not_found' }, 404);
    if (!canEdit(access.role)) return c.json({ error: 'forbidden' }, 403);
    if (!access.format) return notLive(c);
    const form = await c.req.parseBody();
    const file = form['file'];
    if (!(file instanceof File)) return c.json({ error: 'invalid_body', message: 'file is required' }, 400);
    if (file.size > MAX_BYTES) return c.json({ error: 'too_large', message: `File exceeds the ${MAX_BYTES}-byte limit.` }, 400);
    const fileId = uuidv7();
    const storageKey = `files/${docId}/${fileId}`;
    await deps.storage.put(storageKey, new Uint8Array(await file.arrayBuffer()));
    await db.insert(docFiles).values({
      id: fileId,
      documentId: docId,
      storageKey,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      uploadedBy: user.id,
    });
    const response: DocFileUploadResponse = { fileId, url: `primer-blob://${fileId}` };
    return c.json(response, 201);
  });

  // Served from the app's origin with the viewer's session, so nothing here
  // may run: a sandboxing CSP and nosniff always, and inline display only for
  // media types a browser shows passively.
  //
  // `?doc=` names the document whose content references the file, and the
  // file must belong to it: ids come from block props, which any editor can
  // write, so a file id copied from another document is never served here.
  app.get('/api/files/:fileId', async (c) => {
    const docId = c.req.query('doc') ?? '';
    const fileId = c.req.param('fileId');
    if (!UUID.test(docId) || !UUID.test(fileId)) return c.json({ error: 'not_found' }, 404);
    const [file] = await db
      .select()
      .from(docFiles)
      .where(and(eq(docFiles.id, fileId), eq(docFiles.documentId, docId)));
    if (!file) return c.json({ error: 'not_found' }, 404);
    if (!(await docAccess(file.documentId, c.get('user')))) return c.json({ error: 'not_found' }, 404);
    const inline = INLINE_TYPES.has(file.contentType);
    return new Response(await deps.storage.get(file.storageKey), {
      status: 200,
      headers: {
        'content-type': inline ? file.contentType : 'application/octet-stream',
        'content-disposition': inline ? 'inline' : 'attachment',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, max-age=31536000, immutable',
      },
    });
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const INLINE_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
  'video/mp4', 'video/webm', 'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/webm', 'application/pdf',
]);

/** The viewer's role on a document they can read, or null (not found). */
async function docAccess(docId: string, user: AppVariables['user']) {
  const [doc] = await db
    .select({
      uploaderId: documents.uploaderId,
      visibility: documents.visibility,
      deletedAt: documents.deletedAt,
      format: documents.format,
      title: documents.title,
    })
    .from(documents)
    .where(eq(documents.id, docId));
  if (!doc || doc.deletedAt !== null) return null;
  const role = await loadEffectiveRole({ id: docId, uploaderId: doc.uploaderId, visibility: doc.visibility as Visibility }, user);
  if (!canRead(doc.visibility as Visibility, role)) return null;
  return { role, format: doc.format, title: doc.title };
}

/** A checkpoint of a live document, or null. */
async function checkpointOf(versionId: string) {
  const [row] = await db
    .select({ documentId: versions.documentId, bundleKey: versions.bundleKey })
    .from(versions)
    .where(eq(versions.id, versionId));
  return row?.bundleKey ? { documentId: row.documentId, bundleKey: row.bundleKey } : null;
}

function notLive(c: Context<{ Variables: AppVariables }>) {
  const refusal: Refusal = {
    code: 'bad_request',
    message: 'This document is version-only HTML, not a live document.',
    fix: 'Open its versions instead; live documents are created from Markdown or text uploads.',
  };
  return c.json({ error: 'not_live', message: refusal.message, refusal }, 409);
}

function fileName(title: string): string {
  return title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'document';
}
