import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

/**
 * Fetching a URL a person typed into a document, from the server (link cards).
 * The address must be public: the check runs on the addresses the connection
 * itself uses (a `lookup` hook), so a hostname that resolves to a private
 * address, or changes its answer between a check and a connect, never gets
 * through. Redirects are followed by hand and every hop is checked the same
 * way. Only http(s) on the default ports, a hard time limit, a byte cap.
 */

const NON_PUBLIC = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) {
  NON_PUBLIC.addSubnet(net, bits, 'ipv6');
}

NON_PUBLIC.addSubnet('3fff::', 20, 'ipv6');

/** IPv6 addresses are public only inside the global unicast block 2000::/3
 *  (less the special-purpose ranges above): the rest of the space is reserved
 *  or private (site-local fec0::, 5f00::, ...). */
const GLOBAL_UNICAST_V6 = new BlockList();
GLOBAL_UNICAST_V6.addSubnet('2000::', 3, 'ipv6');

/** Whether `address` (an IP literal) is a public unicast address. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6 && !GLOBAL_UNICAST_V6.check(address, 'ipv6')) return false;
  return !NON_PUBLIC.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export class UnsafeFetchError extends Error {}

export type SafeResponse = { url: string; status: number; contentType: string; body: Buffer };

export type SafeGetOptions = {
  /** Whole-request time limit, redirects included. */
  timeoutMs: number;
  /** The body is cut off, and the fetch refused, past this many bytes. */
  maxBytes: number;
  maxRedirects?: number;
  accept?: string;
};

/** The connection's DNS lookup: only public addresses are ever returned. */
function publicLookup(hostname: string, options: { all?: boolean; family?: number }, callback: (...args: unknown[]) => void): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = addresses as { address: string; family: number }[];
    const allowed = list.filter((a) => isPublicAddress(a.address));
    if (allowed.length === 0 || allowed.length !== list.length) {
      return callback(new UnsafeFetchError(`${hostname} does not resolve to a public address`));
    }
    if (options.all) return callback(null, allowed);
    callback(null, allowed[0]!.address, allowed[0]!.family);
  });
}

/** A parsed, vetted URL, or an error: http(s), default port, no credentials, a public IP literal if it is one. */
export function vetUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeFetchError('not a URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UnsafeFetchError('only http and https links are fetched');
  if (url.username || url.password) throw new UnsafeFetchError('links with credentials are not fetched');
  if (url.port !== '') throw new UnsafeFetchError('only the default ports are fetched');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0 && !isPublicAddress(host)) throw new UnsafeFetchError('not a public address');
  return url;
}

function once(url: URL, signal: AbortSignal, opts: SafeGetOptions): Promise<SafeResponse & { location: string | null }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(
      url,
      {
        method: 'GET',
        signal,
        lookup: publicLookup as never,
        headers: { accept: opts.accept ?? '*/*', 'user-agent': 'PrimerLinkCard/1', 'accept-encoding': 'identity' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > opts.maxBytes) {
            req.destroy(new UnsafeFetchError('response too large'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () =>
          resolve({ url: url.href, status, location, contentType: String(res.headers['content-type'] ?? '').toLowerCase(), body: Buffer.concat(chunks) }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** GET `raw` under the rules above. Rejects with `UnsafeFetchError` for a refused address, size or hop count. */
export async function safeGet(raw: string, opts: SafeGetOptions): Promise<SafeResponse> {
  const signal = AbortSignal.timeout(opts.timeoutMs);
  let url = vetUrl(raw);
  for (let hop = 0; ; hop++) {
    const res = await once(url, signal, opts);
    if (res.status >= 300 && res.status < 400 && res.location) {
      if (hop >= (opts.maxRedirects ?? 3)) throw new UnsafeFetchError('too many redirects');
      url = vetUrl(new URL(res.location, url).href);
      continue;
    }
    return res;
  }
}
