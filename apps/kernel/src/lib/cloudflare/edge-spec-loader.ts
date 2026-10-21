import { parse as parseYaml } from 'yaml';
import { egressSafeFetch } from '../kernel/egress-fetch';
import { SPEC_MAX_CHARS } from '../kernel/api-specs';

/**
 * Only registry/configuration-derived URLs enter this seam, never DNS targets
 * or request parameters. Reuse the kernel's DNS-pinned SSRF guard; no cookies,
 * authorization, redirects, external references or provider credentials.
 */
export async function loadRegistryEdgeSpec(rawUrl: string): Promise<unknown> {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('Invalid registry spec URL');
  }
  const response = await egressSafeFetch(url.href, { method: 'GET', headers: { Accept: 'application/yaml, application/json' } },
    { connector: 'edge-spec', timeoutMs: 5_000 });
  if (!response.ok || Number(response.headers.get('content-length')) > SPEC_MAX_CHARS || !response.body) {
    await response.body?.cancel();
    throw new Error('Registry spec unavailable');
  }
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Registry spec deadline exceeded')), 5_000);
  });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > SPEC_MAX_CHARS) throw new Error('Registry spec too large');
      chunks.push(value);
    }
    return parseYaml(Buffer.concat(chunks).toString('utf8'));
  } finally {
    clearTimeout(timer);
    try { await reader.cancel(); }
    finally { reader.releaseLock(); }
  }
}
