import { sql } from 'drizzle-orm';
import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  jsonb,
  bigint,
  bigserial,
  uniqueIndex,
  primaryKey,
  index,
  boolean,
  date,
  customType,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import type { ThreadAnchor } from '@polygonlabs/primer-api-types';

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: (value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
});

export const users = pgTable('users', {
  id: text('id').primaryKey(),                                       // Okta sub (Phase 2) or "mock-user-1" (Phase 1)
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  slackUserId: text('slack_user_id'),                                // nullable; populated in Phase 2
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // 'agent' rows are AI agents: minted by a person (`agent_<uuidv7>`) or
  // created per OAuth MCP client and person (`agent_oauth_<hash>`). An agent
  // acts via the person in `via_user_id` (null for the legacy shared
  // `service-claude`). See lib/permissions.ts for how roles combine.
  kind: text('kind', { enum: ['person', 'agent'] }).notNull().default('person'),
  viaUserId: text('via_user_id').references((): AnyPgColumn => users.id),
});

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  uploaderId: text('uploader_id').notNull().references(() => users.id),
  visibility: text('visibility', { enum: ['org', 'private'] }).notNull().default('org'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
  // Live documents (a Y.Doc in doc_updates/doc_snapshots) have a format; null
  // marks a legacy, version-only HTML document.
  format: text('format', { enum: ['markdown', 'text', 'html'] }),
  // Front matter and other import metadata.
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  // How agents write here: `auto` edits documents an agent owns and suggests elsewhere.
  agentMode: text('agent_mode', { enum: ['auto', 'edit', 'suggest'] }).notNull().default('auto'),
  // A private branch (live/copy.ts): the document it was branched from, and
  // that document's state and docVersion at the branch, the base of the
  // three-way comparison that proposes the branch back.
  branchOf: uuid('branch_of').references((): AnyPgColumn => documents.id, { onDelete: 'set null' }),
  branchBaseDocVersion: bigint('branch_base_doc_version', { mode: 'number' }),
  branchBaseState: bytea('branch_base_state'),
  // A fork (or a document made from a template): where it was copied from.
  forkedFrom: uuid('forked_from').references((): AnyPgColumn => documents.id, { onDelete: 'set null' }),
  // Listed under Templates; "New from template" forks it.
  isTemplate: boolean('is_template').notNull().default(false),
});

export const versions = pgTable(
  'versions',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    storageKey: text('storage_key').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    versionNote: text('version_note'),
    // The uploaded bytes, kept verbatim (`v1/<versionId>.orig`). Null for
    // versions published before originals were kept.
    originalKey: text('original_key'),
    sourceFormat: text('source_format', { enum: ['html', 'markdown', 'text'] }),
    // Checkpoints of live documents: the render bundle (`bundles/<versionId>/`)
    // and the doc_updates id the bundle was captured at.
    bundleKey: text('bundle_key'),
    docVersion: bigint('doc_version', { mode: 'number' }),
    // A checkpoint the live server made on its own once edits settled
    // (live/autoCheckpoint.ts), not one someone saved.
    automatic: boolean('automatic').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqDocVersion: uniqueIndex('versions_doc_version_unique').on(
      t.documentId,
      t.versionNumber
    ),
  })
);

// A thread belongs to its document. `versionId` and `anchor` record where it
// was started (the originating version and the selection made there); where it
// sits on each version is in `thread_placements`.
export const threads = pgTable('threads', {
  id: uuid('id').primaryKey(),
  documentId: uuid('document_id')
    .notNull()
    .references(() => documents.id, { onDelete: 'cascade' }),
  // Null for a thread on a live document: it belongs to the live content,
  // anchored by a comment mark, not to a version.
  versionId: uuid('version_id').references(() => versions.id, { onDelete: 'cascade' }),
  anchor: jsonb('anchor').$type<ThreadAnchor>().notNull(),
  // Set while a live thread's comment mark is gone from reachable content
  // ("Text removed"); the thread stays open and keeps its quote.
  orphanedAt: timestamp('orphaned_at', { withTimezone: true }),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: text('resolved_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // On a branch: the parent's thread this one was copied from, so a proposal
  // maps comment marks back (never a foreign key: the parent may be purged).
  copiedFrom: uuid('copied_from'),
});

// Where a thread shows on a version. The originating version gets a row when
// the thread is created; a legacy document's first live version adds a row
// for every open thread (lib/publish.ts). `anchor` is null when the quoted text could not be
// found on that version ("context changed"): the thread still shows there, in
// the sidebar, without a highlight.
export const threadPlacements = pgTable(
  'thread_placements',
  {
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => versions.id, { onDelete: 'cascade' }),
    anchor: jsonb('anchor').$type<ThreadAnchor>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.threadId, t.versionId] }),
    byVersion: index('thread_placements_version_idx').on(t.versionId),
  }),
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),
    authorId: text('author_id').notNull().references(() => users.id),
    body: text('body').notNull(),
    mentions: text('mentions').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    byThreadAlive: index('comments_thread_id_alive_idx')
      .on(t.threadId)
      .where(sql`${t.deletedAt} IS NULL`),
  }),
);

// One emoji reaction per person per comment.
export const commentReactions = pgTable(
  'comment_reactions',
  {
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => users.id),
    emoji: text('emoji').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.commentId, t.userId, t.emoji] }),
  }),
);

// Structured document events (issue #78): an append-only, access-controlled
// stream of typed JSON payloads on a document — a machine channel PARALLEL to
// threads/comments (which stay human-only). The bright line: a column exists
// here iff the server enforces behavior on it (id → ordering, authorId →
// attribution, audience → read scope, namespace/type → validation and
// filtering); `payload` is opaque and Primer never interprets it. Rows are
// immutable in v1 (no update/delete API) and retained forever — the stream is
// the durable record.
export const events = pgTable(
  'events',
  {
    // The ordering key: a positive integer (bigserial), deliberately NOT a
    // uuid — list and stream deliver ascending id, and consumers dedupe by
    // it. Ids follow commit order; see lib/events.ts (EVENT_ORDER_LOCK_KEY).
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    // Optional write-time provenance: the version that was the entry point
    // when the row was written. The stream itself is document-scoped —
    // consumer state deliberately spans versions.
    versionId: uuid('version_id').references(() => versions.id, { onDelete: 'set null' }),
    authorId: text('author_id').notNull().references(() => users.id),
    // Per-row read scope, REQUIRED on write (no default — a default would be
    // an implicit behavior; every writer is code that can state intent).
    audience: text('audience', { enum: ['author', 'collaborators', 'artifact'] }).notNull(),
    // Hierarchical namespace (`example`, `example/telemetry`) + a single type name
    // within it. Server-validated by shape only; meaning is consumer domain.
    namespace: text('namespace').notNull(),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    // Display-only; carries no ordering guarantee (it can collide).
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Serves every list/stream read: WHERE document_id = ? AND id > ?
    // ORDER BY id ASC. (The issue sketch says "doc+created"; the ordering
    // section pins id as the ordering key, so the index follows the reads.)
    byDocId: index('events_doc_id_idx').on(t.documentId, t.id),
  }),
);

export const documentViews = pgTable(
  'document_views',
  {
    userId: text('user_id').notNull().references(() => users.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    viewedAt: timestamp('viewed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    // A live document's docVersion at that visit: catch-up (live/catchup.ts)
    // shows what changed after it. Null for legacy documents.
    lastDocVersion: bigint('last_doc_version', { mode: 'number' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.documentId] }),
  })
);

export const documentCollaborators = pgTable(
  'document_collaborators',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: ['commenter', 'responder', 'editor'] }).notNull(),
    grantedBy: text('granted_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqDocUser: uniqueIndex('document_collaborators_doc_user_unique').on(
      t.documentId,
      t.userId,
    ),
    byUser: index('document_collaborators_user_id_idx').on(t.userId),
  }),
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
  },
  (t) => ({
    byUser: index('sessions_user_id_idx').on(t.userId),
    byExpiry: index('sessions_expires_at_idx').on(t.expiresAt),
  })
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),                  // e.g. "device: my-laptop" or a manual label
    tokenHash: text('token_hash').notNull(),       // sha-256 hex of the full secret
    tokenPrefix: text('token_prefix').notNull(),   // first 8 chars of the random part, for display
    scopes: text('scopes').array(),                // ApiTokenScope[]; null = unrestricted (see auth/scopes.ts)
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),   // nullable = no expiry
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    byHash: uniqueIndex('api_tokens_token_hash_unique').on(t.tokenHash),
    byUser: index('api_tokens_user_id_idx').on(t.userId),
  }),
);

export const deviceAuthorizations = pgTable(
  'device_authorizations',
  {
    id: uuid('id').primaryKey(),
    deviceCodeHash: text('device_code_hash').notNull(),  // sha-256 of the device_code secret
    userCode: text('user_code').notNull(),               // human-typable, e.g. "WDJB-MZHT"
    status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'denied' | 'consumed'
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }), // set on approval
    clientLabel: text('client_label'),                   // optional hint from the CLI (hostname); displayed as untrusted
    requesterIp: text('requester_ip'),                   // captured at /api/device/authorize; nullable when unknown
    intervalSeconds: integer('interval_seconds').notNull().default(5),
    lastPolledAt: timestamp('last_polled_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDeviceHash: uniqueIndex('device_auth_device_code_hash_unique').on(t.deviceCodeHash),
    byUserCode: uniqueIndex('device_auth_user_code_unique').on(t.userCode),
    byExpiry: index('device_auth_expires_at_idx').on(t.expiresAt),
  }),
);

export const oauthClients = pgTable(
  'oauth_clients',
  {
    id: uuid('id').primaryKey(),
    clientId: text('client_id').notNull(),                               // public identifier
    clientName: text('client_name').notNull(),                            // from DCR metadata
    redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
    grantTypes: jsonb('grant_types').$type<string[]>().notNull(),
    tokenEndpointAuthMethod: text('token_endpoint_auth_method').notNull().default('none'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byClientId: uniqueIndex('oauth_clients_client_id_unique').on(t.clientId),
  }),
);

export const oauthConsents = pgTable(
  'oauth_consents',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byUserClient: uniqueIndex('oauth_consents_user_client_unique').on(t.userId, t.clientId),
  }),
);

export const oauthAuthorizationCodes = pgTable(
  'oauth_authorization_codes',
  {
    id: uuid('id').primaryKey(),
    codeHash: text('code_hash').notNull(),                                 // sha256 hex
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    codeChallenge: text('code_challenge').notNull(),
    codeChallengeMethod: text('code_challenge_method').notNull(),          // 'S256'
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byCodeHash: uniqueIndex('oauth_auth_codes_hash_unique').on(t.codeHash),
    byExpiry: index('oauth_auth_codes_expires_at_idx').on(t.expiresAt),
  }),
);

export const oauthAccessTokens = pgTable(
  'oauth_access_tokens',
  {
    id: uuid('id').primaryKey(),
    tokenHash: text('token_hash').notNull(),                               // sha256 hex
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTokenHash: uniqueIndex('oauth_access_tokens_hash_unique').on(t.tokenHash),
    byExpiry: index('oauth_access_tokens_expires_at_idx').on(t.expiresAt),
  }),
);

export const oauthRefreshTokens = pgTable(
  'oauth_refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    familyId: uuid('family_id').notNull(),                                 // rotation-chain grouping
    tokenHash: text('token_hash').notNull(),                               // sha256 hex
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    clientId: text('client_id').notNull().references(() => oauthClients.clientId, { onDelete: 'cascade' }),
    scopes: jsonb('scopes').$type<string[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTokenHash: uniqueIndex('oauth_refresh_tokens_hash_unique').on(t.tokenHash),
    byFamily: index('oauth_refresh_tokens_family_idx').on(t.familyId),
  }),
);

export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqUserName: uniqueIndex('folders_user_name_lower_unique').on(t.userId, sql`lower(${t.name})`),
    byUser: index('folders_user_id_idx').on(t.userId),
  }),
);

export const documentFolders = pgTable(
  'document_folders',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id')
      .notNull()
      .references(() => folders.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.documentId] }),
    byFolder: index('document_folders_folder_id_idx').on(t.folderId),
  }),
);

// ---------------------------------------------------------------------------
// External sharing plane. External viewers are NOT users: no rows in `users`,
// no Okta, no primer_sid sessions. Everything below joins back to documents
// so revocation/soft-delete kill access at request time.
// ---------------------------------------------------------------------------

export const externalShares = pgTable(
  'external_shares',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    // High-entropy URL token (base64url of 32 random bytes) — deliberately
    // not the document UUID, so share URLs are non-enumerable and revocable
    // independently of the doc.
    shareToken: text('share_token').notNull(),
    // Nullable: nothing is externally visible until the first explicit publish.
    publishedVersionId: uuid('published_version_id').references(() => versions.id),
    createdBy: text('created_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    byToken: uniqueIndex('external_shares_token_unique').on(t.shareToken),
    oneActivePerDoc: uniqueIndex('external_shares_doc_active_unique')
      .on(t.documentId)
      .where(sql`${t.revokedAt} IS NULL`),
  }),
);

export const externalRecipients = pgTable(
  'external_recipients',
  {
    id: uuid('id').primaryKey(),
    shareId: uuid('share_id')
      .notNull()
      .references(() => externalShares.id, { onDelete: 'cascade' }),
    email: text('email').notNull(), // stored lowercased
    addedBy: text('added_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    firstViewedAt: timestamp('first_viewed_at', { withTimezone: true }),
  },
  (t) => ({
    uniqShareEmail: uniqueIndex('external_recipients_share_email_unique').on(t.shareId, t.email),
  }),
);

export const externalOtps = pgTable(
  'external_otps',
  {
    id: uuid('id').primaryKey(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => externalRecipients.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(), // sha-256 hex of the 6-digit code
    attemptCount: integer('attempt_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => ({
    byRecipient: index('external_otps_recipient_idx').on(t.recipientId),
  }),
);

export const externalViewerSessions = pgTable(
  'external_viewer_sessions',
  {
    id: text('id').primaryKey(), // randomBytes(32).toString('hex')
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => externalRecipients.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
  },
  (t) => ({
    byRecipient: index('external_viewer_sessions_recipient_idx').on(t.recipientId),
    byExpiry: index('external_viewer_sessions_expires_at_idx').on(t.expiresAt),
  }),
);

export const externalViews = pgTable(
  'external_views',
  {
    id: uuid('id').primaryKey(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => externalRecipients.id, { onDelete: 'cascade' }),
    versionId: uuid('version_id')
      .notNull()
      .references(() => versions.id, { onDelete: 'cascade' }),
    viewedAt: timestamp('viewed_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => ({
    byRecipient: index('external_views_recipient_idx').on(t.recipientId),
  }),
);

// A live document's Y.Doc is its update log: one row per Yjs update, in
// order. `id` is the document's `docVersion`. Compaction folds old updates into
// doc_snapshots and sets `update` to null, keeping the row for its id,
// attribution and `touched` (the block ids and auxiliary fragments it changed).
export const docUpdates = pgTable(
  'doc_updates',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    update: bytea('update'),
    actorId: text('actor_id').references(() => users.id),
    runId: uuid('run_id'),
    touched: text('touched').array().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDoc: index('doc_updates_document_id_idx').on(t.documentId, t.id),
  }),
);

// The compacted state of a document: every update up to `upto_update_id`.
export const docSnapshots = pgTable('doc_snapshots', {
  documentId: uuid('document_id')
    .primaryKey()
    .references(() => documents.id, { onDelete: 'cascade' }),
  state: bytea('state').notNull(),
  uptoUpdateId: bigint('upto_update_id', { mode: 'number' }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Files placed in live documents (image, video, audio and file blocks). The
// document stores `primer-blob://<id>`, resolved and authorised at read time.
export const docFiles = pgTable(
  'doc_files',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    uploadedBy: text('uploaded_by').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // On a copy: the source document's file this one was copied from.
    copiedFrom: uuid('copied_from'),
  },
  (t) => ({
    byDoc: index('doc_files_document_id_idx').on(t.documentId),
  }),
);

// ── Shared records (per-document storage for pages and agents) ──────────
// Not part of the Y.Doc and never tied to page versions: a republish or a
// restore leaves them alone. `doc_record_changes` is the append-only audit and
// undo log. Every write takes a per-document lock (records/store.ts), so change
// ids follow commit order within a document.
export const docRecords = pgTable(
  'doc_records',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    collection: text('collection').notNull(),
    recordId: text('record_id').notNull(),
    scope: text('scope', { enum: ['shared', 'personal'] }).notNull(),
    // Set for personal records (the viewer or agent they belong to); null for shared.
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    data: jsonb('data').notNull(),
    // Everyone whose writes shaped the current data: a full set resets it to
    // the writer, an update merge adds the writer, a revert carries the
    // restored content's contributors plus the reverter. An agent reads the
    // record as untrusted when anyone but itself is in it.
    contributors: text('contributors').array().notNull(),
    version: integer('version').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by').notNull().references(() => users.id),
  },
  (t) => ({
    key: uniqueIndex('doc_records_key').on(
      t.documentId,
      t.collection,
      t.scope,
      sql`coalesce(${t.ownerUserId}, '')`,
      t.recordId,
    ),
  }),
);

export const docRecordChanges = pgTable(
  'doc_record_changes',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    collection: text('collection').notNull(),
    recordId: text('record_id').notNull(),
    scope: text('scope', { enum: ['shared', 'personal'] }).notNull(),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'cascade' }),
    op: text('op', { enum: ['set', 'update', 'delete'] }).notNull(),
    before: jsonb('before'),
    after: jsonb('after'),
    // Contributors of the before and after data (see doc_records.contributors).
    beforeContributors: text('before_contributors').array(),
    afterContributors: text('after_contributors').array(),
    actorId: text('actor_id').notNull().references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDoc: index('doc_record_changes_doc_idx').on(t.documentId, t.id),
  }),
);

// An agent asked to work on a live document (live/runs.ts). Status moves
// queued → running → done | failed, or to cancelled; every change runs on the
// document's queue, so it never interleaves with an apply. `edits_applied`
// and `blocks_removed` count the run's ops; past the large-edit threshold more
// ops need `plan` approved by a person (`plan_approved_by`).
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull().references(() => users.id),
    requestedBy: text('requested_by').notNull().references(() => users.id),
    status: text('status', { enum: ['queued', 'running', 'failed', 'done', 'cancelled'] }).notNull().default('queued'),
    request: jsonb('request').$type<Record<string, unknown>>().notNull(),
    dedupeKey: text('dedupe_key').notNull(),
    statusLine: text('status_line'),
    error: text('error'),
    editsApplied: integer('edits_applied').notNull().default(0),
    blocksRemoved: integer('blocks_removed').notNull().default(0),
    plan: text('plan'),
    // sha256 of `plan`: an approval names the plan it approves.
    planHash: text('plan_hash'),
    planApprovedBy: text('plan_approved_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    active: uniqueIndex('agent_runs_active_dedupe')
      .on(t.documentId, t.agentId, t.dedupeKey)
      .where(sql`status in ('queued', 'running')`),
    byDoc: index('agent_runs_document_id_idx').on(t.documentId, t.createdAt),
    byAgent: index('agent_runs_agent_id_idx').on(t.agentId, t.status),
  }),
);

// What one run's applied edits replaced, per block (live/pipeline.ts
// BlockInverse), so the run can be undone durably (live/undo.ts).
export const runInverses = pgTable(
  'run_inverses',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    target: jsonb('target').$type<Record<string, unknown>>().notNull(),
    // The block's subtree before the edit; null when the run created it.
    prior: jsonb('prior').$type<Record<string, unknown>>(),
    // The block's content version right after the edit; null when removed.
    afterVersion: text('after_version'),
    // Where the block was (parentId, prevId, nextId) when the edit removed or moved it.
    place: jsonb('place').$type<Record<string, unknown>>(),
    // A sub-fragment the run created (page text, embed, widget label).
    createdFragment: text('created_fragment'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byRun: index('run_inverses_run_id_idx').on(t.runId, t.id),
  }),
);

// A proposed change to a live document (live/suggest.ts): stored proposals,
// not marks in the Y.Doc (y-prosemirror drops node marks, so block-level
// suggestions can't live there). `edits` lists per-block edits (kind, target,
// the proposed blockContainer JSON, the base version it expects, the place);
// accepting replays them through the pipeline with those preconditions.
// `conflict`: made from an edit that conflicted, rather than suggest mode.
export const suggestions = pgTable(
  'suggestions',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    authorId: text('author_id').notNull().references(() => users.id),
    runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'set null' }),
    changeSetId: uuid('change_set_id'),
    status: text('status', { enum: ['open', 'accepted', 'rejected', 'withdrawn'] }).notNull().default('open'),
    tabId: text('tab_id').notNull(),
    targetIds: text('target_ids').array().notNull(),
    edits: jsonb('edits').$type<Record<string, unknown>[]>().notNull(),
    conflict: boolean('conflict').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedBy: text('decided_by').references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
  },
  (t) => ({
    byDoc: index('suggestions_document_id_idx').on(t.documentId, t.status, t.createdAt),
  }),
);

/**
 * Tracked tasks: an index of the task blocks in live documents, never written
 * any other way. The live-update hook (live/tasks.ts) keeps it in sync from
 * block props, and `rebuildTaskIndex` recreates it from the Y.Doc.
 */
export const docTasks = pgTable(
  'doc_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    tabId: text('tab_id').notNull(),
    blockId: text('block_id').notNull(),
    title: text('title').notNull(),
    // Checked against users when indexed: the document is client-writable.
    assigneeId: text('assignee_id').references(() => users.id, { onDelete: 'set null' }),
    dueDate: date('due_date', { mode: 'string' }),
    status: text('status', { enum: ['open', 'done'] }).notNull(),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    block: uniqueIndex('doc_tasks_block').on(t.documentId, t.blockId),
    assignee: index('doc_tasks_assignee').on(t.assigneeId),
  }),
);

/**
 * Decisions on choice blocks, written only by the pick route after its
 * edit-rights check (live/choices.ts). A row applies to a block only when the
 * block's `decisionId` prop equals `decision_id`, a nonce the server minted at
 * the pick: a block id used again never inherits a decision. Rows are never
 * deleted because content changed: one whose block or option is gone is
 * `archived_at` and comes back when an undo or restore brings the block back.
 * Only clearing (a person with pick rights) removes one.
 */
export const docDecisions = pgTable(
  'doc_decisions',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    blockId: text('block_id').notNull(),
    decisionId: uuid('decision_id').notNull(),
    optionId: text('option_id').notNull(),
    // What was decided, as it read then: the block's text may change later.
    question: text('question').notNull(),
    optionLabel: text('option_label').notNull(),
    rationale: text('rationale').notNull(),
    evidence: jsonb('evidence').notNull(),
    openQuestions: jsonb('open_questions').notNull(),
    decidedBy: text('decided_by')
      .notNull()
      .references(() => users.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.documentId, t.blockId] }),
  }),
);

/**
 * Mentions already announced: one row per (block, person) a mention chip in a
 * live document names. Kept from the document by live/mentions.ts so each
 * mention notifies once; rebuildable, never authority.
 */
export const docMentions = pgTable(
  'doc_mentions',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    blockId: text('block_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.documentId, t.blockId, t.userId] }),
  }),
);

// Agent-drawn SVG widgets (diagrams and charts) placed in live documents as
// `widget` blocks. A draft is rendered and previewed before it replaces the
// live publish; a draft with errors never does. `rows` are the published
// rows and `draft_rows` the draft's, so a pending draft never changes what the
// live widget draws from. Label words live in the Y.Doc, not here.
export const widgets = pgTable(
  'widgets',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    blockId: text('block_id').notNull(),
    draftSource: text('draft_source'),
    draftRows: jsonb('draft_rows'),
    draftErrors: jsonb('draft_errors'),
    publishedSource: text('published_source'),
    publishedSvgLight: text('published_svg_light'),
    publishedSvgDark: text('published_svg_dark'),
    publishedHash: text('published_hash'),
    rows: jsonb('rows'),
    // The records collection the widget draws from (widgets/records.ts); the
    // draft's, until it is published.
    collection: text('collection'),
    draftCollection: text('draft_collection'),
    updatedBy: text('updated_by').notNull().references(() => users.id),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byDoc: index('widgets_document_id_idx').on(t.documentId),
  }),
);
