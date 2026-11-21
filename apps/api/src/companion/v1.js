// Primer companion script v1.
// Loaded by the upload pipeline into every artifact iframe.
// Lives in the iframe (sandbox: allow-scripts allow-forms allow-modals allow-downloads, opaque-origin "null").
// Talks to the parent ONLY via a MessageChannel port transferred at init.
(() => {
  /** @type {MessagePort | null} */
  let port = null;

  /** @type {{ id: string, data: any }[]} */
  let knownAnchors = [];

  /** Bridge features the host granted at init (see protocol.ts BridgeFeature).
   *  null until init. @type {string[] | null} */
  let features = null;

  /** @type {Set<string>} */
  const driftedIds = new Set();

  /** @type {{ level: 'info' | 'warn' | 'error', message: string }[]} */
  const logBuffer = [];
  const LOG_BUFFER_CAP = 100;

  function log(level, ...args) {
    const message = args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ');
    // Local iframe console always — useful when inspecting the iframe directly.
    // eslint-disable-next-line no-console
    console.log('[primer/companion][' + level + ']', ...args);
    if (port) {
      try {
        port.postMessage({ type: 'companion_log', level, message });
      } catch (e) {
        // port closed mid-send; nothing to do
      }
    } else {
      logBuffer.push({ level, message });
      if (logBuffer.length > LOG_BUFFER_CAP) logBuffer.shift();
    }
  }
  log.info = (...args) => log('info', ...args);
  log.warn = (...args) => log('warn', ...args);
  log.error = (...args) => log('error', ...args);

  function safeStringify(v) {
    if (v === undefined) return 'undefined';
    try {
      const s = JSON.stringify(v);
      return s ?? String(v);
    } catch {
      return String(v);
    }
  }

  // ── Mobile viewport ──────────────────────────────────────────────
  // Many artifacts ship without a responsive viewport <meta>, so mobile
  // browsers lay them out at the default ~980px viewport inside the iframe —
  // producing horizontal scroll while reading. The upload pipeline injects a
  // viewport for new uploads; this runtime guard covers the backlog uploaded
  // before that change. We only add one when the author didn't declare a
  // viewport, so intentional viewport choices are preserved.
  function ensureViewportMeta() {
    try {
      if (document.querySelector('meta[name="viewport" i]')) return;
      const meta = document.createElement('meta');
      meta.setAttribute('name', 'viewport');
      meta.setAttribute('content', 'width=device-width, initial-scale=1');
      (document.head || document.documentElement).appendChild(meta);
    } catch (e) {
      // Non-fatal: a missing viewport only degrades mobile layout.
    }
  }
  ensureViewportMeta();

  // ── Mermaid detection ────────────────────────────────────────────
  // Mirrored in mermaidScanner.test.ts; keep in sync.
  // Pinned bundle version is duplicated here as a string literal because the
  // companion is plain JS and can't import mermaidVersion.ts. See
  // apps/api/src/companion/mermaidVersion.ts.
  const MERMAID_BUNDLE_VERSION = '12.3.0';
  const MERMAID_BUNDLE_URL = '/companion/mermaid-v' + MERMAID_BUNDLE_VERSION + '.js';

  /** @returns {HTMLElement[]} block roots (always <pre>). */
  function findMermaidBlocks() {
    const matches = document.querySelectorAll(
      'pre > code.language-mermaid, pre.mermaid'
    );
    /** @type {HTMLElement[]} */
    const out = [];
    matches.forEach((el) => {
      const root = el.tagName === 'PRE' ? el : el.parentElement;
      if (!root || root.tagName !== 'PRE') return;
      if (root.querySelector(':scope > svg, :scope > div > svg')) return;
      if (out.indexOf(root) === -1) out.push(root);
    });
    return out;
  }

  /** @returns {boolean} */
  function documentHasMermaidBootstrap() {
    if (typeof window.mermaid !== 'undefined') return true;
    const scripts = document.querySelectorAll('script');
    for (const s of scripts) {
      const src = s.getAttribute('src') || '';
      if (src && /mermaid/i.test(src)) return true;
      const text = s.textContent || '';
      if (text.indexOf('mermaid.initialize') !== -1) return true;
      if (text.indexOf('mermaid.run') !== -1) return true;
    }
    return false;
  }

  // ── Mermaid rendering ────────────────────────────────────────────
  // Loaded lazily — only when at least one matched block is present
  // AND the document doesn't already bootstrap Mermaid itself.

  /** Module-local id counter for mermaid.render. */
  let mermaidRenderCounter = 0;

  /** Cached mermaid module after first dynamic import, or null. */
  let mermaidModule = null;

  /** In-flight import promise so concurrent callers share one fetch. */
  let mermaidLoadPromise = null;

  /** @returns {'dark' | 'default'} */
  function pickMermaidTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default';
  }

  /** Inject a classical <script src> and resolve when load fires. */
  function injectClassicalScript(url) {
    return new Promise(function (resolve, reject) {
      const el = document.createElement('script');
      el.src = url;
      // No async/defer needed — we append at runtime and wait on the events.
      el.addEventListener('load', () => resolve());
      el.addEventListener('error', () => reject(new Error('script load failed: ' + url)));
      document.head.appendChild(el);
    });
  }

  async function loadMermaidOnce() {
    if (mermaidModule !== null) return mermaidModule;
    if (mermaidLoadPromise) return mermaidLoadPromise;
    mermaidLoadPromise = (async () => {
      try {
        // The vendored bundle ends with
        //   globalThis.mermaid = globalThis.__esbuild_esm_mermaid.default;
        // This only works when the bundle is loaded as a CLASSICAL script —
        // its top-level `var __esbuild_esm_mermaid = ...` must alias to
        // globalThis, which happens only at classical-script top level (not
        // under dynamic import(), where top-level var is module-local). So
        // we inject a <script src> tag rather than using import().
        await injectClassicalScript(MERMAID_BUNDLE_URL);
      } catch (e) {
        log.warn('mermaid bundle load failed:', e && e.message ? e.message : e);
        mermaidLoadPromise = null;
        throw e;
      }
      if (typeof window.mermaid === 'undefined') {
        mermaidLoadPromise = null;
        throw new Error('mermaid global missing after bundle load');
      }
      mermaidModule = window.mermaid;
      mermaidModule.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: pickMermaidTheme(),
        fontFamily: 'inherit',
      });
      return mermaidModule;
    })();
    return mermaidLoadPromise;
  }

  /**
   * Replace `wrapper`'s children with the SVG string returned by
   * `mermaid.render()`. The `wrapper.innerHTML = svgString` assignment
   * triggers CodeQL's js/xss-through-dom rule (Alert #4 on PR #19), which
   * is dismissed with this rationale:
   *
   *   1. mermaid.initialize({ securityLevel: 'strict' }) — Mermaid invokes
   *      DOMPurify INTERNALLY on every user-controlled label before
   *      emitting SVG. Strings reaching this assignment have already been
   *      sanitized by the same library CodeQL would recommend.
   *   2. ArtifactIframe runs with sandbox="allow-scripts allow-forms
   *      allow-modals allow-downloads" (no allow-same-origin) — opaque
   *      origin, no access to Primer cookies,
   *      auth, parent DOM, or storage. Any script that did execute inside
   *      the iframe would be defanged.
   *   3. The artifact CSP at apps/api/src/routes/versionContent.ts sets
   *      connect-src 'none' — no network exfil from inside the iframe
   *      even if an XSS payload survived (1) and (2).
   *
   * A defense-in-depth pass via DOMPurify at this layer was attempted
   * (PR #19 commits 27dc7ac and 47d5545) but DOMPurify cannot preserve
   * the HTML content inside Mermaid's `<foreignObject>` text labels in
   * any tested config (svg-only, svg+html, ADD_TAGS, XHTML parser,
   * image/svg+xml parser) — the namespace transition is a known
   * limitation. The result was diagrams with no text. Both attempts
   * were reverted.
   */
  function safelySetSvgContent(wrapper, svgString) {
    while (wrapper.firstChild) wrapper.removeChild(wrapper.firstChild);
    wrapper.innerHTML = svgString;
  }

  /** Renders one <pre> block in place. Never throws — failures are inline. */
  async function renderOneMermaidBlock(preEl, mermaid) {
    const source = preEl.textContent || '';
    const id = 'primer-mermaid-' + (++mermaidRenderCounter);
    try {
      const result = await mermaid.render(id, source);
      const wrapper = document.createElement('div');
      wrapper.className = 'primer-mermaid';
      wrapper.setAttribute('data-mermaid-source', source);
      safelySetSvgContent(wrapper, result.svg);
      // Replace ALL children of <pre> with the wrapper.
      while (preEl.firstChild) preEl.removeChild(preEl.firstChild);
      preEl.appendChild(wrapper);
    } catch (e) {
      const msg = e && e.message ? e.message : 'render failed';
      // Leave the original block content intact; append a small error note.
      const note = document.createElement('div');
      note.className = 'primer-mermaid-error';
      note.textContent = 'Mermaid render failed: ' + msg;
      preEl.appendChild(note);
      log.warn('mermaid render failed for block', id, ':', msg);
    }
  }

  async function renderAllMermaidBlocks() {
    const blocks = findMermaidBlocks();
    if (blocks.length === 0) return;
    if (documentHasMermaidBootstrap()) {
      log.info('mermaid bootstrap detected in document, skipping');
      return;
    }
    let mermaid;
    try {
      mermaid = await loadMermaidOnce();
    } catch (_e) {
      // already logged in loadMermaidOnce
      return;
    }
    for (const pre of blocks) {
      await renderOneMermaidBlock(pre, mermaid);
    }
  }

  /** Re-render every already-rendered block using the current theme. */
  async function reRenderMermaidForTheme() {
    if (mermaidModule === null) return;
    const wrappers = document.querySelectorAll('[data-mermaid-source]');
    if (wrappers.length === 0) return;
    mermaidModule.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: pickMermaidTheme(),
      fontFamily: 'inherit',
    });
    for (const wrapper of wrappers) {
      const source = wrapper.getAttribute('data-mermaid-source') || '';
      const id = 'primer-mermaid-' + (++mermaidRenderCounter);
      try {
        const result = await mermaidModule.render(id, source);
        safelySetSvgContent(wrapper, result.svg);
      } catch (e) {
        // On theme-rerender failure, leave the prior SVG in place — silent.
        log.warn('mermaid re-render failed:', e && e.message ? e.message : e);
      }
    }
  }

  /** True when running in a UA without a hover-capable pointer (phones/tablets). */
  function isTouchUA() {
    try {
      return matchMedia('(hover: none) and (pointer: coarse)').matches;
    } catch (_) {
      return false;
    }
  }

  // WebKit (Safari + all iOS browsers) silently no-ops `behavior: 'smooth'`
  // in scrollTo/scrollIntoView inside cross-origin sandboxed iframes, which is
  // exactly the companion's context — the call returns with no error and no
  // scroll, so clicking a comment never reveals its anchor. Fall back to
  // instant scroll on WebKit. Chromium identifies as AppleWebKit via the
  // legacy UA token, so exclude it explicitly.
  const SCROLL_BEHAVIOR = (() => {
    try {
      const ua = navigator.userAgent || '';
      return /AppleWebKit\//.test(ua) && !/(Chrome|Chromium|Edg)\//.test(ua) ? 'auto' : 'smooth';
    } catch (_) {
      return 'smooth';
    }
  })();

  function flushLogBuffer() {
    if (!port) return;
    while (logBuffer.length > 0) {
      const entry = logBuffer.shift();
      try {
        port.postMessage({
          type: 'companion_log',
          level: entry.level,
          message: entry.message,
        });
      } catch (e) {
        break; // port died mid-flush
      }
    }
  }

  // The message shapes posted from here on (companion_ready, companion_panic,
  // and everything sent over the MessageChannel port below) are the iframe
  // half of the companion protocol. The parent-side half — parsing, guards,
  // and the TypeScript types for these same shapes — lives in
  // apps/web/src/companion/protocol.ts. Kept in sync by hand; this is the
  // standalone plain-JS half, loaded directly into the sandboxed iframe.

  // ── 1. Init handshake ────────────────────────────────────────────
  // Symmetric handshake: the companion announces readiness immediately and
  // retries every 500ms until the parent posts `init` (with a transferable
  // MessagePort). This decouples init from the parent's iframe load-event
  // attachment timing — historically a race on cached page loads.
  // If retries exhaust without receiving init, post a companion_panic so
  // the parent at least surfaces a visible failure mode.

  const READY_RETRY_MS = 500;
  const READY_MAX_TRIES = 10;
  let readyTimer = null;
  let readyTries = 0;

  function postReady() {
    try {
      window.parent.postMessage({ type: 'companion_ready' }, '*');
    } catch (e) {
      // window.parent inaccessible (top-level page); nothing to do.
    }
  }

  function postPanic(reason) {
    try {
      window.parent.postMessage({ type: 'companion_panic', reason }, '*');
    } catch (e) {
      // best-effort
    }
  }

  function startReadyRetry() {
    postReady();
    readyTimer = setInterval(() => {
      if (port !== null) {
        clearInterval(readyTimer);
        readyTimer = null;
        return;
      }
      readyTries += 1;
      if (readyTries >= READY_MAX_TRIES) {
        clearInterval(readyTimer);
        readyTimer = null;
        postPanic('init handshake exhausted retries');
        log.error('init handshake exhausted retries');
        return;
      }
      postReady();
    }, READY_RETRY_MS);
  }

  // ── Theme ownership ──────────────────────────────────────────────
  // The parent app pushes its light/dark theme on init and on every toggle.
  // We only apply it to artifacts Primer authored — Markdown, which the upload
  // pipeline marks with data-primer-theme="managed" on <html>. Raw HTML
  // artifacts often ship their own theme toggle keyed on the same data-theme
  // attribute; clobbering it here would desync that toggle from what's
  // displayed (the light/dark flip bug), so for those we leave data-theme alone.
  function primerOwnsTheme() {
    try {
      return document.documentElement.dataset.primerTheme === 'managed';
    } catch (e) {
      return false;
    }
  }

  /** Apply the parent's theme when (and only when) Primer owns it. Returns
   *  true when the theme was applied, so callers can gate follow-up work
   *  (e.g. Mermaid re-render). */
  function applyParentTheme(theme) {
    if (!primerOwnsTheme()) return false;
    if (theme !== 'light' && theme !== 'dark') return false;
    try {
      document.documentElement.dataset.theme = theme;
    } catch (e) {
      // documentElement should always exist; defensive catch.
    }
    return true;
  }

  /** @type {((event: MessageEvent) => void) | null} */
  let onWindowMessage = (event) => {
    // When actually embedded, accept init ONLY from the parent frame. The
    // init handshake is first-init-wins, so without this check the
    // artifact's own JS could post a fake init to its own window and hijack
    // the companion port before the real parent's arrives (self-DoS plus a
    // fake "parent" feeding the artifact fabricated events). Top-level /
    // test contexts (window.parent === window) have no embedding parent to
    // verify against, and no other frame holds a reference to this window.
    if (window.parent !== window && event.source !== window.parent) return;
    if (!event.ports || event.ports.length === 0) return;
    const incoming = event.data;
    if (!incoming || incoming.type !== 'init') return;

    port = event.ports[0];
    port.onmessage = onPortMessage;
    port.start();

    if (readyTimer) {
      clearInterval(readyTimer);
      readyTimer = null;
    }

    features = Array.isArray(incoming.features) ? incoming.features.filter((f) => typeof f === 'string') : [];
    flushRecordCalls();
    startPage();

    if (Array.isArray(incoming.anchors)) {
      knownAnchors = incoming.anchors;
      log.info('init received, anchors:', knownAnchors.length);
      renderTextRangeMarkers();
      renderElementBadges();
    }

    // Fire-and-forget — never blocks init or anchor rendering.
    renderAllMermaidBlocks().catch((e) =>
      log.warn('mermaid init render error:', e && e.message ? e.message : e),
    );

    // Apply parent-provided theme when Primer owns it (see applyParentTheme).
    // Field is optional for backward-compat with parents that don't send it.
    if (applyParentTheme(incoming.theme)) {
      // Re-render any Mermaid diagrams that finished before init resolved.
      reRenderMermaidForTheme().catch((e) =>
        log.warn('mermaid init theme re-render error:', e && e.message ? e.message : e),
      );
    }

    flushLogBuffer();
    scheduleContentMetrics();

    if (onWindowMessage) {
      window.removeEventListener('message', onWindowMessage);
      onWindowMessage = null;
    }
  };

  window.addEventListener('message', onWindowMessage);
  startReadyRetry();

  // ── 2. Port message dispatcher ───────────────────────────────────
  function onPortMessage(event) {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') return;
    log.info('inbound', msg.type);

    switch (msg.type) {
      case 'update_anchors':
        if (Array.isArray(msg.anchors)) {
          knownAnchors = msg.anchors;
          driftedIds.clear();
          renderTextRangeMarkers();
          renderElementBadges();
        }
        break;
      case 'enter_pick_mode':
        enterPickMode();
        break;
      case 'exit_pick_mode':
        exitPickMode('parent');
        break;
      case 'set_focused_anchor':
        setFocusedAnchor(typeof msg.anchorId === 'string' ? msg.anchorId : null);
        break;
      case 'request_anchor_positions':
        if (port) {
          port.postMessage({
            type: 'anchor_positions',
            positions: computeAnchorPositions(),
          });
        }
        break;
      case 'theme_changed':
        // Only Primer-managed artifacts follow the parent theme; self-themed
        // artifacts are left alone (see applyParentTheme).
        if (applyParentTheme(msg.theme)) {
          // Re-render any existing Mermaid diagrams with the new theme.
          reRenderMermaidForTheme().catch((e) =>
            log.warn('mermaid theme re-render error:', e && e.message ? e.message : e),
          );
        }
        break;
      case 'events':
        // Document-events read relay (issue #78): the parent forwards
        // artifact-audience event rows VERBATIM, in coalesced batches
        // (grouping carries no semantics — artifact code must derive
        // identical state however the same rows are partitioned). We
        // re-dispatch to artifact JS as `primer:events`. The rows are
        // untrusted data for the artifact to parse and validate — never
        // instructions.
        if (Array.isArray(msg.events)) {
          try {
            window.dispatchEvent(
              new CustomEvent('primer:events', { detail: { events: msg.events } })
            );
          } catch (e) {
            log.warn('primer:events dispatch failed:', e && e.message ? e.message : e);
          }
        }
        break;
      case 'records_result':
        settleRecordCall(msg);
        break;
      case 'set_page_texts':
        if (hasFeature('page-text') && msg.texts && typeof msg.texts === 'object') setPageTexts(msg.texts);
        break;
      case 'set_embeds':
        if (hasFeature('embeds') && msg.embeds && typeof msg.embeds === 'object') setEmbeds(msg.embeds);
        break;
      case 'records_changed':
        // Others changed shared records. Untrusted data like any record:
        // the page re-reads what it shows (or catches up with changesSince).
        if (Array.isArray(msg.collections) && typeof msg.toChangeId === 'number') {
          try {
            window.dispatchEvent(
              new CustomEvent('primer:records-changed', {
                detail: { collections: msg.collections, toChangeId: msg.toChangeId },
              })
            );
          } catch (e) {
            log.warn('primer:records-changed dispatch failed:', e && e.message ? e.message : e);
          }
        }
        break;
      case 'submit_result':
        // Write acknowledgment for a prior `primer:submit-events` — `rows`
        // carries the created rows (with server-assigned ids and audiences)
        // so the artifact can reconcile an optimistic echo with
        // server-attributed truth.
        dispatchSubmitResult({
          ok: msg.ok === true,
          rows: Array.isArray(msg.rows) ? msg.rows : undefined,
          error: typeof msg.error === 'string' ? msg.error : undefined,
        });
        break;
      default:
        log.warn('unknown inbound', msg.type);
    }
  }

  // ── 3. Capability wiring (filled in by later tasks) ──────────────
  // Selection capture: Task 7
  // Marker rendering: Tasks 8, 9
  // Pick mode: Task 10
  // Position resolution + ResizeObserver: Task 11

  // ── External-nav forwarding ──────────────────────────────────────
  // Sandbox without allow-popups silently kills window.open / target=_blank.
  // We intercept the two common paths and forward to the parent for opening.

  function postOpenExternal(url) {
    // Record-reading pages never reach outside Primer (the host drops these
    // too; this only saves the round trip).
    if (features && features.indexOf('records') !== -1) {
      log.warn('open_external is off for pages that read records; dropping', url);
      return;
    }
    if (!port) {
      log.warn('open_external attempted before init; dropping', url);
      return;
    }
    port.postMessage({ type: 'open_external', url });
  }

  // ── Page text and Primer blocks (features `page-text`, `embeds`) ───
  // A live page's text lives in Primer's document, not in the page: people
  // edit it in an editor Primer draws over the element, in its own window,
  // so no keystroke reaches the page's scripts. The bridge only reports each
  // stamped element (`data-pid`) with its DOM text and rect, reports clicks,
  // and sets text the host sends, as text: `\n` becomes <br>, nothing else
  // is ever parsed. `<primer-*>` blocks (`data-embed-id`) show the static HTML
  // the host renders from the document's block state.
  const EMBED_SELECTOR = 'primer-table,primer-code,primer-mermaid,primer-math';

  function hasFeature(name) {
    return features !== null && features.indexOf(name) !== -1;
  }

  /** The stamped elements, outside embeds. */
  function pidElements() {
    return Array.prototype.filter.call(document.querySelectorAll('[data-pid]'), (el) => !el.closest(EMBED_SELECTOR));
  }

  function embedElements() {
    return Array.prototype.filter.call(document.querySelectorAll(EMBED_SELECTOR), (el) => el.hasAttribute('data-embed-id'));
  }

  /** An element's text by the server's rule (page/stamp.ts pageText): <br>
   *  is a newline; outside <pre> every whitespace run (newlines in the source
   *  too) collapses to one space and each line is trimmed. */
  function pidText(el) {
    const pre = !!el.closest('pre');
    // Source whitespace (a hard-wrapped paragraph's newlines too) is a space
    // outside <pre>; only <br> is a newline.
    const flow = (text) => (pre ? text : text.replace(/[ \t\n\r\f]+/g, ' '));
    let raw = '';
    el.childNodes.forEach((node) => {
      if (node.nodeType === Node.TEXT_NODE) raw += flow(node.nodeValue);
      else if (node.nodeName === 'BR') raw += '\n';
      else if (node.nodeType === Node.ELEMENT_NODE) raw += flow(node.textContent || '');
    });
    if (pre) return raw;
    return raw
      .split('\n')
      .map((line) => line.trim())
      .join('\n');
  }

  function rectOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  let pageStarted = false;
  let rectsQueued = false;

  function startPage() {
    if (pageStarted || !(hasFeature('page-text') || hasFeature('embeds'))) return;
    pageStarted = true;
    // After the page's own load handlers ran, so text a script draws on load
    // is reported as drawn.
    const report = () =>
      setTimeout(() => {
        if (!port) return;
        port.postMessage({
          type: 'page_elements',
          elements: hasFeature('page-text')
            ? pidElements().map((el) => ({ pid: el.getAttribute('data-pid'), text: pidText(el), rect: rectOf(el) }))
            : [],
          embeds: hasFeature('embeds')
            ? embedElements().map((el) => ({ embedId: el.getAttribute('data-embed-id'), rect: rectOf(el) }))
            : [],
        });
        window.addEventListener('scroll', queuePageRects, true);
        window.addEventListener('resize', queuePageRects);
        document.addEventListener('click', onPageClick, true);
      }, 0);
    if (document.readyState === 'complete') report();
    else window.addEventListener('load', report, { once: true });
  }

  function queuePageRects() {
    if (rectsQueued) return;
    rectsQueued = true;
    requestAnimationFrame(() => {
      rectsQueued = false;
      if (!port) return;
      const rects = {};
      if (hasFeature('page-text')) pidElements().forEach((el) => { rects[el.getAttribute('data-pid')] = rectOf(el); });
      const embedRects = {};
      if (hasFeature('embeds')) embedElements().forEach((el) => { embedRects[el.getAttribute('data-embed-id')] = rectOf(el); });
      port.postMessage({ type: 'page_rects', rects, embedRects });
    });
  }

  function onPageClick(event) {
    if (!port || !(event.target instanceof Element)) return;
    const embed = hasFeature('embeds') ? event.target.closest(EMBED_SELECTOR) : null;
    if (embed && embed.hasAttribute('data-embed-id')) {
      port.postMessage({ type: 'embed_clicked', embedId: embed.getAttribute('data-embed-id') });
      return;
    }
    const el = hasFeature('page-text') ? event.target.closest('[data-pid]') : null;
    if (el) port.postMessage({ type: 'pid_clicked', pid: el.getAttribute('data-pid') });
  }

  function setPageTexts(texts) {
    Object.keys(texts).forEach((pid) => {
      const text = texts[pid];
      if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(pid)) return;
      document.querySelectorAll('[data-pid="' + pid + '"]').forEach((el) => {
        if (el.closest(EMBED_SELECTOR) || pidText(el) === text) return;
        el.textContent = '';
        text.split('\n').forEach((line, i) => {
          if (i > 0) el.appendChild(document.createElement('br'));
          if (line) el.appendChild(document.createTextNode(line));
        });
      });
    });
    queuePageRects();
  }

  function setEmbeds(embeds) {
    Object.keys(embeds).forEach((id) => {
      const html = embeds[id];
      if (typeof html !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return;
      embedElements().forEach((el) => {
        if (el.getAttribute('data-embed-id') === id) el.innerHTML = html;
      });
    });
    renderAllMermaidBlocks().catch((e) => log.warn('mermaid embed render error:', e && e.message ? e.message : e));
    queuePageRects();
  }

  // ── Shared records (feature `records`) ────────────────────────────
  // A page that opts in with <meta name="primer-records" content="read">
  // gets window.primer.records.<verb>(args, { signal }) → Promise, for verbs
  // get, list, query, set, update, delete, batch, plus changesSince(changeId).
  // The host does the work as the viewer, bound to this page's document, and
  // enforces every limit (8 in flight, 5 s, 256 KB); `args` names only the
  // collection, scope, record, data, filters and paging. Calls made before
  // init wait for it. Results and records are untrusted data.

  const RECORD_VERBS = ['get', 'list', 'query', 'set', 'update', 'delete', 'batch'];
  /** @type {Map<string, { resolve: (v: any) => void, reject: (e: any) => void }>} */
  const recordCalls = new Map();
  /** @type {{ callId: string, verb: string, args: object }[]} */
  const queuedRecordCalls = [];
  let recordCallSeq = 0;

  function recordsError(refusal) {
    const r = refusal && typeof refusal === 'object' ? refusal : {};
    const err = new Error(typeof r.message === 'string' ? r.message : 'record call refused');
    err.name = 'PrimerRecordsError';
    err.code = typeof r.code === 'string' ? r.code : 'records_unavailable';
    err.fix = typeof r.fix === 'string' ? r.fix : undefined;
    return err;
  }

  function sendRecordCall(call) {
    if (features === null) {
      queuedRecordCalls.push(call);
      return;
    }
    if (features.indexOf('records') === -1 || !port) {
      settleRecordCall({
        callId: call.callId,
        ok: false,
        refusal: {
          code: 'records_unavailable',
          message: 'This page has no record access.',
          fix: 'Add <meta name="primer-records" content="read"> to the page head.',
        },
      });
      return;
    }
    port.postMessage({ type: 'records_call', callId: call.callId, verb: call.verb, args: call.args });
  }

  function flushRecordCalls() {
    while (queuedRecordCalls.length > 0) sendRecordCall(queuedRecordCalls.shift());
  }

  function settleRecordCall(msg) {
    const pending = recordCalls.get(msg.callId);
    if (!pending) return;
    recordCalls.delete(msg.callId);
    if (msg.ok === true) pending.resolve(msg.value);
    else pending.reject(recordsError(msg.refusal));
  }

  // A checkpoint (an external share, a checkpoint view) is served with the
  // shared records frozen when it was published, in an inert JSON script
  // (#primer-records-frozen, placed by the server). Reads are answered from
  // it, here in the page, and writes are refused: the data is as published,
  // never live. Personal records are never frozen.
  let frozenRecords; // undefined until first read; null when there are none
  function readFrozenRecords() {
    if (frozenRecords !== undefined) return frozenRecords;
    frozenRecords = null;
    const el = document.getElementById('primer-records-frozen');
    if (!el || el.getAttribute('type') !== 'application/json') return null;
    try {
      const snap = JSON.parse(el.textContent || '');
      if (snap && typeof snap === 'object' && snap.collections && typeof snap.collections === 'object') frozenRecords = snap;
    } catch (e) {
      log.warn('frozen records unreadable:', e && e.message ? e.message : e);
    }
    return frozenRecords;
  }

  function frozenRefusal(code, message, fix) {
    return { ok: false, refusal: { code, message, fix } };
  }

  /** One record call answered from the frozen snapshot. */
  function frozenRecordCall(snap, verb, args) {
    if (verb === 'changesSince') return { ok: true, value: { changes: [], toChangeId: snap.toChangeId || 0, hasMore: false } };
    if (verb !== 'get' && verb !== 'list' && verb !== 'query') {
      return frozenRefusal('forbidden', 'This is a published checkpoint: its records are frozen.', 'Open the live document to change records.');
    }
    const collection = typeof args.collection === 'string' ? args.collection : '';
    const scope = args.scope;
    if (scope !== 'shared' && scope !== 'personal') return frozenRefusal('bad_request', 'scope must be "shared" or "personal"', 'Call again with valid arguments.');
    const list = scope === 'shared' && Object.prototype.hasOwnProperty.call(snap.collections, collection) && Array.isArray(snap.collections[collection])
      ? snap.collections[collection]
      : [];
    const dto = (r) => ({
      collection,
      recordId: r.recordId,
      scope: 'shared',
      data: JSON.parse(JSON.stringify(r.data)),
      version: r.version,
      updatedAt: r.updatedAt,
      updatedBy: '',
      writtenBy: r.writtenBy,
    });
    if (verb === 'get') {
      const found = list.find((r) => r.recordId === args.recordId);
      return { ok: true, value: { record: found ? dto(found) : null } };
    }
    const limit = args.limit === undefined ? 50 : args.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return frozenRefusal('bad_request', 'limit must be an integer from 1 to 200', 'Call again with valid arguments.');
    const offset = args.cursor === undefined ? 0 : /^f:\d{1,6}$/.test(String(args.cursor)) ? Number(String(args.cursor).slice(2)) : -1;
    if (offset < 0) return frozenRefusal('bad_request', 'cursor is not a cursor from a previous page', 'Call again with valid arguments.');
    let rows = list.slice();
    if (verb === 'query') {
      const where = args.where && typeof args.where === 'object' ? args.where : {};
      rows = rows.filter((r) => Object.keys(where).every((k) => r.data && r.data[k] === where[k]));
      const o = args.orderBy;
      if (o && typeof o.key === 'string' && (o.dir === 'asc' || o.dir === 'desc')) {
        const sign = o.dir === 'asc' ? 1 : -1;
        rows.sort((a, b) => {
          const x = a.data ? a.data[o.key] : undefined;
          const y = b.data ? b.data[o.key] : undefined;
          // As the live query orders: a missing key last, then by JSON type
          // (null < string < number < boolean < array < object), JSON null a value.
          if (x === undefined && y === undefined) return a.recordId < b.recordId ? -1 : 1;
          if (x === undefined) return 1;
          if (y === undefined) return -1;
          const rx = jsonRank(x);
          const ry = jsonRank(y);
          if (rx !== ry) return (rx < ry ? -1 : 1) * sign;
          const kx = rx >= 4 ? JSON.stringify(x) : x;
          const ky = rx >= 4 ? JSON.stringify(y) : y;
          if (kx === ky) return a.recordId < b.recordId ? -1 : 1;
          return (kx < ky ? -1 : 1) * sign;
        });
      }
    }
    const page = rows.slice(offset, offset + limit).map(dto);
    return { ok: true, value: { records: page, nextCursor: rows.length > offset + limit ? 'f:' + (offset + limit) : null } };
  }

  function jsonRank(v) {
    return v === null ? 0 : typeof v === 'string' ? 1 : typeof v === 'number' ? 2 : typeof v === 'boolean' ? 3 : Array.isArray(v) ? 4 : 5;
  }

  function callRecords(verb, args, opts) {
    const snap = readFrozenRecords();
    if (snap) {
      const out = frozenRecordCall(snap, verb, args && typeof args === 'object' ? args : {});
      return out.ok ? Promise.resolve(out.value) : Promise.reject(recordsError(out.refusal));
    }
    return new Promise((resolve, reject) => {
      const signal = opts && opts.signal;
      if (signal && signal.aborted) {
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      recordCallSeq += 1;
      const callId = 'r' + recordCallSeq;
      recordCalls.set(callId, { resolve, reject });
      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            if (!recordCalls.has(callId)) return;
            recordCalls.delete(callId);
            const queued = queuedRecordCalls.findIndex((c) => c.callId === callId);
            if (queued !== -1) queuedRecordCalls.splice(queued, 1);
            else if (port) port.postMessage({ type: 'records_cancel', callId });
            reject(new DOMException('aborted', 'AbortError'));
          },
          { once: true }
        );
      }
      sendRecordCall({ callId, verb, args: args && typeof args === 'object' ? args : {} });
    });
  }

  const recordsApi = {};
  for (const verb of RECORD_VERBS) {
    recordsApi[verb] = (args, opts) => callRecords(verb, args, opts);
  }
  recordsApi.changesSince = (changeId, opts) =>
    callRecords('changesSince', { changeId, limit: opts && opts.limit }, opts);
  window.primer = window.primer || {};
  window.primer.records = Object.freeze(recordsApi);

  // ── Document events: consent-gated submit relay (issue #78) ──────
  // Artifact JS hands structured event batches to the parent by dispatching
  //   window.dispatchEvent(new CustomEvent('primer:submit-events',
  //     { detail: { events: [{ namespace, type, payload, audience }…] } }))
  // and we forward them over the port as `submit_events`; the parent
  // (authed, outside the sandbox) POSTs the batch. This is the ONLY way out
  // for artifact data — the sandbox + connect-src 'none' block every direct
  // network path (see docs/prd-primer.md threat model).
  //
  // CONSENT GATE — one activation per PHYSICAL interaction, consumed
  // in-dispatch (issue #78 security requirement 1). An artifact is untrusted
  // code running in every viewer's browser; without this gate its JS could
  // fire the submit event on load or in a loop and inject into a consumer's
  // work queue under the viewer's name. Two independent conditions must hold
  // for a forward:
  //
  //   1. IN-DISPATCH: the submit is dispatched while the trusted gesture
  //      event's own dispatch is still IN PROGRESS. The capture-phase
  //      listener stores the trusted event object; the submit handler then
  //      checks its dispatch phase !== Event.NONE — the UA sets eventPhase
  //      for the duration of the dispatch and resets it to NONE when the
  //      dispatch completes (DOM §dispatch), so the window closes exactly
  //      when the gesture's dispatch does, no timers or microtasks involved.
  //      A setTimeout-deferred submit always finds NONE (tasks never
  //      interleave mid-dispatch). CRUCIAL: the phase is read through the
  //      event-guard stash's captured NATIVE getter (see readEventPhase),
  //      NOT a plain `e.eventPhase` — the same event instance is shared
  //      with the artifact's own listeners, so a plain read is forgeable
  //      both by a prototype-getter redefine AND by an own-property shadow
  //      on the instance; the native getter reads the internal slot and is
  //      immune to both. The check also re-verifies `isTrusted`
  //      (LegacyUnforgeable): a synthetic gesture is never stored, and an
  //      artifact replaying a captured trusted event via dispatchEvent()
  //      reads isTrusted=false.
  //      Why not a microtask-retired flag: in a REAL browser the HTML spec
  //      runs a microtask checkpoint after EVERY listener callback, so a
  //      flag minted in our capture listener and retired by queueMicrotask
  //      dies before the artifact's own handler (later in the same
  //      dispatch) ever runs — refusing every legitimate submission. Only
  //      synthetic dispatchEvent() from JS (e.g. jsdom tests) keeps the
  //      whole dispatch on one stack; the eventPhase check is correct under
  //      both. Note the honest boundary this draws: a microtask queued by
  //      an artifact handler MAY run between listeners of the SAME
  //      still-in-progress gesture dispatch and pass this check — that is
  //      the same physical gesture and the same activation cluster (at most
  //      one submission either way); what can never pass is anything after
  //      the gesture's dispatch has ended (timers, later microtasks, an
  //      unrelated interaction's window).
  //
  //   2. UNCONSUMED ACTIVATION CLUSTER: one physical interaction (a tap, a
  //      keystroke) fires a BURST of trusted events — e.g. pointerdown,
  //      mousedown, pointerup, mouseup, click for one mouse tap; pointer +
  //      touch + compatibility-mouse events for one touch tap; repeated
  //      keydowns while a key is held. Minting an authorization per EVENT
  //      would let an artifact with handlers on every gesture type turn one
  //      incidental tap into several attributed submissions. Instead the
  //      whole burst shares ONE consumable activation cluster:
  //        - a press-family event (pointerdown/mousedown/touchstart/keydown)
  //          mints a new cluster only if a release-family event has occurred
  //          since the last mint — so the down-burst of one press, and
  //          auto-repeat keydowns of one held key, never re-mint;
  //        - release-family events (pointerup/mouseup/touchend/keyup/click)
  //          never mint while a cluster exists — they continue it;
  //        - after touchend, the UA may replay the same tap as
  //          compatibility mouse events (mousedown/mouseup/click); the first
  //          mousedown in that window continues the touch cluster instead of
  //          minting.
  //      A successful forward CONSUMES the cluster. Net guarantee: one
  //      physical activation authorizes AT MOST ONE submission (which may be
  //      a batch); one discrete keystroke (keydown..keyup, auto-repeat
  //      included) is one activation cluster.
  //
  // Checking `navigator.userActivation.isActive` alone would leave the
  // activation-laundering window open — this gate does not use it. The
  // companion cannot attest WHICH element the user activated — the submit
  // affordance lives inside the untrusted artifact — so this gate's
  // guarantee is per-activation, not per-"Send-button". That gap is closed
  // one layer up by the PARENT-OWNED FIRST-SUBMISSION GRANT (issue #78
  // security requirement 6, see apps/web/src/lib/eventsGrant.ts and the
  // threat model in docs/prd-primer.md): the parent holds an artifact
  // version's first submission and asks the viewer in Primer-owned chrome,
  // disclosing the envelope and audience meaning, before anything is
  // POSTed. This gate stays a necessary condition underneath it.
  //
  // The validation limits mirror packages/api-types/src/index.ts (the
  // companion is plain JS and can't import it; kept in sync by hand — see
  // events.consent.test.ts, which fails loudly if they drift). The server
  // re-validates everything; this is the polite early refusal.
  const SUBMIT_NAMESPACE_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)*$/;
  const SUBMIT_TYPE_RE = /^[a-z0-9][a-z0-9-]*$/;
  const SUBMIT_MAX_PAYLOAD_CHARS = 256 * 1024;
  const SUBMIT_MAX_BATCH = 100;

  const GESTURE_PRESS_TYPES = ['pointerdown', 'mousedown', 'touchstart', 'keydown'];
  const GESTURE_RELEASE_TYPES = ['pointerup', 'mouseup', 'touchend', 'keyup', 'click'];

  /** The current physical interaction's consumable authorization.
   *  @type {{ consumed: boolean } | null} */
  let activationCluster = null;
  /** True once a release-family event has occurred since the last mint —
   *  the signal that the next press-family event is a NEW physical press. */
  let releaseSeenSinceMint = true;
  /** Set on touchend: the next mousedown may be the UA's compatibility
   *  replay of the same tap and must not mint a new cluster. */
  let compatMousePending = false;
  /** The trusted gesture event whose dispatch is (or was most recently)
   *  in progress. Closure-private — the artifact cannot reach or replace
   *  it; a synthetic gesture never gets stored (isTrusted check in the
   *  listeners below). @type {Event | null} */
  let lastTrustedGestureEvent = null;

  // The event-guard stash the upload pipeline injects as the FIRST head
  // script (apps/api/src/upload/eventGuardShim.ts). It exposes the native
  // `eventPhase` getter applied via a captured `Reflect.apply`, so we read
  // an event's TRUE dispatch phase — immune to an artifact redefining
  // `Event.prototype.eventPhase` OR shadowing `eventPhase` as an own
  // property on the (shared) event instance. Captured once at load: the
  // shim provably ran first and locked this global non-configurable +
  // non-writable, so nothing can have swapped it before we read it here.
  const EVENT_GUARD =
    typeof window !== 'undefined' &&
    window.__primerEventGuard__ &&
    window.__primerEventGuard__.ready === true
      ? window.__primerEventGuard__
      : null;

  /** True iff the stored trusted gesture event's dispatch is in progress
   *  right now. eventPhase is UA-managed: set for the dispatch's duration,
   *  reset to NONE (0) when it completes. The artifact cannot make this
   *  return true post-dispatch: it cannot forge isTrusted (LegacyUnforgeable,
   *  so a synthetic gesture is never stored and a dispatchEvent()-replayed
   *  event reads isTrusted=false), and it cannot forge the phase because we
   *  read it through the guard's captured NATIVE getter, not the instance's
   *  (poisonable) `eventPhase` accessor.
   *
   *  Fail-safe: if the guard is absent (only possible outside the upload
   *  pipeline — e.g. a jsdom unit harness that evals v1.js with no shim;
   *  never in a real artifact, where the shim always precedes this script),
   *  fall back to the plain read. That path is NOT the production security
   *  boundary — the real-browser test tier exercises the guarded path. */
  function readEventPhase(e) {
    if (EVENT_GUARD) {
      try {
        return EVENT_GUARD.eventPhase(e);
      } catch (err) {
        return 0; // guard threw unexpectedly → fail safe (treat as NONE)
      }
    }
    return e.eventPhase;
  }
  function inTrustedGestureDispatch() {
    const e = lastTrustedGestureEvent;
    return !!e && e.isTrusted === true && readEventPhase(e) !== 0 /* Event.NONE */;
  }

  for (const type of GESTURE_PRESS_TYPES) {
    window.addEventListener(
      type,
      (e) => {
        if (!e.isTrusted) return;
        lastTrustedGestureEvent = e;
        if (type === 'mousedown' && compatMousePending) {
          // Compatibility mouse burst of a touch tap — same physical
          // interaction, same cluster.
          compatMousePending = false;
          if (!activationCluster) activationCluster = { consumed: false };
          return;
        }
        compatMousePending = false;
        if (releaseSeenSinceMint || !activationCluster) {
          activationCluster = { consumed: false };
          releaseSeenSinceMint = false;
        }
        // else: another press-family event of the SAME press moment
        // (pointerdown+mousedown+touchstart burst, or keydown auto-repeat)
        // — keep the existing cluster, consumed state included.
      },
      true /* capture, so the state exists before any artifact handler runs */
    );
  }
  for (const type of GESTURE_RELEASE_TYPES) {
    window.addEventListener(
      type,
      (e) => {
        if (!e.isTrusted) return;
        lastTrustedGestureEvent = e;
        // Defensive: a release with no cluster (companion loaded
        // mid-interaction) still represents a genuine physical activation.
        if (!activationCluster) activationCluster = { consumed: false };
        releaseSeenSinceMint = true;
        if (type === 'touchend') compatMousePending = true;
      },
      true
    );
  }

  function dispatchSubmitResult(detail) {
    try {
      window.dispatchEvent(new CustomEvent('primer:submit-result', { detail }));
    } catch (e) {
      // best-effort — the artifact just doesn't get its ack
    }
  }

  /** Validates one event of a submit batch. Returns a clean, structured-
   *  clone-safe copy, or null. Mirrors the api-types wire contract. */
  function cleanSubmitEvent(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.namespace !== 'string' || raw.namespace.length > 128 || !SUBMIT_NAMESPACE_RE.test(raw.namespace)) return null;
    if (typeof raw.type !== 'string' || raw.type.length > 64 || !SUBMIT_TYPE_RE.test(raw.type)) return null;
    if (raw.audience !== 'author' && raw.audience !== 'collaborators' && raw.audience !== 'artifact') return null;
    if (!('payload' in raw)) return null;
    let payload = null;
    try {
      const json = JSON.stringify(raw.payload);
      if (typeof json !== 'string') return null; // undefined / function / symbol
      if (json.length > SUBMIT_MAX_PAYLOAD_CHARS) return null;
      payload = JSON.parse(json); // structured-clone safety before the port
    } catch (e) {
      return null;
    }
    const clean = {
      namespace: raw.namespace,
      type: raw.type,
      audience: raw.audience,
      payload,
    };
    if (typeof raw.versionId === 'string') clean.versionId = raw.versionId;
    return clean;
  }

  window.addEventListener('primer:submit-events', (e) => {
    const refuse = (error) => {
      log.warn('submit-events refused:', error);
      dispatchSubmitResult({ ok: false, error });
    };
    if (!inTrustedGestureDispatch() || !activationCluster || activationCluster.consumed) {
      refuse('consent_required: primer:submit-events must be dispatched from within the user gesture that authorizes it (one physical activation authorizes at most one submission)');
      return;
    }
    if (!port) {
      refuse('not_ready: companion port not initialized yet');
      return;
    }
    const detail = e && e.detail ? e.detail : null;
    if (!detail || !Array.isArray(detail.events) || detail.events.length === 0) {
      refuse('bad_request: detail.events must be a non-empty array');
      return;
    }
    if (detail.events.length > SUBMIT_MAX_BATCH) {
      refuse('bad_request: too many events in one batch');
      return;
    }
    const cleaned = [];
    for (const raw of detail.events) {
      const clean = cleanSubmitEvent(raw);
      if (!clean) {
        refuse('bad_request: every event needs a valid namespace, type, audience, and JSON-serializable payload under the size cap');
        return;
      }
      cleaned.push(clean);
    }
    // One physical activation, one submission — consume the cluster
    // in-dispatch. Every other event of the same interaction burst (and any
    // repeat within it) now finds it consumed.
    activationCluster.consumed = true;
    port.postMessage({ type: 'submit_events', events: cleaned });
  });

  // (a) anchor clicks with target="_blank" or "_top"
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const a = target.closest('a[target="_blank"], a[target="_top"]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href) return;
      e.preventDefault();
      // Resolve relative hrefs against the iframe document base.
      const resolved = new URL(href, document.baseURI).href;
      postOpenExternal(resolved);
    },
    true /* capture phase, so artifact handlers can't preempt us */
  );

  // (b) window.open() override.
  // The companion is `defer` + end-of-body, so this runs after all inline
  // artifact scripts. Artifacts that cached `window.open` early will miss
  // the override — that's a documented limitation (failure mode: link does
  // nothing, since the sandbox blocked it anyway).
  const _nativeOpen = window.open;
  window.open = function patchedOpen(url) {
    if (typeof url === 'string') postOpenExternal(url);
    return null; // mimic the sandbox-blocked behavior
  };
  // Silence "unused variable" without exposing the native to artifacts.
  void _nativeOpen;

  // ── Pure helpers used across capture / rendering ─────────────────

  const BLOCK_TAGS = new Set([
    'BODY','ARTICLE','SECTION','DIV','P',
    'H1','H2','H3','H4','H5','H6',
    'LI','TD','TH','BLOCKQUOTE','PRE','DETAILS',
  ]);

  function normalize(s) {
    return s.replace(/\s+/g, ' ').trim();
  }

  // Collapse whitespace runs to single spaces WITHOUT trimming the outer
  // edges. Used at capture time so the prefix/suffix preserve a single
  // boundary space between them and the selectorText — otherwise the
  // needle reconstructed at resolution time would miss the space that's
  // actually in the document at the join points.
  // See apps/api/src/companion/textRangeResolution.test.ts for the math.
  function collapseWhitespace(s) {
    return s.replace(/\s+/g, ' ');
  }

  function serializeRect(r) {
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }

  function nearestBlockAncestor(node) {
    let el = node instanceof Element ? node : node.parentElement;
    while (el && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
    return el || document.body;
  }

  function cssPath(el) {
    if (el === document.body) return 'body';
    /** @type {string[]} */
    const parts = [];
    /** @type {Element | null} */
    let cur = el;
    while (cur && cur !== document.body && cur.parentElement) {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      const siblings = Array.from(parent.children).filter(
        (c) => c.tagName === cur.tagName
      );
      const nth = siblings.indexOf(cur) + 1;
      parts.push(siblings.length > 1 ? `${tag}:nth-of-type(${nth})` : tag);
      cur = parent;
    }
    parts.push('body');
    return parts.reverse().join(' > ');
  }

  /**
   * Walk text inside `container`, collect the normalized text up to and after the
   * selected range, return the trailing `n` chars before the range start and the
   * leading `n` chars after the range end.
   */
  function collectContext(container, range, n) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let beforeRaw = '';
    let afterRaw = '';
    let node = walker.nextNode();
    while (node) {
      if (node === range.startContainer) {
        beforeRaw += node.nodeValue.slice(0, range.startOffset);
        break;
      }
      // If the node is positioned before the start container in document order,
      // accumulate its full text into `beforeRaw`.
      const cmp = range.startContainer.compareDocumentPosition(node);
      if (cmp & Node.DOCUMENT_POSITION_PRECEDING) {
        beforeRaw += node.nodeValue;
      }
      node = walker.nextNode();
    }
    // Second pass for the trailing context.
    const walker2 = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    node = walker2.nextNode();
    let foundEnd = false;
    while (node) {
      if (node === range.endContainer) {
        afterRaw += node.nodeValue.slice(range.endOffset);
        foundEnd = true;
      } else if (foundEnd) {
        afterRaw += node.nodeValue;
      }
      node = walker2.nextNode();
    }
    const beforeN = collapseWhitespace(beforeRaw).slice(-n);
    const afterN = collapseWhitespace(afterRaw).slice(0, n);
    return { prefix: beforeN, suffix: afterN };
  }

  // ── Position-based anchoring (W3C TextPositionSelector style) ────
  //
  // Artifacts are immutable per version, so we anchor text-range
  // comments by raw cumulative character offsets into the flattened
  // text walk of document.body. Capture: range endpoints → (start, end)
  // integers. Resolve: (start, end) → DOM Range. Cross-block,
  // cross-cell, repeated-text, and whitespace edge cases dissolve.
  //
  // The pure math is mirrored in apps/api/src/companion/textRangePosition.test.ts.
  // Keep the two in sync — especially the boundary convention in
  // offsetToEndpoint (offsets at a segment boundary belong to the
  // earlier segment, matching Range.setEnd at end-of-node).

  /** Ids of DOM injected by the companion. Text nodes inside any of
   *  these subtrees are excluded from the segment index so our own
   *  badges / banner do not shift offsets. */
  const COMPANION_DOM_IDS = new Set([
    '__primer_overlay__',         // appended to document.body
    '__primer_pick_banner__',     // appended to document.body
    '__primer_companion_style__', // in document.head — excluded for completeness
  ]);

  /** Cached segment index. Built lazily on first call to getSegments().
   *  Never invalidated: artifact DOM is immutable, companion DOM is
   *  excluded from the walk, so the index is stable for the lifetime
   *  of the iframe.
   *  @type {{ node: Text, start: number, end: number }[] | null} */
  let _segmentsCache = null;

  /** NodeFilter that rejects text nodes whose ancestor is a subtree
   *  we've injected (overlay, banner, style). Used by every text walker
   *  in the position-based anchoring path so capture, resolution, and
   *  Element-endpoint descent all agree on which text nodes count. */
  function makeCompanionExcludeFilter() {
    return {
      acceptNode(node) {
        let p = node.parentElement;
        while (p) {
          if (p.id && COMPANION_DOM_IDS.has(p.id)) {
            return NodeFilter.FILTER_REJECT;
          }
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    };
  }

  function getSegments() {
    if (_segmentsCache) return _segmentsCache;
    /** @type {{ node: Text, start: number, end: number }[]} */
    const out = [];
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      makeCompanionExcludeFilter()
    );
    let cursor = 0;
    let n = walker.nextNode();
    while (n) {
      const t = /** @type {Text} */ (n);
      const len = t.nodeValue.length;
      out.push({ node: t, start: cursor, end: cursor + len });
      cursor += len;
      n = walker.nextNode();
    }
    _segmentsCache = out;
    return out;
  }

  function findFirstTextDescendant(node) {
    if (node instanceof Text) return node;
    const walker = document.createTreeWalker(
      node,
      NodeFilter.SHOW_TEXT,
      makeCompanionExcludeFilter()
    );
    return /** @type {Text | null} */ (walker.nextNode());
  }

  function findLastTextDescendant(node) {
    if (node instanceof Text) return node;
    const walker = document.createTreeWalker(
      node,
      NodeFilter.SHOW_TEXT,
      makeCompanionExcludeFilter()
    );
    /** @type {Text | null} */
    let last = null;
    /** @type {Node | null} */
    let n = walker.nextNode();
    while (n) {
      last = /** @type {Text} */ (n);
      n = walker.nextNode();
    }
    return last;
  }

  /** Map (containerNode, intra-node offset) → raw cumulative offset.
   *  If containerNode is an Element, descends into childNodes[offset]
   *  and walks to the first text descendant (== "position at start of
   *  that subtree's text"). If offset is past the last child, returns
   *  the end of the element's last text descendant. Returns -1 if no
   *  mapping found. */
  function endpointToOffset(containerNode, offset) {
    const segs = getSegments();
    if (containerNode instanceof Text) {
      for (const seg of segs) {
        if (seg.node === containerNode) {
          const clamped = Math.max(0, Math.min(offset, seg.end - seg.start));
          return seg.start + clamped;
        }
      }
      return -1;
    }
    if (!(containerNode instanceof Element)) return -1;
    const children = containerNode.childNodes;
    if (offset >= children.length) {
      const lastText = findLastTextDescendant(containerNode);
      if (!lastText) return -1;
      for (const seg of segs) {
        if (seg.node === lastText) return seg.end;
      }
      return -1;
    }
    const child = children[offset];
    const firstText = child instanceof Text ? child : findFirstTextDescendant(child);
    if (!firstText) return -1;
    for (const seg of segs) {
      if (seg.node === firstText) return seg.start;
    }
    return -1;
  }

  /** Map a raw cumulative offset → (Text node, intra-node offset).
   *  Boundary convention: an offset that sits on a segment boundary
   *  (== seg.start of the current segment AND == segs[mid-1].end of the
   *  previous segment) belongs to the EARLIER segment. Matches
   *  Range.setEnd's behavior where setEnd(node, node.length) and
   *  setStart(nextNode, 0) refer to the same document position; we
   *  always pick the former. Also handles empty text nodes where
   *  seg.start == seg.end.
   *  Returns null if out of bounds or segments are empty. */
  function offsetToEndpoint(rawOffset) {
    const segs = getSegments();
    if (segs.length === 0) return null;
    const last = segs[segs.length - 1];
    if (rawOffset < 0 || rawOffset > last.end) return null;
    let lo = 0;
    let hi = segs.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const seg = segs[mid];
      if (rawOffset < seg.start) hi = mid - 1;
      else if (rawOffset > seg.end) lo = mid + 1;
      else {
        if (rawOffset === seg.start && mid > 0 && segs[mid - 1].end === rawOffset) {
          const prev = segs[mid - 1];
          return { node: prev.node, offset: rawOffset - prev.start };
        }
        return { node: seg.node, offset: rawOffset - seg.start };
      }
    }
    // Unreachable: the bounds check above guarantees rawOffset ∈ [0, last.end],
    // and the segment array is contiguous by construction, so every valid
    // offset is found inside some segment. Kept as a defensive tail.
    return null;
  }

  /** Build a DOM Range from raw (start, end) offsets. Returns null if
   *  either endpoint can't be mapped or end < start. */
  function rangeFromOffsets(start, end) {
    if (end < start) return null;
    const a = offsetToEndpoint(start);
    const b = offsetToEndpoint(end);
    if (!a || !b) return null;
    try {
      const range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      return range;
    } catch {
      return null;
    }
  }

  // ── Selection capture ────────────────────────────────────────────

  let lastEmittedFingerprint = '';
  let lastEmittedAt = 0;
  let hasActiveCapture = false;
  /** Cached anchor of the most recent selection_captured emission. Used
   *  by scheduleSelectionRectsRefresh to re-emit fresh clientRects on
   *  scroll/resize WITHOUT recomputing the (start, end) offsets — those
   *  don't change when the viewport scrolls. Cleared on selection_cleared.
   *  @type {{ type: 'text-range', start: number, end: number, selectorText: string } | null}
   */
  let lastCapturedAnchor = null;

  function emitSelectionCleared() {
    if (!port || !hasActiveCapture) return;
    hasActiveCapture = false;
    lastEmittedFingerprint = '';
    lastCapturedAnchor = null;
    port.postMessage({ type: 'selection_cleared' });
  }

  function onPossibleSelection() {
    if (!port) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      emitSelectionCleared();
      return;
    }

    const range = sel.getRangeAt(0);
    const selectorText = sel.toString();
    if (selectorText.trim().length === 0) {
      emitSelectionCleared();
      return;
    }

    // Reject selections that started or ended inside companion-injected
    // DOM (overlay badges, pick banner). endpointToOffset would return
    // -1 anyway, but bailing early keeps the capture path quiet.
    if (
      isInCompanionDom(range.startContainer) ||
      isInCompanionDom(range.endContainer)
    ) {
      return;
    }

    const start = endpointToOffset(range.startContainer, range.startOffset);
    const end = endpointToOffset(range.endContainer, range.endOffset);
    if (start < 0 || end < 0 || end <= start) {
      log.info('selection capture skipped — endpoints unmappable', { start, end });
      return;
    }

    const fingerprint = `${start}|${end}`;
    if (fingerprint === lastEmittedFingerprint && Date.now() - lastEmittedAt < 200) {
      return;
    }
    lastEmittedFingerprint = fingerprint;
    lastEmittedAt = Date.now();

    const clientRects = Array.from(range.getClientRects()).map(serializeRect);
    lastCapturedAnchor = {
      type: 'text-range',
      start,
      end,
      selectorText,
    };

    port.postMessage({
      type: 'selection_captured',
      anchor: lastCapturedAnchor,
      clientRects,
    });
    hasActiveCapture = true;
  }

  // Scroll- and resize-driven re-emission of the current selection's
  // clientRects. The parent positions the "Add comment" pill from these
  // rects; when the iframe scrolls or its body reflows, the rects shift
  // but no mouseup fires, so onPossibleSelection() doesn't run.
  //
  // We bypass the fingerprint dedup at lines above because we're
  // intentionally re-emitting the same (start, end) with refreshed
  // geometry; the dedup is for mouseup chatter, not layout updates.
  // Throttled to rAF so a fast scroll doesn't saturate the port.
  let rectsRefreshRafPending = false;
  function scheduleSelectionRectsRefresh() {
    if (rectsRefreshRafPending) return;
    if (!hasActiveCapture || !lastCapturedAnchor || !port) return;
    rectsRefreshRafPending = true;
    requestAnimationFrame(() => {
      rectsRefreshRafPending = false;
      if (!port || !hasActiveCapture || !lastCapturedAnchor) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const clientRects = Array.from(range.getClientRects()).map(serializeRect);
      port.postMessage({
        type: 'selection_captured',
        anchor: lastCapturedAnchor,
        clientRects,
      });
    });
  }

  /** True if `node` is inside any companion-injected subtree. Shares
   *  COMPANION_DOM_IDS with makeCompanionExcludeFilter — register new
   *  companion roots there and both paths pick them up automatically. */
  function isInCompanionDom(node) {
    let p = node instanceof Element ? node : node.parentElement;
    while (p) {
      if (p.id && COMPANION_DOM_IDS.has(p.id)) return true;
      p = p.parentElement;
    }
    return false;
  }

  document.addEventListener('mouseup', () => requestAnimationFrame(onPossibleSelection));
  document.addEventListener('keyup', () => requestAnimationFrame(onPossibleSelection));

  // ── Marker rendering: text-range ─────────────────────────────────
  // Uses CSS Custom Highlight API to paint highlights without mutating
  // the artifact DOM. Falls back to "no marker, mark drifted" when a
  // text-range can't be resolved.

  const STYLE_TAG_ID = '__primer_companion_style__';

  function ensureStyleTag() {
    if (document.getElementById(STYLE_TAG_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_TAG_ID;
    style.setAttribute('data-primer', '1');
    style.textContent = `
      /* Default (unfocused) — subtle yellow wash. Forces dark text so it
         stays readable on dark-mode artifacts. */
      ::highlight(primer-mark) {
        background: rgba(253, 224, 71, 0.45);
        color: #111827;
      }
      /* Focused (sticky) — dramatically more saturated + thick amber
         underline. Designed to be unambiguous against any artifact
         background, light or dark. */
      ::highlight(primer-mark-focused) {
        background: rgba(217, 119, 6, 0.95);
        color: #ffffff;
        text-decoration: underline;
        text-decoration-color: rgba(120, 53, 15, 1);
        text-decoration-thickness: 3px;
        text-underline-offset: 3px;
      }
      .__primer_badge__ {
        position: absolute;
        background: rgba(254, 240, 138, 0.95);
        border: 1px solid rgba(202, 138, 4, 0.6);
        border-radius: 9999px;
        padding: 0 6px;
        font: 11px/16px system-ui;
        pointer-events: auto;
        cursor: pointer;
      }
      .__primer_badge__.focused {
        background: rgba(252, 211, 77, 1);
        outline: 2px solid rgba(202, 138, 4, 0.8);
      }
      .__primer_pick_outline__ {
        position: absolute;
        outline: 2px solid rgba(59, 130, 246, 0.8);
        outline-offset: -2px;
        pointer-events: none;
      }
    `;
    document.head.insertBefore(style, document.head.firstChild);
  }

  /** Two Highlight objects we move ranges between. */
  let highlightDefault = null;
  let highlightFocused = null;
  function ensureHighlights() {
    if (!('Highlight' in window) || !window.CSS || !CSS.highlights) {
      log.warn('CSS Custom Highlight API not available; text-range markers disabled');
      return false;
    }
    if (!highlightDefault) {
      highlightDefault = new Highlight();
      CSS.highlights.set('primer-mark', highlightDefault);
    }
    if (!highlightFocused) {
      highlightFocused = new Highlight();
      CSS.highlights.set('primer-mark-focused', highlightFocused);
    }
    return true;
  }

  /** anchorId → Range (for live anchors), so highlight_anchor can find the range. */
  const rangeByAnchorId = new Map();

  /** Resolve a text-range anchor to a DOM Range. Dispatches on shape:
   *  position-based anchors (start/end integers) use the segment-index
   *  helpers; legacy anchors (prefix / selectorText / suffix /
   *  containerPath) use the text-pattern matcher. Returns null if
   *  unresolvable. New captures (post-Task 4) always carry start/end;
   *  pre-existing stored anchors carry the legacy fields. */
  function resolveTextRange(anchor) {
    if (
      typeof anchor.start === 'number' &&
      typeof anchor.end === 'number' &&
      Number.isFinite(anchor.start) &&
      Number.isFinite(anchor.end)
    ) {
      return rangeFromOffsets(anchor.start, anchor.end);
    }
    if (typeof anchor.containerPath === 'string') {
      return resolveTextRangeLegacy(anchor);
    }
    return null;
  }

  function resolveTextRangeLegacy(anchor) {
    /** @type {Element | null} */
    let container;
    try {
      container = document.querySelector(anchor.containerPath);
    } catch {
      return null;
    }
    if (!container) return null;

    // Build a flat text buffer + segments mapping back to (textNode, offset).
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    /** @type {{ node: Text, start: number }[]} */
    const segs = [];
    let raw = '';
    let n = walker.nextNode();
    while (n) {
      segs.push({ node: /** @type {Text} */ (n), start: raw.length });
      raw += n.nodeValue;
      n = walker.nextNode();
    }

    const normalizedRaw = normalize(raw);
    const cPrefix = collapseWhitespace(anchor.prefix);
    const cSelector = collapseWhitespace(anchor.selectorText);
    const cSuffix = collapseWhitespace(anchor.suffix);
    const cFull = cPrefix + cSelector + cSuffix;
    // The needle aligns with normalizedRaw, which is fully normalized
    // (outer ends trimmed). cFull is already run-collapsed so we only
    // strip the outer edges.
    const needle = cFull.replace(/^\s+|\s+$/g, '');
    const hit = normalizedRaw.indexOf(needle);
    if (hit === -1) return null;

    // Account for whitespace at the outer ends of cFull that got trimmed
    // from the needle. The trim eats cPrefix/cSuffix first, then chews
    // into cSelector if either is empty. Selection.toString() in
    // Chrome/Brave inserts a "\n" at touched block boundaries (triple-
    // click on a list item, shift+extend past a paragraph end), which
    // becomes trailing whitespace in cSelector — without the trim
    // adjustment the rawEnd math overshoots the actual normalized raw
    // length and returns -1, drifting the anchor.
    const leadingTrim = cFull.length - cFull.replace(/^\s+/, '').length;
    const trailingTrim = cFull.length - cFull.replace(/\s+$/, '').length;
    const leadingChopFromSelector = Math.max(0, leadingTrim - cPrefix.length);
    const trailingChopFromSelector = Math.max(0, trailingTrim - cSuffix.length);
    const selStart = Math.max(0, cPrefix.length - leadingTrim);
    const selLength = Math.max(
      0,
      cSelector.length - leadingChopFromSelector - trailingChopFromSelector,
    );

    const rawStart = mapNormalizedToRaw(raw, hit + selStart);
    const rawEnd = mapNormalizedToRaw(raw, hit + selStart + selLength);
    if (rawStart < 0 || rawEnd < 0) return null;

    const start = locateInSegments(segs, rawStart);
    const end = locateInSegments(segs, rawEnd);
    if (!start || !end) return null;

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  }

  function mapNormalizedToRaw(raw, normalizedOffset) {
    // Walk `raw`, counting normalized characters (single-space-collapsed,
    // leading whitespace dropped) until we reach normalizedOffset.
    // A whitespace run contributes one normalized char and advances i
    // past the entire run, so the returned position lands on the first
    // non-whitespace character after the run (not mid-run).
    let i = 0;
    while (i < raw.length && /\s/.test(raw[i])) i++;
    let nIdx = 0;
    while (i < raw.length && nIdx < normalizedOffset) {
      if (/\s/.test(raw[i])) {
        while (i < raw.length && /\s/.test(raw[i])) i++;
        nIdx++;
      } else {
        i++;
        nIdx++;
      }
    }
    return nIdx === normalizedOffset ? i : -1;
  }

  function locateInSegments(segs, rawOffset) {
    for (const seg of segs) {
      const end = seg.start + seg.node.nodeValue.length;
      if (rawOffset >= seg.start && rawOffset <= end) {
        return { node: seg.node, offset: rawOffset - seg.start };
      }
    }
    return null;
  }

  // Sticky-focus state. Persists across `update_anchors` until the parent
  // sends a new `set_focused_anchor`. null = no focus.
  let focusedAnchorId = null;

  function renderTextRangeMarkers() {
    ensureStyleTag();
    if (!ensureHighlights()) return;

    highlightDefault.clear();
    highlightFocused.clear();
    rangeByAnchorId.clear();
    driftedIds.clear();

    for (const a of knownAnchors) {
      if (a.data.type !== 'text-range') continue;
      const range = resolveTextRange(a.data);
      if (!range) {
        driftedIds.add(a.id);
        continue;
      }
      rangeByAnchorId.set(a.id, range);
      // If this anchor is the currently-focused one, paint it focused;
      // otherwise paint the default highlight.
      if (a.id === focusedAnchorId) {
        highlightFocused.add(range);
      } else {
        highlightDefault.add(range);
      }
    }
  }

  /** Switch the focused anchor. Pass null to clear focus.
   *  Scrolls the iframe to the newly-focused anchor on transition. */
  function setFocusedAnchor(nextId) {
    const prevId = focusedAnchorId;
    if (prevId === nextId) return;
    focusedAnchorId = nextId;

    // Repaint text-range focus.
    if (prevId !== null) {
      const prevRange = rangeByAnchorId.get(prevId);
      if (prevRange && highlightFocused && highlightDefault) {
        try {
          highlightFocused.delete(prevRange);
          highlightDefault.add(prevRange);
        } catch {}
      }
    }
    if (nextId !== null) {
      const nextRange = rangeByAnchorId.get(nextId);
      if (nextRange && highlightFocused && highlightDefault) {
        try {
          highlightDefault.delete(nextRange);
          highlightFocused.add(nextRange);
        } catch {}
        try {
          // Scroll to the range's actual visual position. Using
          // startContainer.parentElement is wrong when the resolver
          // landed start at the end of a whitespace text node between
          // elements — that node's parent is a far ancestor (article,
          // body), not the meaningful target. The bounding rect is
          // where the user actually wants to look. Also handles ranges
          // that span multiple elements (cross-cell, cross-paragraph)
          // by centering on the rect spanning all of them.
          const rect = nextRange.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) {
            const targetY = window.scrollY + rect.top + rect.height / 2 - window.innerHeight / 2;
            window.scrollTo({ top: Math.max(0, targetY), behavior: SCROLL_BEHAVIOR });
          } else {
            // Fallback for ranges with no client rects (e.g., inside
            // display:none subtree — unexpected for visible artifact
            // content, but defensive).
            const start = nextRange.startContainer;
            const parentEl = start instanceof Element ? start : start.parentElement;
            parentEl?.scrollIntoView({ behavior: SCROLL_BEHAVIOR, block: 'center' });
          }
        } catch {}
      }
    }

    // Repaint element-path focus (badge styling).
    if (prevId !== null) {
      const prevEntry = elementByAnchorId.get(prevId);
      prevEntry?.badge.classList.remove('focused');
    }
    if (nextId !== null) {
      const nextEntry = elementByAnchorId.get(nextId);
      if (nextEntry) {
        nextEntry.badge.classList.add('focused');
        try {
          nextEntry.el.scrollIntoView({ behavior: SCROLL_BEHAVIOR, block: 'center' });
        } catch {}
      }
    }
  }

  // ── Click-to-focus ───────────────────────────────────────────────
  // Clicking on a highlighted span (text-range) or a tracked element
  // (element-path) tells the parent to focus the matching thread.
  // No preventDefault — the artifact's own click handlers still run.

  let caretApiWarned = false;
  function warnNoCaretApiOnce() {
    if (caretApiWarned) return;
    caretApiWarned = true;
    log.warn('caretRangeFromPoint and caretPositionFromPoint both unavailable; click hit-test on text ranges disabled');
  }

  /**
   * Caret-based hit-test for text-range anchors. Uses the browser's own
   * caret-positioning logic (caretRangeFromPoint / caretPositionFromPoint)
   * and Range.comparePoint to decide which range — if any — contains the
   * click point. Overlapping ranges resolve to the smallest containing one.
   *
   * Returns the anchorId of the matching text-range anchor, or null.
   */
  function findTextRangeAtClick(event) {
    const x = event.clientX;
    const y = event.clientY;

    // Cheap reject: if no range's bounding box contains the click, skip the
    // caret lookup entirely. Bails out fast on the common case (click is
    // outside any highlight).
    let anyRectHit = false;
    outer: for (const range of rangeByAnchorId.values()) {
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i++) {
        const r = rects[i];
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          anyRectHit = true;
          break outer;
        }
      }
    }
    if (!anyRectHit) return null;

    // Authoritative lookup via caret API.
    let caretNode = null;
    let caretOffset = 0;
    if (typeof document.caretRangeFromPoint === 'function') {
      const r = document.caretRangeFromPoint(x, y);
      if (r) { caretNode = r.startContainer; caretOffset = r.startOffset; }
    } else if (typeof document.caretPositionFromPoint === 'function') {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { caretNode = p.offsetNode; caretOffset = p.offset; }
    } else {
      warnNoCaretApiOnce();
    }
    if (!caretNode) return null;

    let best = null;
    let bestLength = Infinity;
    for (const [anchorId, range] of rangeByAnchorId) {
      let inside = false;
      try {
        inside = range.comparePoint(caretNode, caretOffset) === 0;
      } catch (e) {
        // Range.comparePoint throws WrongDocumentError / InvalidNodeTypeError
        // on cross-document or bad-typed nodes. Neither is reachable with
        // caret API output, but catch defensively.
      }
      if (!inside) continue;
      const len = range.toString().length;
      if (len < bestLength) {
        best = anchorId;
        bestLength = len;
      }
    }
    return best;
  }

  function findAnchorAtClick(event) {
    // If the user just selected text by dragging, treat as selection capture,
    // not focus. (selection_captured fires on the same mouseup.)
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return null;

    const target = event.target instanceof Element ? event.target : null;
    if (!target) return null;

    // Pinned 💬 badge: matches its own data-anchor-id directly.
    const badge = target.closest('.__primer_badge__');
    if (badge instanceof HTMLElement && badge.dataset.anchorId) {
      return badge.dataset.anchorId;
    }

    // Element-path: check whether the click target is inside any tracked element.
    // Iterate the map; first match wins (these don't overlap in practice).
    for (const [anchorId, entry] of elementByAnchorId) {
      if (entry.el.contains(target)) return anchorId;
    }

    // Text-range: delegate to caret-based hit-test (more reliable than rects).
    return findTextRangeAtClick(event);
  }

  document.addEventListener('click', (event) => {
    // Pick mode owns clicks while active.
    if (pickActive) return;
    if (!port) return;
    const anchorId = findAnchorAtClick(event);
    if (!anchorId) return;
    port.postMessage({ type: 'anchor_clicked', anchorId });
  });

  // ── Overlay layer + element-pick badges ──────────────────────────

  const OVERLAY_ID = '__primer_overlay__';

  function ensureOverlay() {
    let overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
    document.body.appendChild(overlay);
    return overlay;
  }

  const PICK_BANNER_ID = '__primer_pick_banner__';

  function ensurePickBanner() {
    let el = document.getElementById(PICK_BANNER_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = PICK_BANNER_ID;
    el.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'right:0',
      'z-index:2147483647',
      'background:#111',
      'color:#fff',
      'font:14px/1.4 system-ui, sans-serif',
      'padding:10px 14px',
      'display:flex',
      'align-items:center',
      'justify-content:space-between',
      'gap:12px',
    ].join(';') + ';';
    el.innerHTML = '<span>Tap an element to add a comment</span>';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'background:transparent;color:#fff;border:1px solid #555;padding:4px 10px;border-radius:4px;font:inherit;cursor:pointer;';
    cancel.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      exitPickMode('banner');
    }, true);
    el.appendChild(cancel);
    document.body.appendChild(el);
    return el;
  }

  function removePickBanner() {
    const el = document.getElementById(PICK_BANNER_ID);
    if (el) el.remove();
  }

  async function sha256Hex(text) {
    const buf = new TextEncoder().encode(text);
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /** anchorId → { el, badge } for currently-rendered element-path anchors. */
  const elementByAnchorId = new Map();

  async function renderElementBadges() {
    const overlay = ensureOverlay();
    ensureStyleTag();

    // Clear stale.
    for (const { badge } of elementByAnchorId.values()) {
      badge.remove();
    }
    elementByAnchorId.clear();

    for (const a of knownAnchors) {
      if (a.data.type !== 'element-path') continue;
      let el = null;
      try {
        el = document.querySelector(a.data.path);
      } catch {
        el = null;
      }
      if (!el) {
        driftedIds.add(a.id);
        continue;
      }
      const expected = a.data.innerHash;
      const actual = (await sha256Hex(normalize(el.textContent ?? ''))).slice(0, 16);
      if (actual !== expected) {
        driftedIds.add(a.id);
        continue;
      }
      const badge = document.createElement('div');
      badge.className = '__primer_badge__';
      // Re-apply focus state across re-renders (update_anchors clears + rebuilds).
      if (a.id === focusedAnchorId) badge.classList.add('focused');
      badge.dataset.anchorId = a.id;
      badge.textContent = '💬';
      overlay.appendChild(badge);
      elementByAnchorId.set(a.id, { el, badge });
    }

    repositionElementBadges();
  }

  function repositionElementBadges() {
    for (const { el, badge } of elementByAnchorId.values()) {
      const rect = el.getBoundingClientRect();
      badge.style.left = `${rect.right + 4}px`;
      badge.style.top = `${rect.top}px`;
    }
  }

  // ── Pick mode ────────────────────────────────────────────────────

  let pickActive = false;
  let pickOutline = null;
  let prevBodyCursor = '';

  function enterPickMode() {
    if (pickActive) return;
    pickActive = true;
    prevBodyCursor = document.body.style.cursor;

    if (isTouchUA()) {
      // Touch UAs: no outline preview (finger covers it), use `pointer` cursor
      // so iOS Safari reliably synthesizes click on non-button elements.
      document.body.style.cursor = 'pointer';
      ensurePickBanner();
      document.addEventListener('click', onPickClick, true);
      document.addEventListener('touchend', onPickTouchEnd, true);
    } else {
      document.body.style.cursor = 'crosshair';
      pickOutline = document.createElement('div');
      pickOutline.className = '__primer_pick_outline__';
      ensureOverlay().appendChild(pickOutline);
      document.addEventListener('mousemove', onPickMove, true);
      document.addEventListener('click', onPickClick, true);
      document.addEventListener('keydown', onPickKey, true);
    }
  }

  function exitPickMode(reason /* 'click' | 'esc' | 'parent' | 'banner' */) {
    if (!pickActive) return;
    pickActive = false;
    _pickInFlight = false;
    document.body.style.cursor = prevBodyCursor;
    pickOutline?.remove();
    pickOutline = null;
    removePickBanner();

    document.removeEventListener('mousemove', onPickMove, true);
    document.removeEventListener('click', onPickClick, true);
    document.removeEventListener('touchend', onPickTouchEnd, true);
    document.removeEventListener('keydown', onPickKey, true);

    // 'click' exits are implicit in element_picked; 'parent' was parent-initiated.
    // 'esc' and 'banner' are user-initiated from inside the iframe — parent
    // needs an explicit pick_mode_exited to revert its UI.
    if ((reason === 'esc' || reason === 'banner') && port) {
      port.postMessage({ type: 'pick_mode_exited' });
    }
  }

  let pickMoveQueued = false;
  function onPickMove(e) {
    if (pickMoveQueued) return;
    pickMoveQueued = true;
    requestAnimationFrame(() => {
      pickMoveQueued = false;
      if (!pickActive || !pickOutline) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const r = target.getBoundingClientRect();
      pickOutline.style.left = `${r.left}px`;
      pickOutline.style.top = `${r.top}px`;
      pickOutline.style.width = `${r.width}px`;
      pickOutline.style.height = `${r.height}px`;
    });
  }

  let _pickInFlight = false;

  function onPickTouchEnd(e) {
    if (!pickActive || _pickInFlight) return;
    const t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    const target = document.elementFromPoint(t.clientX, t.clientY);
    if (!(target instanceof Element)) return;
    if (target.closest('#' + PICK_BANNER_ID)) return;
    _pickInFlight = true;
    // Synthesize the same flow as onPickClick.
    e.preventDefault();
    e.stopImmediatePropagation();
    void commitPick(target).finally(() => { _pickInFlight = false; });
  }

  async function onPickClick(e) {
    if (!pickActive || _pickInFlight) return;
    const target = e.target;
    if (!(target instanceof Element)) return;
    _pickInFlight = true;
    e.preventDefault();
    e.stopImmediatePropagation();
    try {
      await commitPick(target);
    } finally {
      _pickInFlight = false;
    }
  }

  async function commitPick(target) {
    const path = cssPath(target);
    const rawText = normalize(target.textContent ?? '');
    const innerHash = (await sha256Hex(rawText)).slice(0, 16);
    const innerText = rawText.length > 160 ? `${rawText.slice(0, 160)}…` : rawText;
    const clientRect = serializeRect(target.getBoundingClientRect());

    exitPickMode('click');

    if (port) {
      port.postMessage({
        type: 'element_picked',
        anchor: { type: 'element-path', path, innerHash, innerText },
        clientRect,
      });
    }
  }

  function onPickKey(e) {
    if (!pickActive) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      exitPickMode('esc');
    }
  }

  // ── Anchor positions + resize ────────────────────────────────────

  function computeAnchorPositions() {
    /** @type {{ anchorId: string, rects: any[], drifted?: boolean }[]} */
    const out = [];
    for (const a of knownAnchors) {
      if (driftedIds.has(a.id)) {
        out.push({ anchorId: a.id, rects: [], drifted: true });
        continue;
      }
      if (a.data.type === 'text-range') {
        const range = rangeByAnchorId.get(a.id);
        if (!range) {
          out.push({ anchorId: a.id, rects: [], drifted: true });
          continue;
        }
        out.push({
          anchorId: a.id,
          rects: Array.from(range.getClientRects()).map(serializeRect),
        });
      } else {
        const entry = elementByAnchorId.get(a.id);
        if (!entry) {
          out.push({ anchorId: a.id, rects: [], drifted: true });
          continue;
        }
        out.push({
          anchorId: a.id,
          rects: [serializeRect(entry.el.getBoundingClientRect())],
        });
      }
    }
    return out;
  }

  // ── Content width reporting (fit-to-width) ───────────────────────
  // The parent scales the iframe down on narrow screens when the artifact
  // is intrinsically wider than the container. Only overflow is reported
  // (scrollWidth > clientWidth * 1.02) and only when the value changes.
  // Guard logic mirrored in contentMetrics.test.ts; tolerance mirrored in
  // apps/web/src/lib/fitToWidth.ts (FIT_OVERFLOW_TOLERANCE). Keep in sync.
  let lastReportedContentWidth = 0;
  let contentMetricsTimer = null;

  function reportContentMetrics() {
    if (!port) return;
    try {
      const doc = document.documentElement;
      const body = document.body;
      const clientWidth = doc ? doc.clientWidth : 0;
      const contentWidth = Math.max(
        doc ? doc.scrollWidth : 0,
        body ? body.scrollWidth : 0,
      );
      if (!(contentWidth > 0) || !(clientWidth > 0)) return;
      if (contentWidth <= clientWidth * 1.02) return;
      if (contentWidth === lastReportedContentWidth) return;
      lastReportedContentWidth = contentWidth;
      port.postMessage({ type: 'content_metrics', contentWidth });
    } catch (e) {
      // Non-fatal: fit-to-width just won't engage.
    }
  }

  function scheduleContentMetrics() {
    if (contentMetricsTimer !== null) return;
    contentMetricsTimer = setTimeout(function () {
      contentMetricsTimer = null;
      reportContentMetrics();
    }, 150);
  }

  // ── Resize observer ──────────────────────────────────────────────

  const ro = new ResizeObserver(() => {
    repositionElementBadges();
    scheduleSelectionRectsRefresh();
    if (port) {
      const h = document.documentElement.scrollHeight || document.body.scrollHeight;
      port.postMessage({ type: 'resize', height: h });
    }
    scheduleContentMetrics();
  });
  ro.observe(document.body);

  // ── Scroll tracking for element-pick badges + pending selection ──
  // Scroll doesn't bubble; capture-phase on window picks up scrolls from
  // any scrollable ancestor. CSS Custom Highlights follow scroll on their
  // own (browser-rendered), so only the overlay badges need repositioning.
  // The pending selection's clientRects also shift on scroll — we re-emit
  // them so the parent's "Add comment" pill tracks the selection.
  window.addEventListener(
    'scroll',
    () => {
      repositionElementBadges();
      scheduleSelectionRectsRefresh();
    },
    { passive: true, capture: true }
  );
})();
