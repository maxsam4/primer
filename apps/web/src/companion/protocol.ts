/**
 * The parent-side half of Primer's companion postMessage protocol: message
 * shapes, the window-level handshake envelope, and the runtime parsers that
 * validate untrusted messages arriving from the sandboxed artifact iframe.
 * The iframe half — the standalone plain-JS script that posts these same
 * shapes — is `apps/api/src/companion/v1.js`. Kept in sync by hand; there
 * is no shared module between the two halves, since one is TypeScript
 * bundled into this app and the other is plain JS loaded directly into an
 * opaque-origin sandboxed iframe.
 *
 * Moved from packages/shared/src/companion-protocol.ts. The anchor shapes
 * (`AnchorData`, `TextRangeAnchor`, `ElementPathAnchor`) and their guards
 * moved to `@polygonlabs/primer-api-types` instead — they're part of the
 * wire contract (stored in `threads.anchor`), not the envelope.
 */
import type {
  AnchorData,
  ElementPathAnchor,
  EventInput,
  EventRowDTO,
  Refusal,
  TextRangeAnchor,
} from '@polygonlabs/primer-api-types';
import {
  EVENT_NAMESPACE_RE,
  EVENT_TYPE_RE,
  MAX_EVENT_NAMESPACE_LENGTH,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENT_TYPE_LENGTH,
  MAX_EVENTS_PER_BATCH,
  isElementPathAnchor,
  isEventAudience,
  isTextRangeAnchor,
  RECORD_VERBS,
} from '@polygonlabs/primer-api-types';

export interface SerializableRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Anchor {
  id: string;
  data: AnchorData;
}

// Parent → Iframe
export type Theme = 'light' | 'dark';

/** Optional bridge capabilities the host grants a page at init. `records`:
 *  the page opted in to records, is served with the records outbound
 *  policy, and gets `window.primer.records`. */
export type BridgeFeature = 'page-text' | 'embeds' | 'records';

export interface MsgInit {
  type: 'init';
  anchors: Anchor[];
  /** Granted features; absent means none. */
  features?: BridgeFeature[];
  /** Parent's effective theme at iframe load. Companion sets
   *  document.documentElement.dataset.theme accordingly. Older companion
   *  snapshots ignore unknown init fields, so this is forward-compatible. */
  theme: Theme;
}
export interface MsgUpdateAnchors {
  type: 'update_anchors';
  anchors: Anchor[];
}
export interface MsgEnterPickMode {
  type: 'enter_pick_mode';
}
export interface MsgExitPickMode {
  type: 'exit_pick_mode';
}
/** Sticky-focus mode. Sending an anchorId focuses that anchor and keeps it
 *  highlighted until another `set_focused_anchor` arrives. Sending null clears
 *  the focus. The companion repaints focus state automatically on
 *  `update_anchors` so the focus survives anchor refreshes. */
export interface MsgSetFocusedAnchor {
  type: 'set_focused_anchor';
  anchorId: string | null;
}
export interface MsgRequestAnchorPositions {
  type: 'request_anchor_positions';
}
export interface MsgThemeChanged {
  type: 'theme_changed';
  theme: Theme;
}
/** Document-events read relay (issue #78): `artifact`-audience event rows,
 *  forwarded VERBATIM into the iframe in coalesced batches (the initial list
 *  fetch as one batch, a re-fetch as one batch, stream bursts coalesced).
 *  Grouping carries NO semantics — the artifact must derive identical state
 *  however the same rows are partitioned into dispatches (it interprets rows
 *  by id, not by arrival grouping). The companion re-dispatches these to
 *  artifact JS as CustomEvent('primer:events', { detail: { events } }). */
export interface MsgEventsRelay {
  type: 'events';
  events: EventRowDTO[];
}
/** Write acknowledgment for a prior `submit_events` — `rows` carries the
 *  created rows (server-assigned ids + stored audiences) so the artifact can
 *  reconcile an optimistic echo with server-attributed truth. Re-dispatched
 *  by the companion as CustomEvent('primer:submit-result'). */
export interface MsgSubmitResult {
  type: 'submit_result';
  ok: boolean;
  rows?: EventRowDTO[];
  error?: string;
}

/** The answer to one `records_call`. */
export interface MsgRecordsResult {
  type: 'records_result';
  callId: string;
  ok: boolean;
  value?: unknown;
  refusal?: Refusal;
}
/** Others changed shared records (a `primer.data.changed` event, or the
 *  host's catch-up when its feed (re)connects). Empty `collections` means
 *  anything may have changed: re-read what the page shows. */
export interface MsgRecordsChanged {
  type: 'records_changed';
  collections: string[];
  toChangeId: number;
}

/** Feature `page-text`: people's current text for stamped elements. The
 *  bridge sets only the text (`\n` as <br>) of elements carrying that
 *  `data-pid`, never markup. */
export interface MsgSetPageTexts {
  type: 'set_page_texts';
  texts: Record<string, string>;
}
/** Feature `embeds`: each `<primer-*>` block's static HTML, rendered by the
 *  host from the document's block state; the page shows it read-only. */
export interface MsgSetEmbeds {
  type: 'set_embeds';
  embeds: Record<string, string>;
}

export type OutboundProtocolMessage =
  | MsgSetPageTexts
  | MsgSetEmbeds
  | MsgInit
  | MsgUpdateAnchors
  | MsgEnterPickMode
  | MsgExitPickMode
  | MsgSetFocusedAnchor
  | MsgRequestAnchorPositions
  | MsgThemeChanged
  | MsgEventsRelay
  | MsgSubmitResult
  | MsgRecordsResult
  | MsgRecordsChanged;

// Iframe → Parent
export interface MsgSelectionCaptured {
  type: 'selection_captured';
  anchor: TextRangeAnchor;
  clientRects: SerializableRect[];
}
export interface MsgElementPicked {
  type: 'element_picked';
  anchor: ElementPathAnchor;
  clientRect: SerializableRect;
}
export interface MsgPickModeExited {
  type: 'pick_mode_exited';
}
/** Fired when a previously-captured text selection collapses or is cleared
 *  inside the iframe (e.g. the user clicked elsewhere). Lets the parent
 *  auto-dismiss a still-empty new-thread composer. */
export interface MsgSelectionCleared {
  type: 'selection_cleared';
}
export interface MsgAnchorPositions {
  type: 'anchor_positions';
  positions: { anchorId: string; rects: SerializableRect[]; drifted?: boolean }[];
}
export interface MsgResize {
  type: 'resize';
  height: number;
}
/** Fired when the artifact's content is intrinsically wider than the iframe
 *  viewport (companion only sends it on overflow, never for fitting
 *  content). The parent uses it to scale the iframe down to fit narrow
 *  screens. */
export interface MsgContentMetrics {
  type: 'content_metrics';
  contentWidth: number;
}
export interface MsgOpenExternal {
  type: 'open_external';
  url: string;
}
/** Fired when the user clicks on a highlighted anchor inside the iframe.
 *  The parent uses this to focus the matching thread + scroll the sidebar
 *  to its card. */
export interface MsgAnchorClicked {
  type: 'anchor_clicked';
  anchorId: string;
}
/** Log line streamed from companion to parent over the port so debugging
 *  doesn't require reaching into the iframe's opaque-origin console. */
export interface MsgCompanionLog {
  type: 'companion_log';
  level: 'info' | 'warn' | 'error';
  message: string;
}

/** Consent-gated event submission from the artifact (issue #78): the
 *  companion forwards CustomEvent('primer:submit-events') payloads ONLY from
 *  within the same trusted event dispatch that carried a user gesture, and
 *  we re-validate the whole batch here — the parent is the authed principal
 *  and this message came, ultimately, from untrusted artifact code. The
 *  parent POSTs the batch to /api/documents/:id/events and answers with a
 *  `submit_result`. */
export interface MsgSubmitEvents {
  type: 'submit_events';
  events: EventInput[];
}

/** The page's call into records. `args` names only what the page may
 *  choose (collection, scope, record, data, filters, paging); the host binds
 *  the document and the viewer, whatever `args` says. */
export type RecordsCallVerb = (typeof RECORD_VERBS)[number] | 'changesSince';
export interface MsgRecordsCall {
  type: 'records_call';
  callId: string;
  verb: RecordsCallVerb;
  args: Record<string, unknown>;
}
export interface MsgRecordsCancel {
  type: 'records_cancel';
  callId: string;
}

/** Feature `page-text` (and `embeds`): every stamped element's DOM text and
 *  rect, sent once after the page loaded and before the host sets any text
 *  (so a script-drawn pid shows text other than its source), with each
 *  embed's rect. Rects are in the frame's viewport. */
export interface MsgPageElements {
  type: 'page_elements';
  elements: { pid: string; text: string; rect: SerializableRect }[];
  embeds: { embedId: string; rect: SerializableRect }[];
}
/** The same elements' rects again, after a scroll, resize or text change. */
export interface MsgPageRects {
  type: 'page_rects';
  rects: Record<string, SerializableRect>;
  embedRects: Record<string, SerializableRect>;
}
export interface MsgPidClicked {
  type: 'pid_clicked';
  pid: string;
}
export interface MsgEmbedClicked {
  type: 'embed_clicked';
  embedId: string;
}

export type InboundProtocolMessage =
  | MsgPageElements
  | MsgPageRects
  | MsgPidClicked
  | MsgEmbedClicked
  | MsgSelectionCaptured
  | MsgSelectionCleared
  | MsgElementPicked
  | MsgPickModeExited
  | MsgAnchorPositions
  | MsgResize
  | MsgContentMetrics
  | MsgOpenExternal
  | MsgAnchorClicked
  | MsgCompanionLog
  | MsgSubmitEvents
  | MsgRecordsCall
  | MsgRecordsCancel;

/** Window-level handshake messages — go via window.postMessage (not the
 *  port) because they exist for the case where the port isn't established
 *  yet, or has already given up. */
export interface MsgCompanionReady {
  type: 'companion_ready';
}
export interface MsgCompanionPanic {
  type: 'companion_panic';
  reason: string;
}
export type WindowEnvelope = MsgCompanionReady | MsgCompanionPanic;

// ───────────────────── Validation helpers ─────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isRect(v: unknown): v is SerializableRect {
  return (
    isObject(v) &&
    isNumber(v.x) &&
    isNumber(v.y) &&
    isNumber(v.width) &&
    isNumber(v.height)
  );
}

export function parseInboundMessage(raw: unknown): InboundProtocolMessage | null {
  if (!isObject(raw) || !isString(raw.type)) return null;

  switch (raw.type) {
    case 'selection_captured': {
      if (!isTextRangeAnchor(raw.anchor)) return null;
      if (!Array.isArray(raw.clientRects) || !raw.clientRects.every(isRect)) return null;
      return {
        type: 'selection_captured',
        anchor: raw.anchor,
        clientRects: raw.clientRects,
      };
    }
    case 'element_picked': {
      if (!isElementPathAnchor(raw.anchor)) return null;
      if (!isRect(raw.clientRect)) return null;
      return { type: 'element_picked', anchor: raw.anchor, clientRect: raw.clientRect };
    }
    case 'pick_mode_exited':
      return { type: 'pick_mode_exited' };
    case 'selection_cleared':
      return { type: 'selection_cleared' };
    case 'anchor_positions': {
      if (!Array.isArray(raw.positions)) return null;
      const positions: MsgAnchorPositions['positions'] = [];
      for (const p of raw.positions) {
        if (!isObject(p) || !isString(p.anchorId)) return null;
        if (!Array.isArray(p.rects) || !p.rects.every(isRect)) return null;
        const entry: MsgAnchorPositions['positions'][number] = {
          anchorId: p.anchorId,
          rects: p.rects,
        };
        if (p.drifted === true) entry.drifted = true;
        positions.push(entry);
      }
      return { type: 'anchor_positions', positions };
    }
    case 'resize': {
      if (!isNumber(raw.height)) return null;
      return { type: 'resize', height: raw.height };
    }
    case 'content_metrics': {
      if (!isNumber(raw.contentWidth) || raw.contentWidth <= 0) return null;
      return { type: 'content_metrics', contentWidth: raw.contentWidth };
    }
    case 'open_external': {
      if (!isString(raw.url)) return null;
      return { type: 'open_external', url: raw.url };
    }
    case 'anchor_clicked': {
      if (!isString(raw.anchorId)) return null;
      return { type: 'anchor_clicked', anchorId: raw.anchorId };
    }
    case 'companion_log': {
      if (raw.level !== 'info' && raw.level !== 'warn' && raw.level !== 'error') return null;
      if (!isString(raw.message)) return null;
      return { type: 'companion_log', level: raw.level, message: raw.message };
    }
    case 'submit_events': {
      if (!Array.isArray(raw.events) || raw.events.length === 0 || raw.events.length > MAX_EVENTS_PER_BATCH) {
        return null;
      }
      const events: EventInput[] = [];
      for (const e of raw.events) {
        const parsed = parseEventInput(e);
        if (!parsed) return null; // all-or-nothing, matching the API's batch semantics
        events.push(parsed);
      }
      return { type: 'submit_events', events };
    }
    case 'records_call': {
      if (!isCallId(raw.callId)) return null;
      if (!isString(raw.verb) || !RECORDS_CALL_VERBS.includes(raw.verb as RecordsCallVerb)) return null;
      if (!isObject(raw.args) || Array.isArray(raw.args)) return null;
      return { type: 'records_call', callId: raw.callId, verb: raw.verb as RecordsCallVerb, args: raw.args };
    }
    case 'records_cancel':
      if (!isCallId(raw.callId)) return null;
      return { type: 'records_cancel', callId: raw.callId };
    case 'page_elements': {
      if (!Array.isArray(raw.elements) || raw.elements.length > MAX_PAGE_ELEMENTS) return null;
      if (!Array.isArray(raw.embeds) || raw.embeds.length > MAX_PAGE_ELEMENTS) return null;
      const elements: MsgPageElements['elements'] = [];
      // An invalid or oversize element is left out (so it reads as script-drawn
      // and stays read-only); it must not void the rest of the page's report.
      for (const e of raw.elements) {
        if (!isObject(e) || !isPageId(e.pid) || !isString(e.text) || e.text.length > MAX_PAGE_TEXT || !isRect(e.rect)) continue;
        elements.push({ pid: e.pid, text: e.text, rect: e.rect });
      }
      const embeds: MsgPageElements['embeds'] = [];
      for (const e of raw.embeds) {
        if (!isObject(e) || !isPageId(e.embedId) || !isRect(e.rect)) continue;
        embeds.push({ embedId: e.embedId, rect: e.rect });
      }
      return { type: 'page_elements', elements, embeds };
    }
    case 'page_rects': {
      const rects = parseRects(raw.rects);
      const embedRects = parseRects(raw.embedRects);
      if (!rects || !embedRects) return null;
      return { type: 'page_rects', rects, embedRects };
    }
    case 'pid_clicked':
      if (!isPageId(raw.pid)) return null;
      return { type: 'pid_clicked', pid: raw.pid };
    case 'embed_clicked':
      if (!isPageId(raw.embedId)) return null;
      return { type: 'embed_clicked', embedId: raw.embedId };
    default:
      return null;
  }
}

const MAX_PAGE_ELEMENTS = 20_000;
const MAX_PAGE_TEXT = 100_000;

/** Pids and embed ids as the server stamps and accepts them. */
function isPageId(v: unknown): v is string {
  return isString(v) && /^[A-Za-z0-9_-]{1,64}$/.test(v);
}

function parseRects(raw: unknown): Record<string, SerializableRect> | null {
  if (!isObject(raw) || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > MAX_PAGE_ELEMENTS) return null;
  const out: Record<string, SerializableRect> = {};
  for (const [id, rect] of entries) {
    if (!isPageId(id) || !isRect(rect)) return null;
    out[id] = rect;
  }
  return out;
}

const RECORDS_CALL_VERBS: readonly string[] = [...RECORD_VERBS, 'changesSince'];

function isCallId(v: unknown): v is string {
  return isString(v) && v.length > 0 && v.length <= 64;
}

/** Validates one untrusted event of a submit batch against the api-types
 *  wire contract (the server re-validates; this keeps garbage from even
 *  reaching the network). Returns a clean copy or null. */
function parseEventInput(raw: unknown): EventInput | null {
  if (!isObject(raw)) return null;
  if (
    !isString(raw.namespace) ||
    raw.namespace.length > MAX_EVENT_NAMESPACE_LENGTH ||
    !EVENT_NAMESPACE_RE.test(raw.namespace)
  ) {
    return null;
  }
  if (!isString(raw.type) || raw.type.length > MAX_EVENT_TYPE_LENGTH || !EVENT_TYPE_RE.test(raw.type)) {
    return null;
  }
  if (!isEventAudience(raw.audience)) return null;
  if (!('payload' in raw)) return null;
  try {
    const json = JSON.stringify(raw.payload);
    if (typeof json !== 'string') return null;
    if (json.length > MAX_EVENT_PAYLOAD_BYTES) return null;
  } catch {
    return null;
  }
  const out: EventInput = {
    namespace: raw.namespace,
    type: raw.type,
    audience: raw.audience,
    payload: raw.payload,
  };
  if (isString(raw.versionId)) out.versionId = raw.versionId;
  return out;
}

export function parseWindowEnvelope(raw: unknown): WindowEnvelope | null {
  if (!isObject(raw) || !isString(raw.type)) return null;
  switch (raw.type) {
    case 'companion_ready':
      return { type: 'companion_ready' };
    case 'companion_panic':
      if (!isString(raw.reason)) return null;
      return { type: 'companion_panic', reason: raw.reason };
    default:
      return null;
  }
}
