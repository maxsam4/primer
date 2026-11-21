import { sql } from 'drizzle-orm';
import type { AuthUser } from '../app.ts';
import type { ResolvedAuth } from '../auth/revocation.ts';
import { db } from '../db/client.ts';
import { canEdit, canRead, loadEffectiveRole, type Visibility } from '../lib/permissions.ts';

/** Who opened a live connection, resolved once from the upgrade request. */
export type LiveAuth = ResolvedAuth;

/** The per-connection Hocuspocus context: `auth` from the upgrade, `user`
 *  and `documentId` added once the document is authorised. */
export type LiveContext = {
  auth?: LiveAuth;
  /** Re-resolves the opening credential (null once revoked): checked at the first join. */
  reauth?: () => Promise<LiveAuth | null>;
  user?: AuthUser;
  documentId?: string;
};

/**
 * What a connection may do on a live document: `none` (stranger, deleted,
 * legacy, or a scoped token without documents:read), `read` (readers, and
 * every bearer connection: agents write only through ops), or `write`
 * (owner and editors).
 */
export async function liveAccess(auth: LiveAuth, documentId: string): Promise<'none' | 'read' | 'write'> {
  if (auth.scopes && !auth.scopes.includes('documents:read')) return 'none';
  const [doc] = (await db.execute(sql`
    SELECT id, uploader_id AS "uploaderId", visibility, deleted_at AS "deletedAt", format
      FROM documents WHERE id = ${documentId} LIMIT 1
  `)) as unknown as { id: string; uploaderId: string; visibility: Visibility; deletedAt: Date | null; format: string | null }[];
  if (!doc || doc.deletedAt !== null || doc.format === null) return 'none';
  const role = await loadEffectiveRole(doc, auth.user);
  if (!canRead(doc.visibility, role)) return 'none';
  return auth.authMethod !== 'bearer' && canEdit(role) ? 'write' : 'read';
}
