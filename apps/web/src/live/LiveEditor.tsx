import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BlockNoteViewEditor, useCreateBlockNote } from '@blocknote/react';
import { insertOrUpdateBlockForSlashMenu } from '@blocknote/core/extensions';
import { VersioningSidebar } from '@blocknote/react/versioning';
import { BlockNoteView } from '@blocknote/ariakit';
import { withCollaboration, YjsVersioningExtension } from '@blocknote/core/yjs';
import { createExtension } from '@blocknote/core';
import { CommentsExtension } from '@blocknote/core/comments';
import { ThreadsSidebar } from '@blocknote/react';
import { PrimerBlocksContext, primerSchema, type DataTableBlockProps, type WidgetBlockProps } from '@primer/blocks';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/ariakit/style.css';
import './editorTheme.css';
import type { CatchUpSince, DocFileUploadResponse, Target, ViewerRole } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';
import { ConnectionStatus } from './ConnectionStatus.tsx';
import { AgentStatus } from './AgentStatus.tsx';
import { createLiveProvider, type LiveProvider } from './provider.ts';
import { editorDictionary, t } from '../i18n/index.ts';
import { ChipMenus } from './ChipMenus.tsx';
import { routeMarkdownPasteToServer } from './paste.ts';
import { PrimerVersionStorage } from './versionStorage.ts';
import { TabStrip, useTabs } from './TabStrip.tsx';
import { MAIN_TAB, tabFragmentName } from './tabs.ts';
import { PrimerThreadStore } from './PrimerThreadStore.ts';
import { commentDeleteGuard, type HeldDelete } from './commentDeleteGuard.ts';
import { DeleteCommentedDialog } from './DeleteCommentedDialog.tsx';
import { relayLiveEvents, useThreadEvents } from './threadEvents.ts';
import { SuggestionsPanel } from './SuggestionsPanel.tsx';
import { SuggestDraft } from './SuggestDraft.tsx';
import { ThreadActions } from './ThreadActions.tsx';
import { CatchUpPanel, ChangeHighlights, useCheckpointChanges } from './changes.tsx';
import { useBlockServices, type ChoiceStore } from './blockServices.ts';
import { DecisionRegister } from './DecisionRegister.tsx';
import { PageView, type PageViewContext } from './PageView.tsx';
import { WidgetView } from './WidgetView.tsx';
import { DataTableView, type DataTableViewProps } from './DataTableView.tsx';
import './blocks.css';

export type LiveEditorProps = {
  documentId: string;
  readOnly: boolean;
  /** Whether this viewer may vote on choices (owner, editor or responder). */
  canVote: boolean;
  theme: 'light' | 'dark';
  /** Shown on this viewer's cursor to everyone else. */
  userName: string;
  userId: string;
  role: ViewerRole;
  canComment: boolean;
  /** Opens a version from before the document went live in the version viewer. */
  onOpenLegacyVersion?: (versionNumber: number) => void;
  /** The viewer's previous visit (document detail `lastView`): catch-up shows what changed since. */
  lastView?: CatchUpSince | null;
  /** The document route's handling of what a page frame asks of the host
   *  (open_external, submit_events) and the sender it acks through. */
  onArtifactMessage?: PageViewContext['onArtifactMessage'];
  registerArtifactSender?: PageViewContext['registerArtifactSender'];
};

/** What every page block of this editor needs; read by one stable component
 *  so a change here updates the frames instead of remounting them. */
const PageContext = createContext<PageViewContext | null>(null);

function BoundPageView(p: { blockId: string; title: string; sourceKey: string }) {
  const context = useContext(PageContext);
  return context ? <PageView {...context} {...p} /> : null;
}

function BoundWidgetView(p: { blockId: string; props: WidgetBlockProps }) {
  const context = useContext(PageContext);
  return context ? <WidgetView {...context} {...p} /> : null;
}

type BoundDataTableProps = { blockId: string; props: DataTableBlockProps; update: DataTableViewProps['update'] };

function BoundDataTableView(p: BoundDataTableProps & { canWrite: boolean }) {
  const context = useContext(PageContext);
  return context ? <DataTableView {...context} {...p} /> : null;
}

const ReadOnlyDataTableView = (p: BoundDataTableProps) => <BoundDataTableView {...p} canWrite={false} />;

/** A suggesting draft is inert until sent: its blocks cast no votes, make no
 *  picks, write no records and edit no page text in the live document, and its
 *  page previews submit nothing (no messages reach the document route). */
function InertBlocks({ children }: { children: ReactNode }) {
  const services = useContext(PrimerBlocksContext);
  const page = useContext(PageContext);
  const inertServices = useMemo(
    () => services && { ...services, canPick: false, canVote: false, DataTableView: ReadOnlyDataTableView },
    [services],
  );
  const inertPage = useMemo(
    () => page && { ...page, canEdit: false, onArtifactMessage: undefined, registerArtifactSender: undefined },
    [page],
  );
  return (
    <PrimerBlocksContext.Provider value={inertServices}>
      <PageContext.Provider value={inertPage}>{children}</PageContext.Provider>
    </PrimerBlocksContext.Provider>
  );
}

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
  useEffect(() => relayLiveEvents(props.documentId, props.live.provider), [props.documentId, props.live.provider]);
  const [selected, setSelected] = useState(MAIN_TAB);
  // A tab someone else deleted falls back to the first.
  const active = tabs.some((t) => t.id === selected) ? selected : MAIN_TAB;
  // Choice and task blocks reach the API through these (people pick; the
  // browser is always a person's session).
  const { services, store } = useBlockServices(props.documentId, { canPick: !props.readOnly, canVote: props.canVote });
  // Taken once: a refetch of the document records a newer visit.
  // `undefined`: the visit's fetch has not answered yet.
  const [since, setSince] = useState(props.lastView);
  useEffect(() => {
    if (since === undefined && props.lastView !== undefined) setSince(props.lastView);
  }, [since, props.lastView]);
  const [catchUp, setCatchUp] = useState<Target[]>([]);
  useEffect(() => store.watch(props.live.doc), [store, props.live.doc]);
  // Page, widget and data-table blocks render their views and overlay through the block services.
  const { live, documentId, readOnly, theme, userId, role, userName, canVote, canComment, onArtifactMessage, registerArtifactSender } = props;
  const pageContext = useMemo<PageViewContext>(
    () => ({
      doc: live.doc,
      documentId,
      tabId: active,
      canEdit: !readOnly,
      theme,
      viewer: { id: userId, isOwner: role === 'owner', canComment, name: userName },
      onArtifactMessage,
      registerArtifactSender,
    }),
    [live.doc, documentId, active, readOnly, theme, userId, role, userName, canComment, onArtifactMessage, registerArtifactSender],
  );
  const withPages = useMemo(() => {
    // Records are written by whoever may vote (owner, editor, responder).
    const DataTableView = (p: BoundDataTableProps) => <BoundDataTableView {...p} canWrite={canVote} />;
    return { ...services, PageView: BoundPageView, WidgetView: BoundWidgetView, DataTableView };
  }, [services, canVote]);
  return (
    <PrimerBlocksContext.Provider value={withPages}>
      <PageContext.Provider value={pageContext}>
      <div className="flex h-full flex-col" data-live-editor={props.documentId}>
        <AgentStatus provider={props.live.provider} />
        <TabStrip doc={props.live.doc} tabs={tabs} active={active} onSelect={setSelected} readOnly={props.readOnly} />
        {since && <CatchUpPanel documentId={props.documentId} since={since} onBlocks={setCatchUp} />}
        {/* One editor per tab fragment, mounted when its tab is opened. */}
        <TabEditor key={active} tabId={active} store={store} catchUp={catchUp} {...props} />
      </div>
      </PageContext.Provider>
    </PrimerBlocksContext.Provider>
  );
}

function TabEditor({
  live,
  tabId,
  documentId,
  readOnly,
  theme,
  userName,
  userId,
  role,
  canComment,
  onOpenLegacyVersion,
  store,
  catchUp,
}: LiveEditorProps & { live: LiveProvider; tabId: string; store: ChoiceStore; catchUp: Target[] }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [changesOn, setChangesOn] = useState(false);
  const sinceCheckpoint = useCheckpointChanges(documentId, tabId, changesOn);
  const [decisionsOpen, setDecisionsOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionCount, setSuggestionCount] = useState(0);
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const [held, setHeld] = useState<HeldDelete | null>(null);
  // Suggesting: the tab as it was when suggesting began, edited as a draft.
  const [suggesting, setSuggesting] = useState(false);
  const [sentNote, setSentNote] = useState<string | null>(null);
  // Suggesting is open to anyone who may comment (the API's ops rule).
  const canSuggest = canComment;
  const threadStore = useMemo(
    () =>
      new PrimerThreadStore(documentId, tabId, {
        id: userId,
        isOwner: role === 'owner',
        canComment,
      }),
    [documentId, tabId, userId, role, canComment],
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
        YjsVersioningExtension({ storage: new PrimerVersionStorage(documentId, onOpenLegacyVersion) }),
      ],
      collaboration: {
        provider: { awareness: live.provider.awareness ?? undefined },
        fragment: live.doc.getXmlFragment(tabFragmentName(tabId)),
        user: { name: userName, color: colorFor(userName) },
      },
      dictionary: editorDictionary(),
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
  useEffect(() => routeMarkdownPasteToServer(editor), [editor]);

  return (
    <>
      <div className="flex min-h-10 items-center gap-2 border-b border-neutral-200 px-3 py-1.5 sm:px-4 dark:border-neutral-800">
        {canSuggest && (
          <ModeSwitch
            suggesting={suggesting}
            canEdit={!readOnly}
            onChange={(suggest) => {
              setSentNote(null);
              setSuggesting(suggest);
            }}
          />
        )}
        <ConnectionStatus provider={live.provider} />
        {sentNote && (
          <span role="status" className="hidden truncate text-xs text-emerald-700 sm:inline dark:text-emerald-400">
            {sentNote}
          </span>
        )}
        <div className="ml-auto flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
          <ToolbarToggle pressed={commentsOpen} onToggle={() => setCommentsOpen((open) => !open)}>
            {t('liveEditor.comments')}
          </ToolbarToggle>
          <ToolbarToggle pressed={suggestionsOpen} onToggle={() => setSuggestionsOpen((open) => !open)}>
            {suggestionCount > 0 ? t('liveEditor.suggestionsCount', { count: suggestionCount }) : t('liveEditor.suggestions')}
          </ToolbarToggle>
          <ToolbarToggle pressed={decisionsOpen} onToggle={() => setDecisionsOpen((open) => !open)}>
            {t('liveEditor.decisions')}
          </ToolbarToggle>
          <ToolbarToggle pressed={changesOn} onToggle={() => setChangesOn((on) => !on)}>
            {t('liveEditor.changes')}
          </ToolbarToggle>
          <ToolbarToggle pressed={historyOpen} onToggle={() => setHistoryOpen((open) => !open)}>
            {t('liveEditor.history')}
          </ToolbarToggle>
        </div>
      </div>
      <ChangeHighlights tone="catchup" blockIds={catchUp.filter((b) => b.tabId === tabId).map((b) => b.blockId)} />
      {sinceCheckpoint && <ChangeHighlights tone="checkpoint" blockIds={sinceCheckpoint} />}
      <BlockNoteView editor={editor} editable={!readOnly} theme={theme} renderEditor={false} slashMenu={false} className="flex min-h-0 flex-1">
        <ChipMenus editor={editor} slashItems={primerSlashItems(editor)} />
        <div className={`min-w-0 flex-1 overflow-y-auto py-4 ${suggesting ? 'hidden' : ''}`}>
          <BlockNoteViewEditor />
        </div>
        {suggesting && (
          <InertBlocks>
            <SuggestDraft
              documentId={documentId}
              tabId={tabId}
              theme={theme}
              onDiscard={() => setSuggesting(false)}
              onSent={(count) => {
                setSuggesting(false);
                setSentNote(t('suggestDraft.sent', { count }));
                setSuggestionsOpen(true);
              }}
            />
          </InertBlocks>
        )}
        {commentsOpen && (
          <div className={`${PANEL} p-2`} data-threads-sidebar>
            <select
              aria-label={t('liveEditor.showComments')}
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
              className="mb-2 h-7 rounded border border-neutral-300 bg-transparent px-2 text-xs dark:border-neutral-700"
            >
              <option value="open">{t('liveEditor.filterOpen')}</option>
              <option value="resolved">{t('liveEditor.filterResolved')}</option>
              <option value="all">{t('liveEditor.filterAll')}</option>
            </select>
            <ThreadsSidebar filter={filter} />
            <ThreadActions store={threadStore} canPromote canReanchor={canComment} />
          </div>
        )}
        <div
          hidden={!suggestionsOpen}
          className={`${PANEL} p-2`}
        >
          <SuggestionsPanel
            documentId={documentId}
            tabId={tabId}
            canDecide={role === 'owner' || role === 'editor'}
            onCount={setSuggestionCount}
            onShow={(blockId) => editor.setTextCursorPosition(blockId, 'start')}
          />
        </div>
        {decisionsOpen && (
          <div className={PANEL}>
            <DecisionRegister documentId={documentId} store={store} onClose={() => setDecisionsOpen(false)} />
          </div>
        )}
        {historyOpen && (
          <div className={PANEL}>
            <VersioningSidebar onClose={() => setHistoryOpen(false)} />
          </div>
        )}
      </BlockNoteView>
      {held && <DeleteCommentedDialog held={held} onClose={() => setHeld(null)} />}
    </>
  );
}

/** A side panel: beside the editor, or a bottom sheet on a phone. */
const PANEL =
  'w-80 shrink-0 overflow-y-auto border-l border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950 max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-30 max-sm:h-[65vh] max-sm:w-auto max-sm:border-t max-sm:border-l-0 max-sm:shadow-2xl';

/** One of the toolbar's panel toggles. */
function ToolbarToggle({ pressed, onToggle, children }: { pressed: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={pressed}
      className="h-7 shrink-0 whitespace-nowrap rounded-md px-2.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 aria-pressed:bg-violet-50 aria-pressed:text-violet-700 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100 dark:aria-pressed:bg-violet-500/15 dark:aria-pressed:text-violet-300"
    >
      {children}
    </button>
  );
}

/**
 * Editing | Suggesting. Suggesting turns edits into proposals that the owner
 * or an editor accepts or rejects; people who can't edit see Viewing instead
 * of Editing, and can still suggest.
 */
function ModeSwitch({ suggesting, canEdit, onChange }: { suggesting: boolean; canEdit: boolean; onChange: (suggest: boolean) => void }) {
  const segment = 'inline-flex h-6 items-center gap-1.5 whitespace-nowrap rounded px-2.5 text-xs font-medium transition-colors';
  return (
    <div role="radiogroup" aria-label={t('liveEditor.modeLabel')} className="inline-flex shrink-0 rounded-md border border-neutral-200 bg-neutral-100 p-0.5 dark:border-neutral-800 dark:bg-neutral-900">
      <button
        type="button"
        role="radio"
        aria-checked={!suggesting}
        title={canEdit ? t('liveEditor.modeEditingHint') : t('liveEditor.modeViewingHint')}
        onClick={() => onChange(false)}
        className={`${segment} ${!suggesting ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white' : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'}`}
      >
        {canEdit ? t('liveEditor.modeEditing') : t('liveEditor.modeViewing')}
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={suggesting}
        title={t('liveEditor.modeSuggestingHint')}
        onClick={() => onChange(true)}
        className={`${segment} ${suggesting ? 'bg-emerald-600 text-white shadow-sm dark:bg-emerald-500 dark:text-emerald-950' : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-100'}`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${suggesting ? 'bg-white dark:bg-emerald-950' : 'bg-emerald-500'}`} aria-hidden="true" />
        {t('liveEditor.modeSuggesting')}
      </button>
    </div>
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

/** Slash menu entries for Primer's own blocks. */
function primerSlashItems(editor: unknown) {
  const insert = (block: object) => () => insertOrUpdateBlockForSlashMenu(editor as never, block as never);
  return [
    {
      title: t('slash.choice'),
      subtext: t('slash.choiceHint'),
      aliases: ['choice', 'decision', 'vote', 'poll', 'options'],
      group: t('slash.group'),
      onItemClick: insert({
        type: 'choice',
        children: [
          { type: 'choiceOption', children: [{ type: 'paragraph' }] },
          { type: 'choiceOption', children: [{ type: 'paragraph' }] },
        ],
      }),
    },
    {
      title: t('slash.task'),
      subtext: t('slash.taskHint'),
      aliases: ['task', 'todo', 'assign', 'action'],
      group: t('slash.group'),
      onItemClick: insert({ type: 'task' }),
    },
    {
      title: t('slash.callout'),
      subtext: t('slash.calloutHint'),
      aliases: ['callout', 'alert', 'note', 'warning', 'info', 'admonition'],
      group: t('slash.blocksGroup'),
      onItemClick: insert({ type: 'callout', props: { kind: 'info' } }),
    },
    {
      title: t('slash.columns'),
      subtext: t('slash.columnsHint'),
      aliases: ['columns', 'column', 'layout', 'side by side', 'grid'],
      group: t('slash.blocksGroup'),
      onItemClick: insert({
        type: 'columnList',
        children: [
          { type: 'column', children: [{ type: 'paragraph' }] },
          { type: 'column', children: [{ type: 'paragraph' }] },
        ],
      }),
    },
    {
      title: t('slash.embed'),
      subtext: t('slash.embedHint'),
      aliases: ['link card', 'link', 'card', 'bookmark', 'document', 'unfurl', 'embed document'],
      group: t('slash.blocksGroup'),
      onItemClick: insert({ type: 'embed' }),
    },
    {
      title: t('slash.dataTable'),
      subtext: t('slash.dataTableHint'),
      aliases: ['table', 'data', 'records', 'database', 'sheet'],
      group: t('slash.group'),
      onItemClick: insert({ type: 'dataTable' }),
    },
  ];
}

const COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#4d7c0f'];

function colorFor(name: string): string {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length]!;
}

