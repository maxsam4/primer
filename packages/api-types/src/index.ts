/**
 * The single public home of Primer's REST API wire contract: every
 * request/response DTO shape used by apps/api's routes, the anchor shapes
 * stored in `threads.anchor` and returned by the threads endpoints, and the
 * two runtime validators used to check untrusted anchor payloads at the
 * edges of the system. Consumers: apps/api (routes, MCP tool bridge),
 * apps/mcp (comment formatting), and apps/web (transitively, via the
 * parent-side companion protocol module).
 */

// ───────────────────── Anchor shapes (wire contract) ─────────────────────
// Moved from packages/shared/src/companion-protocol.ts. These are stored in
// threads.anchor and returned by the threads endpoints, so they live here
// alongside the DTOs that reference them rather than with the companion
// postMessage envelope machinery (which stays app-local; see
// apps/web/src/companion/protocol.ts).

/** Text-range anchor. New captures (v1.1+) emit `start`/`end` raw
 *  character offsets into the artifact's flattened text. Legacy
 *  captures (pre-v1.1) carry `prefix`/`suffix`/`containerPath` for
 *  text-pattern resolution. The companion's resolver dispatches on
 *  which fields are present, so both shapes are valid on the wire and
 *  in storage. New code should write the position-based shape. */
export interface TextRangeAnchor {
  type: 'text-range';
  selectorText: string;
  /** Inclusive raw cumulative character offset (position-based shape). */
  start?: number;
  /** Exclusive raw cumulative character offset (position-based shape). */
  end?: number;
  /** Legacy: text-context prefix. Present on pre-v1.1 anchors. */
  prefix?: string;
  /** Legacy: text-context suffix. Present on pre-v1.1 anchors. */
  suffix?: string;
  /** Legacy: CSS path to the nearest block ancestor. Present on
   *  pre-v1.1 anchors. */
  containerPath?: string;
}

export interface ElementPathAnchor {
  type: 'element-path';
  path: string;
  innerHash: string;
  /** Captured text content of the picked element at the moment it was picked.
   * Used for human-readable previews in the comment sidebar. Optional for
   * backward-compat with rows created before this field existed. */
  innerText?: string;
}

export type AnchorData = TextRangeAnchor | ElementPathAnchor;

// ───────────────────── Validation helpers ─────────────────────
// Moved from packages/shared/src/companion-protocol.ts, along with the
// private helpers they depend on. Dependency-free — the package's only
// runtime exports.

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function isTextRangeAnchor(v: unknown): v is TextRangeAnchor {
  if (!isObject(v) || v.type !== 'text-range' || !isString(v.selectorText)) {
    return false;
  }
  // Position-based shape: start AND end must be finite numbers AND end > start.
  // (A zero-length range would resolve to an invisible "ghost" highlight.)
  const hasPosition =
    isNumber(v.start) && isNumber(v.end) && (v.end as number) > (v.start as number);
  // Legacy shape: prefix AND suffix AND containerPath must all be strings.
  const hasLegacy =
    isString(v.prefix) && isString(v.suffix) && isString(v.containerPath);
  return hasPosition || hasLegacy;
}

export function isElementPathAnchor(v: unknown): v is ElementPathAnchor {
  return (
    isObject(v) &&
    v.type === 'element-path' &&
    isString(v.path) &&
    isString(v.innerHash)
  );
}

// ───────────────────── REST API DTOs ─────────────────────
// Moved verbatim from packages/shared/src/api.ts. AnchorData is now local
// (above) instead of imported from the companion-protocol module.

export interface UploadResponse {
  documentId: string;
  versionId: string;
  url: string;
}

export type UploadErrorCode =
  | 'validation_failed'
  | 'parse_failed'
  | 'too_large'
  | 'bad_extension'
  | 'bad_content_type'
  | 'missing_title'
  | 'missing_file'
  | 'internal';

export interface UploadErrorResponse {
  error: UploadErrorCode;
  message: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  description: string | null;
  uploaderId: string;             // NEW in SP5
  uploaderDisplayName: string;
  visibility: 'org' | 'private';
  createdAt: string;          // ISO timestamp
}

export interface UserDTO {
  id: string;
  email: string;
  displayName: string;
}

export interface MeResponse extends UserDTO {
  isAdmin: boolean;
}

export interface VersionSummary {
  id: string;
  versionNumber: number;
  versionNote: string | null;
  sizeBytes: number;
  createdAt: string;          // ISO timestamp
}

export interface DocumentDetail extends DocumentSummary {
  externallyShared: boolean;
}

/** The requesting viewer's effective role on a document. Mirrors
 *  EffectiveRole in apps/api/src/lib/permissions.ts: 'stranger' is a
 *  non-collaborator (readable only when visibility is 'org').
 *
 *  The ladder is commenter < responder < editor < owner; each step adds one
 *  kind of power. A commenter reads and comments. A responder additionally
 *  writes structured document events (so the page can act in their name) but
 *  cannot publish versions, rename, or manage people. An editor can also
 *  rewrite the document; only the owner manages collaborators. */
export type ViewerRole = 'owner' | 'editor' | 'responder' | 'commenter' | 'stranger';

export interface DocumentDetailResponse {
  document: DocumentDetail;
  latestVersion: VersionSummary;
  myRole: ViewerRole;
}

export interface CommentDTO {
  id: string;
  threadId: string;
  authorId: string;
  authorDisplayName: string;
  /** Empty string for a tombstoned comment — the server never discloses the
   *  text of a deleted comment, even to its author. The row keeps it, so an
   *  in-window restore brings the original text back. */
  body: string;
  createdAt: string;
  updatedAt: string | null;
  deletedAt: string | null;
  mentions: string[];
}

/** How long after deleting a comment its author may still undo the delete.
 *  Enforced by POST /api/comments/:id/restore; the web UI shows the Undo
 *  affordance for exactly this window so client and server agree. */
export const COMMENT_UNDO_WINDOW_MS = 15 * 60 * 1000;

/** A comment thread. Threads belong to the document: a thread started on one
 *  version is carried to each later version while it is open (see
 *  `contextChanged`). */
export interface ThreadDTO {
  id: string;
  /** The version the thread was started on. */
  versionId: string;
  versionNumber: number;
  /** Where the thread sits on the version that was listed. When
   *  `contextChanged` is true, or in single-thread responses, this is the
   *  anchor the thread was started with. */
  anchor: AnchorData;
  /** True when the thread's quoted text could not be found on the listed
   *  version: it shows there without a highlight. */
  contextChanged: boolean;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByDisplayName: string | null;
  createdAt: string;
  comments: CommentDTO[];
}

export interface ThreadsListResponse {
  threads: ThreadDTO[];
  asOf: string;
}

export interface CreateThreadRequest {
  anchor: AnchorData;
  body: string;
  mentions?: string[];
}

export interface CommentBodyRequest {
  body: string;
  mentions?: string[];
}

export interface MentionableUser {
  id: string;
  displayName: string;
  email: string;
}

export interface MentionableUsersResponse {
  users: MentionableUser[];
}

export interface DeletedDocumentEntry {
  id: string;
  title: string;
  deletedAt: string;
  daysRemaining: number;
}

export interface VersionSummaryDTO {
  id: string;
  versionNumber: number;
  versionNote: string | null;
  sizeBytes: number;
  createdAt: string;
}

export interface VersionsListResponse {
  versions: VersionSummaryDTO[];
}

export interface DocumentPatchRequest {
  title?: string;
  description?: string | null;
}

export interface VersionPatchRequest {
  versionNote: string | null;
}

export interface AddVersionResponse {
  versionId: string;
  versionNumber: number;
  url: string;
}

export interface AdminStatsBucket {
  total: number;
  last7d: number;
}

export interface DailyPoint {
  date: string;     // 'YYYY-MM-DD' UTC
  value: number;
}

export interface DailyStackPoint {
  date: string;     // 'YYYY-MM-DD' UTC
  documents: number;
  versions: number;
  comments: number;
}

export interface ThreadFlowPoint {
  date: string;
  opened: number;
  resolved: number;
}

export interface TopDocument {
  title: string;
  viewers: number;
}

export interface TopCommenter {
  displayName: string;
  comments: number;
}

export interface HistogramBucket {
  bucket: string;
  count: number;
}

export interface AdminAdoptionBlock {
  createdPerDay: DailyStackPoint[];
  activeUsersPerDay: DailyPoint[];
  cumulativeUsers: DailyPoint[];
}

export interface AdminEngagementBlock {
  topDocumentsByViewers: TopDocument[];
  topCommenters: TopCommenter[];
  viewersPerDocHistogram: HistogramBucket[];
}

export interface AdminOperationalBlock {
  storageBytesPerDay: DailyPoint[];
  threadsOpenedVsResolved: ThreadFlowPoint[];
  openThreadsAgingOver14d: {
    count: number;
    sparkline: DailyPoint[];
  };
}

export interface AdminStatsResponse {
  users: AdminStatsBucket;
  documents: AdminStatsBucket;
  versions: AdminStatsBucket;
  threads: AdminStatsBucket;
  comments: AdminStatsBucket;
  documentViews: AdminStatsBucket;

  rangeDays: 30;
  adoption: AdminAdoptionBlock;
  engagement: AdminEngagementBlock;
  operational: AdminOperationalBlock;
}

export interface DeviceAuthorizeResponse {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceTokenSuccess {
  token: string;
  tokenPrefix: string;
  tokenId: string;
  expiresAt: string | null;
}

export interface DeviceTokenPending {
  error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | 'invalid_grant';
}

export interface DevicePendingResponse {
  clientLabel: string | null;
  requesterIp: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface DeviceApproveResponse {
  clientLabel: string | null;
  requesterIp: string | null;
  createdAt: string;
}

/**
 * Permissions an API token can be limited to. A token minted with `scopes`
 * may call only the routes and MCP tools those scopes grant; everything else
 * answers 403 `insufficient_scope`. A scope only narrows what the user's
 * role on a document already allows; it never grants access the role doesn't
 * have. Some operations have no scope at all and are never reachable with a
 * scoped token: deleting or restoring documents, making a document
 * org-visible, external sharing, folders, and token management.
 */
export const API_TOKEN_SCOPES = [
  'documents:read',
  'documents:write',
  'comments:write',
  'events:write',
  'collaborators:manage',
  'users:read',
] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const API_TOKEN_SCOPE_DESCRIPTIONS: Record<ApiTokenScope, string> = {
  'documents:read': 'Read documents, versions, content, comments, and events',
  'documents:write':
    'Create documents, upload versions, edit titles, descriptions, and version notes, and make documents private, where your role on the document allows it',
  'comments:write': 'Create, edit, resolve, and delete comments where your role on the document allows it',
  'events:write':
    'Write structured document events where your role on the document allows it (the owner, an editor or a responder)',
  'collaborators:manage':
    'Change who can access documents you own: list, add, change, and remove collaborators',
  'users:read': 'Look up and search users',
};

export function isApiTokenScope(value: unknown): value is ApiTokenScope {
  return typeof value === 'string' && (API_TOKEN_SCOPES as readonly string[]).includes(value);
}

export interface ApiTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  /** null = unrestricted (every route an API token may call). */
  scopes: ApiTokenScope[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ApiTokensListResponse {
  tokens: ApiTokenSummary[];
}

export interface CreateTokenRequest {
  name: string;
  /** Omit for an unrestricted token. Must be non-empty when present. */
  scopes?: ApiTokenScope[];
}

/**
 * `token` is the plaintext secret and appears ONLY in this response — it is
 * never stored or returned again.
 */
export interface CreateTokenResponse {
  token: string;
  summary: ApiTokenSummary;
}

/** Roles an owner can grant through the collaborators API. The single
 *  source for every surface (API validation, web share UI, MCP client) so a
 *  new role is added in one place rather than re-declared per consumer. */
export const COLLABORATOR_ROLES = ['commenter', 'responder', 'editor'] as const;

export type CollaboratorRole = (typeof COLLABORATOR_ROLES)[number];

export function isCollaboratorRole(v: unknown): v is CollaboratorRole {
  return COLLABORATOR_ROLES.some((r) => r === v);
}

export interface Collaborator {
  userId: string;
  displayName: string;
  role: CollaboratorRole;
  grantedBy: string;
  createdAt: string;
}

export interface CollaboratorsListResponse {
  collaborators: Collaborator[];
}

export interface AddCollaboratorRequest {
  userId: string;
  role: CollaboratorRole;
}

export interface UpdateCollaboratorRequest {
  role: CollaboratorRole;
}

export interface UserSearchHit {
  id: string;
  displayName: string;
  email: string;
}

export interface UserSearchResponse {
  users: UserSearchHit[];
}

export interface FolderDTO {
  id: string;
  name: string;
  docCount: number;
}

export interface LibraryDocument {
  id: string;
  title: string;
  description: string | null;
  uploaderId: string;
  uploaderDisplayName: string;
  visibility: 'org' | 'private';
  ownership: 'mine' | 'collaborator' | 'org';
  threadCount: number;
  activeThreadCount: number;
  lastActivityAt: string;
  createdAt: string;
  folderId: string | null;
}

export interface LibraryResponse {
  folders: FolderDTO[];
  documents: LibraryDocument[];
  recentlyDeleted: DeletedDocumentEntry[];
}

export interface ExternalRecipientDto {
  id: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  firstViewedAt: string | null;
  viewCount: number;
  lastViewedAt: string | null;
}

export interface ExternalShareDto {
  id: string;
  shareToken: string;
  publishedVersionId: string | null;
  publishedVersionNumber: number | null;
  createdAt: string;
}

export interface ExternalShareResponse {
  share: ExternalShareDto | null;
  recipients: ExternalRecipientDto[];
  /** False when the server has no working email transport (NoopNotifier in
   *  production) — the sharer UI must warn that external sharing is unusable. */
  emailEnabled: boolean;
}

export interface ExternalViewEventDto {
  id: string;
  email: string;         // recipient email (from external_recipients)
  versionNumber: number; // version that was viewed
  viewedAt: string;      // ISO
}

export interface ExternalShareViewsResponse {
  views: ExternalViewEventDto[]; // ordered viewedAt DESC, capped at 200
  total: number;                 // full event count for the share
}

export interface AddExternalRecipientRequest {
  email: string;
  expiresInDays?: number; // default 90, max 365
}

export interface PublishExternalShareRequest {
  versionId: string;
}

// ───────────────────── Document events (wire contract) ─────────────────────
// Structured document events (issue #78): typed JSON payloads written by
// tooling, humans (via the consent-gated companion path), or agents, stored
// on a document as an append-only, access-controlled stream. Primer enforces
// behavior ONLY on its own columns (id → ordering, authorId → attribution,
// audience → read scope, namespace/type → validation + filtering); `payload`
// is opaque data Primer never interprets, and NOTHING consuming these rows
// may treat a payload as instructions to execute — payloads are always
// untrusted data to parse and validate.

/** Per-row read scope. REQUIRED on write — there is no default, because a
 *  default would be an implicit behavior and every writer is code that can
 *  state intent.
 *  - `author`: readable by the row's author + the document owner.
 *  - `collaborators`: readable by all authenticated document collaborators
 *    (owner included).
 *  - `artifact`: readable by the same set as `collaborators`, AND the
 *    companion relays the row into the sandboxed artifact iframe. This tier
 *    is the injection boundary — whether the row may become input to
 *    untrusted artifact code running in every viewer's browser — so it must
 *    never be collapsed into `collaborators`. */
export type EventAudience = 'author' | 'collaborators' | 'artifact';

export function isEventAudience(v: unknown): v is EventAudience {
  return v === 'author' || v === 'collaborators' || v === 'artifact';
}

/** The audience a stored row can carry. `readers` is server-only: Primer's
 *  own lifecycle events (namespace `primer`) use it, and it means everyone
 *  who may read the document. No writer can choose it, and the page never
 *  relays it into the artifact. */
export type StoredEventAudience = EventAudience | 'readers';

/** `namespace` is hierarchical: `/`-separated lowercase kebab segments
 *  (`example`, `example/telemetry`). Namespace MEANING is the consumers' domain —
 *  the server validates shape only and never infers behavior from it. */
export const EVENT_NAMESPACE_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
/** `type` is a single name within a namespace (`export`, `verdict`). */
export const EVENT_TYPE_RE = /^[a-z0-9][a-z0-9-]*$/;
/** A `?type=` filter also matches Primer's own dotted lifecycle types
 *  (`comment.created`), which writers can never use. */
export const EVENT_TYPE_FILTER_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
export const MAX_EVENT_NAMESPACE_LENGTH = 128;
export const MAX_EVENT_TYPE_LENGTH = 64;
/** Serialized (UTF-8) size cap per event payload. */
export const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024;
/** Maximum events per POST batch (the batch cap is Primer's to own). */
export const MAX_EVENTS_PER_BATCH = 100;

/** One event as submitted by a writer (each event in a batch carries its own
 *  namespace/type/payload/audience; `versionId` is optional write-time
 *  provenance — the version that was the entry point when the row was
 *  written). */
export interface EventInput {
  namespace: string;
  type: string;
  payload: unknown;
  audience: EventAudience;
  versionId?: string;
}

/** A stored event row. `id` is the server-assigned ordering key — a positive
 *  integer (bigserial), NOT a uuid. Ids follow commit order: a row only ever
 *  becomes visible after every row with a lower id, so "everything after id
 *  N" is a complete resume point. Ids need not be contiguous. `createdAt` is
 *  display-only. `versionId` is present only when the writer declared it. */
export interface EventRowDTO {
  id: number;
  documentId: string;
  versionId?: string;
  authorId: string;
  audience: StoredEventAudience;
  namespace: string;
  type: string;
  payload: unknown;
  createdAt: string; // ISO
}

/** POST /api/documents/:id/events — the body is uniformly a batch (a single
 *  send is a batch of one). All-or-nothing: any invalid event rejects the
 *  whole batch and nothing is inserted. */
export interface SendEventsRequest {
  events: EventInput[];
}

/** 201 response: the created rows, in insertion (array) order, with their
 *  server-assigned ids and stored audiences — the ids are the consumer's
 *  dedupe keys and the echoed audience is how tooling asserts its write
 *  landed with the intended scope. */
export interface SendEventsResponse {
  events: EventRowDTO[];
}

/** GET /api/documents/:id/events — one token-paginated page of ascending-id
 *  rows. Follow `nextPageToken` to exhaustion; page overlaps are harmless
 *  because consumers dedupe by id. */
export interface EventsListResponse {
  events: EventRowDTO[];
  nextPageToken: string | null;
}

/** GET /api/users/lookup?email= — resolve a human-entered email to the
 *  canonical server user id, so consumers can classify authority by
 *  comparing identities against server-attributed row authors in the same
 *  id space. */
export interface UserLookupResponse {
  id: string;
}

// ───────────────────── Lifecycle events (server-only) ─────────────────────
// Primer writes these itself, in the same transaction as the change they
// describe. Rows carry namespace `primer`, audience `readers`, and one of the
// types below; the full event name is `primer.<type>` (for example
// `primer.comment.created`). Clients can never write the `primer` namespace.
// Payloads hold ids only — fetch the comment, thread or version for content.

export const PRIMER_EVENT_NAMESPACE = 'primer';

export interface PrimerCommentCreatedPayload {
  document_id: string;
  version_id: string;
  thread_id: string;
  comment_id: string;
  author_id: string;
}

export interface PrimerThreadResolvedPayload {
  document_id: string;
  thread_id: string;
  by: string;
}

/** A thread changed in a way other events don't name: a comment edited,
 *  deleted or restored, or the thread reopened. */
export interface PrimerThreadUpdatedPayload {
  document_id: string;
  thread_id: string;
  by: string;
}

export interface PrimerVersionPublishedPayload {
  document_id: string;
  version_id: string;
  number: number;
  author_id: string;
}

export type DocumentStatusState = 'working' | 'idle';

/** How long a `working` status counts before it expires unless refreshed. */
export const DOCUMENT_STATUS_TTL_MS = 10 * 60 * 1000;

export interface PrimerStatusPayload {
  document_id: string;
  state: DocumentStatusState;
  by: string;
  expires_at: string; // ISO
}

export interface PrimerEventPayloads {
  'comment.created': PrimerCommentCreatedPayload;
  'thread.resolved': PrimerThreadResolvedPayload;
  'thread.updated': PrimerThreadUpdatedPayload;
  'version.published': PrimerVersionPublishedPayload;
  status: PrimerStatusPayload;
}

export type PrimerEventType = keyof PrimerEventPayloads;

/** POST /api/documents/:id/status */
export interface SetDocumentStatusRequest {
  state: DocumentStatusState;
}

/** One person currently working on a document (an unexpired `working`). */
export interface DocumentStatusDTO {
  by: string;
  displayName: string;
  state: 'working';
  expiresAt: string; // ISO
}

/** GET /api/documents/:id/status — who is working on the document now. */
export interface DocumentStatusResponse {
  statuses: DocumentStatusDTO[];
}
