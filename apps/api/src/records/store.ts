// Shared records: per-document storage that pages (through the host bridge)
// and agents (MCP) read and write. One service, one set of verbs: the REST
// routes, the MCP tools and the page bridge (via REST) all call recordsApi.
//
// - Records live in Postgres, outside the live document, and are never tied
//   to page versions. Every write appends to doc_record_changes, the audit
//   and undo log.
// - `shared` records: read by every reader, written by the owner, editors
//   and responders (the event-write bar: a page writes in its viewer's name).
//   `personal` records: the caller's own rows only, with the same write bar.
//   There is no owner argument anywhere; the owner of a personal record is
//   always the caller.
// - Every write runs under one per-document lock, so caps hold under
//   concurrency and change ids follow commit order within a document
//   (`changes?since=` is then a complete resume point). Shared records have
//   per-document caps; each principal's personal records have their own, so
//   no viewer can fill a document for everyone. The owner can purge another
//   user's personal records.
// - Provenance: each record keeps `contributors`, everyone whose writes shaped
//   its current data. An agent reading a record (or a change) that anyone but
//   itself contributed to gets it marked `untrusted`: record data is data,
//   never instructions. A merge or a revert can't launder it.
import { fenceStrings, fenceUntrusted } from '../lib/untrusted.ts';
import { sql } from 'drizzle-orm';
import {
  DEFAULT_RECORDS_PAGE_SIZE,
  MAX_PERSONAL_RECORDS_BYTES_PER_USER,
  MAX_PERSONAL_RECORDS_PER_USER,
  MAX_RECORDS_BATCH,
  MAX_RECORDS_BYTES_PER_DOCUMENT,
  MAX_RECORDS_PAGE_SIZE,
  MAX_RECORDS_PER_DOCUMENT,
  MAX_RECORD_BYTES,
  RECORD_COLLECTION_RE,
  RECORD_ID_RE,
  RECORD_KEY_RE,
  type RecordBatchOp,
  type RecordChangeDTO,
  type RecordChangesResponse,
  type RecordDTO,
  type RecordQuery,
  type RecordScope,
  type RecordVerb,
  type RecordVerbResults,
  type Refusal,
  type RefusalCode,
} from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { actorNameOf } from '../lib/actors.ts';
import { canWriteEvents, loadEventDocContext } from '../lib/events.ts';
import { canEdit, canManage, canRead, loadEffectiveRole, type EffectiveRole } from '../lib/permissions.ts';
import { scheduleDataChanged } from './changed.ts';

export type RecordsResult<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Pick<Tx, 'execute'>;

// pg_advisory_xact_lock(key1, key2): key2 is hashtext(document id).
const RECORDS_LOCK_KEY = 7_201_949;

const FIX: Partial<Record<RefusalCode, string>> = {
  bad_request: 'Fix the arguments and call again.',
  not_found: 'Check the document id and that you can read it.',
  forbidden: 'Ask the document owner for responder, editor or owner access.',
  records_cap: 'Delete records you no longer need, or keep each record under 64 KB.',
  record_conflict: 'Read the record again, apply your change to its current data, and pass its new version.',
};

function refuse(code: RefusalCode, message: string, details?: Record<string, unknown>): { ok: false; refusal: Refusal } {
  const refusal: Refusal = { code, message, fix: FIX[code] ?? 'Call again with valid arguments.' };
  if (details) refusal.details = details;
  return { ok: false, refusal };
}

class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.message);
  }
}

// ───────────────────────── Validation ─────────────────────────

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkTarget(args: { collection?: unknown; scope?: unknown }): string | null {
  if (typeof args.collection !== 'string' || !RECORD_COLLECTION_RE.test(args.collection)) {
    return 'collection must be 1–128 characters of letters, digits and . _ : / - (starting with a letter or digit)';
  }
  if (args.scope !== 'shared' && args.scope !== 'personal') return 'scope must be "shared" or "personal"';
  return null;
}

function checkRecordId(raw: unknown): string | null {
  return typeof raw === 'string' && RECORD_ID_RE.test(raw)
    ? null
    : 'recordId must be 1–128 characters of letters, digits and . _ : @ -';
}

function checkData(raw: unknown): string | null {
  if (!isPlainObject(raw)) return 'data must be a JSON object';
  let json: string | undefined;
  try {
    json = JSON.stringify(raw);
  } catch {
    return 'data is not JSON-serializable';
  }
  if (json === undefined) return 'data is not JSON-serializable';
  if (/<\/?untrusted-record-/i.test(json)) return 'data holds <untrusted-record-…> fence markup: write only the keys you change, never text read back from a fenced record';
  return badKey(raw);
}

/** A data key at any depth is a plain name, so a key can't carry markup. */
function badKey(value: unknown): string | null {
  if (Array.isArray(value)) return value.map(badKey).find((m) => m !== null) ?? null;
  if (value === null || typeof value !== 'object') return null;
  for (const [key, inner] of Object.entries(value)) {
    if (!RECORD_KEY_RE.test(key)) return `data keys must be 1–64 characters of letters, digits and . _ - (got "${key.slice(0, 30)}")`;
    const bad = badKey(inner);
    if (bad) return bad;
  }
  return null;
}

function checkExpect(raw: unknown): string | null {
  return raw === undefined || (Number.isInteger(raw) && (raw as number) >= 0)
    ? null
    : 'expectVersion must be a non-negative integer (0 = the record must not exist yet)';
}

function parseLimit(raw: unknown): number | null {
  if (raw === undefined) return DEFAULT_RECORDS_PAGE_SIZE;
  if (!Number.isInteger(raw) || (raw as number) < 1 || (raw as number) > MAX_RECORDS_PAGE_SIZE) return null;
  return raw as number;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: unknown): number | null {
  if (raw === undefined) return 0;
  if (typeof raw !== 'string') return null;
  const m = /^o:(\d{1,6})$/.exec(Buffer.from(raw, 'base64url').toString('utf8'));
  return m ? Number(m[1]) : null;
}

/** A batch write, validated. */
function checkWrite(op: Partial<RecordBatchOp>): string | null {
  if (op.verb !== 'set' && op.verb !== 'update' && op.verb !== 'delete') return 'verb must be set, update or delete';
  return (
    checkTarget(op) ??
    checkRecordId(op.recordId) ??
    (op.verb === 'delete' ? null : checkData(op.data)) ??
    checkExpect(op.expectVersion)
  );
}

// ───────────────────────── Rows ─────────────────────────

interface RecordRow {
  collection: string;
  recordId: string;
  scope: RecordScope;
  data: Record<string, unknown>;
  version: number;
  updatedAt: Date | string;
  updatedBy: string;
  writtenBy: string;
  contributors: string[];
}

const RECORD_COLUMNS = sql`r.collection, r.record_id AS "recordId", r.scope, r.data, r.version, r.contributors,
  r.updated_at AS "updatedAt", r.updated_by AS "updatedBy", ${actorNameOf('u')} AS "writtenBy"`;

function iso(v: Date | string): string {
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function toDTO(row: RecordRow, actor: AuthUser): RecordDTO {
  const dto: RecordDTO = {
    collection: row.collection,
    recordId: row.recordId,
    scope: row.scope,
    data: row.data,
    version: row.version,
    updatedAt: iso(row.updatedAt),
    updatedBy: row.updatedBy,
    writtenBy: row.writtenBy,
  };
  // A display name is text a person chose: fenced for any agent reader.
  if (actor.kind === 'agent') dto.writtenBy = fenceUntrusted(dto.writtenBy, 'record');
  if (untrustedFor(actor, [row.contributors])) {
    dto.untrusted = true;
    dto.data = fenceStrings(dto.data, 'record');
  }
  return dto;
}

/** An agent trusts only content it alone wrote. */
function untrustedFor(actor: AuthUser, contributors: (string[] | null)[]): boolean {
  return actor.kind === 'agent' && contributors.some((list) => (list ?? []).some((id) => id !== actor.id));
}

/** The owner column for a scope: the caller for personal records. */
function ownerOf(scope: RecordScope, actor: AuthUser): string | null {
  return scope === 'personal' ? actor.id : null;
}

function ownerMatch(scope: RecordScope, actor: AuthUser) {
  const owner = ownerOf(scope, actor);
  return owner === null ? sql`r.owner_user_id IS NULL` : sql`r.owner_user_id = ${owner}`;
}

// ───────────────────────── Access ─────────────────────────

interface Access {
  role: EffectiveRole;
  canWrite: boolean;
}

async function access(documentId: string, actor: AuthUser): Promise<Access | null> {
  const doc = await loadEventDocContext(documentId);
  if (!doc) return null;
  const role = await loadEffectiveRole(doc, actor);
  if (!canRead(doc.visibility, role)) return null;
  return { role, canWrite: canWriteEvents(role) };
}

// ───────────────────────── Writes ─────────────────────────

interface Change {
  id: number;
  collection: string;
  scope: RecordScope;
}

async function readRecord(tx: Exec, documentId: string, op: RecordBatchOp, actor: AuthUser): Promise<RecordRow | null> {
  const [row] = (await tx.execute(sql`
    SELECT ${RECORD_COLUMNS}
      FROM doc_records r JOIN users u ON u.id = r.updated_by
     WHERE r.document_id = ${documentId} AND r.collection = ${op.collection} AND r.scope = ${op.scope}
       AND ${ownerMatch(op.scope, actor)} AND r.record_id = ${op.recordId}
     FOR UPDATE OF r
  `)) as unknown as RecordRow[];
  return row ?? null;
}

/** A Postgres text[] literal, passed as one parameter. */
function pgTextArray(values: string[] | null): string | null {
  if (values === null) return null;
  return `{${values.map((v) => `"${v.replace(/["\\]/g, '\\$&')}"`).join(',')}}`;
}

/** Applies one write inside the locked transaction. Throws Refused.
 *  `restoredContributors` is set by a revert: the restored data keeps the
 *  provenance it had. */
async function applyWrite(
  tx: Tx,
  documentId: string,
  op: RecordBatchOp,
  actor: AuthUser,
  changes: Change[],
  restoredContributors?: string[],
): Promise<{ record: RecordDTO } | { deleted: boolean }> {
  const current = await readRecord(tx, documentId, op, actor);
  if (op.expectVersion !== undefined && (current?.version ?? 0) !== op.expectVersion) {
    throw new Refused(
      refuse('record_conflict', `Record "${op.recordId}" is at version ${current?.version ?? 0}, not ${op.expectVersion}.`, {
        recordId: op.recordId,
        version: current?.version ?? 0,
      }).refusal,
    );
  }
  const owner = ownerOf(op.scope, actor);
  const logChange = async (kind: RecordBatchOp['verb'], after: unknown, afterContributors: string[] | null) => {
    const [row] = (await tx.execute(sql`
      INSERT INTO doc_record_changes (document_id, collection, record_id, scope, owner_user_id, op,
                                      before, after, before_contributors, after_contributors, actor_id)
      VALUES (${documentId}, ${op.collection}, ${op.recordId}, ${op.scope}, ${owner}, ${kind},
              ${current === null ? null : JSON.stringify(current.data)}::jsonb,
              ${after === null ? null : JSON.stringify(after)}::jsonb,
              ${pgTextArray(current?.contributors ?? null)}::text[], ${pgTextArray(afterContributors)}::text[], ${actor.id})
      RETURNING id
    `)) as unknown as { id: number | string }[];
    changes.push({ id: Number(row.id), collection: op.collection, scope: op.scope });
  };

  if (op.verb === 'delete') {
    if (!current) return { deleted: false };
    await tx.execute(sql`
      DELETE FROM doc_records r
       WHERE r.document_id = ${documentId} AND r.collection = ${op.collection} AND r.scope = ${op.scope}
         AND ${ownerMatch(op.scope, actor)} AND r.record_id = ${op.recordId}
    `);
    await logChange('delete', null, null);
    return { deleted: true };
  }

  if (op.verb === 'update' && !current) {
    throw new Refused(
      refuse('not_found', `Record "${op.recordId}" does not exist in ${op.collection}.`, { recordId: op.recordId }).refusal,
    );
  }
  const next = op.verb === 'update' ? { ...current!.data, ...op.data } : op.data!;
  const json = JSON.stringify(next);
  if (Buffer.byteLength(json, 'utf8') > MAX_RECORD_BYTES) {
    throw new Refused(refuse('records_cap', `A record holds at most ${MAX_RECORD_BYTES} bytes of data.`).refusal);
  }
  // A record recreated after a delete continues from its change count, so
  // its version never repeats one a reader may have seen.
  let previous = current?.version ?? 0;
  if (!current) {
    const [seen] = (await tx.execute(sql`
      SELECT count(*)::int AS count FROM doc_record_changes
       WHERE document_id = ${documentId} AND collection = ${op.collection} AND scope = ${op.scope}
         AND ${owner === null ? sql`owner_user_id IS NULL` : sql`owner_user_id = ${owner}`} AND record_id = ${op.recordId}
    `)) as unknown as { count: number }[];
    previous = seen.count;
  }
  const version = previous + 1;
  // A full set is the writer's alone; a merge or a revert adds the writer to
  // whoever shaped the content it keeps.
  const kept = op.verb === 'update' ? current!.contributors : (restoredContributors ?? []);
  const contributors = [...new Set([...kept, actor.id])].sort();
  await tx.execute(sql`
    INSERT INTO doc_records (document_id, collection, record_id, scope, owner_user_id, data, contributors, version, updated_at, updated_by)
    VALUES (${documentId}, ${op.collection}, ${op.recordId}, ${op.scope}, ${owner}, ${json}::jsonb,
            ${pgTextArray(contributors)}::text[], ${version}, now(), ${actor.id})
    ON CONFLICT (document_id, collection, scope, coalesce(owner_user_id, ''), record_id)
    DO UPDATE SET data = EXCLUDED.data, contributors = EXCLUDED.contributors, version = EXCLUDED.version,
                  updated_at = now(), updated_by = EXCLUDED.updated_by
  `);
  await logChange(op.verb, next, contributors);
  const row = await readRecord(tx, documentId, op, actor);
  return { record: toDTO(row!, actor) };
}

/** Refuses a write whose result crosses a cap: the document's shared caps
 *  when it touched shared records, the caller's personal caps when it
 *  touched personal ones (a caller only ever writes its own). */
async function checkCaps(tx: Tx, documentId: string, actor: AuthUser, changes: Change[]): Promise<void> {
  const scopes = new Set(changes.map((c) => c.scope));
  for (const scope of scopes) {
    const owner = scope === 'personal' ? sql`owner_user_id = ${actor.id}` : sql`owner_user_id IS NULL`;
    const [usage] = (await tx.execute(sql`
      SELECT count(*)::int AS count, COALESCE(sum(octet_length(data::text)), 0)::bigint AS bytes
        FROM doc_records WHERE document_id = ${documentId} AND scope = ${scope} AND ${owner}
    `)) as unknown as { count: number; bytes: number | string }[];
    const [maxCount, maxBytes, what] = scope === 'shared'
      ? [MAX_RECORDS_PER_DOCUMENT, MAX_RECORDS_BYTES_PER_DOCUMENT, 'A document holds at most']
      : [MAX_PERSONAL_RECORDS_PER_USER, MAX_PERSONAL_RECORDS_BYTES_PER_USER, 'You can keep at most'];
    if (usage.count > maxCount || Number(usage.bytes) > maxBytes) {
      throw new Refused(
        refuse('records_cap', `${what} ${maxCount} ${scope} records and ${maxBytes} bytes of ${scope} record data.`, {
          scope,
          count: usage.count,
          bytes: Number(usage.bytes),
        }).refusal,
      );
    }
  }
}

/** Runs writes atomically under the document's records lock, checks the
 *  caps on the result, and schedules the coalesced `data.changed`. */
async function runWrites<T>(
  documentId: string,
  actor: AuthUser,
  fn: (tx: Tx, changes: Change[]) => Promise<T>,
): Promise<RecordsResult<T>> {
  const changes: Change[] = [];
  let value: T;
  try {
    value = await db.transaction(async (tx) => {
      changes.length = 0;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${RECORDS_LOCK_KEY}, hashtext(${documentId}))`);
      const out = await fn(tx, changes);
      await checkCaps(tx, documentId, actor, changes);
      return out;
    });
  } catch (err) {
    if (err instanceof Refused) return { ok: false, refusal: err.refusal };
    throw err;
  }
  // Personal records wake no one: nobody else may read them.
  const shared = changes.filter((c) => c.scope === 'shared');
  if (shared.length > 0) {
    scheduleDataChanged(documentId, actor.id, {
      collections: [...new Set(shared.map((c) => c.collection))],
      fromChangeId: shared[0].id,
      toChangeId: shared[shared.length - 1].id,
    });
  }
  return { ok: true, value };
}

// ───────────────────────── Reads ─────────────────────────

async function readPage(
  documentId: string,
  actor: AuthUser,
  args: RecordQuery,
  filtered: boolean,
): Promise<RecordsResult<RecordVerbResults['list']>> {
  const limit = parseLimit(args.limit);
  if (limit === null) return refuse('bad_request', `limit must be an integer from 1 to ${MAX_RECORDS_PAGE_SIZE}`);
  const offset = decodeCursor(args.cursor);
  if (offset === null) return refuse('bad_request', 'cursor is not a cursor from a previous page');
  const conditions = [
    sql`r.document_id = ${documentId}`,
    sql`r.collection = ${args.collection}`,
    sql`r.scope = ${args.scope}`,
    ownerMatch(args.scope, actor),
  ];
  let order = sql`r.record_id ASC`;
  if (filtered) {
    if (args.where !== undefined) {
      if (!isPlainObject(args.where)) return refuse('bad_request', 'where must be an object of key: value');
      for (const [k, v] of Object.entries(args.where)) {
        if (!RECORD_KEY_RE.test(k)) return refuse('bad_request', `where key "${k}" is not a valid data key`);
        if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
          return refuse('bad_request', `where.${k} must be a string, number, boolean or null`);
        }
      }
      conditions.push(sql`r.data @> ${JSON.stringify(args.where)}::jsonb`);
    }
    if (args.orderBy !== undefined) {
      const o = args.orderBy as { key?: unknown; dir?: unknown } | null;
      if (o === null || typeof o !== 'object' || typeof o.key !== 'string' || !RECORD_KEY_RE.test(o.key) || (o.dir !== 'asc' && o.dir !== 'desc')) {
        return refuse('bad_request', 'orderBy must be { key, dir: "asc" | "desc" }');
      }
      order = o.dir === 'asc'
        ? sql`r.data -> ${o.key} ASC NULLS LAST, r.record_id ASC`
        : sql`r.data -> ${o.key} DESC NULLS LAST, r.record_id ASC`;
    }
  }
  const rows = (await db.execute(sql`
    SELECT ${RECORD_COLUMNS}
      FROM doc_records r JOIN users u ON u.id = r.updated_by
     WHERE ${sql.join(conditions, sql` AND `)}
     ORDER BY ${order}
     LIMIT ${limit + 1} OFFSET ${offset}
  `)) as unknown as RecordRow[];
  return {
    ok: true,
    value: {
      records: rows.slice(0, limit).map((r) => toDTO(r, actor)),
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    },
  };
}

// ───────────────────────── The service ─────────────────────────

export type RecordsApi = {
  [V in RecordVerb]: (args: V extends 'batch' ? { ops: RecordBatchOp[] } : RecordQuery) => Promise<RecordsResult<RecordVerbResults[V]>>;
};

/** The records verbs for one caller on one document. Every verb checks
 *  access itself, so callers (REST, MCP, the bridge via REST) can't skip it. */
/** Collections Primer's own features write (votes on choice blocks): the
 *  general verbs read them but never write them. */
export const RESERVED_COLLECTION_PREFIX = 'primer.';

function reservedWrite(op: { collection?: unknown }): string | null {
  return typeof op.collection === 'string' && op.collection.startsWith(RESERVED_COLLECTION_PREFIX)
    ? `collections starting with "${RESERVED_COLLECTION_PREFIX}" are written only by Primer (votes go through the choice vote route)`
    : null;
}

export function recordsApi(actor: AuthUser, rawDocumentId: string, opts: { reserved?: true } = {}): RecordsApi {
  // Ids match case-insensitively but the lock key and data.changed key hash
  // the spelling, so one canonical spelling keeps every writer on one lock.
  const documentId = rawDocumentId.toLowerCase();
  const gate = async (write: boolean): Promise<RecordsResult<Access>> => {
    const a = await access(documentId, actor);
    if (!a) return refuse('not_found', 'Document not found.');
    if (write && !a.canWrite) {
      return refuse('forbidden', 'Only the document owner, editors and responders may write records.');
    }
    return { ok: true, value: a };
  };

  const write = async (op: RecordBatchOp) => {
    const bad = checkWrite(op) ?? (opts.reserved ? null : reservedWrite(op));
    if (bad) return refuse('bad_request', bad);
    const g = await gate(true);
    if (!g.ok) return g;
    return runWrites(documentId, actor, (tx, changes) => applyWrite(tx, documentId, op, actor, changes));
  };

  return {
    get: async (args) => {
      const bad = checkTarget(args) ?? checkRecordId(args.recordId);
      if (bad) return refuse('bad_request', bad);
      const g = await gate(false);
      if (!g.ok) return g;
      const [row] = (await db.execute(sql`
        SELECT ${RECORD_COLUMNS}
          FROM doc_records r JOIN users u ON u.id = r.updated_by
         WHERE r.document_id = ${documentId} AND r.collection = ${args.collection} AND r.scope = ${args.scope}
           AND ${ownerMatch(args.scope, actor)} AND r.record_id = ${args.recordId}
      `)) as unknown as RecordRow[];
      return { ok: true, value: { record: row ? toDTO(row, actor) : null } };
    },
    list: async (args) => {
      const bad = checkTarget(args);
      if (bad) return refuse('bad_request', bad);
      const g = await gate(false);
      if (!g.ok) return g;
      return readPage(documentId, actor, args, false);
    },
    query: async (args) => {
      const bad = checkTarget(args);
      if (bad) return refuse('bad_request', bad);
      const g = await gate(false);
      if (!g.ok) return g;
      return readPage(documentId, actor, args, true);
    },
    set: (args) => write({ ...args, verb: 'set' } as RecordBatchOp) as Promise<RecordsResult<RecordVerbResults['set']>>,
    update: (args) => write({ ...args, verb: 'update' } as RecordBatchOp) as Promise<RecordsResult<RecordVerbResults['update']>>,
    delete: (args) => write({ ...args, verb: 'delete' } as RecordBatchOp) as Promise<RecordsResult<RecordVerbResults['delete']>>,
    batch: async (args) => {
      const ops = (args as { ops?: unknown }).ops;
      if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_RECORDS_BATCH) {
        return refuse('bad_request', `ops must hold 1–${MAX_RECORDS_BATCH} writes`);
      }
      for (let i = 0; i < ops.length; i++) {
        const bad = isPlainObject(ops[i])
          ? (checkWrite(ops[i] as RecordBatchOp) ?? (opts.reserved ? null : reservedWrite(ops[i] as RecordBatchOp)))
          : 'must be an object';
        if (bad) return refuse('bad_request', `ops[${i}]: ${bad}`, { index: i });
      }
      const g = await gate(true);
      if (!g.ok) return g;
      return runWrites(documentId, actor, async (tx, changes) => {
        const results: RecordVerbResults['batch']['results'] = [];
        for (const op of ops as RecordBatchOp[]) results.push(await applyWrite(tx, documentId, op, actor, changes));
        return { results };
      });
    },
  };
}

// ───────────────────────── Change log ─────────────────────────

interface ChangeRow {
  id: number | string;
  documentId: string;
  collection: string;
  recordId: string;
  scope: RecordScope;
  ownerUserId: string | null;
  op: RecordChangeDTO['op'];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  beforeContributors: string[] | null;
  afterContributors: string[] | null;
  actorId: string;
  actorName: string;
  createdAt: Date | string;
}

const CHANGE_COLUMNS = sql`c.id, c.document_id AS "documentId", c.collection, c.record_id AS "recordId", c.scope,
  c.owner_user_id AS "ownerUserId", c.op, c.before, c.after, c.before_contributors AS "beforeContributors",
  c.after_contributors AS "afterContributors", c.actor_id AS "actorId",
  ${actorNameOf('u')} AS "actorName", c.created_at AS "createdAt"`;

function changeDTO(row: ChangeRow, actor: AuthUser): RecordChangeDTO {
  const dto: RecordChangeDTO = {
    id: Number(row.id),
    collection: row.collection,
    recordId: row.recordId,
    scope: row.scope,
    op: row.op,
    before: row.before,
    after: row.after,
    actorId: row.actorId,
    actorName: row.actorName,
    createdAt: iso(row.createdAt),
  };
  if (actor.kind === 'agent') dto.actorName = fenceUntrusted(dto.actorName, 'record');
  if (untrustedFor(actor, [row.beforeContributors, row.afterContributors, [row.actorId]])) {
    dto.untrusted = true;
    dto.before = fenceStrings(dto.before, 'record');
    dto.after = fenceStrings(dto.after, 'record');
  }
  return dto;
}

/** Changes after `since`, ascending: shared ones and the caller's own
 *  personal ones (never anyone else's). Readers of the document only. */
export async function listRecordChanges(
  actor: AuthUser,
  rawDocumentId: string,
  args: { since?: number; limit?: number },
): Promise<RecordsResult<RecordChangesResponse>> {
  const documentId = rawDocumentId.toLowerCase();
  const since = args.since ?? 0;
  if (!Number.isInteger(since) || since < 0) return refuse('bad_request', 'since must be a non-negative change id');
  const limit = parseLimit(args.limit);
  if (limit === null) return refuse('bad_request', `limit must be an integer from 1 to ${MAX_RECORDS_PAGE_SIZE}`);
  if (!(await access(documentId, actor))) return refuse('not_found', 'Document not found.');
  const rows = (await db.execute(sql`
    SELECT ${CHANGE_COLUMNS}
      FROM doc_record_changes c JOIN users u ON u.id = c.actor_id
     WHERE c.document_id = ${documentId} AND c.id > ${since}
       AND (c.scope = 'shared' OR c.owner_user_id = ${actor.id})
     ORDER BY c.id ASC
     LIMIT ${limit + 1}
  `)) as unknown as ChangeRow[];
  const changes = rows.slice(0, limit).map((r) => changeDTO(r, actor));
  return {
    ok: true,
    value: {
      changes,
      toChangeId: changes.length > 0 ? changes[changes.length - 1].id : since,
      hasMore: rows.length > limit,
    },
  };
}

/** Restores a change's before image as a new change (deleting the record
 *  when it did not exist before). Shared changes need the owner or an
 *  editor; a personal change only its own owner. */
export async function revertChange(changeId: number, actor: AuthUser): Promise<RecordsResult<{ changeId: number }>> {
  if (!Number.isInteger(changeId) || changeId < 1) return refuse('bad_request', 'changeId must be a change id');
  const [row] = (await db.execute(sql`
    SELECT ${CHANGE_COLUMNS}
      FROM doc_record_changes c JOIN users u ON u.id = c.actor_id
     WHERE c.id = ${changeId}
  `)) as unknown as ChangeRow[];
  const notFound = refuse('not_found', 'Change not found.');
  if (!row) return notFound;
  if (row.scope === 'personal' && row.ownerUserId !== actor.id) return notFound;
  const a = await access(row.documentId, actor);
  if (!a) return notFound;
  if (row.scope === 'shared' ? !canEdit(a.role) : !a.canWrite) {
    return refuse('forbidden', 'Only the document owner or an editor can revert shared record changes.');
  }
  // After the access checks, so a caller without access learns nothing (change ids are sequential).
  const reserved = reservedWrite(row);
  if (reserved) return refuse('bad_request', reserved);
  const op: RecordBatchOp = row.before === null
    ? { verb: 'delete', collection: row.collection, scope: row.scope, recordId: row.recordId }
    : { verb: 'set', collection: row.collection, scope: row.scope, recordId: row.recordId, data: row.before };
  const out = await runWrites(row.documentId, actor, (tx, changes) =>
    applyWrite(tx, row.documentId, op, actor, changes, row.beforeContributors ?? [row.actorId]),
  );
  if (!out.ok) return out;
  return { ok: true, value: { changeId } };
}

/** Deletes one user's personal records on a document (the owner's way to
 *  reclaim space or remove what a viewer stored). People only. Logged as deletes in that
 *  user's personal change log. */
export async function purgePersonalRecords(
  actor: AuthUser,
  rawDocumentId: string,
  userId: unknown,
): Promise<RecordsResult<{ deleted: number }>> {
  const documentId = rawDocumentId.toLowerCase();
  if (typeof userId !== 'string' || userId.length === 0) return refuse('bad_request', 'userId is required');
  // Erasing people's data is a person's decision. Agents own what they
  // upload and OAuth tokens carry no scopes, so neither the role nor the
  // scope alone would keep an agent out.
  if (actor.kind === 'agent') {
    return refuse('forbidden', "Only a person who owns the document can purge someone's personal records.");
  }
  const a = await access(documentId, actor);
  if (!a) return refuse('not_found', 'Document not found.');
  if (!canManage(a.role)) return refuse('forbidden', "Only the document owner can purge someone's personal records.");
  return runWrites(documentId, actor, async (tx) => {
    const rows = (await tx.execute(sql`
      DELETE FROM doc_records
       WHERE document_id = ${documentId} AND scope = 'personal' AND owner_user_id = ${userId}
      RETURNING collection, record_id AS "recordId", data, contributors
    `)) as unknown as { collection: string; recordId: string; data: unknown; contributors: string[] }[];
    for (const r of rows) {
      await tx.execute(sql`
        INSERT INTO doc_record_changes (document_id, collection, record_id, scope, owner_user_id, op,
                                        before, after, before_contributors, after_contributors, actor_id)
        VALUES (${documentId}, ${r.collection}, ${r.recordId}, 'personal', ${userId}, 'delete',
                ${JSON.stringify(r.data)}::jsonb, NULL, ${pgTextArray(r.contributors)}::text[], NULL, ${actor.id})
      `);
    }
    return { deleted: rows.length };
  });
}
