import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { agentClientId } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { findBlock } from './blocks.ts';
import { liveDocName, liveInstance } from './instance.ts';
import { fragmentDoc, toRelativeJSON } from './marks.ts';
import { MAIN_TAB, tabFragmentName } from './reach.ts';

const COLORS = ['#7c3aed', '#0891b2', '#c2410c', '#15803d', '#be185d', '#1d4ed8'];

/** What a running agent shows to everyone on the document. */
export type AgentAwarenessState = { status: string; cursorBlockId: string | null; tabId?: string };

/**
 * Agents appear in a document's awareness like any collaborator: BlockNote
 * draws `{ user: { name, color }, cursor: { anchor, head } }` (relative
 * positions as JSON) as a collaboration cursor, and Primer's status line
 * reads `status`.
 *
 * Each (document, agent) has a scratch Awareness whose client id is the
 * agent's synthetic id (fnv1a32 of its user id). Its updates are forwarded to
 * the Hocuspocus document's awareness when the document is loaded, and its
 * own renewal (every 15 s) is the heartbeat that keeps peers from dropping
 * the state after 30 s. A document loaded later picks the state up at the
 * next renewal. `null` removes the state and stops the heartbeat.
 */
const active = new Map<string, Awareness>();

/** The last clock of a cleared scratch Awareness: peers drop updates whose
 *  clock isn't above what they hold, so a later run must continue from it. */
const lastClock = new Map<string, number>();

/** The scratch Awareness of an agent on a document (tests drive its clock). */
export function agentAwareness(documentId: string, agentId: string): Awareness | undefined {
  return active.get(`${documentId}:${agentId}`);
}

/** Fields only the server's agent states may carry. */
const AGENT_FIELDS = ['agentId', 'status'] as const;

/**
 * Cleans a client's inbound awareness update (awareness is client-writable):
 * a person can't pose as an agent or as someone else. Agent fields are
 * stripped, the name shown on the cursor is the connection's own, and a
 * state or removal for a running agent's client id is dropped.
 */
export function sanitizeClientAwareness(
  documentId: string,
  user: { displayName: string },
  states: Map<number, Record<string, any>>,
  removed: Set<number>,
): void {
  const agentIds = new Set(
    [...active.keys()].filter((k) => k.startsWith(`${documentId}:`)).map((k) => agentClientId(k.slice(documentId.length + 1))),
  );
  for (const [clientId, state] of states) {
    if (agentIds.has(clientId)) {
      states.delete(clientId);
      continue;
    }
    for (const field of AGENT_FIELDS) delete state[field];
    if (state.user && typeof state.user === 'object') state.user.name = user.displayName;
  }
  for (const clientId of removed) if (agentIds.has(clientId)) removed.delete(clientId);
}

export { agentClientId };

export async function setAgentAwareness(documentId: string, agent: AuthUser, state: AgentAwarenessState | null): Promise<void> {
  const key = `${documentId}:${agent.id}`;
  let aw = active.get(key);
  if (state === null) {
    if (aw) {
      active.delete(key);
      aw.destroy();
      lastClock.set(key, aw.meta.get(aw.clientID)?.clock ?? 0);
    }
    return;
  }
  if (!aw) {
    const scratch = new Y.Doc();
    scratch.clientID = agentClientId(agent.id);
    aw = new Awareness(scratch);
    const previous = lastClock.get(key);
    if (previous !== undefined) aw.meta.set(scratch.clientID, { clock: previous, lastUpdated: Date.now() });
    (aw as unknown as { _checkInterval?: { unref?: () => void } })._checkInterval?.unref?.();
    const forwarder = aw;
    forwarder.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const doc = liveInstance().documents.get(liveDocName(documentId));
      if (!doc) return;
      applyAwarenessUpdate(doc.awareness, encodeAwarenessUpdate(forwarder, [...added, ...updated, ...removed]), 'primer-agent');
    });
    active.set(key, aw);
  }
  aw.setLocalState({
    user: { name: agent.displayName, color: COLORS[agentClientId(agent.id) % COLORS.length] },
    cursor: cursorFor(documentId, state),
    status: state.status,
    agentId: agent.id,
  });
}

/** The agent's cursor at the start of a block's text, or null. */
function cursorFor(documentId: string, state: AgentAwarenessState): { anchor: unknown; head: unknown } | null {
  if (!state.cursorBlockId) return null;
  const doc = liveInstance().documents.get(liveDocName(documentId));
  if (!doc) return null;
  const fragment = doc.getXmlFragment(tabFragmentName(state.tabId ?? MAIN_TAB));
  const block = findBlock(fragmentDoc(fragment), state.cursorBlockId);
  if (!block) return null;
  const at = toRelativeJSON(fragment, block.pos + 2);
  return { anchor: at, head: at };
}
