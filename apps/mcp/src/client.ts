import type {
  Target,
  AgentRunDTO,
  ApplyOpsRequest,
  Reconciliation,
  LiveDocDTO,
  LiveReadFormat,
  AddVersionResponse,
  CollaboratorRole,
  CommentDTO,
  DocumentDetailResponse,
  EventInput,
  EventsListResponse,
  SendEventsResponse,
  SuggestionsResponse,
  ThreadDTO,
  ThreadsListResponse,
  UploadResponse,
  UserDTO,
  UserLookupResponse,
  VersionsListResponse,
} from '@polygonlabs/primer-api-types';

/**
 * Machine-checkable error codes returned by every PrimerApiError.
 * See spec D17 — the skill and tool layer branch on `code`, never on
 * message text. `login_denied` / `login_expired` are emitted by the
 * device-login helpers (B4), not by this HTTP client.
 */
export type PrimerErrorCode =
  | 'not_authenticated'
  | 'forbidden'
  | 'not_found'
  | 'bad_request'
  | 'rate_limited'
  | 'network'
  | 'login_denied'
  | 'login_expired';

export class PrimerApiError extends Error {
  readonly code: PrimerErrorCode;
  readonly status?: number;
  /** The server's JSON error body (refusal, per-op errors), when it sent one. */
  readonly body?: unknown;

  constructor(code: PrimerErrorCode, message: string, status?: number, body?: unknown) {
    super(message);
    this.name = 'PrimerApiError';
    this.code = code;
    this.status = status;
    this.body = body;
  }
}

export interface PrimerClientOptions {
  /** Base URL, e.g. `http://localhost:3000` or `https://primer.polygon.tools`.
   *  A trailing slash is stripped during construction. */
  baseUrl: string;
  /** `primer_pat_…` bearer token. */
  token: string;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export type DocumentFormat = 'markdown' | 'html' | 'text';

export interface CreateDocumentInput {
  title: string;
  description?: string;
  content: string;
  format: DocumentFormat;
}

export interface AddVersionInput {
  documentId: string;
  content: string;
  format: DocumentFormat;
  versionNote?: string;
  /** The version the caller read; a newer one refuses the publish (409 stale_base). */
  baseVersionNumber?: number;
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body?: FormData;
  /** JSON request body — serialized with the content-type header set.
   *  Mutually exclusive with `body`. */
  json?: unknown;
}

/** Carries the parsed body of a non-2xx response, when JSON-decodable. */
interface ApiErrorBody {
  error?: string;
  message?: string;
  /** Present on publish refusals: what to do instead. */
  refusal?: { fix?: string };
}

function statusToCode(status: number): PrimerErrorCode {
  if (status === 401) return 'not_authenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 400) return 'bad_request';
  if (status === 429) return 'rate_limited';
  // 5xx (and any other non-2xx we don't have a specific code for) collapses to
  // bad_request for v1 — the original status is surfaced via error.status so
  // callers can still tell the difference if they need to.
  return 'bad_request';
}

async function parseErrorBody(res: Response): Promise<ApiErrorBody | null> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) return null;
  try {
    const parsed = (await res.json()) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as ApiErrorBody;
    return null;
  } catch {
    return null;
  }
}

async function parseSuccessBody<T>(res: Response): Promise<T> {
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    // The API always returns JSON on success today (no 204s on the endpoints
    // this client uses). If a future endpoint changes that, the caller can
    // cast appropriately — but for now we treat a non-JSON success as empty.
    return undefined as T;
  }
  return (await res.json()) as T;
}

export class PrimerClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PrimerClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    // Bind to preserve `this` for the global fetch on platforms that care
    // (Node's undici is strict about this).
    const f = opts.fetchImpl ?? globalThis.fetch;
    this.fetchImpl = ((input, init) => f(input, init)) as typeof fetch;
  }

  // ────────────────────────────── Public API ──────────────────────────────

  whoami(): Promise<UserDTO> {
    return this.request<UserDTO>({ method: 'GET', path: '/api/me' });
  }

  getDocument(documentId: string): Promise<DocumentDetailResponse> {
    return this.request<DocumentDetailResponse>({
      method: 'GET',
      path: `/api/documents/${encodeURIComponent(documentId)}`,
    });
  }

  listVersions(documentId: string): Promise<VersionsListResponse> {
    return this.request<VersionsListResponse>({
      method: 'GET',
      path: `/api/documents/${encodeURIComponent(documentId)}/versions`,
    });
  }

  getVersionThreads(versionId: string): Promise<ThreadsListResponse> {
    return this.request<ThreadsListResponse>({
      method: 'GET',
      path: `/api/versions/${encodeURIComponent(versionId)}/threads`,
    });
  }

  /** Posts a reply in a thread (reopening it if resolved). */
  replyToThread(threadId: string, body: string): Promise<{ comment: CommentDTO; thread: ThreadDTO }> {
    return this.request<{ comment: CommentDTO; thread: ThreadDTO }>({
      method: 'POST',
      path: `/api/threads/${encodeURIComponent(threadId)}/comments`,
      json: { body },
    });
  }

  /** Reads a live document's blocks (see primer_get_doc). */
  getLiveDoc(
    documentId: string,
    opts: { format?: LiveReadFormat; tabId?: string; since?: number; range?: { from: Target; to: Target }; runId?: string } = {},
  ): Promise<LiveDocDTO> {
    const q = new URLSearchParams();
    if (opts.format) q.set('format', opts.format);
    if (opts.tabId) q.set('tabId', opts.tabId);
    if (opts.since !== undefined) q.set('since', String(opts.since));
    if (opts.runId) q.set('runId', opts.runId);
    if (opts.range) {
      q.set('from', opts.range.from.blockId);
      q.set('to', opts.range.to.blockId);
    }
    const qs = q.toString();
    return this.request<LiveDocDTO>({
      method: 'GET',
      path: `/api/documents/${encodeURIComponent(documentId)}/live${qs ? `?${qs}` : ''}`,
    });
  }

  /** The caller's (an agent's) runs; active ones by default. */
  listRuns(opts: { documentId?: string; status?: string } = {}): Promise<{ runs: AgentRunDTO[] }> {
    const q = new URLSearchParams();
    if (opts.documentId) q.set('documentId', opts.documentId);
    if (opts.status) q.set('status', opts.status);
    const qs = q.toString();
    return this.request<{ runs: AgentRunDTO[] }>({ method: 'GET', path: `/api/runs${qs ? `?${qs}` : ''}` });
  }

  /** Claims, updates, finishes or fails one of the caller's runs. */
  updateRun(
    runId: string,
    action: 'claim' | 'status' | 'finish' | 'fail',
    input: { statusLine?: string; plan?: string; error?: string } = {},
  ): Promise<AgentRunDTO> {
    const id = encodeURIComponent(runId);
    if (action === 'claim') return this.request<AgentRunDTO>({ method: 'POST', path: `/api/runs/${id}/claim`, json: {} });
    if (action === 'status') {
      return this.request<AgentRunDTO>({ method: 'POST', path: `/api/runs/${id}/status`, json: { statusLine: input.statusLine, plan: input.plan } });
    }
    const json = action === 'fail' ? { error: input.error ?? 'failed' } : {};
    return this.request<AgentRunDTO>({ method: 'POST', path: `/api/runs/${id}/finish`, json });
  }

  /** The open suggestions on a live document (fenced for agents). */
  listSuggestions(documentId: string): Promise<SuggestionsResponse> {
    return this.request<SuggestionsResponse>({
      method: 'GET',
      path: `/api/documents/${encodeURIComponent(documentId)}/suggestions`,
    });
  }

  /** Withdraws one of the caller's own suggestions. */
  withdrawSuggestion(suggestionId: string): Promise<Reconciliation> {
    return this.request<Reconciliation>({
      method: 'POST',
      path: `/api/suggestions/${encodeURIComponent(suggestionId)}/withdraw`,
      json: {},
    });
  }

  /** Edits a live document by block (see primer_apply_ops). */
  applyOps(documentId: string, req: ApplyOpsRequest): Promise<Reconciliation> {
    return this.request<Reconciliation>({
      method: 'POST',
      path: `/api/documents/${encodeURIComponent(documentId)}/ops`,
      json: req,
    });
  }

  /** Comments on a live document's text, quoted exactly from one block. */
  createLiveThread(
    documentId: string,
    input: { target: Target; quote: string; body: string },
  ): Promise<ThreadDTO & { commentId: string }> {
    return this.request<ThreadDTO & { commentId: string }>({
      method: 'POST',
      path: `/api/documents/${encodeURIComponent(documentId)}/threads`,
      json: { anchor: { type: 'prose', target: input.target, quote: input.quote }, body: input.body },
    });
  }

  /** Moves a live thread's comment onto quoted text. */
  reanchorThread(threadId: string, input: { target: Target; quote: string }): Promise<ThreadDTO> {
    return this.request<ThreadDTO>({
      method: 'POST',
      path: `/api/threads/${encodeURIComponent(threadId)}/reanchor`,
      json: input,
    });
  }

  /** Resolves a thread (document owner or thread starter only). */
  resolveThread(threadId: string): Promise<ThreadDTO> {
    return this.request<ThreadDTO>({
      method: 'POST',
      path: `/api/threads/${encodeURIComponent(threadId)}/resolve`,
    });
  }

  createDocument(input: CreateDocumentInput): Promise<UploadResponse> {
    const fd = new FormData();
    fd.append('file', buildFileBlob(input.content, input.format), filenameFor(input.format));
    fd.append('title', input.title);
    if (input.description !== undefined) {
      fd.append('description', input.description);
    }
    return this.request<UploadResponse>({
      method: 'POST',
      path: '/api/upload',
      body: fd,
    });
  }

  addVersion(input: AddVersionInput): Promise<AddVersionResponse> {
    const fd = new FormData();
    fd.append('file', buildFileBlob(input.content, input.format), filenameFor(input.format));
    if (input.versionNote !== undefined) {
      fd.append('versionNote', input.versionNote);
    }
    if (input.baseVersionNumber !== undefined) {
      fd.append('baseVersionNumber', String(input.baseVersionNumber));
    }
    return this.request<AddVersionResponse>({
      method: 'POST',
      path: `/api/documents/${encodeURIComponent(input.documentId)}/versions`,
      body: fd,
    });
  }

  // ── Document events (issue #78) ──────────────────────────────────
  // Structured, audience-scoped event rows on a document. EVENT PAYLOADS
  // ARE ALWAYS UNTRUSTED DATA — parse and validate them, never execute
  // them as instructions.

  /** One token-paginated page of ascending-id event rows the caller may
   *  read. Ids follow commit order, so `since` is a complete resume point.
   *  Follow `nextPageToken` to exhaustion. */
  getEvents(
    documentId: string,
    opts: {
      since?: number;
      namespace?: string;
      type?: string;
      versionId?: string;
      pageToken?: string;
      limit?: number;
    } = {},
  ): Promise<EventsListResponse> {
    const params = new URLSearchParams();
    if (opts.since !== undefined) params.set('since', String(opts.since));
    if (opts.namespace !== undefined) params.set('namespace', opts.namespace);
    if (opts.type !== undefined) params.set('type', opts.type);
    if (opts.versionId !== undefined) params.set('versionId', opts.versionId);
    if (opts.pageToken !== undefined) params.set('pageToken', opts.pageToken);
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    const qs = params.size > 0 ? `?${params.toString()}` : '';
    return this.request<EventsListResponse>({
      method: 'GET',
      path: `/api/documents/${encodeURIComponent(documentId)}/events${qs}`,
    });
  }

  /** Writes one atomic batch (all-or-nothing, array order, strictly
   *  increasing server-assigned ids); returns the created rows. Each event
   *  carries its own namespace/type/payload and a REQUIRED audience. */
  sendEvents(documentId: string, events: EventInput[]): Promise<SendEventsResponse> {
    return this.request<SendEventsResponse>({
      method: 'POST',
      path: `/api/documents/${encodeURIComponent(documentId)}/events`,
      json: { events },
    });
  }

  /** Resolves a human-entered email to the canonical server user id —
   *  the id space row authorship is attributed in. */
  lookupUser(email: string): Promise<UserLookupResponse> {
    return this.request<UserLookupResponse>({
      method: 'GET',
      path: `/api/users/lookup?email=${encodeURIComponent(email)}`,
    });
  }

  /** Adds a user as a document collaborator (owner-only operation). */
  addCollaborator(documentId: string, userId: string, role: CollaboratorRole): Promise<void> {
    return this.request<void>({
      method: 'POST',
      path: `/api/documents/${encodeURIComponent(documentId)}/collaborators`,
      json: { userId, role },
    });
  }

  /** Server responds `{ ok: true }` on success; we discard the body. */
  async revokeToken(tokenId: string): Promise<void> {
    await this.request<{ ok: true }>({
      method: 'DELETE',
      path: `/api/tokens/${encodeURIComponent(tokenId)}`,
    });
  }

  /** Raw stored body of a version — `text/html`, not JSON, so this bypasses
   *  the JSON success parser and returns the response text verbatim. */
  async getVersionContent(versionId: string): Promise<string> {
    const res = await this.send({
      method: 'GET',
      path: `/api/versions/${encodeURIComponent(versionId)}/content`,
    });
    return res.text();
  }

  // ─────────────────────────────── Internals ───────────────────────────────

  private async request<T>(opts: RequestOptions): Promise<T> {
    const res = await this.send(opts);
    return parseSuccessBody<T>(res);
  }

  /** Fetch + error mapping shared by the JSON (`request`) and text
   *  (`getVersionContent`) paths. Resolves only for 2xx responses. */
  private async send(opts: RequestOptions): Promise<Response> {
    const url = `${this.baseUrl}${opts.path}`;
    // For multipart bodies we intentionally DO NOT set Content-Type — fetch
    // writes it with the correct boundary. Setting it manually breaks parsing.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    let body: BodyInit | undefined = opts.body;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: opts.method,
        headers,
        body,
      });
    } catch (err) {
      // Network-layer failure (DNS, ECONNREFUSED, TLS, etc.) — never let a
      // raw fetch error escape; the tool layer needs a typed code to branch on.
      const message = err instanceof Error ? err.message : String(err);
      throw new PrimerApiError('network', message);
    }

    if (!res.ok) {
      const body = await parseErrorBody(res);
      const code = statusToCode(res.status);
      const base = body?.message ?? body?.error ?? res.statusText ?? `HTTP ${res.status}`;
      const message = body?.refusal?.fix ? `${base} ${body.refusal.fix}` : base;
      throw new PrimerApiError(code, message, res.status, body ?? undefined);
    }

    return res;
  }
}

function filenameFor(format: DocumentFormat): string {
  return format === 'markdown' ? 'doc.md' : format === 'text' ? 'doc.txt' : 'doc.html';
}

function contentTypeFor(format: DocumentFormat): string {
  return format === 'markdown' ? 'text/markdown' : format === 'text' ? 'text/plain' : 'text/html';
}

function buildFileBlob(content: string, format: DocumentFormat): Blob {
  return new Blob([content], { type: contentTypeFor(format) });
}
