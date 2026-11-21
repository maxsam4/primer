import { useEffect, useState } from 'react';
import type { CatchUpDTO, CatchUpPerson, CatchUpSince, LiveDocDTO, Target, VersionsListResponse } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';
import { t } from '../i18n/index.ts';

/** Block ids are client-writable document content: only plain ids reach CSS. */
const SAFE_ID = /^[\w-]{1,128}$/;

/**
 * Highlights blocks by id, as decoration only: a stylesheet keyed on the
 * `data-id` BlockNote renders, so nothing is written to the document and the
 * highlight follows the block wherever it moves.
 */
export function ChangeHighlights({ blockIds, tone }: { blockIds: Iterable<string>; tone: 'catchup' | 'checkpoint' }) {
  const ids = [...blockIds].filter((id) => SAFE_ID.test(id));
  if (ids.length === 0) return null;
  const color = tone === 'catchup' ? 'rgb(14 165 233 / 0.14)' : 'rgb(245 158 11 / 0.16)';
  const edge = tone === 'catchup' ? 'rgb(14 165 233)' : 'rgb(245 158 11)';
  const selector = ids.map((id) => `.bn-block-outer[data-id="${id}"] > .bn-block > .bn-block-content`).join(',\n');
  return (
    <style data-change-highlights={tone}>{`${selector} { background: ${color}; box-shadow: inset 3px 0 0 ${edge}; border-radius: 2px; }`}</style>
  );
}

/**
 * The blocks of one tab changed after the latest checkpoint (M10b.2), while
 * `on`: the checkpoint's docVersion from the version list, then a delta read
 * of the live document since it. Null while off or before the first checkpoint.
 */
export function useCheckpointChanges(documentId: string, tabId: string, on: boolean): Set<string> | null {
  const [ids, setIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (!on) {
      setIds(null);
      return;
    }
    let live = true;
    void (async () => {
      const list = await api(`/api/documents/${encodeURIComponent(documentId)}/versions`);
      if (!list.ok) return;
      const latest = ((await list.json()) as VersionsListResponse).versions.find((v) => v.docVersion !== undefined);
      if (!latest) {
        if (live) setIds(new Set());
        return;
      }
      const read = await api(
        `/api/documents/${encodeURIComponent(documentId)}/live?format=json&tabId=${encodeURIComponent(tabId)}&since=${latest.docVersion}`,
      );
      if (!read.ok || !live) return;
      setIds(new Set(((await read.json()) as LiveDocDTO).blocks.map((b) => b.target.blockId)));
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [documentId, tabId, on]);
  return ids;
}

/**
 * "Since you last looked" (M10b.1): what others changed after the viewer's
 * previous visit, per person, with the changed blocks highlighted while the
 * panel is open. Shown once per visit; dismissing hides it.
 */
export function CatchUpPanel(props: { documentId: string; since: CatchUpSince; onBlocks: (targets: Target[]) => void }) {
  const { documentId, since, onBlocks } = props;
  const [catchUp, setCatchUp] = useState<CatchUpDTO | null>(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    let live = true;
    const query = `since=${encodeURIComponent(since.at)}${since.docVersion === null ? '' : `&sinceVersion=${since.docVersion}`}`;
    void api(`/api/documents/${encodeURIComponent(documentId)}/catchup?${query}`)
      .then(async (res) => {
        if (!res.ok || !live) return;
        const body = (await res.json()) as CatchUpDTO;
        setCatchUp(body);
        onBlocks(body.changedBlocks.map((b) => b.target));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [documentId, since, onBlocks]);

  if (!catchUp || !open || isEmpty(catchUp)) return null;
  const name = (id: string) => catchUp.people.find((p) => p.id === id)?.displayName ?? t('document.someone');
  const close = () => {
    setOpen(false);
    onBlocks([]);
  };
  return (
    <section
      aria-label={t('catchUp.title')}
      data-catch-up=""
      className="mx-4 mt-2 rounded border border-sky-200 bg-sky-50 p-3 text-xs text-sky-950 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100"
    >
      <header className="mb-1 flex items-center justify-between gap-2">
        <strong>{t('catchUp.heading', { when: new Date(catchUp.since.at).toLocaleString() })}</strong>
        <button type="button" onClick={close} className="h-6 rounded border border-sky-300 px-2 dark:border-sky-700">
          {t('catchUp.dismiss')}
        </button>
      </header>
      <ul className="list-disc pl-5">
        {catchUp.people.map((p) => (
          <li key={p.id} data-catch-up-person={p.id}>
            {t('catchUp.person', { name: p.displayName, what: summary(p) })}
          </li>
        ))}
        {catchUp.decisions.map((d, i) => (
          <li key={`d${i}`}>
            {d.event === 'cleared'
              ? t('catchUp.cleared', { name: name(d.by) })
              : d.optionLabel
                ? t('catchUp.decided', { name: name(d.by), question: d.question ?? '', option: d.optionLabel })
                : t('catchUp.picked', { name: name(d.by) })}
          </li>
        ))}
        {catchUp.threads.map((th, i) => (
          <li key={`t${i}`}>
            {t(th.event === 'resolved' ? 'catchUp.resolved' : th.event === 'replied' ? 'catchUp.replied' : 'catchUp.commented', {
              name: name(th.by),
              quote: th.quote,
            })}
          </li>
        ))}
        {catchUp.suggestions.map((s, i) => (
          <li key={`s${i}`}>{t(s.event === 'created' ? 'catchUp.suggested' : 'catchUp.suggestionDecided', { name: name(s.by), decision: s.event })}</li>
        ))}
        {catchUp.versions.map((v) => (
          <li key={v.versionId}>{t('catchUp.published', { name: name(v.by), number: v.number })}</li>
        ))}
      </ul>
      {catchUp.changedBlocks.length + catchUp.moreChangedBlocks > 0 && (
        <p className="mt-1 text-sky-800 dark:text-sky-300">
          {t('catchUp.blocks', { count: catchUp.changedBlocks.length + catchUp.moreChangedBlocks })}
        </p>
      )}
    </section>
  );
}

const COUNTS = [
  ['edits', 'catchUp.edits'],
  ['comments', 'catchUp.comments'],
  ['resolved', 'catchUp.resolvedCount'],
  ['decisions', 'catchUp.decisions'],
  ['suggestions', 'catchUp.suggestions'],
  ['tasks', 'catchUp.tasks'],
] as const;

/** "edits: 2, comments: 1": only what the person did. */
function summary(p: CatchUpPerson): string {
  return COUNTS.filter(([field]) => p[field] > 0)
    .map(([field, key]) => t(key, { count: p[field] }))
    .join(', ');
}

function isEmpty(c: CatchUpDTO): boolean {
  return (
    c.people.length + c.changedBlocks.length + c.deletedBlockIds.length + c.threads.length + c.decisions.length + c.suggestions.length +
      c.versions.length ===
    0
  );
}
