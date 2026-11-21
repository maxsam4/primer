import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { isWidgetAttributeValue, type DataPointAnchor, type Target, type ThreadDTO, type ThreadsListResponse, type WidgetPartAnchor } from '@polygonlabs/primer-api-types';
import type { WidgetBlockProps } from '@primer/blocks';
import { api } from '../lib/fetch.ts';
import { t } from '../i18n/index.ts';
import { Overlay, subFragmentName, type OverlayRect } from './Overlay.tsx';
import type { PageViewContext } from './PageView.tsx';
import { fragmentText } from './pageBridge.ts';
import { useThreadEvents } from './threadEvents.ts';
import './widget.css';
import robotoRegular from 'roboto-fontface/fonts/roboto/Roboto-Regular.woff2?url';
import robotoMedium from 'roboto-fontface/fonts/roboto/Roboto-Medium.woff2?url';
import robotoBold from 'roboto-fontface/fonts/roboto/Roboto-Bold.woff2?url';

let fontLoaded = false;

/** Widgets draw in Roboto here and on the server (apps/api/src/widgets/raster.ts),
 *  so the page shows what the agent's preview showed. */
function loadWidgetFont(): void {
  if (fontLoaded || typeof FontFace === 'undefined' || typeof document === 'undefined') return;
  fontLoaded = true;
  for (const [url, weight] of [[robotoRegular, '400'], [robotoMedium, '500'], [robotoBold, '700']] as const) {
    const face = new FontFace('Roboto', `url(${url}) format('woff2')`, { weight });
    document.fonts.add(face);
    void face.load().catch(() => undefined);
  }
}

type WidgetAnchor = WidgetPartAnchor | DataPointAnchor;
type Picked = { anchor: WidgetAnchor; rect: OverlayRect };

/** The words a thread on a part or a data point names: the part, or row · column. */
export function anchorName(anchor: WidgetAnchor): string {
  return anchor.type === 'widget-part' ? anchor.anchor : `${anchor.row} · ${anchor.column}`;
}

/** The part or data point a click landed on: a mark drawn from a row first, then its named group. */
export function anchorAt(el: Element, target: Target): WidgetAnchor | null {
  const mark = el.closest('[data-row][data-col]');
  if (mark) return { type: 'data-point', target, row: mark.getAttribute('data-row')!, column: mark.getAttribute('data-col')! };
  const part = el.closest('[data-anchor]');
  if (part) return { type: 'widget-part', target, anchor: part.getAttribute('data-anchor')! };
  return null;
}

/** A value inside a quoted attribute selector. */
const attr = (value: string) => value.replace(/["\\]/g, '\\$&');

/** The SVG elements a thread's anchor names. */
function anchorElements(root: Element, anchor: WidgetAnchor): Element[] {
  const sel =
    anchor.type === 'widget-part'
      ? `[data-anchor="${attr(anchor.anchor)}"]`
      : `[data-row="${attr(anchor.row)}"][data-col="${attr(anchor.column)}"]`;
  return [...root.querySelectorAll(sel)];
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// The server's SVG allowlist (apps/api/src/upload/sanitize.ts SVG_TAGS,
// SVG_TAG_ATTRS and SVG_PRESENTATION_ATTRS, as widgets/serialize.ts applies it).
const PRESENTATION = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'opacity', 'transform', 'font-size', 'font-weight',
  'font-style', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'word-spacing',
  'clip-path', 'mask', 'filter', 'marker-start', 'marker-mid', 'marker-end',
  'id', 'data-text-id', 'data-anchor', 'data-row', 'data-col',
];
const TAG_ATTRS: Record<string, string[]> = {
  svg: ['viewBox', 'xmlns', 'preserveAspectRatio', 'width', 'height', 'role', 'aria-label', 'aria-labelledby', 'aria-describedby', 'font-family'],
  g: [], defs: [], title: [], desc: [], symbol: [], textPath: [],
  use: ['href', 'x', 'y', 'width', 'height'],
  path: ['d', 'pathLength'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  polyline: ['points'],
  polygon: ['points'],
  text: ['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust'],
  tspan: ['x', 'y', 'dx', 'dy', 'rotate', 'textLength', 'lengthAdjust'],
  marker: ['markerWidth', 'markerHeight', 'markerUnits', 'refX', 'refY', 'orient', 'viewBox'],
  linearGradient: ['x1', 'y1', 'x2', 'y2', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
  radialGradient: ['cx', 'cy', 'r', 'fx', 'fy', 'gradientUnits', 'gradientTransform', 'spreadMethod'],
  stop: ['offset', 'stop-color', 'stop-opacity'],
  clipPath: ['clipPathUnits'],
  mask: ['maskUnits', 'maskContentUnits', 'x', 'y', 'width', 'height'],
  pattern: ['patternUnits', 'patternContentUnits', 'patternTransform', 'x', 'y', 'width', 'height', 'viewBox'],
  filter: ['x', 'y', 'width', 'height', 'filterUnits', 'primitiveUnits'],
};

/**
 * The widget SVG as a checked element tree, or null. The server allowlists
 * every render (apps/api/src/widgets/serialize.ts); this second check keeps
 * the host window safe should that ever slip, since the SVG sits in Primer's
 * own page, not a sandbox. The string is parsed once, as XML, and only the
 * checked nodes are mounted (`importNode`), never the string itself, so no
 * second parser can read it differently. Anything but SVG elements and text
 * (comments, CDATA, processing instructions, another namespace), and any tag
 * or attribute outside the allowlist, refuses the whole widget.
 */
export function parseSafeSvg(text: string): Element | null {
  const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = parsed.documentElement;
  if (parsed.getElementsByTagName('parsererror').length > 0 || root.localName !== 'svg') return null;
  for (const child of parsed.childNodes) if (child !== root) return null; // a doctype, PI or comment outside the root
  const ok = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) return true;
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const el = node as Element;
    const allowed = TAG_ATTRS[el.localName];
    if (el.namespaceURI !== SVG_NS || el.prefix !== null || !allowed) return false;
    for (const a of el.attributes) {
      if (a.name === 'xmlns' && el === root) continue;
      if (a.namespaceURI !== null || (!allowed.includes(a.name) && !PRESENTATION.includes(a.name))) return false;
      if (a.name === 'href' && !/^#[\w-]+$/.test(a.value)) return false;
      if (!isWidgetAttributeValue(a.name, a.value)) return false;
    }
    return [...el.childNodes].every(ok);
  };
  return ok(root) ? root : null;
}

/** Each label's current words into its `[data-text-id]` element. */
export function applyLabels(root: Element, labels: Record<string, string>): void {
  for (const [textId, words] of Object.entries(labels)) {
    const el = root.querySelector(`[data-text-id="${attr(textId)}"]`);
    if (el && el.textContent !== words) el.textContent = words;
  }
}

/**
 * A widget block in the live editor (M8): the published SVG for the page's
 * theme, inline (the server allowlisted it), with each label showing its
 * current words from the document. Clicking a label opens the shared overlay
 * on that label's fragment: people with edit rights change its words, and
 * anyone who may comment comments on them. Clicking a mark drawn from a row,
 * or a named part, comments on that data point or part.
 */
export function WidgetView(props: PageViewContext & { blockId: string; props: WidgetBlockProps }) {
  const { doc, documentId, tabId, blockId, theme, viewer } = props;
  const { widgetId, hash } = props.props;
  const textIds = props.props.textIds.split(' ').filter(Boolean);
  const box = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<Element | null>(null);
  const [failed, setFailed] = useState(false);
  const [label, setLabel] = useState<{ textId: string; rect: OverlayRect } | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [threads, setThreads] = useState<ThreadDTO[]>([]);
  const target: Target = { tabId, blockId };
  useEffect(loadWidgetFont, []);

  // The live publish, redrawn when it changes (its hash is on the block) or the theme flips.
  useEffect(() => {
    if (!widgetId || !hash) return;
    let live = true;
    void api(`/api/widgets/${encodeURIComponent(widgetId)}/image?theme=${theme}&v=${hash}`).then(async (res) => {
      if (!live) return;
      const raw = res.ok ? await res.text() : '';
      const safe = res.ok ? parseSafeSvg(raw) : null;
      setFailed(safe === null);
      setSvg(safe);
    });
    return () => {
      live = false;
    };
  }, [widgetId, hash, theme]);

  // The checked tree is mounted as nodes, never as markup.
  useLayoutEffect(() => {
    box.current?.replaceChildren(...(svg ? [document.importNode(svg, true)] : []));
  }, [svg, hash]);

  // Labels show their current words, and follow every edit.
  useLayoutEffect(() => {
    const root = box.current;
    if (!root || !svg) return;
    const fragments = textIds.map((textId) => ({ textId, fragment: doc.getXmlFragment(subFragmentName({ tabId, blockId, textId })) }));
    const push = () => {
      const labels: Record<string, string> = {};
      for (const { textId, fragment } of fragments) {
        if (fragment.length > 0) labels[textId] = fragmentText(yXmlFragmentToProsemirrorJSON(fragment) as Parameters<typeof fragmentText>[0]);
      }
      applyLabels(root, labels);
    };
    push();
    for (const { fragment } of fragments) fragment.observeDeep(push);
    return () => fragments.forEach(({ fragment }) => fragment.unobserveDeep(push));
  }, [doc, svg, tabId, blockId, props.props.textIds]);

  const refresh = useCallback(() => {
    void api(`/api/documents/${encodeURIComponent(documentId)}/threads`).then(async (res) => {
      if (!res.ok) return;
      const body = (await res.json()) as ThreadsListResponse;
      setThreads(
        body.threads.filter(
          (th) => (th.anchor.type === 'widget-part' || th.anchor.type === 'data-point') && th.anchor.target.blockId === blockId && th.resolvedAt === null,
        ),
      );
    });
  }, [documentId, blockId]);
  useEffect(refresh, [refresh]);
  useThreadEvents(documentId, refresh);

  // Parts and points with open threads are marked.
  useLayoutEffect(() => {
    const root = box.current;
    if (!root || !svg) return;
    root.querySelectorAll('.primer-widget-commented').forEach((el) => el.classList.remove('primer-widget-commented'));
    for (const th of threads) for (const el of anchorElements(root, th.anchor as WidgetAnchor)) el.classList.add('primer-widget-commented');
  }, [svg, threads]);

  const rectOf = (el: Element): OverlayRect => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  };

  const onClick = (e: React.MouseEvent) => {
    const el = e.target as Element;
    const text = el.closest('[data-text-id]');
    if (text && box.current?.contains(text)) {
      setPicked(null);
      setLabel({ textId: text.getAttribute('data-text-id')!, rect: rectOf(text) });
      return;
    }
    const anchor = viewer.canComment ? anchorAt(el, target) : null;
    if (anchor) {
      setLabel(null);
      setPicked({ anchor, rect: rectOf(el.closest('[data-row][data-col], [data-anchor]')!) });
    }
  };

  if (!hash) {
    return (
      <div className="primer-widget primer-widget-empty" data-widget-id={widgetId} contentEditable={false}>
        {t('widget.drawing')}
      </div>
    );
  }
  return (
    <div className="primer-widget" data-widget-id={widgetId} contentEditable={false}>
      {failed && <p className="text-xs text-red-600">{t('widget.unavailable')}</p>}
      <div ref={box} className="primer-widget-svg" onClick={onClick} />
      {threads.length > 0 && (
        <ul className="primer-widget-threads" aria-label={t('widget.comments')}>
          {threads.map((th) => (
            <li key={th.id}>
              <span className="primer-widget-thread-anchor">{anchorName(th.anchor as WidgetAnchor)}</span>
              <span>{th.comments[0]?.body}</span>
              {th.comments.length > 1 && <span className="text-neutral-500">{t('widget.replies', { count: String(th.comments.length - 1) })}</span>}
            </li>
          ))}
        </ul>
      )}
      {label && (
        <Overlay
          doc={doc}
          documentId={documentId}
          target={{ tabId, blockId, textId: label.textId }}
          rect={label.rect}
          kind="text"
          readOnly={!props.canEdit}
          theme={theme}
          viewer={viewer}
          onClose={() => setLabel(null)}
        />
      )}
      {picked && <AnchorComposer documentId={documentId} picked={picked} onDone={(posted) => (setPicked(null), posted && refresh())} />}
    </div>
  );
}

/** A comment on one part or data point, written in a small box beside it. */
function AnchorComposer(props: { documentId: string; picked: Picked; onDone: (posted: boolean) => void }) {
  const { picked } = props;
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const post = async () => {
    const res = await api(`/api/documents/${encodeURIComponent(props.documentId)}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anchor: picked.anchor, body }),
    });
    if (res.ok) return props.onDone(true);
    const out = (await res.json().catch(() => null)) as { refusal?: { message?: string } } | null;
    setError(out?.refusal?.message ?? t('widget.commentFailed'));
  };
  return (
    <div
      role="dialog"
      aria-label={t('widget.commentOn', { name: anchorName(picked.anchor) })}
      className="primer-widget-composer fixed z-50 w-72 rounded border border-neutral-300 bg-white p-2 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
      // Below the mark, kept on screen (it is fixed, so it can't be scrolled to).
      style={{
        left: Math.max(8, Math.min(picked.rect.x, window.innerWidth - 300)),
        top: Math.max(8, Math.min(picked.rect.y + picked.rect.height + 6, window.innerHeight - 180)),
      }}
    >
      <p className="mb-1 text-xs text-neutral-500">{t('widget.commentOn', { name: anchorName(picked.anchor) })}</p>
      <textarea
        className="w-full rounded border border-neutral-300 p-1 text-sm dark:border-neutral-700 dark:bg-neutral-800"
        rows={3}
        value={body}
        autoFocus
        placeholder={t('widget.commentPlaceholder')}
        onChange={(e) => setBody(e.target.value)}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="mt-1 flex justify-end gap-2">
        <button type="button" className="text-sm" onClick={() => props.onDone(false)}>
          {t('widget.cancel')}
        </button>
        <button type="button" className="rounded bg-sky-600 px-2 py-0.5 text-sm text-white disabled:opacity-50" disabled={!body.trim()} onClick={() => void post()}>
          {t('widget.comment')}
        </button>
      </div>
    </div>
  );
}
