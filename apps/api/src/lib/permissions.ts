import { sql, type SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';
import type { AgentMode, CollaboratorRole } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';

// Re-exported so existing importers (notifier, collaborators routes) keep
// one import site while the union itself lives in api-types.
export type { CollaboratorRole } from '@polygonlabs/primer-api-types';

export type Visibility = 'org' | 'private';
export type EffectiveRole = 'owner' | 'editor' | 'responder' | 'commenter' | 'stranger';

const RANK: Record<EffectiveRole, number> = { stranger: 0, commenter: 1, responder: 2, editor: 3, owner: 4 };

/**
 * The actor's role on a document.
 *
 * - A person is `owner` of documents they uploaded and of documents their own
 *   agents uploaded; otherwise their collaborator role, if any.
 * - An agent gets the higher of its own role (computed the same way, without
 *   the agents rule) and its via person's role capped at `editor`: an agent
 *   never manages people, visibility or deletion on its person's behalf.
 */
export async function loadEffectiveRole(
  doc: { id: string; uploaderId: string; visibility: Visibility },
  actor: AuthUser,
): Promise<EffectiveRole> {
  const via = actor.kind === 'agent' ? actor.viaUserId : null;
  const ids = via ? [actor.id, via] : [actor.id];
  const rows = (await db.execute(sql`
    SELECT dc.user_id AS "userId", dc.role AS role
      FROM document_collaborators dc
     WHERE dc.document_id = ${doc.id}
       AND dc.user_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
  `)) as unknown as { userId: string; role: CollaboratorRole }[];
  const roleOf = (id: string): EffectiveRole => rows.find((r) => r.userId === id)?.role ?? 'stranger';

  if (actor.kind === 'person') {
    if (doc.uploaderId === actor.id) return 'owner';
    if (await isAgentOf(doc.uploaderId, actor.id)) return 'owner';
    return roleOf(actor.id);
  }

  const own: EffectiveRole = doc.uploaderId === actor.id ? 'owner' : roleOf(actor.id);
  if (!via) return own;
  let viaRole: EffectiveRole =
    doc.uploaderId === via || (await isAgentOf(doc.uploaderId, via)) ? 'owner' : roleOf(via);
  if (viaRole === 'owner') viaRole = 'editor';
  return RANK[own] >= RANK[viaRole] ? own : viaRole;
}

async function isAgentOf(userId: string, personId: string): Promise<boolean> {
  if (!userId.startsWith('agent_')) return false;
  const [row] = (await db.execute(sql`
    SELECT 1 AS hit FROM users WHERE id = ${userId} AND via_user_id = ${personId} LIMIT 1
  `)) as unknown as { hit: number }[];
  return row !== undefined;
}

/** SQL predicate: `column` (a user id) is `userId` or one of `userId`'s
 *  agents. For "documents I own" filters, so a person's library and `mine`
 *  scopes include what their agents created. */
export function isSelfOrAgentOf(column: AnyColumn | SQL, userId: string): SQL {
  return sql`(${column} = ${userId} OR ${column} IN (SELECT a.id FROM users a WHERE a.via_user_id = ${userId}))`;
}

/** Whose library an actor browses: an agent sees its person's (it can read
 *  at least what the person can), a person their own. */
export function libraryOwnerId(actor: AuthUser): string {
  return actor.kind === 'agent' && actor.viaUserId ? actor.viaUserId : actor.id;
}

/** SQL: the person who owns a document whose uploader is `column`: the
 *  uploader itself, or the person an uploading agent acts via. For "tell the
 *  owner" paths (notifications). */
export function ownerPersonOf(column: AnyColumn | SQL): SQL<string> {
  return sql<string>`COALESCE((SELECT o.via_user_id FROM users o WHERE o.id = ${column} AND o.kind = 'agent'), ${column})`;
}

export function canRead(visibility: Visibility, role: EffectiveRole): boolean {
  if (visibility === 'org') return true;
  return role !== 'stranger';
}

export function canComment(visibility: Visibility, role: EffectiveRole): boolean {
  // Same as canRead: reading implies the ability to comment.
  return canRead(visibility, role);
}

export function canEdit(role: EffectiveRole): boolean {
  // Responder is deliberately excluded: it exists so event-write can be granted without publish/rename rights.
  return role === 'owner' || role === 'editor';
}

export function canManage(role: EffectiveRole): boolean {
  return role === 'owner';
}

/**
 * How an actor's edits land on a live document: `edit` writes them, `suggest`
 * stores them as suggestions for a person to decide. People always edit. An
 * agent follows the document's `agentMode`; `auto` (the default) edits only
 * documents the agent owns: ones it or its person uploaded (or another agent
 * of its person did, which makes the person the owner). An agent's role on
 * its person's document is capped at editor, so ownership is compared by
 * person, not by role.
 */
export async function effectiveAgentMode(documentId: string, actorId: string): Promise<'edit' | 'suggest'> {
  const [row] = (await db.execute(sql`
    SELECT d.agent_mode AS "agentMode", d.uploader_id AS "uploaderId", up.via_user_id AS "uploaderVia",
           a.kind, a.via_user_id AS "actorVia"
      FROM documents d
      LEFT JOIN users up ON up.id = d.uploader_id
      LEFT JOIN users a ON a.id = ${actorId}
     WHERE d.id = ${documentId}
  `)) as unknown as { agentMode: AgentMode; uploaderId: string; uploaderVia: string | null; kind: string | null; actorVia: string | null }[];
  if (!row) return 'suggest';
  if (row.kind === 'person') return 'edit';
  if (row.agentMode !== 'auto') return row.agentMode;
  if (row.uploaderId === actorId) return 'edit';
  const ownerPerson = row.uploaderVia ?? row.uploaderId;
  return row.actorVia !== null && ownerPerson === row.actorVia ? 'edit' : 'suggest';
}
