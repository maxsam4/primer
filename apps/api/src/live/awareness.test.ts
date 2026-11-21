import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentClientId } from '@polygonlabs/primer-api-types';
import { db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { setAgentAwareness } from './awareness.ts';
import { createLiveDoc, paragraph, seedBlocks, startTestHub, until } from './live.testlib.ts';

const OWNER = 'mock-user-1';
let hub: Awaited<ReturnType<typeof startTestHub>>;
beforeAll(async () => {
  hub = await startTestHub();
});
afterAll(async () => {
  await hub.close();
});

describe('agent awareness', () => {
  it('a client publishing an agent-shaped awareness state does not show as an agent', async () => {
    const id = await createLiveDoc({ uploaderId: OWNER });
    await seedBlocks(id, [paragraph('p1', 'Risks')]);
    const agent = { id: 'agent-aw', email: 'a@example.com', displayName: 'Claude (via Mock User)', kind: 'agent' as const, viaUserId: OWNER };
    await db.insert(users).values({ id: agent.id, email: agent.email, displayName: 'Claude', kind: 'agent', viaUserId: OWNER }).onConflictDoNothing();
    const watcher = await hub.connect(id, OWNER);
    const forger = await hub.connect(id, OWNER);

    // A person poses as an agent: agent fields, an agent's name, and the
    // client id the server uses for a real agent.
    const real = agentClientId(agent.id);
    await setAgentAwareness(id, agent, { status: 'Reading', cursorBlockId: null });
    await until(() => watcher.provider.awareness!.getStates().has(real));
    forger.provider.awareness!.setLocalState({ agentId: 'agent-aw', status: 'Claude is rewriting Risks', user: { name: 'Claude', color: '#000' } });
    const forgerId = forger.doc.clientID;
    await until(() => watcher.provider.awareness!.getStates().has(forgerId));

    const forged = watcher.provider.awareness!.getStates().get(forgerId)!;
    expect(forged.agentId).toBeUndefined();
    expect(forged.status).toBeUndefined();
    expect(forged.user.name).toBe('Mock User');
    // The real agent's state is untouched.
    expect(watcher.provider.awareness!.getStates().get(real)!.status).toBe('Reading');
    await setAgentAwareness(id, agent, null);
  });

  it('a second run on the document shows from its first update', async () => {
    const id = await createLiveDoc({ uploaderId: OWNER });
    await seedBlocks(id, [paragraph('p1', 'Risks')]);
    const agent = { id: 'agent-aw2', email: 'a2@example.com', displayName: 'Claude (via Mock User)', kind: 'agent' as const, viaUserId: OWNER };
    await db.insert(users).values({ id: agent.id, email: agent.email, displayName: 'Claude', kind: 'agent', viaUserId: OWNER }).onConflictDoNothing();
    const watcher = await hub.connect(id, OWNER);
    const real = agentClientId(agent.id);
    for (let i = 0; i < 5; i++) await setAgentAwareness(id, agent, { status: `Step ${i}`, cursorBlockId: null });
    await until(() => watcher.provider.awareness!.getStates().get(real)?.status === 'Step 4');
    await setAgentAwareness(id, agent, null);
    await until(() => !watcher.provider.awareness!.getStates().has(real));
    await setAgentAwareness(id, agent, { status: 'Second run', cursorBlockId: null });
    await until(() => watcher.provider.awareness!.getStates().get(real)?.status === 'Second run');
    await setAgentAwareness(id, agent, null);
  });
});
