import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { events } from '../db/schema.ts';
import { gateEventAccess, listEvents, listOwnedEvents } from '../lib/events.ts';
import { flushDataChanged } from './changed.ts';
import { recordsApi } from './store.ts';
import { AGENT, OWNER, VIEWER, seedRecordsDoc } from './records.testlib.ts';

async function dataChangedSeenBy(doc: string, reader: AuthUser) {
  const g = await gateEventAccess(doc, reader);
  if (g.status !== 'ok') throw new Error('no access');
  const page = await listEvents({ documentId: doc, identity: g.identity, filters: { namespace: 'primer', type: 'data.changed' }, afterId: null, limit: 100 });
  return page.rows.map((r) => r.authorId);
}

describe('coalesced data.changed', () => {
  it('ten writes in a burst emit one event per actor', async () => {
    const doc = await seedRecordsDoc();
    for (const actor of [VIEWER, AGENT]) {
      const api = recordsApi(actor, doc);
      for (let i = 0; i < 10; i++) {
        await api.set({ collection: i % 2 ? 'votes' : 'tally', scope: 'shared', recordId: `${actor.id}-${i}`, data: { i } });
      }
    }
    // Personal writes wake no one.
    await recordsApi(VIEWER, doc).set({ collection: 'mine', scope: 'personal', recordId: 'p', data: {} });
    await flushDataChanged();

    const rows = await db.select().from(events).where(and(eq(events.documentId, doc), eq(events.type, 'data.changed')));
    expect(rows).toHaveLength(2);
    const byViewer = rows.find((r) => r.authorId === VIEWER.id)!;
    expect(byViewer.payload).toMatchObject({ document_id: doc, collections: ['tally', 'votes'] });
    const p = byViewer.payload as { from_change_id: number; to_change_id: number };
    expect(p.to_change_id - p.from_change_id).toBe(9);

    // An agent is never handed its own data.changed (it would wake itself);
    // a person is, so the same person's second tab refreshes.
    expect(await dataChangedSeenBy(doc, AGENT)).toEqual([VIEWER.id]);
    expect((await dataChangedSeenBy(doc, VIEWER)).sort()).toEqual([AGENT.id, VIEWER.id].sort());
    expect((await dataChangedSeenBy(doc, OWNER)).sort()).toEqual([AGENT.id, VIEWER.id].sort());
    // Same on the owner stream an agent follows for its person.
    const owned = await listOwnedEvents({
      userId: OWNER.id, readerId: AGENT.id, filters: { namespace: 'primer', type: 'data.changed' }, afterId: 0, limit: 100,
    });
    expect(owned.rows.map((r) => r.authorId)).toEqual([VIEWER.id]);
  });
});
