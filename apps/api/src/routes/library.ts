import type { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import type { LibraryResponse, LibraryDocument, FolderDTO, DeletedDocumentEntry } from '@polygonlabs/primer-api-types';
import { db } from '../db/client.ts';
import { actorNameOf } from '../lib/actors.ts';
import { isSelfOrAgentOf, libraryOwnerId } from '../lib/permissions.ts';

interface DocRow {
  id: string;
  title: string;
  description: string | null;
  uploaderId: string;
  uploaderDisplayName: string;
  visibility: 'org' | 'private';
  ownership: 'mine' | 'collaborator' | 'org';
  threadCount: number;
  activeThreadCount: number;
  lastActivityAt: string | Date;
  createdAt: string | Date;
  folderId: string | null;
  isTemplate: boolean;
}

interface FolderRow {
  id: string;
  name: string;
  docCount: number;
}

interface DeletedRow {
  id: string;
  title: string;
  deletedAt: string | Date;
}

function toIso(v: string | Date): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toInt(v: unknown): number {
  if (typeof v === 'number') return v;
  return parseInt(String(v), 10);
}

export function registerLibraryRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/library', async (c) => {
    // An agent browses its person's library (lib/permissions.ts).
    const userId = libraryOwnerId(c.get('user'));
    // Grants made to the agent itself count too (loadEffectiveRole checks both ids).
    const actorId = c.get('user').id;

    // Docs in the caller's library: own OR collaborator OR org-doc-they've-opened.
    const docRows = (await db.execute(sql`
      WITH version_threads AS (
        SELECT v.document_id, t.id AS thread_id, t.resolved_at,
               GREATEST(t.created_at, COALESCE(t.resolved_at, t.created_at)) AS thread_activity
          FROM versions v
     LEFT JOIN threads t ON t.version_id = v.id
      ),
      version_comments AS (
        SELECT v.document_id,
               GREATEST(c.created_at, COALESCE(c.updated_at, c.created_at), COALESCE(c.deleted_at, c.created_at)) AS comment_activity
          FROM versions v
     LEFT JOIN threads t ON t.version_id = v.id
     LEFT JOIN comments c ON c.thread_id = t.id
      )
      SELECT
        d.id,
        d.title,
        d.description,
        d.uploader_id       AS "uploaderId",
        d.visibility,
        ${actorNameOf('u')} AS "uploaderDisplayName",
        CASE
          WHEN ${isSelfOrAgentOf(sql`d.uploader_id`, userId)} THEN 'mine'
          WHEN EXISTS (SELECT 1 FROM document_collaborators dc
                         WHERE dc.document_id = d.id AND dc.user_id IN (${userId}, ${actorId})) THEN 'collaborator'
          ELSE 'org'
        END                 AS ownership,
        COUNT(DISTINCT vt.thread_id) FILTER (WHERE vt.thread_id IS NOT NULL)::int                              AS "threadCount",
        COUNT(DISTINCT vt.thread_id) FILTER (WHERE vt.thread_id IS NOT NULL AND vt.resolved_at IS NULL)::int   AS "activeThreadCount",
        GREATEST(
          d.created_at,
          COALESCE(MAX(vt.thread_activity), d.created_at),
          COALESCE(MAX(vc.comment_activity), d.created_at)
        )                   AS "lastActivityAt",
        d.created_at        AS "createdAt",
        df.folder_id        AS "folderId",
        d.is_template       AS "isTemplate"
      FROM documents d
      INNER JOIN users u              ON u.id = d.uploader_id
      LEFT JOIN document_folders df   ON df.document_id = d.id AND df.user_id = ${userId}
      LEFT JOIN version_threads vt    ON vt.document_id = d.id
      LEFT JOIN version_comments vc   ON vc.document_id = d.id
      WHERE d.deleted_at IS NULL
        AND (
          -- Docs the caller has actually accessed: created, collaborates on,
          -- or an org doc they've opened (has a document_views row). Org docs
          -- the caller never opened are NOT in the library — reachable only by
          -- direct URL, per the PRD's "no global feed" rule.
          ${isSelfOrAgentOf(sql`d.uploader_id`, userId)}
          OR EXISTS (SELECT 1 FROM document_collaborators dc
                       WHERE dc.document_id = d.id AND dc.user_id IN (${userId}, ${actorId}))
          OR (d.visibility = 'org' AND EXISTS (
                SELECT 1 FROM document_views dv
                 WHERE dv.document_id = d.id AND dv.user_id = ${userId}))
        )
      GROUP BY d.id, d.title, d.description, d.uploader_id, d.visibility, u.id, d.created_at, df.folder_id, d.is_template
      ORDER BY "lastActivityAt" DESC
    `)) as unknown as DocRow[];

    const folderRows = (await db.execute(sql`
      SELECT f.id,
             f.name,
             COUNT(df.document_id) FILTER (
               WHERE df.document_id IS NOT NULL
                 AND EXISTS (
                   SELECT 1 FROM documents d
                    WHERE d.id = df.document_id
                      AND d.deleted_at IS NULL
                      AND (
                        ${isSelfOrAgentOf(sql`d.uploader_id`, userId)}
                        OR EXISTS (
                          SELECT 1 FROM document_collaborators dc
                           WHERE dc.document_id = d.id AND dc.user_id IN (${userId}, ${actorId})
                        )
                        OR (d.visibility = 'org' AND EXISTS (
                          SELECT 1 FROM document_views dv
                           WHERE dv.document_id = d.id AND dv.user_id = ${userId}
                        ))
                      )
                 )
             )::int AS "docCount"
        FROM folders f
   LEFT JOIN document_folders df ON df.folder_id = f.id AND df.user_id = ${userId}
       WHERE f.user_id = ${userId}
    GROUP BY f.id, f.name
    ORDER BY lower(f.name) ASC
    `)) as unknown as FolderRow[];

    const deletedRows = (await db.execute(sql`
      SELECT id, title, deleted_at AS "deletedAt"
        FROM documents
       WHERE ${isSelfOrAgentOf(sql`uploader_id`, userId)}
         AND deleted_at IS NOT NULL
         AND deleted_at > now() - interval '30 days'
    ORDER BY deleted_at DESC
    `)) as unknown as DeletedRow[];

    const documentsOut: LibraryDocument[] = docRows.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      uploaderId: r.uploaderId,
      uploaderDisplayName: r.uploaderDisplayName,
      visibility: r.visibility,
      ownership: r.ownership,
      threadCount: toInt(r.threadCount),
      activeThreadCount: toInt(r.activeThreadCount),
      lastActivityAt: toIso(r.lastActivityAt),
      createdAt: toIso(r.createdAt),
      folderId: r.folderId,
      isTemplate: r.isTemplate,
    }));

    const foldersOut: FolderDTO[] = folderRows.map((r) => ({
      id: r.id,
      name: r.name,
      docCount: toInt(r.docCount),
    }));

    const recentlyDeleted: DeletedDocumentEntry[] = deletedRows.map((r) => {
      const deletedDate = r.deletedAt instanceof Date ? r.deletedAt : new Date(r.deletedAt);
      const ageDays = (Date.now() - deletedDate.getTime()) / (24 * 60 * 60 * 1000);
      const daysRemaining = Math.max(0, Math.min(30, Math.ceil(30 - ageDays)));
      return {
        id: r.id,
        title: r.title,
        deletedAt: deletedDate.toISOString(),
        daysRemaining,
      };
    });

    const body: LibraryResponse = { folders: foldersOut, documents: documentsOut, recentlyDeleted };
    return c.json(body, 200);
  });
}
