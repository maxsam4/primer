import { describe, expect, it } from 'vitest';
import { createLiveDoc, withLiveDoc } from '../live/live.testlib.ts';
import { SYSTEM_ORIGIN } from '../live/origin.ts';
import { applyPlan } from '../live/pipeline.ts';
import { serverEditor } from '../live/editor.ts';
import { embedTarget, renderPage, seedPage } from './page.ts';
import { stampPage } from './stamp.ts';
import { setPidText } from './text.ts';

const PAGE = `<!doctype html><html><head><script>/* chart */</script></head><body>
<h1>Results</h1>
<p>
  Scores for the week.
</p>
<primer-table data-embed-id="scores"><table><tr><th>Team</th><th>Score</th></tr><tr><td>A</td><td>3</td></tr></table></primer-table>
<primer-code data-embed-id="snippet" lang="ts">const a = 1 &lt; 2;</primer-code>
</body></html>`;

describe('page documents', () => {
  it('a republish reseeds only the embeds whose source changed', async () => {
    const { stamped } = stampPage(PAGE);
    const same = await seedPage({ tabId: 'main', blockId: 'pg', stamped, pids: [], previous: stamped });
    expect(same).toEqual([]);

    const changed = stampPage(PAGE.replace('const a = 1', 'const a = 2')).stamped;
    const edits = await seedPage({ tabId: 'main', blockId: 'pg', stamped: changed, pids: [], previous: stamped });
    expect(edits.map((e) => e.target.embedId)).toEqual(['snippet']);
  });

  it('untouched page exports the original byte for byte (with pid attributes)', async () => {
    const { stamped } = stampPage(PAGE);
    const id = await createLiveDoc();
    await applyPlan(id, SYSTEM_ORIGIN, { onConflict: 'refuse', edits: await seedPage({ tabId: 'main', blockId: 'pg', stamped }) });
    const html = await withLiveDoc(id, (doc) => renderPage(doc, { tabId: 'main', blockId: 'pg', stamped }));
    expect(html).toBe(stamped);
  });

  it('editing one pid or one embed changes only its span', async () => {
    const { stamped } = stampPage(PAGE);
    const id = await createLiveDoc();
    await applyPlan(id, SYSTEM_ORIGIN, { onConflict: 'refuse', edits: await seedPage({ tabId: 'main', blockId: 'pg', stamped }) });
    const code = serverEditor()._blocksToProsemirrorNode([
      { id: 'snippet-0', type: 'codeBlock', props: { language: 'ts' }, content: 'const b = 2 > 1;' },
    ] as never);
    await applyPlan(id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: [
        setPidText({ tabId: 'main', blockId: 'pg', pid: 'p2' }, 'Scores for the month.'),
        { target: embedTarget('main', 'pg', 'snippet'), inverse: false, build: (tr) => void tr.replaceWith(0, tr.doc.content.size, code.content) },
      ],
    });
    const html = await withLiveDoc(id, (doc) => renderPage(doc, { tabId: 'main', blockId: 'pg', stamped }));
    expect(html).toBe(
      stamped
        .replace(/(<p data-pid="p2">)[\s\S]*?(<\/p>)/, '$1Scores for the month.$2')
        .replace('const a = 1 &lt; 2;', 'const b = 2 &gt; 1;'),
    );
  });
});
