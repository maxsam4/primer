import type { Hono } from 'hono';
import { eq, desc, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AppVariables, AppDeps } from '../app.ts';
import type { DocumentDetailResponse, DocumentDetail, AddVersionResponse, DocumentSummary } from '@polygonlabs/primer-api-types';
import { documents, versions, users } from '../db/schema.ts';
import { db } from '../db/client.ts';
import { logger } from '../logger.ts';
import { validateUpload } from '../upload/validate.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
import { markdownToHtml } from '../upload/markdown.ts';
import {
  canRead, canEdit, canManage, effectiveRole, loadCollaboratorRole,
  type Visibility,
} from '../lib/permissions.ts';
import { tokenScopes } from '../auth/scopes.ts';
import { carryOpenThreads } from '../lib/threadCarry.ts';

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
        uploaderDisplayName: users.displayName,
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
    const collabRole = await loadCollaboratorRole(docId, user.id);
    const eff = effectiveRole(docRows[0], user.id, collabRole);
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
      } satisfies DocumentDetail,
      latestVersion: {
        id: v.id,
        versionNumber: v.versionNumber,
        versionNote: v.versionNote,
        sizeBytes: v.sizeBytes,
        createdAt: v.createdAt.toISOString(),
      },
      myRole: eff,
    };
    try {
      await db.execute(sql`
        INSERT INTO document_views (user_id, document_id)
        VALUES (${user.id}, ${docId})
        ON CONFLICT (user_id, document_id) DO UPDATE SET viewed_at = excluded.viewed_at
      `);
    } catch (err) {
      logger.warn({ err, docId, userId: user.id }, 'failed to upsert document_views');
    }

    return c.json(body, 200);
  });

  app.patch('/api/documents/:docId', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');

    let payload: { title?: unknown; description?: unknown; visibility?: unknown };
    try {
      payload = (await c.req.json()) as { title?: unknown; description?: unknown; visibility?: unknown };
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }

    const hasTitle = Object.prototype.hasOwnProperty.call(payload, 'title');
    const hasDescription = Object.prototype.hasOwnProperty.call(payload, 'description');

    const updates: { title?: string; description?: string | null; visibility?: 'org' | 'private' } = {};

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

    if (!hasTitle && !hasDescription && !hasVisibility) {
      return c.json({ error: 'invalid_body', message: 'Provide title, description, or visibility.' }, 400);
    }

    const [existing] = await db
      .select({ uploaderId: documents.uploaderId, visibility: documents.visibility, deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, docId));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.deletedAt !== null) return c.json({ error: 'not_found' }, 404);

    const collabRole = await loadCollaboratorRole(docId, user.id);
    const eff = effectiveRole(existing, user.id, collabRole);
    if (!canRead(existing.visibility as Visibility, eff)) {
      return c.json({ error: 'not_found' }, 404);
    }
    // Sub 1 wired this to canEdit. Sub 2: if the body includes any manage-only
    // field, require canManage instead.
    const requiresManage = hasVisibility;
    if (requiresManage) {
      if (!canManage(eff)) return c.json({ error: 'forbidden' }, 403);
    } else {
      if (!canEdit(eff)) return c.json({ error: 'forbidden' }, 403);
    }

    await db.update(documents).set(updates).where(eq(documents.id, docId));

    const [updated] = await db
      .select({
        id: documents.id,
        title: documents.title,
        description: documents.description,
        uploaderId: documents.uploaderId,
        visibility: documents.visibility,
        createdAt: documents.createdAt,
      })
      .from(documents)
      .where(eq(documents.id, docId));

    const [uploader] = await db
      .select({ displayName: users.displayName })
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

    const collabRole = await loadCollaboratorRole(docId, user.id);
    const eff = effectiveRole(existing, user.id, collabRole);
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

    const collabRole = await loadCollaboratorRole(docId, user.id);
    const eff = effectiveRole(existing, user.id, collabRole);
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
      .select({ displayName: users.displayName })
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

    const collabRole = await loadCollaboratorRole(docId, user.id);
    const eff = effectiveRole(existingDoc, user.id, collabRole);
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
        })),
      },
      200
    );
  });

  app.post('/api/documents/:docId/versions', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');

    const [existingDoc] = await db
      .select({ uploaderId: documents.uploaderId, visibility: documents.visibility, deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, docId));
    if (!existingDoc) return c.json({ error: 'not_found' }, 404);
    if (existingDoc.deletedAt !== null) return c.json({ error: 'not_found' }, 404);

    const collabRole = await loadCollaboratorRole(docId, user.id);
    const eff = effectiveRole(existingDoc, user.id, collabRole);
    if (!canRead(existingDoc.visibility as Visibility, eff)) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (!canEdit(eff)) return c.json({ error: 'forbidden' }, 403);

    const form = await c.req.parseBody();
    const file = form['file'];
    const versionNoteRaw = form['versionNote'];

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

    const text = new TextDecoder('utf-8').decode(validated.file.bytes);
    const lowerName = validated.file.filename.toLowerCase();
    const isMarkdown =
      lowerName.endsWith('.md') || lowerName.endsWith('.markdown');

    let preparedHtml: string;
    if (isMarkdown) {
      let mdResult;
      try {
        mdResult = markdownToHtml(text);
      } catch (err) {
        return c.json(
          {
            error: 'parse_failed',
            message: `Markdown conversion failed: ${(err as Error).message}`,
          },
          400,
        );
      }
      if (mdResult.bodyIsEmpty) {
        return c.json(
          { error: 'parse_failed', message: 'Document body is empty.' },
          400,
        );
      }
      preparedHtml = mdResult.html;
    } else {
      preparedHtml = text;
    }

    // Primer authored the HTML for Markdown uploads, so the parent app owns
    // its theme; raw HTML uploads keep their own theme handling.
    const transformed = transformHtml(preparedHtml, { themeManaged: isMarkdown });
    if (!transformed.ok) {
      return c.json({ error: transformed.error, message: transformed.message }, 400);
    }

    let versionNote: string | null = null;
    if (typeof versionNoteRaw === 'string') {
      const trimmed = versionNoteRaw.trim();
      if (trimmed.length > 500) {
        return c.json({ error: 'invalid_body', message: 'versionNote must be ≤500 chars' }, 400);
      }
      versionNote = trimmed.length === 0 ? null : trimmed;
    }

    const versionId = uuidv7();
    const storageKey = `v1/${versionId}.html`;
    const transformedBytes = new TextEncoder().encode(transformed.html);

    const [maxRow] = (await db.execute(sql`
      SELECT COALESCE(MAX(version_number), 0)::int AS max_n
      FROM versions
      WHERE document_id = ${docId}
    `)) as unknown as { max_n: number }[];
    const nextNumber = (maxRow?.max_n ?? 0) + 1;

    await deps.storage.put(storageKey, transformedBytes);

    try {
      await db.transaction(async (tx) => {
        await tx.insert(versions).values({
          id: versionId,
          documentId: docId,
          versionNumber: nextNumber,
          storageKey,
          sizeBytes: transformedBytes.byteLength,
          versionNote,
        });
        await carryOpenThreads(tx, deps.storage, { documentId: docId, versionId, html: transformed.html });
      });
    } catch (err) {
      try { await deps.storage.delete(storageKey); } catch {}
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        return c.json({ error: 'version_race', message: 'Concurrent version write; retry.' }, 409);
      }
      throw err;
    }

    const response: AddVersionResponse = {
      versionId,
      versionNumber: nextNumber,
      url: `/d/${docId}`,
    };
    return c.json(response, 201);
  });
}
