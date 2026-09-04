import { NextRequest, NextResponse } from 'next/server';
import { resolveCallerIdentity, isCallerIdentityError } from '@/src/lib/auth/require-caller-did';
import { identifyArtifactKind, createDefaultRepository } from '@/src/lib/retrace/repository';
import { walkRetrace, RetraceNotFoundError, RetraceForbiddenStartError } from '@/src/lib/retrace/walk';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * GET /auth/api/retrace?artifact=<id>&kind=<attestation|agent_provision|bus_event>
 *
 * Retrace (#1962): a read-only causal walk from any terminal artifact
 * (attestation, agent provision, or bus event) back to the originating
 * signed intent, newest hop first. `kind` is optional — it's inferred from
 * the artifact id's prefix when omitted (see
 * `src/lib/retrace/repository.ts`'s `identifyArtifactKind`).
 *
 * Auth mirrors the rest of the provisioner surface (#1933): `requireAuth`
 * via `resolveCallerIdentity`, resolving to the caller's own effective DID
 * (`actingAs ?? id`). Per-hop visibility beyond that is enforced by the
 * walk itself (`src/lib/retrace/authorize.ts`) — hops the caller can't read
 * come back as opaque tombstones rather than 403s, except for the starting
 * artifact itself, which 403s outright (see `RetraceForbiddenStartError`).
 *
 * See `docs/agents/retrace-view.md` for the full response contract.
 */
export async function GET(request: NextRequest) {
  const auth = await resolveCallerIdentity(request);
  if (isCallerIdentityError(auth)) {
    return auth.errorResponse;
  }
  const { callerDid } = auth;

  const { searchParams } = new URL(request.url);
  const artifact = searchParams.get('artifact');
  if (!artifact) {
    return NextResponse.json({ error: 'artifact is required' }, { status: 400 });
  }
  const kind = identifyArtifactKind(artifact, searchParams.get('kind'));

  try {
    const result = await walkRetrace({ kind, id: artifact }, callerDid, createDefaultRepository());
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RetraceNotFoundError) {
      return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
    }
    if (error instanceof RetraceForbiddenStartError) {
      return NextResponse.json({ error: 'Not authorized to retrace this artifact' }, { status: 403 });
    }
    log.error({ err: String(error) }, '[retrace] Walk error');
    return NextResponse.json({ error: 'Failed to retrace artifact' }, { status: 500 });
  }
}
