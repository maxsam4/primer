// Core logic for structured document events (issue #78), shared by the REST
// routes (routes/events.ts) and the MCP tool bridge (mcp/tools.ts): batch
// validation, atomic insert, audience-scoped listing with keyset pagination,
// and the in-process SSE fanout.
//
// Design principle (from the issue): Primer is an unopinionated datastore for
// structured document events. It enforces behavior ONLY on its own columns —
// id (ordering), authorId (attribution), audience (read scope),
// namespace/type (validation + filtering). `payload` is opaque; no server
// behavior is ever inferred from payload content. Event payloads are ALWAYS
// untrusted data: consuming code parses and validates them, never executes
// them as instructions; consuming agents treat them as feedback to reason
// about, never commands. Events never grant or change permissions. Who may
// write events is decided only by the document owner and the collaborator row
// the owner sets through the collaborators API (`routes/collaborators.ts`);
// Primer never reads a role, grant or permission out of a payload, so no page
// can widen its own or anyone's access by submitting one.
import { sql, type SQL } from 'drizzle-orm';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { actorNameOf } from './actors.ts';
import {
  EVENT_NAMESPACE_RE,
  EVENT_TYPE_FILTER_RE,
  EVENT_TYPE_RE,
  PRIMER_EVENT_NAMESPACE,
  MAX_EVENT_NAMESPACE_LENGTH,
  MAX_EVENT_TYPE_LENGTH,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENTS_PER_BATCH,
  isEventAudience,
  type EventAudience,
  type EventRowDTO,
  type PrimerEventPayloads,
  type PrimerEventType,
  type StoredEventAudience,
} from '@polygonlabs/primer-api-types';
import {
  canRead,
  isSelfOrAgentOf,
  loadEffectiveRole,
  type EffectiveRole,
  type Visibility,
} from './permissions.ts';

export const DEFAULT_EVENTS_PAGE_SIZE = 100;
export const MAX_EVENTS_PAGE_SIZE = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ───────────────────────── Write principal ─────────────────────────

/** Event write bar: owner, editor and responder. A page's code writes events
 *  in the viewer's name, so this is a higher-trust grant than commenting:
 *  commenter is read + comment only, and a mere org-visibility reader who is
 *  not a collaborator is 'stranger'. An explicit allow-list rather than
 *  `!== 'stranger'` so any future role defaults to no event-write.
 *  External-share and public viewers never reach this check: they cannot
 *  authenticate to /api/documents routes at all (their session plane stops
 *  at /api/share/*). */
export function canWriteEvents(role: EffectiveRole): boolean {
  return role === 'owner' || role === 'editor' || role === 'responder';
}

// ───────────────────────── Read identity ─────────────────────────

/** What the audience scoping needs to know about the caller. Computed once
 *  per request/connection from the document row + collaborator lookup. */
export interface EventReadIdentity {
  userId: string;
  isOwner: boolean;
  isCollaborator: boolean;
  /** Agents are never handed their own `data.changed` (see notOwnDataChanged). */
  isAgent: boolean;
}

// ───────────────────────── Access gate ─────────────────────────
// Shared by the REST routes and the MCP tool bridge so both surfaces apply
// identical access rules.

export interface EventDocContext {
  id: string;
  uploaderId: string;
  visibility: Visibility;
}

export async function loadEventDocContext(documentId: string): Promise<EventDocContext | null> {
  if (!UUID_RE.test(documentId)) return null;
  const [row] = (await db.execute(sql`
    SELECT d.id, d.uploader_id AS "uploaderId", d.visibility, d.deleted_at AS "deletedAt"
    FROM documents d WHERE d.id = ${documentId} LIMIT 1
  `)) as unknown as {
    id: string;
    uploaderId: string;
    visibility: Visibility;
    deletedAt: Date | null;
  }[];
  if (!row || row.deletedAt !== null) return null;
  return { id: row.id, uploaderId: row.uploaderId, visibility: row.visibility };
}

export type EventAccessGate =
  | { status: 'not_found' }
  | {
      status: 'ok';
      doc: EventDocContext;
      identity: EventReadIdentity;
      /** True when the caller may write events (owner, editor or responder). */
      mayWrite: boolean;
    };

/** Read gate: not_found (per existing route conventions) when the document
 *  doesn't exist, is deleted, or the caller can't see it at all. Returns the
 *  caller's read identity for per-row audience scoping. */
export async function gateEventAccess(documentId: string, actor: AuthUser): Promise<EventAccessGate> {
  const doc = await loadEventDocContext(documentId);
  if (!doc) return { status: 'not_found' };
  const eff = await loadEffectiveRole(doc, actor);
  if (!canRead(doc.visibility, eff)) return { status: 'not_found' };
  // An agent reads its person's documents as the owner does (every audience),
  // though it acts there with at most editor rights.
  const readsAsOwner =
    eff === 'owner' ||
    (actor.kind === 'agent' &&
      actor.viaUserId !== null &&
      (await loadEffectiveRole(doc, { id: actor.viaUserId, email: '', displayName: '', kind: 'person', viaUserId: null })) ===
        'owner');
  return {
    status: 'ok',
    doc,
    identity: {
      userId: actor.id,
      isOwner: readsAsOwner,
      isCollaborator: eff !== 'owner' && eff !== 'stranger',
      isAgent: actor.kind === 'agent',
    },
    mayWrite: canWriteEvents(eff),
  };
}

/** Validates the optional versionId provenance filter: must be a version of
 *  THIS document, else bad_request. A version-filtered read is a provenance
 *  lens, never a complete partition of the stream. */
export async function validateVersionFilter(
  documentId: string,
  raw: string | undefined,
): Promise<{ ok: true; versionId?: string } | { ok: false }> {
  if (raw === undefined) return { ok: true };
  if (!UUID_RE.test(raw)) return { ok: false };
  const foreign = await findForeignVersionIds(documentId, [raw]);
  if (foreign.length > 0) return { ok: false };
  return { ok: true, versionId: raw };
}

// ───────────────────────── Batch validation ─────────────────────────

/** `primer` and everything beneath it belong to Primer's lifecycle events;
 *  no client (page, REST or MCP) may write there. */
function isReservedNamespace(namespace: string): boolean {
  return namespace === PRIMER_EVENT_NAMESPACE || namespace.startsWith(`${PRIMER_EVENT_NAMESPACE}/`);
}

export interface ValidatedEvent {
  namespace: string;
  type: string;
  audience: EventAudience;
  /** Serialized once at validation time — reused by the insert so the size
   *  cap and the stored value can never disagree. */
  payloadJson: string;
  payload: unknown;
  versionId: string | null;
}

export type BatchValidation =
  | { ok: true; events: ValidatedEvent[] }
  | { ok: false; message: string };

/** Validates a whole POST body. All-or-nothing by construction: the first
 *  invalid event fails the batch and the caller inserts nothing. */
export function validateEventBatch(raw: unknown): BatchValidation {
  if (typeof raw !== 'object' || raw === null || !Array.isArray((raw as { events?: unknown }).events)) {
    return { ok: false, message: 'body must be { events: [event…] }' };
  }
  const batch = (raw as { events: unknown[] }).events;
  if (batch.length === 0) {
    return { ok: false, message: 'events must contain at least one event' };
  }
  if (batch.length > MAX_EVENTS_PER_BATCH) {
    return { ok: false, message: `events must contain at most ${MAX_EVENTS_PER_BATCH} events` };
  }
  const out: ValidatedEvent[] = [];
  for (let i = 0; i < batch.length; i++) {
    const ev = batch[i];
    if (typeof ev !== 'object' || ev === null) {
      return { ok: false, message: `events[${i}] must be an object` };
    }
    const e = ev as Record<string, unknown>;
    if (!isEventAudience(e.audience)) {
      return {
        ok: false,
        message: `events[${i}].audience is required and must be one of author|collaborators|artifact`,
      };
    }
    if (
      typeof e.namespace !== 'string' ||
      e.namespace.length > MAX_EVENT_NAMESPACE_LENGTH ||
      !EVENT_NAMESPACE_RE.test(e.namespace)
    ) {
      return {
        ok: false,
        message: `events[${i}].namespace must be /-separated lowercase kebab segments (e.g. "example", "example/telemetry")`,
      };
    }
    if (isReservedNamespace(e.namespace)) {
      return {
        ok: false,
        message: `events[${i}].namespace "${PRIMER_EVENT_NAMESPACE}" is reserved for Primer's own events`,
      };
    }
    if (
      typeof e.type !== 'string' ||
      e.type.length > MAX_EVENT_TYPE_LENGTH ||
      !EVENT_TYPE_RE.test(e.type)
    ) {
      return {
        ok: false,
        message: `events[${i}].type must be a single lowercase kebab name (e.g. "export")`,
      };
    }
    if (!('payload' in e)) {
      return { ok: false, message: `events[${i}].payload is required (any JSON value)` };
    }
    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(e.payload) ?? 'null';
    } catch {
      return { ok: false, message: `events[${i}].payload is not JSON-serializable` };
    }
    if (Buffer.byteLength(payloadJson, 'utf8') > MAX_EVENT_PAYLOAD_BYTES) {
      return {
        ok: false,
        message: `events[${i}].payload exceeds ${MAX_EVENT_PAYLOAD_BYTES} serialized bytes`,
      };
    }
    let versionId: string | null = null;
    if (e.versionId !== undefined && e.versionId !== null) {
      if (typeof e.versionId !== 'string' || !UUID_RE.test(e.versionId)) {
        return { ok: false, message: `events[${i}].versionId must be a version uuid` };
      }
      versionId = e.versionId;
    }
    out.push({
      namespace: e.namespace,
      type: e.type,
      audience: e.audience,
      payloadJson,
      payload: e.payload,
      versionId,
    });
  }
  return { ok: true, events: out };
}

/** Every distinct versionId declared by the batch must belong to the
 *  document (issue #78 security requirement 5). Returns the ids that do
 *  NOT — a non-empty result rejects the whole batch as bad_request. */
export async function findForeignVersionIds(
  documentId: string,
  versionIds: string[],
): Promise<string[]> {
  const distinct = [...new Set(versionIds)];
  if (distinct.length === 0) return [];
  const idList = sql.join(
    distinct.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await db.execute(sql`
    SELECT id FROM versions
    WHERE document_id = ${documentId} AND id IN (${idList})
  `)) as unknown as { id: string }[];
  const found = new Set(rows.map((r) => r.id));
  return distinct.filter((id) => !found.has(id));
}

// ───────────────────────── Insert (atomic batch) ─────────────────────────

interface EventDbRow {
  id: number | string; // bigserial arrives as string from postgres-js
  documentId: string;
  versionId: string | null;
  authorId: string;
  audience: StoredEventAudience;
  namespace: string;
  type: string;
  payload: unknown;
  createdAt: Date | string;
}

function rowToDTO(r: EventDbRow): EventRowDTO {
  const dto: EventRowDTO = {
    id: Number(r.id),
    documentId: r.documentId,
    authorId: r.authorId,
    audience: r.audience,
    namespace: r.namespace,
    type: r.type,
    payload: r.payload,
    createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : new Date(r.createdAt).toISOString(),
  };
  // Emitted only when the writer declared it (matches the wire contract's
  // optional field — consumers key on id, never on this).
  if (r.versionId !== null) dto.versionId = r.versionId;
  return dto;
}

const SELECT_COLUMNS = sql`
  id, document_id AS "documentId", version_id AS "versionId",
  author_id AS "authorId", audience, namespace, type, payload,
  created_at AS "createdAt"
`;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface EventInsert {
  documentId: string;
  versionId: string | null;
  authorId: string;
  audience: StoredEventAudience;
  namespace: string;
  type: string;
  payloadJson: string;
}

// Every event write takes this transaction-scoped lock right before it draws
// ids, and holds it until commit. Postgres releases it only after the commit
// is visible, so the next writer draws higher ids strictly after this one is
// readable: ids follow commit order and `id > N` never skips a row that
// commits later. The lock serializes only the tail of each writing
// transaction (the event inserts and the commit), which is why callers write
// events last.
export const EVENT_ORDER_LOCK_KEY = 7_201_948_211;

/** Documents written to, with their owners: who to wake after commit. */
type Touched = { documentId: string; ownerId: string }[];

async function insertEventsLocked(
  tx: Tx,
  rows: EventInsert[],
): Promise<{ rows: EventRowDTO[]; touched: Touched }> {
  // Read before taking the lock, so the lock still covers only the inserts.
  const docIds = [...new Set(rows.map((r) => r.documentId))];
  // A document's owner stream is its uploader's and, when the uploader is an
  // agent, its person's (a person owns what their agents create).
  const touched = (await tx.execute(sql`
    SELECT d.id AS "documentId", o.owner AS "ownerId"
    FROM documents d
    JOIN users u ON u.id = d.uploader_id
    CROSS JOIN LATERAL (VALUES (d.uploader_id), (u.via_user_id)) AS o(owner)
    WHERE d.id IN (${sql.join(docIds.map((id) => sql`${id}::uuid`), sql`, `)})
      AND o.owner IS NOT NULL
  `)) as unknown as Touched;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(${EVENT_ORDER_LOCK_KEY})`);
  const out: EventRowDTO[] = [];
  for (const r of rows) {
    const [row] = (await tx.execute(sql`
      INSERT INTO events (document_id, version_id, author_id, audience, namespace, type, payload)
      VALUES (${r.documentId}, ${r.versionId}, ${r.authorId}, ${r.audience},
              ${r.namespace}, ${r.type}, ${r.payloadJson}::jsonb)
      RETURNING ${SELECT_COLUMNS}
    `)) as unknown as EventDbRow[];
    out.push(rowToDTO(row));
  }
  return { rows: out, touched: [...touched] };
}

/** Inserts a validated batch in ONE transaction, in array order: strictly
 *  increasing ids, all visible together at commit — the atomicity that lets
 *  a consumer split an oversized logical write across several events without
 *  losing all-or-nothing. Wakes open streams after commit. */
export async function insertEventBatch(
  documentId: string,
  authorId: string,
  batch: ValidatedEvent[],
): Promise<EventRowDTO[]> {
  const { rows, touched } = await db.transaction((tx) =>
    insertEventsLocked(
      tx,
      batch.map((ev) => ({
        documentId,
        versionId: ev.versionId,
        authorId,
        audience: ev.audience,
        namespace: ev.namespace,
        type: ev.type,
        payloadJson: ev.payloadJson,
      })),
    ),
  );
  notifyEventsCommitted(touched);
  return rows;
}

// ───────────────────────── Lifecycle events ─────────────────────────
// Primer's own events (namespace `primer`, audience `readers`): written in the
// same transaction as the change they describe, so a reader never sees the
// change without its event or the event without the change.

export interface LifecycleEvent<T extends PrimerEventType = PrimerEventType> {
  documentId: string;
  /** Provenance column (the version the event concerns), when there is one. */
  versionId?: string;
  /** Who caused it — the row's authorId. */
  actorId: string;
  type: T;
  payload: PrimerEventPayloads[T];
}

export type EmitLifecycle = <T extends PrimerEventType>(event: LifecycleEvent<T>) => void;

/** Runs `fn` in a transaction and writes the lifecycle events it emits at the
 *  end of that same transaction (after everything `fn` wrote, so the
 *  ordering lock is held only for the tail). Open streams are woken after
 *  commit. Every lifecycle write goes through here. */
export async function transactionWithEvents<T>(
  fn: (tx: Tx, emit: EmitLifecycle) => Promise<T>,
): Promise<T> {
  let touched: Touched = [];
  let emitted: LifecycleEvent[] = [];
  const result = await db.transaction(async (tx) => {
    emitted = [];
    touched = [];
    const value = await fn(tx, (event) => {
      emitted.push(event as LifecycleEvent);
    });
    if (emitted.length > 0) {
      ({ touched } = await insertEventsLocked(
        tx,
        emitted.map((e) => ({
          documentId: e.documentId,
          versionId: e.versionId ?? null,
          authorId: e.actorId,
          audience: 'readers',
          namespace: PRIMER_EVENT_NAMESPACE,
          type: e.type,
          payloadJson: JSON.stringify(e.payload),
        })),
      ));
    }
    return value;
  });
  notifyEventsCommitted(touched);
  for (const handler of lifecycleHandlers) for (const event of emitted) handler(event);
  return result;
}

const lifecycleHandlers = new Set<(event: LifecycleEvent) => void>();

/** Runs after each lifecycle event commits (the live server relays some to
 *  a document's open editors: live/instance.ts). */
export function onLifecycleCommitted(handler: (event: LifecycleEvent) => void): () => void {
  lifecycleHandlers.add(handler);
  return () => lifecycleHandlers.delete(handler);
}

// ───────────────────────── Filters ─────────────────────────

export interface EventFilters {
  /** Exact namespace, or the one glob form this API owns: a trailing `/*`
   *  matches the namespace and every sub-namespace beneath it. */
  namespace?: string;
  /** Exact type. */
  type?: string;
}

export type FilterValidation = { ok: true; filters: EventFilters } | { ok: false; message: string };

/** Validates ?namespace= / ?type= query params (shared by list and stream —
 *  Pin 14 filter parity). Filters are bandwidth hygiene, never a correctness
 *  or security boundary — `audience` governs who may read. */
export function validateEventFilters(query: {
  namespace?: string;
  type?: string;
}): FilterValidation {
  const filters: EventFilters = {};
  if (query.namespace !== undefined) {
    const base = query.namespace.endsWith('/*') ? query.namespace.slice(0, -2) : query.namespace;
    if (base.length === 0 || base.length > MAX_EVENT_NAMESPACE_LENGTH || !EVENT_NAMESPACE_RE.test(base)) {
      return { ok: false, message: 'namespace must be exact (e.g. "example") or a subtree glob (e.g. "example/*")' };
    }
    filters.namespace = query.namespace;
  }
  if (query.type !== undefined) {
    if (query.type.length === 0 || query.type.length > MAX_EVENT_TYPE_LENGTH || !EVENT_TYPE_FILTER_RE.test(query.type)) {
      return { ok: false, message: 'type must be a single lowercase kebab name' };
    }
    filters.type = query.type;
  }
  return { ok: true, filters };
}

// ───────────────────────── since / page tokens ─────────────────────────

/** `since` is a complete resume point: ids follow commit order (see
 *  EVENT_ORDER_LOCK_KEY), so every row committed after a read of `id > N`
 *  has an id above everything that read returned. */
export function parseSince(raw: string | undefined): { ok: true; since: number | null } | { ok: false } {
  if (raw === undefined) return { ok: true, since: null };
  if (!/^\d{1,18}$/.test(raw)) return { ok: false };
  return { ok: true, since: Number(raw) };
}

const PAGE_TOKEN_PREFIX = 'v1:';

export function encodePageToken(lastId: number): string {
  return Buffer.from(`${PAGE_TOKEN_PREFIX}${lastId}`, 'utf8').toString('base64url');
}

export function decodePageToken(token: string): number | null {
  let decoded: string;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.startsWith(PAGE_TOKEN_PREFIX)) return null;
  const rest = decoded.slice(PAGE_TOKEN_PREFIX.length);
  if (!/^\d{1,18}$/.test(rest)) return null;
  return Number(rest);
}

// ───────────────────────── List query ─────────────────────────

export interface ListEventsArgs {
  documentId: string;
  identity: EventReadIdentity;
  filters: EventFilters;
  /** Highest id already consumed (from ?since, Last-Event-ID, or a page
   *  token) — the query returns rows with id strictly greater. */
  afterId: number | null;
  /** Optional provenance lens: only rows that DECLARED this version. Never a
   *  complete partition of the stream — consumers own version semantics. */
  versionId?: string;
  limit: number;
}

export interface ListEventsPage {
  rows: EventRowDTO[];
  nextPageToken: string | null;
}

/** An agent is never handed the `data.changed` events it authored: its own
 *  record writes must not wake it (records/changed.ts). A person keeps them,
 *  so a second tab of the same person still refreshes. */
function notOwnDataChanged(authorColumn: SQL, readerId: string, readerIsAgent: boolean): SQL {
  if (!readerIsAgent) return sql`TRUE`;
  return sql`NOT (namespace = ${PRIMER_EVENT_NAMESPACE} AND type = 'data.changed' AND ${authorColumn} = ${readerId})`;
}

function filterConditions(filters: EventFilters) {
  const conditions = [];
  if (filters.namespace !== undefined) {
    if (filters.namespace.endsWith('/*')) {
      // Subtree form. The namespace regex admits only [a-z0-9-/], so the
      // prefix can never contain LIKE metacharacters — no escaping needed.
      const prefix = filters.namespace.slice(0, -2);
      conditions.push(sql`(namespace = ${prefix} OR namespace LIKE ${`${prefix}/%`})`);
    } else {
      conditions.push(sql`namespace = ${filters.namespace}`);
    }
  }
  if (filters.type !== undefined) conditions.push(sql`type = ${filters.type}`);
  return conditions;
}

/** One bounded page of ascending-id rows the caller's identity may read,
 *  plus an opaque next-page token when more remain. */
export async function listEvents(args: ListEventsArgs): Promise<ListEventsPage> {
  const { documentId, identity, filters, afterId, versionId, limit } = args;

  const conditions = [sql`document_id = ${documentId}`, ...filterConditions(filters)];
  if (afterId !== null) conditions.push(sql`id > ${afterId}`);
  if (versionId !== undefined) conditions.push(sql`version_id = ${versionId}`);

  // Audience scope: exactly the rows this identity may read (issue #78
  // security requirement 4):
  //  - readers:       everyone who passed the read gate (Primer's own rows)
  //  - author:        the row's author + the document owner
  //  - collaborators: all document collaborators (owner included)
  //  - artifact:      same readers as collaborators; additionally relayed
  //                   into the sandboxed artifact by the parent page (the
  //                   relay is the injection boundary).
  // Commenters keep READ access to collaborators- and artifact-audience rows
  // (consumers render the page from them); they lose event write only.
  const tierReadable = identity.isOwner || identity.isCollaborator;
  conditions.push(sql`(
    audience = 'readers'
    OR (audience = 'author' AND (author_id = ${identity.userId} OR ${identity.isOwner}))
    OR (audience IN ('collaborators', 'artifact') AND ${tierReadable})
  )`);

  conditions.push(notOwnDataChanged(sql`author_id`, identity.userId, identity.isAgent));

  const where = sql.join(conditions, sql` AND `);
  // Fetch one extra row to learn whether another page exists.
  const rows = (await db.execute(sql`
    SELECT ${SELECT_COLUMNS}
    FROM events
    WHERE ${where}
    ORDER BY id ASC
    LIMIT ${limit + 1}
  `)) as unknown as EventDbRow[];

  const page = rows.slice(0, limit).map(rowToDTO);
  const hasMore = rows.length > limit;
  return {
    rows: page,
    nextPageToken: hasMore && page.length > 0 ? encodePageToken(page[page.length - 1].id) : null,
  };
}

/** One bounded page of ascending-id rows across every live document
 *  `userId` owns, their agents' uploads included (owners read every audience
 *  on their own documents). An agent passes its person (libraryOwnerId). The
 *  ownership join runs on every read, so a deleted document drops out at
 *  once. Backs `GET /api/events/stream?scope=me`. */
export async function listOwnedEvents(args: {
  userId: string;
  /** Who reads (the agent itself, not its person): never handed its own
   *  `data.changed`. Only agents follow this stream. */
  readerId: string;
  filters: EventFilters;
  afterId: number;
  limit: number;
}): Promise<ListEventsPage> {
  const { userId, readerId, filters, afterId, limit } = args;
  const conditions = [
    sql`e.id > ${afterId}`,
    notOwnDataChanged(sql`e.author_id`, readerId, true),
    isSelfOrAgentOf(sql`d.uploader_id`, userId),
    sql`d.deleted_at IS NULL`,
    ...filterConditions(filters),
  ];
  const rows = (await db.execute(sql`
    SELECT e.id, e.document_id AS "documentId", e.version_id AS "versionId",
           e.author_id AS "authorId", e.audience, e.namespace, e.type, e.payload,
           e.created_at AS "createdAt"
    FROM events e
    JOIN documents d ON d.id = e.document_id
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY e.id ASC
    LIMIT ${limit + 1}
  `)) as unknown as EventDbRow[];
  const page = rows.slice(0, limit).map(rowToDTO);
  return {
    rows: page,
    nextPageToken: rows.length > limit && page.length > 0 ? encodePageToken(page[page.length - 1].id) : null,
  };
}

/** The highest committed id: a stream opened without a resume point starts
 *  after it. Anything committed later has a higher id. */
export async function latestEventId(): Promise<number> {
  const [row] = (await db.execute(sql`SELECT COALESCE(MAX(id), 0) AS id FROM events`)) as unknown as {
    id: number | string;
  }[];
  return Number(row?.id ?? 0);
}

// ───────────────────────── Stream wake-ups ─────────────────────────
// In-process wake-up for the stream endpoints. A wake carries no rows: each
// open stream re-reads `id > <last id it sent>` from the database, and since
// ids follow commit order that read is complete — a reader can never be
// handed a higher id before a lower one is visible. Fine for the current
// single-node deployment; swap for Postgres LISTEN/NOTIFY if the API ever
// scales out horizontally. Wakes are targeted: a commit wakes only the
// streams of the documents it wrote to and the owner-scoped streams of
// those documents' owners, so one busy document never makes every open
// stream re-query.

type Wake = () => void;
const wakesByDoc = new Map<string, Set<Wake>>();
const wakesByOwner = new Map<string, Set<Wake>>();

function addTo(map: Map<string, Set<Wake>>, key: string, wake: Wake): () => void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(wake);
  return () => {
    const current = map.get(key);
    if (!current) return;
    current.delete(wake);
    if (current.size === 0) map.delete(key);
  };
}

/** Wake on commits that write to `documentId`. */
export function subscribeDocWakes(documentId: string, wake: Wake): () => void {
  return addTo(wakesByDoc, documentId, wake);
}

/** Wake on commits that write to any document `ownerId` owns. */
export function subscribeOwnerWakes(ownerId: string, wake: Wake): () => void {
  return addTo(wakesByOwner, ownerId, wake);
}

/** Called after a transaction that wrote events commits. */
export function notifyEventsCommitted(touched: Touched): void {
  for (const { documentId, ownerId } of touched) {
    for (const wake of wakesByDoc.get(documentId) ?? []) wake();
    for (const wake of wakesByOwner.get(ownerId) ?? []) wake();
  }
}
