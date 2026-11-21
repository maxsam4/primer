import type { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AppVariables, AppDeps, AuthUser } from '../app.ts';
import {
  isCollaboratorRole,
  type AddCollaboratorRequest,
  type Collaborator,
  type CollaboratorsListResponse,
  type RefusalCode,
  type UpdateCollaboratorRequest,
} from '@polygonlabs/primer-api-types';
import { documents, documentCollaborators, users } from '../db/schema.ts';
import { db } from '../db/client.ts';
import { actorName } from '../lib/actors.ts';
import { logger } from '../logger.ts';
import { recheckAccess } from '../auth/revocation.ts';
import type { Notifier } from '../notifications/notifier.ts';
import {
  canManage,
  canRead,
  loadEffectiveRole,
  type CollaboratorRole,
  type Visibility,
} from '../lib/permissions.ts';

type EffectiveRole = Awaited<ReturnType<typeof loadEffectiveRole>>;

/** Why a collaborator operation refused. `error` is the REST error code and
 *  the MCP tool's `code`; `fix` is the one-sentence next step for an agent.
 *  `message` is omitted where the REST body has only ever carried `error`. */
export interface CollaboratorFailure {
  ok: false;
  status: 400 | 403 | 404 | 409;
  error: RefusalCode;
  message?: string;
  fix: string;
}
export type CollaboratorResult<T> = { ok: true; value: T } | CollaboratorFailure;

function fail(
  status: CollaboratorFailure['status'],
  error: RefusalCode,
  fix: string,
  message?: string,
): CollaboratorFailure {
  return { ok: false, status, error, fix, ...(message === undefined ? {} : { message }) };
}

const NOT_FOUND = fail(404, 'not_found', 'Check the document id; it may not exist or you may not be able to see it.');
const FORBIDDEN = fail(403, 'forbidden', 'Only the document owner manages collaborators. Ask the owner to share it.');
const OWNER_NOT_COLLABORATOR = fail(
  400,
  'owner_not_collaborator',
  'The document owner already has full access; nothing to add.',
  'Owner cannot be added as their own collaborator.',
);

// The highest collaborator role each effective role may hand out. An owner
// is capped at editor, the top collaborator role. Nobody grants above their
// own role, which is what keeps an agent from exceeding itself.
const GRANT_CEILING: Record<EffectiveRole, number> = {
  stranger: 0,
  commenter: 1,
  responder: 2,
  editor: 3,
  owner: 3,
};
const COLLABORATOR_RANK: Record<CollaboratorRole, number> = { commenter: 1, responder: 2, editor: 3 };

/** True when an actor with effective role `eff` may grant `role`. */
export function canGrantRole(eff: EffectiveRole, role: CollaboratorRole): boolean {
  return COLLABORATOR_RANK[role] <= GRANT_CEILING[eff];
}

async function loadDocForManage(
  docId: string,
  actor: AuthUser,
): Promise<
  | CollaboratorFailure
  | { ok: true; eff: EffectiveRole; doc: { id: string; title: string; uploaderId: string; visibility: Visibility } }
> {
  const [row] = await db
    .select({
      id: documents.id,
      title: documents.title,
      uploaderId: documents.uploaderId,
      visibility: documents.visibility,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(eq(documents.id, docId));
  if (!row) return NOT_FOUND;
  if (row.deletedAt !== null) return NOT_FOUND;

  const eff = await loadEffectiveRole(
    { id: docId, uploaderId: row.uploaderId, visibility: row.visibility as Visibility },
    actor,
  );
  if (!canRead(row.visibility as Visibility, eff)) return NOT_FOUND;
  if (!canManage(eff)) return FORBIDDEN;
  return {
    ok: true,
    eff,
    doc: { id: row.id, title: row.title, uploaderId: row.uploaderId, visibility: row.visibility as Visibility },
  };
}

/** Resolves an email (case-insensitive) to a Primer user, or null. Shared by
 *  `primer_lookup_user` and `addCollaborator`. */
export async function lookupUserByEmail(
  email: string,
): Promise<{ id: string; email: string; displayName: string } | null> {
  const [row] = await db
    .select({ id: users.id, email: users.email, displayName: actorName })
    .from(users)
    .where(sql`lower(${users.email}) = ${email.trim().toLowerCase()}`)
    .limit(1);
  return row ?? null;
}

/** Lists a document's collaborators. Owner only. Shared by REST and MCP. */
export async function listCollaborators(
  actor: AuthUser,
  docId: string,
): Promise<CollaboratorResult<Collaborator[]>> {
  const gate = await loadDocForManage(docId, actor);
  if (!gate.ok) return gate;

  const rows = await db
    .select({
      userId: documentCollaborators.userId,
      role: documentCollaborators.role,
      grantedBy: documentCollaborators.grantedBy,
      createdAt: documentCollaborators.createdAt,
      displayName: actorName,
    })
    .from(documentCollaborators)
    .innerJoin(users, eq(users.id, documentCollaborators.userId))
    .where(eq(documentCollaborators.documentId, docId))
    .orderBy(documentCollaborators.createdAt);

  return {
    ok: true,
    value: rows.map((r) => ({
      userId: r.userId,
      displayName: r.displayName,
      role: r.role as CollaboratorRole,
      grantedBy: r.grantedBy,
      createdAt: r.createdAt.toISOString(),
    })),
  };
}

/**
 * Adds a collaborator, as `actor`. The one implementation behind
 * `POST /api/documents/:docId/collaborators` and `primer_add_collaborator`.
 *
 * - Owner only. An agent is the owner of documents it uploaded, and its
 *   person is also an owner (so can revoke); an agent never grants above
 *   its own role.
 * - The target is a user id or an email; an unknown one is `user_not_found`
 *   (this never creates users).
 * - The owner cannot be added, and `commenter` is refused on org documents.
 * - Fires `notifyCollaboratorAdded` after the row is written.
 */
export async function addCollaborator(
  actor: AuthUser,
  docId: string,
  input: { userId?: string; email?: string; role: CollaboratorRole },
  notifier: Notifier,
): Promise<CollaboratorResult<Collaborator>> {
  const gate = await loadDocForManage(docId, actor);
  if (!gate.ok) return gate;
  const { doc, eff } = gate;
  const { role } = input;

  if (!canGrantRole(eff, role)) {
    return fail(403, 'role_exceeds_own', 'Grant a role no higher than your own.', `You cannot grant ${role}.`);
  }

  let target: { id: string; displayName: string } | undefined;
  if (input.userId !== undefined) {
    [target] = await db
      .select({ id: users.id, displayName: actorName })
      .from(users)
      .where(eq(users.id, input.userId));
  } else if (input.email !== undefined) {
    target = (await lookupUserByEmail(input.email)) ?? undefined;
  }
  if (!target) {
    return fail(
      400,
      'user_not_found',
      'Check the email or user id. Primer does not create users; the person must have signed in to Primer once.',
      'target user does not exist',
    );
  }
  // Both the uploader and, for an agent's upload, the person it acts for own the document.
  const [uploader] = await db
    .select({ viaUserId: users.viaUserId })
    .from(users)
    .where(and(eq(users.id, doc.uploaderId), eq(users.kind, 'agent')));
  if (target.id === doc.uploaderId || target.id === uploader?.viaUserId) return OWNER_NOT_COLLABORATOR;

  // Responder is allowed on org documents because it grants what org visibility
  // does not (event-write); commenter is not because it grants nothing there.
  if (doc.visibility === 'org' && role === 'commenter') {
    return fail(
      400,
      'invalid_role_for_visibility',
      'Use responder or editor on an org-visible document.',
      'Commenter role is only meaningful under private visibility.',
    );
  }

  const createdAt = new Date();
  try {
    await db.insert(documentCollaborators).values({
      id: uuidv7(),
      documentId: docId,
      userId: target.id,
      role,
      grantedBy: actor.id,
      createdAt,
    });
  } catch (err) {
    const pgErr = err as { code?: string; cause?: { code?: string } };
    const pgCode = pgErr.code ?? pgErr.cause?.code;
    if (pgCode === '23505') {
      return fail(409, 'collaborator_exists', 'They already have access; nothing to do.', 'that user is already a collaborator');
    }
    throw err;
  }

  const addedUserId = target.id;
  void notifier
    .notifyCollaboratorAdded({ docId, docTitle: doc.title, addedUserId, addedByUserId: actor.id, role })
    .catch((err) => logger.error({ err, docId, addedUserId }, 'notifier notifyCollaboratorAdded failed'));

  return {
    ok: true,
    value: {
      userId: addedUserId,
      displayName: target.displayName,
      role,
      grantedBy: actor.id,
      createdAt: createdAt.toISOString(),
    },
  };
}

function failBody(f: CollaboratorFailure): { error: string; message?: string } {
  return f.message === undefined ? { error: f.error } : { error: f.error, message: f.message };
}

export function registerCollaboratorRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps,
): void {
  app.get('/api/documents/:docId/collaborators', async (c) => {
    const out = await listCollaborators(c.get('user'), c.req.param('docId'));
    if (!out.ok) return c.json(failBody(out), out.status);
    const body: CollaboratorsListResponse = { collaborators: out.value };
    return c.json(body, 200);
  });

  app.post('/api/documents/:docId/collaborators', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');
    // Authorise before reading the body: a non-owner learns nothing about
    // body validation.
    const gate = await loadDocForManage(docId, user);
    if (!gate.ok) return c.json(failBody(gate), gate.status);

    let payload: Partial<AddCollaboratorRequest>;
    try {
      payload = (await c.req.json()) as Partial<AddCollaboratorRequest>;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    if (typeof payload.userId !== 'string' || payload.userId.length === 0 || !isCollaboratorRole(payload.role)) {
      return c.json({ error: 'invalid_body', message: 'userId (string) and role (commenter|responder|editor) are required' }, 400);
    }
    const out = await addCollaborator(user, docId, { userId: payload.userId, role: payload.role }, deps.notifier);
    if (!out.ok) return c.json(failBody(out), out.status);
    return c.json(out.value, 201);
  });

  app.patch('/api/documents/:docId/collaborators/:userId', async (c) => {
    const docId = c.req.param('docId');
    const targetUserId = c.req.param('userId');
    const user = c.get('user');
    const gate = await loadDocForManage(docId, user);
    if (!gate.ok) return c.json(failBody(gate), gate.status);

    let payload: Partial<UpdateCollaboratorRequest>;
    try {
      payload = (await c.req.json()) as Partial<UpdateCollaboratorRequest>;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    if (!isCollaboratorRole(payload.role)) {
      return c.json({ error: 'invalid_body', message: 'role (commenter|responder|editor) is required' }, 400);
    }
    const { role } = payload;
    if (!canGrantRole(gate.eff, role)) {
      return c.json({ error: 'role_exceeds_own', message: `You cannot grant ${role}.` }, 403);
    }
    if (gate.doc.visibility === 'org' && role === 'commenter') {
      return c.json(
        { error: 'invalid_role_for_visibility', message: 'Commenter role is only meaningful under private visibility.' },
        400,
      );
    }

    const [existing] = await db
      .select({ userId: documentCollaborators.userId })
      .from(documentCollaborators)
      .where(and(eq(documentCollaborators.documentId, docId), eq(documentCollaborators.userId, targetUserId)));
    if (!existing) return c.json({ error: 'not_found' }, 404);

    await db
      .update(documentCollaborators)
      .set({ role })
      .where(and(eq(documentCollaborators.documentId, docId), eq(documentCollaborators.userId, targetUserId)));
    await recheckAccess({ documentId: docId });

    const [row] = await db
      .select({
        userId: documentCollaborators.userId,
        role: documentCollaborators.role,
        grantedBy: documentCollaborators.grantedBy,
        createdAt: documentCollaborators.createdAt,
        displayName: actorName,
      })
      .from(documentCollaborators)
      .innerJoin(users, eq(users.id, documentCollaborators.userId))
      .where(and(eq(documentCollaborators.documentId, docId), eq(documentCollaborators.userId, targetUserId)));

    const body: Collaborator = {
      userId: row.userId,
      displayName: row.displayName,
      role: row.role as CollaboratorRole,
      grantedBy: row.grantedBy,
      createdAt: row.createdAt.toISOString(),
    };
    return c.json(body, 200);
  });

  app.delete('/api/documents/:docId/collaborators/:userId', async (c) => {
    const docId = c.req.param('docId');
    const targetUserId = c.req.param('userId');
    const user = c.get('user');
    const gate = await loadDocForManage(docId, user);
    if (!gate.ok) return c.json(failBody(gate), gate.status);

    await db
      .delete(documentCollaborators)
      .where(and(eq(documentCollaborators.documentId, docId), eq(documentCollaborators.userId, targetUserId)));
    await recheckAccess({ documentId: docId });
    return new Response(null, { status: 204 });
  });
}
