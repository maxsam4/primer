import { describe, expect, it, vi } from 'vitest';
import type { Storage } from '../storage/types.ts';

describe('loadSigningKey', () => {
  it('makes the key only when it is missing, never on another storage failure', async () => {
    const { loadSigningKey } = await import('./signing.ts');
    const put = vi.fn(async () => undefined);
    const down: Storage = {
      get: async () => {
        throw Object.assign(new Error('storage unavailable'), { code: 'EIO' });
      },
      put,
      delete: async () => undefined,
    };
    await expect(loadSigningKey(down)).rejects.toThrow('storage unavailable');
    expect(put).not.toHaveBeenCalled();

    const missing: Storage = {
      get: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      put,
      delete: async () => undefined,
    };
    await loadSigningKey(missing);
    expect(put).toHaveBeenCalledTimes(1);
  });
});
