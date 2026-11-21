import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_DATA_TABLE_ROWS,
  MAX_RECORDS_PAGE_SIZE,
  RECORD_COLLECTION_RE,
  RECORD_KEY_RE,
  parseDataTable,
  recordCellText,
  type DataPointAnchor,
  type DataTableColumn,
  type DataTableColumnType,
  type RecordDTO,
  type RecordsPage,
  type ThreadDTO,
  type ThreadsListResponse,
} from '@polygonlabs/primer-api-types';
import type { DataTableBlockProps } from '@primer/blocks';
import { api } from '../lib/fetch.ts';
import { t } from '../i18n/index.ts';
import type { PageViewContext } from './PageView.tsx';
import { announceDataChanged, useDataChanged, useThreadEvents } from './threadEvents.ts';
import './dataTable.css';

export type DataTableViewProps = PageViewContext & {
  blockId: string;
  props: DataTableBlockProps;
  /** May this viewer write records (owner, editor, responder)? */
  canWrite: boolean;
  /** Changes the block's props (collection, columns); people with edit rights. */
  update: (props: Partial<Pick<DataTableBlockProps, 'collection' | 'columns'>>) => void;
};

/** The value a cell's input stores, by column type: numbers as numbers (an
 *  empty one clears the cell), everything else as text. */
export function cellValue(type: DataTableColumnType, raw: string): unknown {
  if (type === 'number') return raw.trim() === '' || Number.isNaN(Number(raw)) ? null : Number(raw);
  return raw;
}

const recordsUrl = (documentId: string, verb: string) => `/api/documents/${encodeURIComponent(documentId)}/records/${verb}`;

async function post<T>(documentId: string, verb: string, body: unknown): Promise<{ ok: true; value: T } | { ok: false; status: number; message: string }> {
  const res = await api(recordsUrl(documentId, verb), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = (await res.json().catch(() => null)) as (T & { refusal?: { message?: string } }) | null;
  if (res.ok && out) return { ok: true, value: out };
  return { ok: false, status: res.status, message: out?.refusal?.message ?? t('dataTable.failed') };
}

/** A new row's record id: short, unique enough, and a valid RECORD_ID_RE. */
function newRecordId(): string {
  return `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** `version` and `original` are the row as it was when the cell opened: a save is checked against them. */
type Editing = { recordId: string; key: string; value: string; version: number; original: string };

/**
 * A data-table block in the live editor (M9b): a view over one records
 * collection of the document. Rows are the records, read and written through
 * the records routes (the same verbs agents and pages use), so the table holds
 * nothing of its own: an agent's write shows up here, and a cell edited here
 * is a record write others see. Others' writes arrive as a coalesced
 * `primer.data.changed` and the table reads again; its own writes update in
 * place. `query:<name>` collections hold a named warehouse query's results
 * and are read-only. Each row can be commented on (a `data-point` anchor:
 * the record id, column '' for the whole row).
 */
export function DataTableView(props: DataTableViewProps) {
  const { documentId, tabId, blockId, viewer, canWrite, canEdit } = props;
  const spec = useMemo(() => parseDataTable(props.props), [props.props]);
  const [rows, setRows] = useState<RecordDTO[] | null>(null);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [threads, setThreads] = useState<ThreadDTO[]>([]);
  const [commenting, setCommenting] = useState<string | null>(null);
  const writable = canWrite && spec !== null && !spec.readOnly;

  // Only the latest read of the current binding may install rows.
  const loadSeq = useRef(0);
  const load = useCallback(async () => {
    if (!spec) return;
    const seq = ++loadSeq.current;
    const all: RecordDTO[] = [];
    let cursor: string | null | undefined;
    do {
      const out = await post<RecordsPage>(documentId, 'list', {
        collection: spec.collection,
        scope: spec.scope,
        limit: MAX_RECORDS_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      });
      if (seq !== loadSeq.current) return;
      if (!out.ok) return setError(out.message);
      all.push(...out.value.records);
      cursor = out.value.nextCursor;
    } while (cursor && all.length < MAX_DATA_TABLE_ROWS);
    setError(null);
    setMore(Boolean(cursor));
    setRows(all.slice(0, MAX_DATA_TABLE_ROWS));
  }, [documentId, spec?.collection, spec?.scope]);
  useEffect(() => {
    // A new binding starts empty: rows and an open edit of the old one are gone.
    setRows(null);
    setEditing(null);
    void load();
  }, [load]);
  useDataChanged(
    documentId,
    (collections) => {
      if (spec && spec.scope === 'shared' && collections.includes(spec.collection)) void load();
    },
    () => void load(),
  );

  const loadThreads = useCallback(() => {
    void api(`/api/documents/${encodeURIComponent(documentId)}/threads`).then(async (res) => {
      if (!res.ok) return;
      const body = (await res.json()) as ThreadsListResponse;
      setThreads(body.threads.filter((th) => th.anchor.type === 'data-point' && th.anchor.target.blockId === blockId && th.resolvedAt === null));
    });
  }, [documentId, blockId]);
  useEffect(loadThreads, [loadThreads]);
  useThreadEvents(documentId, loadThreads);

  if (!spec) return <DataTableSetup canEdit={canEdit} update={props.update} />;

  const columns: DataTableColumn[] =
    spec.columns.length > 0
      ? spec.columns
      : [...new Set((rows ?? []).flatMap((r) => Object.keys(r.data)))].slice(0, 30).map((key) => ({ key, label: key, type: 'text' }));

  const replace = (record: RecordDTO) => setRows((list) => (list ?? []).map((r) => (r.recordId === record.recordId ? record : r)));

  const commit = async (edit: Editing, column: DataTableColumn) => {
    setEditing(null);
    const row = rows?.find((r) => r.recordId === edit.recordId);
    if (!row || edit.original === edit.value) return;
    const out = await post<{ record: RecordDTO }>(documentId, 'update', {
      collection: spec.collection,
      scope: spec.scope,
      recordId: edit.recordId,
      data: { [edit.key]: cellValue(column.type, edit.value) },
      expectVersion: edit.version,
    });
    if (out.ok) {
      replace(out.value.record);
      return announceDataChanged(documentId, [spec.collection]);
    }
    setError(out.status === 409 ? t('dataTable.conflict') : out.message);
    void load();
  };

  const addRow = async () => {
    const out = await post<{ record: RecordDTO }>(documentId, 'set', {
      collection: spec.collection,
      scope: spec.scope,
      recordId: newRecordId(),
      data: {},
      expectVersion: 0,
    });
    if (out.ok) {
      setRows((list) => [...(list ?? []), out.value.record]);
      announceDataChanged(documentId, [spec.collection]);
    } else setError(out.message);
  };

  const deleteRow = async (row: RecordDTO) => {
    const out = await post(documentId, 'delete', { collection: spec.collection, scope: spec.scope, recordId: row.recordId, expectVersion: row.version });
    if (out.ok) {
      setRows((list) => (list ?? []).filter((r) => r.recordId !== row.recordId));
      announceDataChanged(documentId, [spec.collection]);
    } else {
      setError(out.status === 409 ? t('dataTable.conflict') : out.message);
      void load();
    }
  };

  const threadsOf = (recordId: string) => threads.filter((th) => (th.anchor as DataPointAnchor).row === recordId);

  return (
    <div className="primer-data-table" data-collection={spec.collection} contentEditable={false}>
      <div className="primer-data-table-bar">
        <span className="primer-data-table-name">{spec.collection}</span>
        {spec.readOnly && <span className="primer-data-table-badge">{t('dataTable.query')}</span>}
        {spec.scope === 'personal' && <span className="primer-data-table-badge">{t('dataTable.personal')}</span>}
        {canEdit && <ColumnEditor spec={spec.columns} update={props.update} />}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
      <div className="primer-data-table-scroll">
        <table>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
              <th className="primer-data-table-actions" aria-label={t('dataTable.rowActions')} />
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr>
                <td colSpan={columns.length + 1}>{t('dataTable.loading')}</td>
              </tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={columns.length + 1} className="primer-data-table-empty">
                  {t('dataTable.empty')}
                </td>
              </tr>
            )}
            {rows?.map((row) => {
              const open = threadsOf(row.recordId);
              return (
                <tr key={row.recordId} data-record-id={row.recordId} className={open.length > 0 ? 'primer-data-table-commented' : undefined}>
                  {columns.map((c) => {
                    const active = editing?.recordId === row.recordId && editing.key === c.key;
                    return (
                      <td
                        key={c.key}
                        data-column={c.key}
                        onClick={() => writable && !active && setEditing({ recordId: row.recordId, key: c.key, value: recordCellText(row.data[c.key]), version: row.version, original: recordCellText(row.data[c.key]) })}
                        className={writable ? 'primer-data-table-editable' : undefined}
                      >
                        {active ? <CellInput column={c} editing={editing} onChange={setEditing} onCommit={(e) => void commit(e, c)} onCancel={() => setEditing(null)} /> : recordCellText(row.data[c.key])}
                      </td>
                    );
                  })}
                  <td className="primer-data-table-actions">
                    {viewer.canComment && (
                      <button type="button" onClick={() => setCommenting(row.recordId)} title={t('dataTable.comment')} aria-label={t('dataTable.comment')}>
                        {open.length > 0 ? t('dataTable.commentCount', { count: open.length }) : t('dataTable.comment')}
                      </button>
                    )}
                    {writable && (
                      <button type="button" onClick={() => void deleteRow(row)} title={t('dataTable.deleteRow')} aria-label={t('dataTable.deleteRow')}>
                        ×
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {more && <p className="text-xs text-neutral-500">{t('dataTable.more', { count: MAX_DATA_TABLE_ROWS })}</p>}
      {writable && (
        <button type="button" className="primer-data-table-add" onClick={() => void addRow()}>
          {t('dataTable.addRow')}
        </button>
      )}
      {threads.length > 0 && (
        <ul className="primer-data-table-threads" aria-label={t('dataTable.comments')}>
          {threads.map((th) => (
            <li key={th.id}>
              <span className="primer-data-table-thread-row">{(th.anchor as DataPointAnchor).row}</span>
              <span>{th.comments[0]?.body}</span>
              {th.comments.length > 1 && <span className="text-neutral-500">{t('dataTable.replies', { count: th.comments.length - 1 })}</span>}
            </li>
          ))}
        </ul>
      )}
      {commenting && (
        <RowComposer
          documentId={documentId}
          anchor={{ type: 'data-point', target: { tabId, blockId }, row: commenting, column: '' }}
          onDone={(posted) => {
            setCommenting(null);
            if (posted) loadThreads();
          }}
        />
      )}
    </div>
  );
}

function CellInput(props: {
  column: DataTableColumn;
  editing: Editing;
  onChange: (e: Editing) => void;
  onCommit: (e: Editing) => void;
  onCancel: () => void;
}) {
  const { column, editing } = props;
  // Enter, a pick or Escape ends the edit once: the blur that follows (the
  // input going away) must not write it again.
  const done = useRef(false);
  const once = (fn: () => void) => () => {
    if (done.current) return;
    done.current = true;
    fn();
  };
  const commit = (e: Editing) => once(() => props.onCommit(e))();
  const cancel = once(props.onCancel);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commit(editing);
    if (e.key === 'Escape') cancel();
  };
  if (column.type === 'select') {
    return (
      <select
        autoFocus
        aria-label={column.label}
        value={editing.value}
        onChange={(e) => commit({ ...editing, value: e.target.value })}
        onBlur={cancel}
        onKeyDown={keys}
      >
        <option value="" />
        {(column.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      autoFocus
      aria-label={column.label}
      type={column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : 'text'}
      value={editing.value}
      onChange={(e) => props.onChange({ ...editing, value: e.target.value })}
      onBlur={() => commit(editing)}
      onKeyDown={keys}
    />
  );
}

/** A data table with no valid collection yet: people with edit rights name one. */
function DataTableSetup(props: { canEdit: boolean; update: DataTableViewProps['update'] }) {
  const [name, setName] = useState('');
  if (!props.canEdit) return <div className="primer-data-table primer-data-table-empty" contentEditable={false}>{t('dataTable.unset')}</div>;
  const valid = RECORD_COLLECTION_RE.test(name);
  return (
    <form
      className="primer-data-table primer-data-table-setup"
      contentEditable={false}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) props.update({ collection: name });
      }}
    >
      <label>
        {t('dataTable.collection')}
        <input value={name} placeholder="tasks" onChange={(e) => setName(e.target.value)} />
      </label>
      <button type="submit" disabled={!valid}>
        {t('dataTable.bind')}
      </button>
      <p className="text-xs text-neutral-500">{t('dataTable.collectionHint')}</p>
    </form>
  );
}

const TYPES: DataTableColumnType[] = ['text', 'number', 'date', 'select'];
const TYPE_LABEL: Record<DataTableColumnType, () => string> = {
  text: () => t('dataTable.typeText'),
  number: () => t('dataTable.typeNumber'),
  date: () => t('dataTable.typeDate'),
  select: () => t('dataTable.typeSelect'),
};

/** Adds and removes columns (the block's `columns` prop). */
function ColumnEditor(props: { spec: DataTableColumn[]; update: DataTableViewProps['update'] }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<DataTableColumnType>('text');
  const [options, setOptions] = useState('');
  const save = (columns: DataTableColumn[]) => props.update({ columns: JSON.stringify(columns) });
  if (!open) {
    return (
      <button type="button" className="primer-data-table-columns" onClick={() => setOpen(true)}>
        {t('dataTable.columns')}
      </button>
    );
  }
  const valid = RECORD_KEY_RE.test(key) && !props.spec.some((c) => c.key === key);
  return (
    <div className="primer-data-table-column-editor" role="dialog" aria-label={t('dataTable.columns')}>
      <ul>
        {props.spec.map((c) => (
          <li key={c.key}>
            {c.label} <span className="text-neutral-500">({c.key}, {c.type})</span>
            <button type="button" aria-label={t('dataTable.removeColumn', { name: c.label })} onClick={() => save(props.spec.filter((x) => x.key !== c.key))}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <input aria-label={t('dataTable.columnKey')} placeholder={t('dataTable.columnKey')} value={key} onChange={(e) => setKey(e.target.value)} />
      <input aria-label={t('dataTable.columnLabel')} placeholder={t('dataTable.columnLabel')} value={label} onChange={(e) => setLabel(e.target.value)} />
      <select aria-label={t('dataTable.columnType')} value={type} onChange={(e) => setType(e.target.value as DataTableColumnType)}>
        {TYPES.map((x) => (
          <option key={x} value={x}>
            {TYPE_LABEL[x]()}
          </option>
        ))}
      </select>
      {type === 'select' && (
        <input aria-label={t('dataTable.columnOptions')} placeholder={t('dataTable.columnOptions')} value={options} onChange={(e) => setOptions(e.target.value)} />
      )}
      <button
        type="button"
        disabled={!valid}
        onClick={() => {
          const column: DataTableColumn = { key, label: label.trim() || key, type };
          if (type === 'select') column.options = options.split(',').map((o) => o.trim()).filter(Boolean);
          save([...props.spec, column]);
          setKey('');
          setLabel('');
          setOptions('');
        }}
      >
        {t('dataTable.addColumn')}
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        {t('dataTable.done')}
      </button>
    </div>
  );
}

/** A comment on one row, written in a small box under the table. */
function RowComposer(props: { documentId: string; anchor: DataPointAnchor; onDone: (posted: boolean) => void }) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const send = async () => {
    const res = await api(`/api/documents/${encodeURIComponent(props.documentId)}/threads`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anchor: props.anchor, body }),
    });
    if (res.ok) return props.onDone(true);
    const out = (await res.json().catch(() => null)) as { refusal?: { message?: string } } | null;
    setError(out?.refusal?.message ?? t('dataTable.commentFailed'));
  };
  return (
    <div role="dialog" aria-label={t('dataTable.commentOn', { row: props.anchor.row })} className="primer-data-table-composer">
      <p className="text-xs text-neutral-500">{t('dataTable.commentOn', { row: props.anchor.row })}</p>
      <textarea rows={3} value={body} autoFocus placeholder={t('dataTable.commentPlaceholder')} onChange={(e) => setBody(e.target.value)} />
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={() => props.onDone(false)}>
          {t('dataTable.cancel')}
        </button>
        <button type="button" disabled={!body.trim()} onClick={() => void send()} className="rounded bg-sky-600 px-2 py-0.5 text-white disabled:opacity-50">
          {t('dataTable.comment')}
        </button>
      </div>
    </div>
  );
}
