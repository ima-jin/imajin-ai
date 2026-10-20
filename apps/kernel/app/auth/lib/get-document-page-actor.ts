import { headers } from 'next/headers';
import { requireDocumentActor } from '@/src/lib/auth/document-authorization';
import { nodeUrl } from '@/src/lib/http/node-url';

/** Cookie-selected identities are untrusted until the shared live authority gate accepts them. */
export async function getDocumentPageActor() {
  const request = new Request(`${nodeUrl()}/auth/attestations`, { headers: await headers() });
  const actor = await requireDocumentActor(request);
  return actor instanceof Response ? null : actor;
}
