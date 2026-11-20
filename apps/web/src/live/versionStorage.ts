import type {
  VersionError,
  VersionResult,
  VersionSnapshot,
  VersionSnapshotPage,
  VersionStorage,
} from '@blocknote/core/extensions';
import type { CheckpointResponse, VersionsListResponse } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';
import { t } from '../i18n/index.ts';

/**
 * BlockNote's version history over Primer's checkpoints. Each checkpoint is a
 * version; its content is the frozen Y.Doc state of its render bundle, which
 * BlockNote previews in a fork of the document. Saving names the checkpoint
 * with its note; restoring is a new edit made by the server. Versions are
 * never deleted, so `remove` is left out.
 *
 * Versions from before the document went live have no Y.Doc to preview. They
 * stay in the list, and selecting one hands its number to `openLegacy`, which
 * shows it in the read-only version viewer (rendered HTML in its sandboxed
 * frame), the same as for any legacy document.
 */
export class PrimerVersionStorage implements VersionStorage<Uint8Array> {
  private readonly legacy = new Map<string, number>();

  constructor(
    private readonly documentId: string,
    private readonly openLegacy: (versionNumber: number) => void = () => undefined,
  ) {}

  async list(signal: AbortSignal): Promise<VersionResult<VersionSnapshotPage>> {
    const res = await call(`/api/documents/${this.documentId}/versions`, { signal });
    if (!res.ok) return res;
    const body = (await res.value.json()) as VersionsListResponse;
    this.legacy.clear();
    for (const v of body.versions) if (v.bundled === false) this.legacy.set(v.id, v.versionNumber);
    return {
      ok: true,
      value: {
        snapshots: body.versions.map((v) => ({
          id: v.id,
          createdAt: Date.parse(v.createdAt),
          name: v.versionNote ?? t(v.automatic ? 'liveEditor.autoCheckpointName' : 'liveEditor.checkpointName', { number: v.versionNumber }),
          metadata: { versionNumber: v.versionNumber },
        })),
      },
    };
  }

  async getContent(id: string, signal: AbortSignal): Promise<VersionResult<Uint8Array>> {
    const legacyNumber = this.legacy.get(id);
    if (legacyNumber !== undefined) {
      this.openLegacy(legacyNumber);
      // The viewer replaces the editor, so this preview never settles.
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    }
    const res = await call(`/api/versions/${id}/ydoc`, { signal });
    if (!res.ok) return res;
    return { ok: true, value: new Uint8Array(await res.value.arrayBuffer()) };
  }

  create = async (_content: Uint8Array, name?: string): Promise<VersionResult<VersionSnapshot>> => {
    const res = await call(`/api/documents/${this.documentId}/checkpoints`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: name ?? null }),
    });
    if (!res.ok) return res;
    const checkpoint = (await res.value.json()) as CheckpointResponse;
    return {
      ok: true,
      value: {
        id: checkpoint.versionId,
        createdAt: Date.now(),
        name: name ?? t('liveEditor.checkpointName', { number: checkpoint.versionNumber }),
        metadata: { versionNumber: checkpoint.versionNumber },
      },
    };
  };

  restore = async (id: string): Promise<VersionResult<void>> => {
    const res = await call(`/api/versions/${id}/restore`, { method: 'POST' });
    return res.ok ? { ok: true, value: undefined } : res;
  };

  rename = async (id: string, name?: string): Promise<VersionResult<void>> => {
    const res = await call(`/api/versions/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ versionNote: name ?? null }),
    });
    return res.ok ? { ok: true, value: undefined } : res;
  };
}

async function call(url: string, init: RequestInit): Promise<VersionResult<Response>> {
  let res: Response;
  try {
    res = await api(url, init);
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    return { ok: false, error: { type: 'network' } };
  }
  if (res.ok) return { ok: true, value: res };
  const error: VersionError =
    res.status === 403 ? { type: 'forbidden' } :
    res.status === 404 ? { type: 'not-found' } :
    res.status === 409 ? { type: 'conflict' } :
    { type: 'server', status: res.status };
  return { ok: false, error };
}
