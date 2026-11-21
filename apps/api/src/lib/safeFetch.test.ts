import { describe, expect, it } from 'vitest';
import { isPublicAddress, safeGet, UnsafeFetchError } from './safeFetch.ts';

const opts = { timeoutMs: 2000, maxBytes: 1024 };

describe('safeGet', () => {
  it('private, loopback, link-local and metadata addresses are not public', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '64:ff9b::a00:1', 'fec0::1', '5f00::1', '3fff::1', '::127.0.0.1']) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111']) expect(isPublicAddress(ip), ip).toBe(true);
  });

  it('refuses addresses and links it must not reach, before connecting', async () => {
    for (const url of [
      'http://127.0.0.1/',
      'http://[::1]/',
      'http://10.0.0.1/admin',
      'http://169.254.169.254/latest/meta-data',
      'http://localhost/',
      'http://user:pass@example.com/',
      'http://example.com:8080/',
      'file:///etc/passwd',
      'ftp://example.com/',
    ]) {
      await expect(safeGet(url, opts), url).rejects.toBeInstanceOf(UnsafeFetchError);
    }
  });
});
