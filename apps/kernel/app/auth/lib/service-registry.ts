import { registryAppPublicUrl } from '@/src/lib/apps/public-url';
import { validateEntryUrl } from '@/src/lib/apps/entry-url';

/** Add hub parameters without altering a registry destination's path, query, or fragment. */
function withEmbedParams(destination: string, did: string): string {
  const url = new URL(destination, 'https://kernel.invalid');
  url.searchParams.set('embed', 'hub');
  url.searchParams.set('did', did);
  return destination.startsWith('/') ? `${url.pathname}${url.search}${url.hash}` : url.href;
}

/** Legacy configured app bases expose their identity dashboard under `/dashboard`. */
export function buildEmbedSrc(did: string, baseUrl: string): string {
  return withEmbedParams(`${baseUrl.replace(/\/$/, '')}/dashboard`, did);
}

/** Registry entryUrl is an exact destination; only legacy bases imply `/dashboard`. */
export function registryAppEmbedUrl(app: { slug: string; entryUrl: string | null }, did: string): string {
  const destination = registryAppPublicUrl(app);
  if (app.entryUrl && validateEntryUrl(app.entryUrl).ok) {
    return withEmbedParams(destination, did);
  }
  return buildEmbedSrc(did, destination);
}
