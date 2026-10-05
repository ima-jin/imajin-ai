import { NextRequest } from 'next/server';

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';

/**
 * GET /api/attestations/:did
 * Shorthand for GET /api/attestations?subject_did=:did
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const { did } = await params;
  const subjectDid = decodeURIComponent(did);

  // Forward to the main attestations handler with subject_did injected
  const url = new URL(request.url);
  url.pathname = '/api/attestations';
  url.searchParams.set('subject_did', subjectDid);

  const forwarded = new NextRequest(url, {
    headers: request.headers,
  });

  const { GET: getAttestations } = await import('../route');
  return getAttestations(forwarded);
}
