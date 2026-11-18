import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Navigate, Link, useParams, useNavigate, useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import type {
  InboundProtocolMessage,
  OutboundProtocolMessage,
  SerializableRect,
} from '../companion/protocol.ts';
import type {
  AnchorData,
  EventInput,
  EventRowDTO,
  TextRangeAnchor,
  ElementPathAnchor,
} from '@polygonlabs/primer-api-types';
import { useDocument, useDeleteDocument, useEditDocument } from '../queries/documents.ts';
import { useMe } from '../queries/me.ts';
import { useVersionsQuery } from '../queries/versions.ts';
import { useThreadsQuery } from '../queries/threads.ts';
import { useCreateThread } from '../queries/mutations.ts';
import { ArtifactIframe } from '../components/ArtifactIframe.tsx';
import { CommentSidebar } from '../components/CommentSidebar.tsx';
import { EditableField } from '../components/EditableField.tsx';
import { HeaderActions, type ActionFeedback } from '../components/HeaderActions.tsx';
import { PrivateLockIcon } from '../components/PrivateLockIcon.tsx';
import { AddVersionModal } from '../components/AddVersionModal.tsx';
import { ShareModal } from '../components/ShareModal.tsx';
import { NotebookLmModal } from '../components/NotebookLmModal.tsx';
import { handleOpenExternal, isSafeExternalUrl } from '../companion/client.ts';
import { useDocumentTitle } from '../lib/useDocumentTitle.ts';
import {
  composerPendingFrom,
  nextLatch,
  resolveViewedVersion,
  type VersionLatch,
} from '../lib/viewedVersion.ts';
import { useTheme } from '../lib/useTheme.ts';
import {
  commentsFilename,
  formatThreadsAsMarkdown,
  htmlFilename,
  markdownFilename,
} from '../lib/exportComments.ts';
import { buildNotebookLmSource, countLiveComments } from '../lib/notebookLm.ts';
import { internalDocUrl } from '../lib/internalDocUrl.ts';
import { hasAnyComments, hasLiveComments } from '../lib/liveComments.ts';
import { BottomSheet, type SnapPoint } from '../components/BottomSheet.tsx';
import { useMediaQuery } from '../lib/useMediaQuery.ts';
import { copyDeferredText, copyText, type CopyResult } from '../lib/clipboardCopy.ts';
import { canEditDoc, canSubmitEventsDoc } from '../lib/docCapabilities.ts';
import { extractCanonicalDocId } from '../lib/docIdParam.ts';
import {
  computePillPosition,
  type PillPosition,
} from '../lib/computePillPosition.ts';
import { useLibraryQuery } from '../queries/library.ts';
import { useSendEvents } from '../queries/events.ts';
import { browserEventSourceFactory, createEventsFeed } from '../lib/eventsFeed.ts';
import {
  createGrantStore,
  decideSubmission,
  summarizeEnvelope,
  type GrantEnvelope,
  type GrantScope,
} from '../lib/eventsGrant.ts';
import { EventsGrantPrompt } from '../components/EventsGrantPrompt.tsx';
import { api } from '../lib/fetch.ts';

// First-submission grants (issue #78, security requirement 6): per
// (viewer, document, artifact content version), fronted by an in-memory map
// so a blocked localStorage degrades to per-page-load grants (more
// prompting, never less). Module-scoped so grants survive route remounts.
const eventsGrantStore = createGrantStore(
  typeof window !== 'undefined' ? window.localStorage : null,
);

interface PendingGrant {
  /** The held submission — forwarded verbatim on Allow, never anything else. */
  events: EventInput[];
  envelope: GrantEnvelope;
  /** Captured at hold time so an Allow can never bind the grant to a
   *  version the viewer navigated to while the prompt was open. */
  scope: GrantScope;
}
import { DocDetailFolderControl } from '../components/DocDetailFolderControl.tsx';
import { relativeTime } from '../lib/relativeTime.ts';

interface PendingSelection {
  anchor: TextRangeAnchor;
  clientRects: SerializableRect[];
}

interface PendingPick {
  anchor: ElementPathAnchor;
  clientRect: SerializableRect;
}

/** Everything the NotebookLM modal needs, captured when it opens so the
 *  source stays pinned to the version and comments the user clicked on. */
interface NotebookLmSession {
  html: Promise<string>;
  initialCopy: Promise<CopyResult>;
  commentCount: number;
  buildSource: (html: string, includeComments: boolean) => string;
  filename: string;
}

export function DocumentPage() {
  const { docId: rawDocId, versionNumber: versionNumberParam } = useParams();
  const canonicalDocId = rawDocId ? extractCanonicalDocId(rawDocId) : null;
  if (canonicalDocId && canonicalDocId !== rawDocId) {
    const target = versionNumberParam
      ? `/d/${canonicalDocId}/v/${versionNumberParam}`
      : `/d/${canonicalDocId}`;
    return <Navigate to={target} replace />;
  }
  return <DocumentPageInner />;
}

function DocumentPageInner() {
  const { docId, versionNumber: versionNumberParam } = useParams();
  const navigate = useNavigate();
  const docQuery = useDocument(docId ?? '');
  const versionsQuery = useVersionsQuery(docId ?? '');
  const queryClient = useQueryClient();
  const versions = versionsQuery.data?.versions ?? [];

  useDocumentTitle(docQuery.data?.document.title);

  const requestedNumber = versionNumberParam ? Number(versionNumberParam) : undefined;
  const latestNumber = versions[0]?.versionNumber;

  // The version we're viewing — and the one new threads/replies post to.
  // On /d/:docId this is latched to the latest as of this navigation, so a
  // version-list refresh never swaps it; see lib/viewedVersion.ts. The latch
  // is "state derived from the previous render", updated during render.
  const location = useLocation();
  const [latch, setLatch] = useState<VersionLatch | null>(null);
  const latchNow = nextLatch({ prev: latch, locationKey: location.key, requestedNumber, versions });
  if (latchNow !== latch) setLatch(latchNow);
  const currentVersion = resolveViewedVersion({ versions, requestedNumber, latch: latchNow });
  const currentVersionId = currentVersion?.id ?? '';
  const currentVersionNumber = currentVersion?.versionNumber ?? 1;
  const isViewingLatest =
    currentVersion === undefined ||
    latestNumber === undefined ||
    currentVersion.versionNumber === latestNumber;
  const readMostly = !isViewingLatest;
  // True when this navigation started on the latest version and a newer one
  // was published since (vs. deliberately opening an older /v/:n).
  const newerPublishedWhileOpen = requestedNumber === undefined && readMostly;

  // Handle "version not found" — requested a number that doesn't exist.
  const versionNotFound =
    requestedNumber !== undefined && versionsQuery.isSuccess && !currentVersion;

  const threadsQuery = useThreadsQuery(currentVersionId);
  const threads = threadsQuery.data?.data.threads ?? [];
  const createThread = useCreateThread(currentVersionId);

  const editDoc = useEditDocument(docId ?? '');
  const deleteDoc = useDeleteDocument(docId ?? '');

  const [showAddVersion, setShowAddVersion] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [notebookLm, setNotebookLm] = useState<NotebookLmSession | null>(null);

  const COLLAPSED_KEY = 'primer.sidebar.collapsed';
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(COLLAPSED_KEY, sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  const me = useMe();
  const libraryQ = useLibraryQuery();
  const libDoc = libraryQ.data?.documents.find((d) => d.id === docId);
  const currentFolder = libDoc?.folderId ? libraryQ.data?.folders.find((f) => f.id === libDoc.folderId) : null;
  const { effective: theme } = useTheme();
  const isMobile = useMediaQuery('(max-width: 767px)');
  const [sheetSnap, setSheetSnap] = useState<SnapPoint>('handle');
  const isUploader = !!me.data && me.data.id === docQuery.data?.document.uploaderId;
  const canEdit = canEditDoc(docQuery.data?.myRole);

  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const [positionsByAnchorId, setPositionsByAnchorId] = useState<
    Map<string, { y: number; drifted: boolean }>
  >(new Map());

  const senderRef = useRef<((m: OutboundProtocolMessage) => void) | null>(null);
  const iframeWrapperRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLDivElement | null>(null);
  const [pillPos, setPillPos] = useState<PillPosition | null>(null);
  // True iff the new-thread composer currently holds non-whitespace input.
  // Read by the iframe message handler to decide whether `selection_cleared`
  // should auto-dismiss a still-empty composer.
  const composerDirtyRef = useRef(false);

  // Tombstoned threads keep their anchor registered so the "Comment deleted"
  // card in the sidebar can still highlight the passage it referred to.
  // Threads whose text isn't on this version ("context changed") have no
  // anchor here.
  const anchorsForCompanion = useMemo(
    () =>
      threads
        .filter((t) => hasAnyComments(t) && !t.contextChanged)
        .map((t) => ({ id: t.id, data: t.anchor })),
    [threads]
  );

  const send = useCallback((msg: OutboundProtocolMessage) => {
    senderRef.current?.(msg);
  }, []);

  const onComposerDirtyChange = useCallback((dirty: boolean) => {
    composerDirtyRef.current = dirty;
  }, []);

  // Every artifact-audience event row relayed so far for this document.
  // A new iframe mount (version switch, remount) starts with fresh artifact
  // state, so registerSender re-plays the accumulated rows as its "initial
  // batch on load" — batch grouping carries no semantics, so one big batch
  // and the original dispatch sequence produce identical artifact state.
  const relayedEventsRef = useRef<EventRowDTO[]>([]);
  const sendEventsMutation = useSendEvents(docId ?? '');

  // First-submission grant prompt state. The ref is the authoritative
  // "prompt open" flag for the message handler — two submissions arriving
  // in the same render window must both see the hold, which React state
  // alone (stale in the closure until re-render) cannot guarantee.
  const [pendingGrant, setPendingGrant] = useState<PendingGrant | null>(null);
  const pendingGrantRef = useRef<PendingGrant | null>(null);

  const ackSubmitResult = useCallback(
    (result: { ok: boolean; rows?: EventRowDTO[]; error?: string }) => {
      senderRef.current?.({ type: 'submit_result', ...result });
    },
    [],
  );

  /** The actual authed POST + ack — runs only AFTER every consent layer
   *  (companion in-dispatch gate, protocol validation, first-submission
   *  grant) has passed. */
  const postSubmission = useCallback(
    (events: EventInput[]) => {
      sendEventsMutation
        .mutateAsync(events)
        .then((resp) => {
          ackSubmitResult({ ok: true, rows: resp.events });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'submit failed';
          ackSubmitResult({ ok: false, error: message });
        });
    },
    [sendEventsMutation, ackSubmitResult],
  );

  const registerSender = useCallback(
    (s: ((m: OutboundProtocolMessage) => void) | null) => {
      senderRef.current = s;
      if (s) {
        s({ type: 'update_anchors', anchors: anchorsForCompanion });
        s({ type: 'request_anchor_positions' });
        if (relayedEventsRef.current.length > 0) {
          s({ type: 'events', events: relayedEventsRef.current });
        }
      }
    },
    [anchorsForCompanion]
  );

  // Document-events read relay (issue #78): hydrate the visible list, hold
  // an SSE subscription, and forward `artifact`-audience rows verbatim into
  // the iframe in coalesced batches. Delivery mechanics (reconnect resume
  // via Last-Event-ID, overlap re-fetch on visibility regain) live in
  // createEventsFeed and are invisible to the artifact.
  useEffect(() => {
    if (!docId) return;
    relayedEventsRef.current = [];
    const feed = createEventsFeed({
      documentId: docId,
      onBatch: (rows) => {
        relayedEventsRef.current = relayedEventsRef.current.concat(rows);
        senderRef.current?.({ type: 'events', events: rows });
      },
      fetchImpl: (url) => api(url),
      eventSourceFactory: browserEventSourceFactory,
    });
    void feed.start();
    const onVisibility = () => {
      if (!window.document.hidden) void feed.refresh();
    };
    window.document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.document.removeEventListener('visibilitychange', onVisibility);
      feed.stop();
    };
  }, [docId]);

  useEffect(() => {
    setPositionsByAnchorId(new Map());
    setFocusedThreadId(null);
    // A version switch remounts the iframe; a submission held for the OLD
    // artifact instance can no longer be acked or meaningfully granted —
    // drop it (never carry a held submission across artifact versions).
    pendingGrantRef.current = null;
    setPendingGrant(null);
  }, [currentVersionId]);

  useEffect(() => {
    const s = senderRef.current;
    if (!s) return;
    s({ type: 'update_anchors', anchors: anchorsForCompanion });
    s({ type: 'request_anchor_positions' });
  }, [anchorsForCompanion]);

  const onMessage = useCallback(
    (msg: InboundProtocolMessage) => {
      switch (msg.type) {
        case 'selection_captured':
          if (!readMostly) {
            setPendingSelection({ anchor: msg.anchor, clientRects: msg.clientRects });
            setPendingPick(null);
          }
          break;
        case 'selection_cleared':
          if (!composerDirtyRef.current) {
            setPendingSelection(null);
          }
          break;
        case 'element_picked':
          if (!readMostly) {
            setPendingPick({ anchor: msg.anchor, clientRect: msg.clientRect });
            setPendingSelection(null);
            setPickMode(false);
          }
          break;
        case 'pick_mode_exited':
          setPickMode(false);
          break;
        case 'anchor_positions':
          setPositionsByAnchorId(
            new Map(
              msg.positions.map((p) => [
                p.anchorId,
                {
                  y: p.rects[0]?.y ?? Number.POSITIVE_INFINITY,
                  drifted: p.drifted ?? false,
                },
              ])
            )
          );
          break;
        case 'open_external':
          if (isSafeExternalUrl(msg.url)) handleOpenExternal(msg);
          break;
        // Consent-gated artifact submission (issue #78): the companion only
        // forwards this from within a trusted user-gesture dispatch, and the
        // protocol parser has already re-validated the batch. Before the
        // authed POST, the FIRST-SUBMISSION GRANT (security requirement 6)
        // must cover this submission's audience tier: the first submission
        // by this artifact version — or one escalating past the granted
        // tier — is HELD while Primer-owned chrome discloses the envelope
        // and asks the viewer; grant forwards the held submission, deny
        // answers with an error ack.
        case 'submit_events': {
          // Stamp write-time provenance (the version being viewed) on events
          // that didn't declare their own — the artifact has no version
          // awareness by design (a companion version hook is a v1 non-goal).
          const stamped = msg.events.map((e) =>
            e.versionId !== undefined || !currentVersionId
              ? e
              : { ...e, versionId: currentVersionId },
          );
          const scope: GrantScope = {
            userId: me.data?.id ?? '',
            documentId: docId ?? '',
            versionId: currentVersionId,
          };
          const decision = decideSubmission({
            events: stamped,
            granted: eventsGrantStore.load(scope),
            promptOpen: pendingGrantRef.current !== null,
            // Unknown until the document detail loads; then the server's
            // write bar (owner, editor, responder) decides up front.
            mayWrite: docQuery.data ? canSubmitEventsDoc(docQuery.data.myRole) : undefined,
          });
          if (decision === 'refuse_role') {
            // The viewer can see this page but their role does not let it
            // submit in their name: say so instead of prompting for consent
            // that would end in a bare "forbidden".
            ackSubmitResult({
              ok: false,
              error: "forbidden: You can view this document but can't respond to it.",
            });
          } else if (decision === 'refuse_pending') {
            // Exactly one submission may be held per prompt: nothing
            // queue-jumps or piggybacks on the viewer's grant click.
            ackSubmitResult({
              ok: false,
              error: 'grant_pending: a submission is already awaiting the viewer’s decision',
            });
          } else if (decision === 'prompt') {
            const held: PendingGrant = {
              events: stamped,
              envelope: summarizeEnvelope(stamped),
              scope,
            };
            pendingGrantRef.current = held;
            setPendingGrant(held);
          } else {
            postSubmission(stamped);
          }
          break;
        }
        case 'companion_log': {
          const fn = msg.level === 'error' ? console.error
                   : msg.level === 'warn'  ? console.warn
                   : console.log;
          // eslint-disable-next-line no-console
          fn('[companion]', msg.message);
          break;
        }
        case 'resize':
          senderRef.current?.({ type: 'request_anchor_positions' });
          break;
        case 'anchor_clicked':
          setFocusedThreadId(msg.anchorId);
          setSidebarCollapsed(false);
          setSheetSnap('peek');
          requestAnimationFrame(() => {
            window.document.getElementById(`thread-${msg.anchorId}`)?.scrollIntoView({
              behavior: 'smooth',
              block: 'center',
            });
          });
          break;
      }
    },
    [readMostly, currentVersionId, docId, me.data?.id, docQuery.data, ackSubmitResult, postSubmission]
  );

  function openFullScreen() {
    if (!currentVersionId) return;
    window.open(
      `/api/versions/${currentVersionId}/content`,
      '_blank',
      'noopener,noreferrer',
    );
  }

  async function downloadHtml(): Promise<ActionFeedback | null> {
    if (!docQuery.data || !currentVersionId) return null;
    try {
      const res = await fetch(`/api/versions/${currentVersionId}/content`, {
        credentials: 'same-origin',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = window.document.createElement('a');
      a.href = url;
      a.download = htmlFilename(
        { title: docQuery.data.document.title },
        { versionNumber: currentVersionNumber },
      );
      a.style.display = 'none';
      window.document.body.appendChild(a);
      a.click();
      window.document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return null;
    } catch {
      return { kind: 'error', message: 'Download failed. Try again.' };
    }
  }

  // Runs synchronously inside the menu click: the clipboard write has to
  // start during the gesture even though the text is still being fetched.
  function sendToNotebookLm() {
    if (!docQuery.data || !currentVersionId || !docId) return;
    const { title, description } = docQuery.data.document;
    const versionNumber = currentVersionNumber;
    const url = internalDocUrl(window.location.origin, docId, versionNumber);
    const threadsAtOpen = threads;
    const buildSource = (html: string, includeComments: boolean) =>
      buildNotebookLmSource({
        title,
        description,
        url,
        versionNumber,
        html,
        threads: includeComments ? threadsAtOpen : [],
      });
    const html = fetch(`/api/versions/${currentVersionId}/content`, {
      credentials: 'same-origin',
    }).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
    const initialCopy = copyDeferredText(html.then((h) => buildSource(h, true)));
    setNotebookLm({
      html,
      initialCopy,
      commentCount: countLiveComments(threadsAtOpen),
      buildSource,
      filename: markdownFilename({ title }, { versionNumber }),
    });
  }

  function exportComments() {
    if (!docQuery.data) return;
    const md = formatThreadsAsMarkdown(
      { title: docQuery.data.document.title },
      { versionNumber: currentVersionNumber },
      threads,
    );
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = commentsFilename(
      { title: docQuery.data.document.title },
      { versionNumber: currentVersionNumber },
    );
    a.style.display = 'none';
    window.document.body.appendChild(a);
    a.click();
    window.document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function copyComments(): Promise<ActionFeedback> {
    if (!docQuery.data) return { kind: 'error', message: 'Comments not loaded yet.' };
    const md = formatThreadsAsMarkdown(
      { title: docQuery.data.document.title },
      { versionNumber: currentVersionNumber },
      threads,
    );
    const result = await copyText(md);
    return result === 'failed'
      ? { kind: 'error', message: 'Copy failed. Try Download instead.' }
      : { kind: 'success', message: 'Copied' };
  }

  const togglePickMode = () => {
    if (pickMode) {
      send({ type: 'exit_pick_mode' });
      setPickMode(false);
    } else {
      send({ type: 'enter_pick_mode' });
      setPickMode(true);
    }
  };

  // Sticky-focus state — null = no thread focused. Sidebar threads can set it
  // (click or composer mount). Companion paints the focused anchor and keeps
  // it painted until we send a new value.
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);

  // Push focus changes to the companion. Re-pushes on version change too so
  // the new iframe picks up the existing focus on mount.
  useEffect(() => {
    senderRef.current?.({ type: 'set_focused_anchor', anchorId: focusedThreadId });
  }, [focusedThreadId, currentVersionId]);

  const onHighlight = useCallback((anchorId: string) => {
    setFocusedThreadId(anchorId);
  }, []);

  useEffect(() => {
    const hash = window.location.hash;
    const match = hash.match(/^#thread-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
    if (!match) return;
    const threadId = match[1];
    if (!threadsQuery.isSuccess) return;
    const found = threads.find((t) => t.id === threadId);
    if (!found) return;

    setSidebarCollapsed(false);

    // Defer to next frame so the sidebar transition starts + the DOM is ready.
    requestAnimationFrame(() => {
      window.document.getElementById(`thread-${threadId}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      });
      onHighlight(threadId);
    });

    // Clear the hash so a manual refresh doesn't re-fire.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }, [threadsQuery.isSuccess, threads, onHighlight]);

  const submitPending = async (body: string, mentions: string[]) => {
    const anchor: AnchorData | null = pendingSelection
      ? pendingSelection.anchor
      : pendingPick
      ? pendingPick.anchor
      : null;
    if (!anchor) return;
    await createThread.mutateAsync({ anchor, body, mentions });
    setPendingSelection(null);
    setPendingPick(null);
  };

  // "Switch to latest" — from the composer after a not_latest_version 409,
  // and from the newer-version notice. The pending anchor belongs to the
  // version being left, so it (and any draft) can't carry over.
  const switchToLatest = async () => {
    setPendingSelection(null);
    setPendingPick(null);
    // Refresh the list first: /d/:docId latches whatever "latest" is when it
    // renders, so navigating on a stale list would land on the same version
    // and the button would do nothing.
    await queryClient.refetchQueries({ queryKey: ['versions', docId], exact: true });
    navigate(`/d/${docId}`);
  };

  const composerPending = useMemo(
    () => composerPendingFrom<AnchorData>({ pendingSelection, pendingPick }),
    [pendingSelection, pendingPick],
  );

  // The composer is no longer hidden when the viewed version stops being
  // latest (composerPendingFrom), so drop a pending anchor when the user
  // navigates to a different version — it belongs to the one being left.
  useEffect(() => {
    setPendingSelection(null);
    setPendingPick(null);
  }, [currentVersionId]);

  // Mobile sheet automation. No-op on desktop because the sheet isn't rendered.
  // Placed after composerPending so it can appear in the dependency array.
  useEffect(() => {
    if (!isMobile) return;
    if (pickMode) {
      setSheetSnap('handle');
    } else if (composerPending) {
      setSheetSnap('expanded');
    }
  }, [isMobile, pickMode, composerPending]);

  // Position the "Add comment in sidebar →" pill relative to the
  // selection. Recomputed whenever the selection's clientRects change
  // (mouseup + scroll-driven refreshes from the companion) or the host
  // window resizes. Two-pass measurement: first render uses a
  // conservative fallback size, then re-measures via pillRef.
  useLayoutEffect(() => {
    if (
      readMostly ||
      isMobile ||
      !pendingSelection ||
      pendingSelection.clientRects.length === 0
    ) {
      setPillPos(null);
      return;
    }
    const compute = () => {
      const iframe = iframeWrapperRef.current?.querySelector('iframe');
      if (!iframe) return;
      const pill = pillRef.current;
      const pillSize = pill
        ? { width: pill.offsetWidth, height: pill.offsetHeight }
        : { width: 220, height: 32 };
      const next = computePillPosition({
        rects: pendingSelection.clientRects,
        iframeRect: iframe.getBoundingClientRect(),
        pillSize,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      setPillPos(next);
    };
    compute();
    window.addEventListener('resize', compute, { passive: true });
    return () => window.removeEventListener('resize', compute);
  }, [readMostly, isMobile, pendingSelection]);

  if (docQuery.isLoading) return <div className="text-neutral-500">Loading…</div>;
  if (docQuery.error) {
    return (
      <div className="text-red-600 dark:text-red-400">
        Could not load document: {(docQuery.error as Error).message}
      </div>
    );
  }
  if (!docQuery.data) return null;

  if (versionNotFound) {
    return (
      <div className="space-y-3">
        <h1 className="text-xl font-semibold">Version not found</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Version {requestedNumber} doesn't exist for this document.
        </p>
        <button
          type="button"
          onClick={() => navigate(`/d/${docId}`)}
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          Back to latest
        </button>
      </div>
    );
  }

  const { document } = docQuery.data;

  const headerActionsProps = {
    docId: docId!,
    versions,
    currentVersionNumber,
    isViewingLatest,
    onAddVersion: canEdit && !readMostly ? () => setShowAddVersion(true) : undefined,
    isUploader,
    onShare: () => setShowShare(true),
    onOpenFullScreen: openFullScreen,
    onDownloadHtml: downloadHtml,
    onSendToNotebookLm: sendToNotebookLm,
    onCopyComments: copyComments,
    onExportComments: exportComments,
    onDelete: async () => {
      await deleteDoc.mutateAsync();
      navigate('/');
    },
  };

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <header className="border-b border-neutral-200 px-3 pb-2 pt-1 dark:border-neutral-800 sm:px-4 md:flex md:items-baseline md:justify-between md:gap-3">
        {/* Mobile top row: breadcrumb (or spacer) + compact actions. */}
        <div className="mb-0.5 flex items-center justify-between gap-2 md:hidden">
          {currentFolder ? (
            <Link
              to={`/?folder=${encodeURIComponent(currentFolder.id)}`}
              className="inline-flex min-w-0 items-center gap-1 text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
            >
              <span aria-hidden="true">←</span>
              <span className="truncate">{currentFolder.name}</span>
            </Link>
          ) : (
            <span aria-hidden="true" />
          )}
          <HeaderActions variant="mobile" {...headerActionsProps} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          {currentFolder && (
            <Link
              to={`/?folder=${encodeURIComponent(currentFolder.id)}`}
              className="mb-1 hidden items-center gap-1 text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 md:inline-flex"
            >
              ← {currentFolder.name}
            </Link>
          )}
          <div className="flex min-w-0 items-center gap-2">
            {document.visibility === 'private' && (
              <PrivateLockIcon className="h-4 w-4 shrink-0 text-purple-600 dark:text-purple-400" />
            )}
            <EditableField
              value={document.title}
              placeholder="Add a title"
              canEdit={canEdit}
              displayClassName="text-lg md:text-xl font-semibold line-clamp-2 md:line-clamp-none"
              maxLength={200}
              ariaLabel="Document title"
              onSave={async (next) => {
                if (next === null || next.trim().length === 0) {
                  throw new Error('Title cannot be empty');
                }
                await editDoc.mutateAsync({ title: next });
              }}
            />
            {docQuery.data?.document.externallyShared && (
              <span
                title="This document has an active external share"
                className="ml-2 inline-flex items-center rounded-full bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300 px-2 py-0.5 text-[11px] font-medium align-middle"
              >
                Shared externally
              </span>
            )}
          </div>
          <EditableField
            value={document.description}
            placeholder="Add a description"
            canEdit={canEdit}
            multiline
            displayClassName="max-w-[60ch] break-words text-sm text-neutral-600 dark:text-neutral-400 line-clamp-2 md:line-clamp-none"
            maxLength={2000}
            ariaLabel="Document description"
            onSave={async (next) => {
              await editDoc.mutateAsync({ description: next });
            }}
          />
        </div>
        <div className="hidden shrink-0 items-center gap-3 md:flex">
          <div className="flex items-center gap-1.5">
            {libDoc && (
              <DocDetailFolderControl
                docId={libDoc.id}
                currentFolderId={libDoc.folderId}
                currentFolderName={currentFolder?.name ?? null}
                folders={libraryQ.data?.folders ?? []}
              />
            )}
            <HeaderActions variant="desktop" {...headerActionsProps} />
          </div>
          {!readMostly && (
            <button
              type="button"
              onClick={togglePickMode}
              className={`hidden h-7 items-center rounded px-3 text-xs font-medium md:inline-flex ${
                pickMode
                  ? 'bg-red-600 text-white hover:bg-red-700'
                  : 'bg-neutral-900 text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200'
              }`}
            >
              {pickMode ? 'Cancel' : '+ Add Comment'}
            </button>
          )}
          <div className="hidden items-center gap-3 md:flex">
            <div className="h-4 w-px bg-neutral-200 dark:bg-neutral-800" aria-hidden="true" />
            <div className="flex h-7 flex-col justify-center text-right leading-tight">
              <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">
                {document.uploaderDisplayName}
              </span>
              <span
                className="text-[10px] text-neutral-500"
                title={new Date(document.createdAt).toLocaleString()}
              >
                {relativeTime(document.createdAt)}
              </span>
            </div>
          </div>
        </div>
      </header>

      {readMostly && (
        <div className="flex items-center justify-between border-b border-yellow-200 bg-yellow-50 px-4 py-1.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
          <span>
            {newerPublishedWhileOpen ? (
              <>
                A newer version (v{latestNumber}) of "{document.title}" was published. You're
                still viewing v{currentVersionNumber}; switch to the latest to add new comments.
              </>
            ) : (
              <>
                You're viewing v{currentVersionNumber} of "{document.title}". This version is
                read-only. Switch to v{latestNumber} (latest) to add new comments.
              </>
            )}
          </span>
          <button
            type="button"
            onClick={() => void switchToLatest()}
            className="rounded border border-amber-700 px-2 py-0.5 text-amber-900 hover:bg-amber-100 dark:border-amber-600 dark:text-amber-200 dark:hover:bg-amber-900/30"
          >
            Switch to latest
          </button>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        <div ref={iframeWrapperRef} className="flex-1 overflow-hidden">
          {/* Mount only once the version id has resolved: an empty id would
              build src="/api/versions//content" and 404 on first render
              while the versions query is still in flight. */}
          {currentVersionId && (
            <ArtifactIframe
              src={`/api/versions/${currentVersionId}/content`}
              anchors={anchorsForCompanion}
              theme={theme}
              fitToWidth={isMobile}
              onMessage={onMessage}
              registerSender={registerSender}
            />
          )}
        </div>
        {!isMobile && (
          <CommentSidebar
            versionId={currentVersionId}
            currentUserId={me.data?.id ?? ''}
            pending={composerPending}
            onCancelPending={() => {
              setPendingSelection(null);
              setPendingPick(null);
            }}
            onSubmitPending={submitPending}
            onComposerDirtyChange={onComposerDirtyChange}
            onHighlight={onHighlight}
            positionsByAnchorId={positionsByAnchorId}
            collapsed={sidebarCollapsed}
            onCollapsedChange={setSidebarCollapsed}
            focusedThreadId={focusedThreadId}
            onGoToLatest={() => void switchToLatest()}
          />
        )}
      </div>

      {isMobile && (
        <BottomSheet
          snap={sheetSnap}
          onSnapChange={(next) => {
            if (pickMode && next !== 'handle') {
              // User tried to expand the sheet while picking — interpret as cancel.
              send({ type: 'exit_pick_mode' });
              setPickMode(false);
              setSheetSnap('handle');
              return;
            }
            setSheetSnap(next);
          }}
          dragLocked={composerPending !== null}
          showBackdrop
          handleLabel={
            pickMode
              ? 'Picking element… (tap to cancel)'
              : `💬 ${threads.filter(hasLiveComments).length} comments`
          }
        >
          <CommentSidebar
            versionId={currentVersionId}
            currentUserId={me.data?.id ?? ''}
            pending={composerPending}
            onCancelPending={() => {
              setPendingSelection(null);
              setPendingPick(null);
            }}
            onSubmitPending={submitPending}
            onComposerDirtyChange={onComposerDirtyChange}
            onHighlight={onHighlight}
            positionsByAnchorId={positionsByAnchorId}
            focusedThreadId={focusedThreadId}
            onAddCommentClick={readMostly ? undefined : togglePickMode}
            addCommentActive={readMostly ? false : pickMode}
            onGoToLatest={() => void switchToLatest()}
          />
        </BottomSheet>
      )}

      {!isMobile && pendingSelection && composerPending && (
        <div
          ref={pillRef}
          style={{
            position: 'fixed',
            left: pillPos?.left ?? 0,
            top: pillPos?.top ?? 0,
            zIndex: 1000,
            visibility:
              pillPos && !pillPos.hidden ? 'visible' : 'hidden',
          }}
          className="flex items-center gap-2 rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white shadow-lg"
        >
          <span>Add comment in sidebar →</span>
          <button
            type="button"
            onClick={() => setPendingSelection(null)}
            className="rounded border border-neutral-700 px-1 text-neutral-300 hover:bg-neutral-800"
          >
            ×
          </button>
        </div>
      )}
      {pendingGrant && (
        <EventsGrantPrompt
          envelope={pendingGrant.envelope}
          documentTitle={document.title}
          onAllow={() => {
            const held = pendingGrantRef.current;
            pendingGrantRef.current = null;
            setPendingGrant(null);
            if (!held) return;
            // Record the DISCLOSED tier, then forward exactly the held
            // submission — never anything that arrived since.
            eventsGrantStore.save(held.scope, held.envelope.required);
            postSubmission(held.events);
          }}
          onDeny={() => {
            pendingGrantRef.current = null;
            setPendingGrant(null);
            ackSubmitResult({
              ok: false,
              error: 'grant_denied: the viewer declined to let this artifact submit events as them',
            });
          }}
        />
      )}
      <AddVersionModal
        open={showAddVersion}
        preselectedDocId={docId}
        preselectedDocTitle={document.title}
        onClose={() => setShowAddVersion(false)}
      />
      {showShare && docId && (
        <ShareModal
          open
          docId={docId}
          versionNumber={requestedNumber}
          onClose={() => setShowShare(false)}
        />
      )}
      {notebookLm && <NotebookLmModal {...notebookLm} onClose={() => setNotebookLm(null)} />}
    </div>
  );
}
