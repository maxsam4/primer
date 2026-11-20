import { afterEach, describe, expect, it } from 'vitest';
import { transactionWithEvents } from '../lib/events.ts';
import { LIVENESS_PING, LIVENESS_PONG } from './instance.ts';
import { createLiveDoc, startTestHub, until } from './live.testlib.ts';

let hub: Awaited<ReturnType<typeof startTestHub>> | null = null;
afterEach(async () => {
  await hub?.close();
  hub = null;
});

describe('live socket relays', () => {
  it("a document's comment events reach its open editors over the socket, and only its own", async () => {
    hub = await startTestHub();
    const documentId = await createLiveDoc();
    const other = await createLiveDoc();
    const { provider } = await hub.connect(documentId, 'mock-user-1');
    const { provider: elsewhere } = await hub.connect(other, 'mock-user-1');
    const got: string[] = [];
    const gotElsewhere: string[] = [];
    provider.on('stateless', ({ payload }: { payload: string }) => got.push(payload));
    elsewhere.on('stateless', ({ payload }: { payload: string }) => gotElsewhere.push(payload));

    await transactionWithEvents(async (_tx, emit) => {
      emit({ documentId, actorId: 'mock-user-1', type: 'comment.created', payload: { document_id: documentId } as never });
      emit({ documentId, actorId: 'mock-user-1', type: 'version.published', payload: { document_id: documentId } as never });
    });
    await until(() => got.length > 0);
    expect(got.map((p) => JSON.parse(p))).toEqual([{ type: 'primer.event', event: { type: 'comment.created' } }]);
    expect(gotElsewhere).toEqual([]);

    // A liveness probe is answered at once.
    provider.sendStateless(LIVENESS_PING);
    await until(() => got.includes(LIVENESS_PONG));
  });
});
