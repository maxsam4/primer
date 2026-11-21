import { t } from '../i18n/index.ts';
import { useEffect, useRef, useState } from 'react';
import type {
  Anchor,
  BridgeFeature,
  InboundProtocolMessage,
  OutboundProtocolMessage,
  Theme,
} from '../companion/protocol.ts';
import { parseInboundMessage, parseWindowEnvelope } from '../companion/protocol.ts';
import { createMessageBuffer } from '../companion/buffer.ts';
import { api } from '../lib/fetch.ts';
import { browserEventSourceFactory } from '../lib/eventsFeed.ts';
import { createRecordsHost, loadPageBinding, type RecordsHost } from '../live/recordsHost.ts';
import {
  computeFitScale,
  fitIframeStyle,
  hasResidualOverflow,
  nextFitState,
  type FitState,
} from '../lib/fitToWidth.ts';

interface Props {
  src: string;
  anchors: Anchor[];
  theme: Theme;
  onMessage: (msg: InboundProtocolMessage) => void;
  /** Imperative outbound channel. Parent stores a setter; child stores the sender. */
  registerSender?: (send: ((msg: OutboundProtocolMessage) => void) | null) => void;
  /** Scale content down (to at most 0.5×) when the artifact is intrinsically
   * wider than the container. Enabled by the document route on mobile. */
  fitToWidth?: boolean;
  /** A live page's text and Primer blocks (live/PageView.tsx): the bridge
   *  features it grants and the messages it handles. */
  page?: PageFrame;
  /** The iframe element, for positioning overlays over the page. */
  frameRef?: (el: HTMLIFrameElement | null) => void;
}

/** What a live page adds to its frame's bridge. */
export interface PageFrame {
  features: BridgeFeature[];
  /** Handles a page message; true when it was one (never forwarded). */
  handle(msg: InboundProtocolMessage): boolean;
  /** The port to the page once init went out; null when it closes. */
  attach(post: ((msg: OutboundProtocolMessage) => void) | null): void;
}

/** A record-reading page that keeps navigating itself is left revoked and
 *  blank after this many reloads instead of looping. */
const MAX_BREACH_RELOADS = 3;

// SECURITY-CRITICAL: The sandbox value below is the primary defense against
// hostile JS inside uploaded artifacts. Do NOT add `allow-same-origin`,
// `allow-popups`, or `allow-popups-to-escape-sandbox`. Adding any of these
// would re-open phishing / cookie-theft / fake-SSO vectors described in
// docs/prd-primer.md ("Iframe sandboxing"). If you find yourself needing
// to widen the sandbox further, stop and consult the threat model first.
//
// `allow-modals` enables `window.print()` (and alert/confirm/prompt) inside
// the iframe — required for in-artifact "Print / Save as PDF" buttons.
// `allow-downloads` enables `<a download>.click()` on blob URLs — required
// for in-artifact "Export to Excel/CSV" buttons that build a file in memory.
// Both tokens are scoped to the iframe's opaque origin: they do not grant
// access to parent cookies, storage, or DOM and do not open the
// fake-SSO-popup vector that the three forbidden tokens above would.
export function ArtifactIframe({ src, anchors, theme, onMessage, registerSender, fitToWidth, page, frameRef }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  // Bumped to reload a record-reading page from Primer after it navigated itself.
  const [reload, setReload] = useState(0);
  const breachesRef = useRef(0);
  // Set at the breach cap: the frame is unmounted, which also drops its listeners.
  const [blanked, setBlanked] = useState(false);
  const hostRef = useRef<RecordsHost | null>(null);
  // Loads seen before the page's binding arrived, replayed once it does.
  const pendingLoadsRef = useRef(0);
  useEffect(() => { breachesRef.current = 0; setBlanked(false); }, [src]);

  // Latest-value refs so deferred handlers see current props, not the values
  // closed over at mount.
  const anchorsRef = useRef(anchors);
  const themeRef = useRef(theme);
  const onMessageRef = useRef(onMessage);
  const registerSenderRef = useRef(registerSender);
  const pageRef = useRef(page);
  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => { anchorsRef.current = anchors; }, [anchors]);
  useEffect(() => { themeRef.current = theme; }, [theme]);
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);
  useEffect(() => { registerSenderRef.current = registerSender; }, [registerSender]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<FitState>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const fitToWidthRef = useRef(fitToWidth === true);
  useEffect(() => { fitToWidthRef.current = fitToWidth === true; }, [fitToWidth]);

  // New document/version → forget the previous artifact's width.
  useEffect(() => { setFit(null); }, [src]);

  // Track the wrapper's width so the scale follows rotation and layout
  // changes. Observing unconditionally keeps hook order stable and is cheap.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number') setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    // Per-mount state. Buffer drops messages older than 50 if the handshake
    // never completes; sendInit is idempotent so duplicate triggers are safe.
    const buffer = createMessageBuffer<OutboundProtocolMessage>(50);
    let initSent = false;
    let disposed = false;
    // No init (so no port) until the server says what this page may do.
    let host: RecordsHost | null = null;
    let wantInit = false;
    pendingLoadsRef.current = 0;
    void loadPageBinding(src, api).then((binding) => {
      if (disposed) return;
      host = createRecordsHost(binding, { fetchImpl: api, eventSourceFactory: browserEventSourceFactory });
      hostRef.current = host;
      const seen = pendingLoadsRef.current;
      pendingLoadsRef.current = 0;
      for (let i = 0; i < seen; i++) noteLoadRef.current();
      if (wantInit && !host.capability?.revoked) sendInit();
    });

    const sendInit = () => {
      wantInit = true;
      if (initSent || !host) return;
      if (!iframe.contentWindow) return;
      initSent = true;
      const pageHost = host;

      const channel = new MessageChannel();
      const port = channel.port1;
      portRef.current = port;

      port.onmessage = (event) => {
        const parsed = parseInboundMessage(event.data);
        if (!parsed) return;
        if (pageHost.handle(parsed)) return;
        if (pageRef.current?.handle(parsed)) return;
        // Record-reading pages never reach outside Primer.
        if (parsed.type === 'open_external' && !pageHost.allowsOutbound) return;
        if (parsed.type === 'content_metrics') {
          // Rendering concern owned by this component — not forwarded.
          if (fitToWidthRef.current) {
            setFit((cur) =>
              nextFitState(cur, parsed.contentWidth, wrapRef.current?.clientWidth ?? 0),
            );
          }
          return;
        }
        onMessageRef.current(parsed);
      };
      port.start();

      iframe.contentWindow.postMessage(
        {
          type: 'init',
          anchors: anchorsRef.current,
          theme: themeRef.current,
          features: [...pageHost.features, ...(pageRef.current?.features ?? [])],
        } satisfies OutboundProtocolMessage,
        '*',
        [channel.port2],
      );
      pageHost.attach((msg) => port.postMessage(msg));
      pageRef.current?.attach((msg) => port.postMessage(msg));

      // Wire the sender for the parent route. The cleanup function
      // deregisters this sender BEFORE closing the port, so callers can rely
      // on the port being live whenever this sender is reachable.
      registerSenderRef.current?.((msg) => port.postMessage(msg));
      buffer.drain((msg) => port.postMessage(msg));
    };

    const onWindowMessage = (event: MessageEvent) => {
      if (event.source !== iframe.contentWindow) return;
      const envelope = parseWindowEnvelope(event.data);
      if (!envelope) return;
      if (envelope.type === 'companion_ready') {
        sendInit();
      } else if (envelope.type === 'companion_panic') {
        // eslint-disable-next-line no-console
        console.error('[companion] panic:', envelope.reason);
      }
    };

    const onLoad = () => sendInit();

    window.addEventListener('message', onWindowMessage);
    iframe.addEventListener('load', onLoad);

    return () => {
      disposed = true;
      host?.dispose();
      hostRef.current = null;
      window.removeEventListener('message', onWindowMessage);
      iframe.removeEventListener('load', onLoad);
      // Deregister the sender BEFORE closing the port so any caller still
      // holding a reference to the sender cannot post to a dead port.
      registerSenderRef.current?.(null);
      pageRef.current?.attach(null);
      portRef.current?.close();
      portRef.current = null;
    };
  }, [src, reload, blanked]);

  // Every load of the frame, counted from its creation (React attaches this
  // before the first load can fire). A second load of a record-reading page
  // is the page navigating itself: access is revoked there and then, and the
  // page is reloaded from Primer with a fresh frame and capability.
  const onFrameLoad = () => noteLoadRef.current();
  const noteLoadRef = useRef(() => {});
  noteLoadRef.current = () => {
    const host = hostRef.current;
    if (!host) {
      pendingLoadsRef.current += 1;
      return;
    }
    if (host.onLoad() !== 'breach') return;
    portRef.current?.close();
    portRef.current = null;
    registerSenderRef.current?.(null);
    if (breachesRef.current >= MAX_BREACH_RELOADS) {
      setBlanked(true);
      return;
    }
    breachesRef.current += 1;
    setReload((n) => n + 1);
  };

  // Push theme changes to the companion. The init handshake already carries
  // the current theme; this effect propagates subsequent toggles. The first
  // run (initial mount) is harmless — the companion may not yet be ready.
  useEffect(() => {
    portRef.current?.postMessage({ type: 'theme_changed', theme } satisfies OutboundProtocolMessage);
  }, [theme]);

  const scale = fitToWidth ? computeFitScale(fit, containerWidth) : 1;
  const fitStyle = fitIframeStyle(scale, fit);
  const allowPanX = fitToWidth ? hasResidualOverflow(scale, fit, containerWidth) : false;

  return (
    <div
      ref={wrapRef}
      className="h-full w-full"
      style={{ overflowX: allowPanX ? 'auto' : 'hidden', overflowY: 'hidden' }}
    >
      {!blanked && (
        <iframe
          key={`${src}#${reload}`}
          ref={(el) => {
            iframeRef.current = el;
            frameRef?.(el);
          }}
          src={src}
          onLoad={onFrameLoad}
          sandbox="allow-scripts allow-forms allow-modals allow-downloads"
          title={t('artifactIframe.artifact')}
          style={{ border: 0, display: 'block', ...fitStyle }}
        />
      )}
    </div>
  );
}
