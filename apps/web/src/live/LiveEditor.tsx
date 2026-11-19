import { useEffect, useMemo, useState } from 'react';
import { BlockNoteViewEditor, useCreateBlockNote } from '@blocknote/react';
import { VersioningSidebar } from '@blocknote/react/versioning';
import { BlockNoteView } from '@blocknote/ariakit';
import { withCollaboration, YjsVersioningExtension } from '@blocknote/core/yjs';
import { createExtension } from '@blocknote/core';
import { CommentsExtension } from '@blocknote/core/comments';
import { ThreadsSidebar } from '@blocknote/react';
import * as locales from '@blocknote/core/locales';
import { primerSchema } from '@primer/blocks';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/ariakit/style.css';
import type { DocFileUploadResponse, ViewerRole } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';
import { ConnectionStatus } from './ConnectionStatus.tsx';
import { AgentStatus } from './AgentStatus.tsx';
import { createLiveProvider, type LiveProvider } from './provider.ts';
import { PrimerVersionStorage } from './versionStorage.ts';
import { TabStrip, useTabs } from './TabStrip.tsx';
import { MAIN_TAB, tabFragmentName } from './tabs.ts';
import { PrimerThreadStore } from './PrimerThreadStore.ts';
import { commentDeleteGuard, type HeldDelete } from './commentDeleteGuard.ts';
import { DeleteCommentedDialog } from './DeleteCommentedDialog.tsx';
import { useThreadEvents } from './threadEvents.ts';
import { SuggestionsPanel } from './SuggestionsPanel.tsx';

export type LiveEditorProps = {
  documentId: string;
  readOnly: boolean;
  theme: 'light' | 'dark';
  /** Shown on this viewer's cursor to everyone else. */
  userName: string;
  userId: string;
  role: ViewerRole;
};

/**
 * A live document in BlockNote, synced over `/collab`, one editor per tab: stock blocks, the
 * Ariakit UI (slash menu, formatting toolbar, side menu, table handles, file
 * panel), collaboration cursors and BlockNote's version history over Primer's
 * checkpoints. Files upload to the document and are stored as opaque
 * `primer-blob://` ids, resolved to an authorised link at read time.
 */
export default function LiveEditor(props: LiveEditorProps) {
  // The connection is made and torn down by one effect, so a remount (React
  // runs effects twice in development) never reuses a destroyed provider.
  const [live, setLive] = useState<LiveProvider | null>(null);
  useEffect(() => {
    const created = createLiveProvider(props.documentId);
    setLive(created);
    return () => created.destroy();
  }, [props.documentId]);
  if (!live) return null;
  return <LiveEditorView key={live.doc.guid} live={live} {...props} />;
}

function LiveEditorView(props: LiveEditorProps & { live: LiveProvider }) {
  const tabs = useTabs(props.live.doc);
  const [selected, setSelected] = useState(MAIN_TAB);
  // A tab someone else deleted falls back to the first.
  const active = tabs.some((t) => t.id === selected) ? selected : MAIN_TAB;
  return (
    <div className="flex h-full flex-col" data-live-editor={props.documentId}>
      <ConnectionStatus provider={props.live.provider} />
      <AgentStatus provider={props.live.provider} />
      <TabStrip doc={props.live.doc} tabs={tabs} active={active} onSelect={setSelected} readOnly={props.readOnly} />
      {/* One editor per tab fragment, mounted when its tab is opened. */}
      <TabEditor key={active} tabId={active} {...props} />
    </div>
  );
}

function TabEditor({ live, tabId, documentId, readOnly, theme, userName, userId, role }: LiveEditorProps & { live: LiveProvider; tabId: string }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionCount, setSuggestionCount] = useState(0);
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [held, setHeld] = useState<HeldDelete | null>(null);
  const threadStore = useMemo(
    () =>
      new PrimerThreadStore(documentId, tabId, {
        id: userId,
        isOwner: role === 'owner',
        canComment: role !== 'stranger',
      }),
    [documentId, tabId, userId, role],
  );
  useThreadEvents(documentId, () => void threadStore.refresh());

  const editor = useCreateBlockNote(
    withCollaboration({
      schema: primerSchema,
      extensions: [
        // Comments on Primer's threads; the server writes their marks.
        CommentsExtension({
          threadStore,
          resolveUsers: async (ids: string[]) =>
            ids.map((id) => {
              const username = threadStore.names.get(id) ?? id;
              return { id, username, avatarUrl: initialsAvatar(username) };
            }),
        }),
        createExtension({
          key: 'primerCommentDeleteGuard',
          prosemirrorPlugins: [
            commentDeleteGuard({
              openThreadIds: () => threadStore.openThreadIds(),
              quoteOf: (id) => threadStore.quoteOf(id),
              onHold: setHeld,
              dispatch: (tr) => threadStore.editor?._tiptapEditor.view.dispatch(tr),
              currentDoc: () => threadStore.editor!.prosemirrorState.doc,
            }),
          ],
        }),
        YjsVersioningExtension({ storage: new PrimerVersionStorage(documentId) }),
      ],
      collaboration: {
        provider: { awareness: live.provider.awareness ?? undefined },
        fragment: live.doc.getXmlFragment(tabFragmentName(tabId)),
        user: { name: userName, color: colorFor(userName) },
      },
      dictionary: dictionaryFor(typeof navigator === 'undefined' ? 'en' : navigator.language),
      uploadFile: async (file: File) => {
        const form = new FormData();
        form.append('file', file);
        const res = await api(`/api/documents/${documentId}/files`, { method: 'POST', body: form });
        if (!res.ok) throw new Error(`upload failed: ${res.status}`);
        return ((await res.json()) as DocFileUploadResponse).url;
      },
      resolveFileUrl: async (url: string) =>
        url.startsWith('primer-blob://')
          ? `/api/files/${encodeURIComponent(url.slice('primer-blob://'.length))}?doc=${encodeURIComponent(documentId)}`
          : url,
    }),
    [live, tabId, threadStore],
  );
  useEffect(() => {
    threadStore.editor = editor;
    void threadStore.refresh();
  }, [editor, threadStore]);

  return (
    <>
      <div className="flex items-center justify-end gap-2 px-4 pt-2">
        <button
          type="button"
          onClick={() => setCommentsOpen((open) => !open)}
          aria-pressed={commentsOpen}
          className="h-7 rounded border border-neutral-300 px-3 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Comments
        </button>
        <button
          type="button"
          onClick={() => setSuggestionsOpen((open) => !open)}
          aria-pressed={suggestionsOpen}
          className="h-7 rounded border border-neutral-300 px-3 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Suggestions{suggestionCount > 0 ? ` (${suggestionCount})` : ''}
        </button>
        <button
          type="button"
          onClick={() => setHistoryOpen((open) => !open)}
          aria-pressed={historyOpen}
          className="h-7 rounded border border-neutral-300 px-3 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          History
        </button>
      </div>
      <BlockNoteView editor={editor} editable={!readOnly} theme={theme} renderEditor={false} className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto py-4">
          <BlockNoteViewEditor />
        </div>
        {commentsOpen && (
          <div className="w-80 shrink-0 overflow-y-auto border-l border-neutral-200 p-2 dark:border-neutral-800" data-threads-sidebar>
            <select
              aria-label="Show comments"
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
              className="mb-2 h-7 rounded border border-neutral-300 bg-transparent px-2 text-xs dark:border-neutral-700"
            >
              <option value="open">Open</option>
              <option value="resolved">Resolved</option>
              <option value="all">All</option>
            </select>
            <ThreadsSidebar filter={filter} />
          </div>
        )}
        <div
          hidden={!suggestionsOpen}
          className="w-80 shrink-0 overflow-y-auto border-l border-neutral-200 p-2 dark:border-neutral-800"
        >
          <SuggestionsPanel
            documentId={documentId}
            tabId={tabId}
            canDecide={role === 'owner' || role === 'editor'}
            onCount={setSuggestionCount}
            onShow={(blockId) => editor.setTextCursorPosition(blockId, 'start')}
          />
        </div>
        {historyOpen && (
          <div className="w-80 shrink-0 overflow-y-auto border-l border-neutral-200 dark:border-neutral-800">
            <VersioningSidebar onClose={() => setHistoryOpen(false)} />
          </div>
        )}
      </BlockNoteView>
      {held && <DeleteCommentedDialog held={held} onClose={() => setHeld(null)} />}
    </>
  );
}

/** A small initials badge, so comments need no avatar service. */
function initialsAvatar(name: string): string {
  const initials = name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="16" fill="${colorFor(name)}"/><text x="16" y="21" font-family="sans-serif" font-size="13" fill="white" text-anchor="middle">${initials.replace(/[<>&"]/g, '')}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f'];

function colorFor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length]!;
}

function dictionaryFor(language: string) {
  const all = locales as unknown as Record<string, typeof locales.en>;
  return all[language.toLowerCase().split('-')[0] ?? 'en'] ?? locales.en;
}
