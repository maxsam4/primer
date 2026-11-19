// Spike: prosemirror-suggest-changes marks stored in the live Y.Doc. Two real
// Hocuspocus clients edit concurrently with a server-made suggestion; accept
// and reject run on the server; everything converges and survives a reload.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import { v7 as uuidv7 } from 'uuid';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { Node as PmNode } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { updateYFragment, yXmlFragmentToProseMirrorRootNode, yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { mockMultiResolver } from '../auth/resolver.ts';
import { blockVersion, findBlock } from './blocks.ts';
import { readBlocks, serverEditor } from './editor.ts';
import { createHub, type Hub } from './hub.ts';
import { liveDocName, liveInstance } from './instance.ts';
import { createLiveDoc, paragraph, seedBlocks, withLiveDoc } from './live.testlib.ts';
import { SYSTEM_ORIGIN } from './origin.ts';
import { loadYDoc } from './persist.ts';
import { applyPlan, type PlannedEdit } from './pipeline.ts';
import { asSuggestion, settleSuggestion } from './suggest.ts';

const APP_ORIGIN = 'http://app.test';
const OWNER = 'mock-user-1';
const FRAGMENT = 'document-store';
const main = (blockId: string) => ({ tabId: 'main', blockId });
const schema = () => serverEditor().editor.pmSchema;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let server: Server;
let hub: Hub;
let url: string;

beforeAll(async () => {
  hub = createHub({ resolver: mockMultiResolver, appOrigin: APP_ORIGIN });
  server = createServer();
  server.on('upgrade', hub.handleUpgrade);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/collab`;
});

afterAll(async () => {
  hub.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Client = { provider: HocuspocusProvider; doc: Y.Doc };

function synced(provider: HocuspocusProvider): Promise<void> {
  return new Promise((resolve, reject) => {
    if (provider.isSynced) return resolve();
    provider.on('synced', () => resolve());
    provider.on('authenticationFailed', () => reject(new Error('denied')));
  });
}

async function connect(documentId: string): Promise<Client> {
  class HeaderWebSocket extends WebSocket {
    constructor(target: string | URL) {
      super(target, { headers: { 'x-mock-user-id': OWNER, origin: APP_ORIGIN } } as never);
    }
  }
  const doc = new Y.Doc();
  const provider = new HocuspocusProvider({
    url,
    name: liveDocName(documentId),
    document: doc,
    WebSocketPolyfill: HeaderWebSocket,
  } as ConstructorParameters<typeof HocuspocusProvider>[0]);
  await synced(provider);
  return { provider, doc };
}

/** A client edit: a ProseMirror transform on the client's own Y.Doc, written
 *  back with y-prosemirror (what ySyncPlugin does for an editor view). */
function clientEdit(doc: Y.Doc, build: (tr: Transform) => void): void {
  const fragment = doc.getXmlFragment(FRAGMENT);
  const tr = new Transform(PmNode.fromJSON(schema(), yXmlFragmentToProsemirrorJSON(fragment)));
  build(tr);
  updateYFragment(doc, fragment, tr.doc, { mapping: new Map(), isOMark: new Map() });
}

function typeAt(tr: Transform, pos: number, text: string): void {
  tr.insert(pos, schema().text(text));
}

/** Position of character `offset` of `text` inside paragraph block `blockId`. */
function posOf(doc: PmNode, blockId: string, text: string, offset = 0): number {
  const at = findBlock(doc, blockId)!;
  const index = at.node.firstChild!.textContent.indexOf(text);
  if (index < 0) throw new Error(`"${text}" not in block ${blockId}`);
  return at.pos + 2 + index + offset;
}

/** Replaces the first `from` in paragraph `blockId` with `to`. */
function replaceText(blockId: string, from: string, to: string): PlannedEdit {
  return {
    target: main(blockId),
    inverse: false,
    build: (tr) => {
      const start = posOf(tr.doc, blockId, from);
      tr.replaceWith(start, start + from.length, schema().text(to));
    },
  };
}

function pmDoc(doc: Y.Doc): PmNode {
  return PmNode.fromJSON(schema(), pmJson(doc) as Record<string, unknown>);
}

function pmJson(doc: Y.Doc): unknown {
  return yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(FRAGMENT));
}

/** Each paragraph's text, with `[-deleted-]` and `[+inserted+]` and the
 *  suggestion id of each marked run. */
function render(json: unknown): Record<string, string> {
  const doc = PmNode.fromJSON(schema(), json as Record<string, unknown>);
  doc.check();
  const out: Record<string, string> = {};
  doc.descendants((node) => {
    if (node.type.name !== 'blockContainer') return true;
    let text = '';
    node.firstChild!.forEach((child) => {
      const del = child.marks.find((m) => m.type.name === 'deletion');
      const ins = child.marks.find((m) => m.type.name === 'insertion');
      if (del) text += `[-${child.text}-]{${del.attrs.id}}`;
      else if (ins) text += `[+${child.text}+]{${ins.attrs.id}}`;
      else text += child.text;
    });
    out[node.attrs.id as string] = text;
    return false;
  });
  return out;
}

async function serverJson(documentId: string): Promise<unknown> {
  return withLiveDoc(documentId, (doc) => pmJson(doc));
}

/** Waits until the server and every client hold the same state. */
async function converged(documentId: string, clients: Client[]): Promise<unknown> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const server = await serverJson(documentId);
    const all = clients.map((c) => pmJson(c.doc));
    if (all.every((json) => JSON.stringify(json) === JSON.stringify(server))) {
      // Same content is not enough: the same CRDT state, too.
      const vectors = await withLiveDoc(documentId, (doc) => Buffer.from(Y.encodeStateVector(doc)).toString('hex'));
      if (clients.every((c) => Buffer.from(Y.encodeStateVector(c.doc)).toString('hex') === vectors)) return server;
    }
    if (Date.now() > deadline) throw new Error(`did not converge:\n${JSON.stringify({ server, all })}`);
    await sleep(20);
  }
}

describe('suggestion storage spike', () => {
  it('two clients, one agent suggestion, concurrent edits, accept and reject converge, and survive reload', async () => {
    const id = await createLiveDoc({ uploaderId: OWNER });
    await seedBlocks(id, [
      paragraph('p1', 'The quick brown fox jumps.'),
      paragraph('p2', 'Second paragraph here.'),
      paragraph('p3', 'Third line.'),
      paragraph('p4', 'Fourth stays pending.'),
      paragraph('p5', 'Fifth word here.'),
    ]);
    const a = await connect(id);
    const b = await connect(id);
    await converged(id, [a, b]);

    // Both clients go offline, so their edits are concurrent with the server's.
    a.provider.disconnect();
    b.provider.disconnect();
    clientEdit(a.doc, (tr) => typeAt(tr, posOf(tr.doc, 'p1', 'fox'), 'sly '));
    clientEdit(b.doc, (tr) => typeAt(tr, posOf(tr.doc, 'p3', '.'), ', edited by B'));
    // A also types inside a word the agent is about to delete.
    clientEdit(a.doc, (tr) => typeAt(tr, posOf(tr.doc, 'p5', 'word', 2), 'X'));

    // The agent's suggestions, through the pipeline: one per paragraph.
    const s1 = uuidv7();
    const s2 = uuidv7();
    const s4 = uuidv7();
    const s5 = uuidv7();
    const p1Before = await withLiveDoc(id, (doc) => blockVersion(findBlock(pmDoc(doc), 'p1')!.node));
    await applyPlan(id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: [
        asSuggestion(replaceText('p1', 'brown', 'red'), s1),
        asSuggestion(replaceText('p2', 'Second', 'Other'), s2),
        asSuggestion(replaceText('p4', 'stays', 'remains'), s4),
        asSuggestion(replaceText('p5', 'word', 'term'), s5),
      ],
    });
    expect(render(await serverJson(id))).toEqual({
      p1: `The quick [-brown-]{${s1}}[+red+]{${s1}} fox jumps.`,
      p2: `[-Second-]{${s2}}[+Other+]{${s2}} paragraph here.`,
      p3: 'Third line.',
      p4: `Fourth [-stays-]{${s4}}[+remains+]{${s4}} pending.`,
      p5: `Fifth [-word-]{${s5}}[+term+]{${s5}} here.`,
    });
    // Gotcha: block.version hashes text, so a suggestion's inserted text makes
    // an agent's earlier read of the block stale (only mark entries are stripped).
    expect(await withLiveDoc(id, (doc) => blockVersion(findBlock(pmDoc(doc), 'p1')!.node))).not.toBe(p1Before);

    await Promise.all([a.provider.connect(), b.provider.connect()]);
    const merged = await converged(id, [a, b]);
    expect(render(merged)).toEqual({
      p1: `The quick [-brown-]{${s1}}[+red+]{${s1}} sly fox jumps.`,
      p2: `[-Second-]{${s2}}[+Other+]{${s2}} paragraph here.`,
      p3: 'Third line, edited by B.',
      p4: `Fourth [-stays-]{${s4}}[+remains+]{${s4}} pending.`,
      // Y.Text formatting is a pair of markers around the range, so text typed
      // concurrently inside a suggested deletion joins the deletion.
      p5: `Fifth [-woXrd-]{${s5}}[+term+]{${s5}} here.`,
    });

    // In Yjs each mark is a plain Y.Text formatting attribute keyed by its name
    // (the marks exclude themselves, so y-prosemirror adds no `--hash` suffix).
    const p1Text = await withLiveDoc(id, (doc) => {
      const group = doc.getXmlFragment(FRAGMENT).get(0) as Y.XmlElement;
      const container = group.toArray().find((el) => (el as Y.XmlElement).getAttribute('id') === 'p1') as Y.XmlElement;
      return ((container.get(0) as Y.XmlElement).get(0) as Y.XmlText).toDelta();
    });
    expect(p1Text).toEqual([
      { insert: 'The quick ' },
      { insert: 'brown', attributes: { deletion: { id: s1 } } },
      { insert: 'red', attributes: { insertion: { id: s1 } } },
      { insert: ' sly fox jumps.' },
    ]);
    // The node builder an editor's ySyncPlugin uses (which deletes text whose
    // marks the schema lacks) keeps every marked run.
    expect(yXmlFragmentToProseMirrorRootNode(a.doc.getXmlFragment(FRAGMENT), schema()).toJSON()).toEqual(merged);
    expect(JSON.stringify(pmJson(a.doc))).toBe(JSON.stringify(merged));

    // BlockNote reads suggestion-marked text as plain text (blocknoteIgnore):
    // nothing is dropped, both sides of a pending suggestion are there.
    const blocks = await withLiveDoc(id, (doc) => readBlocks(doc, 'main'));
    expect(blocks.map((block) => (block.content as { text: string }[]).map((c) => c.text).join(''))).toEqual([
      'The quick brownred sly fox jumps.',
      'SecondOther paragraph here.',
      'Third line, edited by B.',
      'Fourth staysremains pending.',
      'Fifth woXrdterm here.',
    ]);

    // Accept s1 and reject s2 from the server while A keeps typing.
    clientEdit(a.doc, (tr) => typeAt(tr, posOf(tr.doc, 'p1', '.', 1), ' Really.'));
    await applyPlan(id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: [
        settleSuggestion(main(''), s1, 'accept'),
        settleSuggestion(main(''), s2, 'reject'),
        settleSuggestion(main(''), s5, 'accept'),
      ],
    });
    const settled = await converged(id, [a, b]);
    expect(render(settled)).toEqual({
      p1: 'The quick red sly fox jumps. Really.',
      p2: 'Second paragraph here.',
      p3: 'Third line, edited by B.',
      p4: `Fourth [-stays-]{${s4}}[+remains+]{${s4}} pending.`,
      // Accepting the deletion takes A's concurrent "X" with it.
      p5: 'Fifth term here.',
    });

    // Unload: every client leaves, Hocuspocus stores and drops the document.
    expect(liveInstance().documents.has(liveDocName(id))).toBe(true);
    a.provider.destroy();
    b.provider.destroy();
    const deadline = Date.now() + 5000;
    while (liveInstance().documents.has(liveDocName(id))) {
      if (Date.now() > deadline) throw new Error('document never unloaded');
      await sleep(20);
    }
    const { doc: reloaded } = await loadYDoc(id);
    expect(pmJson(reloaded)).toEqual(settled);
    expect(render(pmJson(reloaded)).p4).toBe(`Fourth [-stays-]{${s4}}[+remains+]{${s4}} pending.`);

    // The pending suggestion settles after the reload too.
    await applyPlan(id, SYSTEM_ORIGIN, { onConflict: 'refuse', edits: [settleSuggestion(main(''), s4, 'accept')] });
    expect(render(await serverJson(id)).p4).toBe('Fourth remains pending.');
  });
  // Block-level suggestions FAIL: the library marks a whole inserted or deleted
  // block, and any attribute or type change, with node marks (`addNodeMark`,
  // `modification` via setNodeMarkup), but y-prosemirror 1.3.7 stores only a
  // node's attrs on its Y.XmlElement, never its marks. So the write drops them:
  // a suggested block deletion vanishes without a trace, an attribute or type
  // change is applied outright, and an inserted block keeps only its text's
  // inline insertion mark (rejecting it leaves an empty block).
  const blockEdits: Record<string, (tr: Transform) => void> = {
    'insert a block': (tr) => {
      const at = findBlock(tr.doc, 'p1')!;
      const block = schema().nodes.blockContainer!.create({ id: 'n1' }, schema().nodes.paragraph!.create({}, schema().text('New block')));
      tr.insert(at.pos + at.node.nodeSize, block);
    },
    'delete a block': (tr) => {
      const at = findBlock(tr.doc, 'p2')!;
      tr.delete(at.pos, at.pos + at.node.nodeSize);
    },
    'change a block prop': (tr) => tr.setNodeAttribute(findBlock(tr.doc, 'p2')!.pos + 1, 'textAlignment', 'center'),
    'change a block type': (tr) => tr.setNodeMarkup(findBlock(tr.doc, 'p2')!.pos + 1, schema().nodes.heading!, { level: 1 }),
  };
  for (const [name, build] of Object.entries(blockEdits)) {
    it.fails(`block-level suggestion keeps its node marks: ${name}`, async () => {
      const id = await createLiveDoc({ uploaderId: OWNER });
      await seedBlocks(id, [paragraph('p1', 'One.'), paragraph('p2', 'Two.')]);
      let tracked: unknown;
      const edit = asSuggestion({ target: main('p1'), inverse: false, build }, uuidv7());
      await applyPlan(id, SYSTEM_ORIGIN, {
        onConflict: 'refuse',
        edits: [{ ...edit, build: (tr, at) => (edit.build(tr, at), (tracked = tr.doc.toJSON())) }],
      });
      expect(JSON.stringify(tracked)).toMatch(/"marks":\[\{"type":"(insertion|deletion|modification)"/);
      expect(await serverJson(id)).toEqual(tracked);
    });
  }
});
