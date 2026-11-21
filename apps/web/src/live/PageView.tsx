import { useEffect, useMemo, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import type { LivePageInfo, Target } from '@polygonlabs/primer-api-types';
import type { InboundProtocolMessage, OutboundProtocolMessage, SerializableRect } from '../companion/protocol.ts';
import { ArtifactIframe, type PageFrame } from '../components/ArtifactIframe.tsx';
import { api } from '../lib/fetch.ts';
import { t } from '../i18n/index.ts';
import { Overlay, subFragmentName, type OverlayRect } from './Overlay.tsx';
import { editablePids, embedHtml, fragmentText } from './pageBridge.ts';
import type { StoreViewer } from './PrimerThreadStore.ts';

export type PageViewContext = {
  doc: Y.Doc;
  documentId: string;
  tabId: string;
  canEdit: boolean;
  theme: 'light' | 'dark';
  viewer: StoreViewer & { name: string };
  /** The document route's handlers for what a frame asks of the host (links
   *  out, event submissions) and its sender registration (their acks). */
  onArtifactMessage?: (msg: InboundProtocolMessage) => void;
  registerArtifactSender?: (send: ((msg: OutboundProtocolMessage) => void) | null) => void;
};

type Open = { target: Target; kind: 'text' | 'blocks' };

/**
 * A page block in the live editor (M6): the agent's page in its sandboxed
 * frame, showing people's current text, with the overlay for editing it.
 *
 * The frame is served the page as published; after it reports its elements
 * (page_elements: DOM text and rects) the host pushes the current text of
 * every pid and the HTML of every Primer block, and pushes again whenever
 * those fragments change. A pid whose reported text isn't its source text was
 * drawn by a script and is read-only.
 */
export function PageView(props: PageViewContext & { blockId: string; title: string; sourceKey: string }) {
  const { doc, documentId, tabId, blockId, sourceKey } = props;
  const src = `/api/documents/${documentId}/pages/${blockId}/content`;
  const [info, setInfo] = useState<LivePageInfo | null>(null);
  const [reported, setReported] = useState<{ pid: string; text: string }[] | null>(null);
  const [rects, setRects] = useState<Record<string, SerializableRect>>({});
  const [embedRects, setEmbedRects] = useState<Record<string, SerializableRect>>({});
  const [open, setOpen] = useState<Open | null>(null);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const post = useRef<((msg: OutboundProtocolMessage) => void) | null>(null);

  // A republish switches the block's source: read the new page's texts and frame again.
  useEffect(() => {
    let live = true;
    setReported(null);
    void api(`/api/documents/${documentId}/pages/${blockId}`).then(async (res) => {
      if (live && res.ok) setInfo((await res.json()) as LivePageInfo);
    });
    return () => {
      live = false;
    };
  }, [documentId, blockId, sourceKey]);

  // The overlay follows the frame when the host scrolls or resizes.
  const [, setLayout] = useState(0);
  useEffect(() => {
    if (!open) return;
    const relayout = () => setLayout((n) => n + 1);
    window.addEventListener('scroll', relayout, true);
    window.addEventListener('resize', relayout);
    return () => {
      window.removeEventListener('scroll', relayout, true);
      window.removeEventListener('resize', relayout);
    };
  }, [open]);

  const editable = useMemo(() => (info && reported ? editablePids(info.texts, reported) : new Set<string>()), [info, reported]);

  // Push current texts and embeds once the page reported, and on every change.
  useEffect(() => {
    if (!info || !reported) return;
    // Script-drawn text stays as the script drew it.
    const pids = Object.keys(info.texts).filter((pid) => editable.has(pid));
    const pidTarget = (pid: string): Target => ({ tabId, blockId, pid });
    const embedTarget = (embedId: string): Target => ({ tabId, blockId, embedId });
    const read = (fragment: Y.XmlFragment) => yXmlFragmentToProsemirrorJSON(fragment) as Parameters<typeof fragmentText>[0];
    const pushTexts = (only?: string[]) => {
      const texts: Record<string, string> = {};
      for (const pid of only ?? pids) {
        const fragment = doc.getXmlFragment(subFragmentName(pidTarget(pid)));
        if (fragment.length > 0) texts[pid] = fragmentText(read(fragment));
      }
      post.current?.({ type: 'set_page_texts', texts });
    };
    const pushEmbeds = (only?: string[]) => {
      const embeds: Record<string, string> = {};
      for (const embedId of only ?? info.embeds.map((e) => e.embedId)) {
        const fragment = doc.getXmlFragment(subFragmentName(embedTarget(embedId)));
        if (fragment.length > 0) embeds[embedId] = embedHtml(read(fragment));
      }
      if (Object.keys(embeds).length > 0) post.current?.({ type: 'set_embeds', embeds });
    };
    pushTexts();
    pushEmbeds();
    const off: (() => void)[] = [];
    for (const pid of pids) {
      const fragment = doc.getXmlFragment(subFragmentName(pidTarget(pid)));
      const onChange = () => pushTexts([pid]);
      fragment.observeDeep(onChange);
      off.push(() => fragment.unobserveDeep(onChange));
    }
    for (const { embedId } of info.embeds) {
      const fragment = doc.getXmlFragment(subFragmentName(embedTarget(embedId)));
      const onChange = () => pushEmbeds([embedId]);
      fragment.observeDeep(onChange);
      off.push(() => fragment.unobserveDeep(onChange));
    }
    return () => off.forEach((f) => f());
  }, [doc, info, reported, editable, tabId, blockId]);

  const page = useMemo<PageFrame>(
    () => ({
      features: ['page-text', 'embeds'],
      attach: (p) => {
        post.current = p;
        if (!p) setReported(null);
      },
      handle: (msg: InboundProtocolMessage) => {
        switch (msg.type) {
          case 'page_elements':
            setReported(msg.elements.map(({ pid, text }) => ({ pid, text })));
            setRects(Object.fromEntries(msg.elements.map((e) => [e.pid, e.rect])));
            setEmbedRects(Object.fromEntries(msg.embeds.map((e) => [e.embedId, e.rect])));
            return true;
          case 'page_rects':
            setRects(msg.rects);
            setEmbedRects(msg.embedRects);
            return true;
          case 'pid_clicked':
            setOpen({ target: { tabId, blockId, pid: msg.pid }, kind: 'text' });
            return true;
          case 'embed_clicked':
            setOpen({ target: { tabId, blockId, embedId: msg.embedId }, kind: 'blocks' });
            return true;
          default:
            return false;
        }
      },
    }),
    [tabId, blockId],
  );

  // Only pids the page shows as authored open; script-drawn text stays read-only.
  const openable = open && (open.target.pid ? editable.has(open.target.pid) : info?.embeds.some((e) => e.embedId === open.target.embedId));
  const inner = open ? (open.target.pid ? rects[open.target.pid] : embedRects[open.target.embedId!]) : undefined;
  let rect: OverlayRect | null = null;
  if (openable && inner && frame.current) {
    const box = frame.current.getBoundingClientRect();
    rect = { x: box.left + inner.x, y: box.top + inner.y, width: inner.width, height: inner.height };
  }

  return (
    <div className="primer-page w-full" data-primer-page={blockId} contentEditable={false} style={{ height: '70vh' }}>
      <ArtifactIframe
        key={sourceKey}
        src={src}
        anchors={[]}
        theme={props.theme}
        // Only what a page asks of the host: its comments live in the overlay editor.
        onMessage={(msg) => {
          if (msg.type === 'open_external' || msg.type === 'submit_events') props.onArtifactMessage?.(msg);
        }}
        registerSender={props.registerArtifactSender}
        page={page}
        frameRef={(el) => {
          frame.current = el;
        }}
      />
      {open && rect && (
        <Overlay
          doc={doc}
          documentId={documentId}
          target={open.target}
          rect={rect}
          kind={open.kind}
          readOnly={!props.canEdit}
          theme={props.theme}
          viewer={props.viewer}
          onClose={() => setOpen(null)}
        />
      )}
      {open && !openable && reported && (
        <p role="status" className="mt-1 text-xs text-neutral-500">
          {t('page.readOnlyText')}
        </p>
      )}
    </div>
  );
}
