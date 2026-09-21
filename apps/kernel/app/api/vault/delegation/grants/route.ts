import { NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { listGrantsForGrantee } from '@/src/lib/vault';
import { toVaultErrorResponse } from '@/src/lib/vault/errors';

const log = createLogger('kernel');

/**
 * GET /api/vault/delegation/grants — an agent's self-service view of its own
 * `vault_delegation_grants` rows (#2231 remote human -> agent credential
 * handoff).
 *
 * Session/bearer-authenticated as the agent DID itself (`requireAuth`), NOT
 * `requireAdmin` — unlike `/api/vault/delegation/grant` (which the node's own
 * owner agent posts to), this route is what lets an arbitrary grantee DID
 * enumerate grants issued to it. Never returns wrapped key material: the
 * value itself is only ever available via
 * `POST /api/vault/delegation/grants/{grantId}/fetch`.
 *
 * `?purpose=` narrows the list to grants carrying that exact `purpose` label
 * (e.g. `?purpose=gha-runner-registration`), so an agent that expects many
 * unrelated grants can find the ones relevant to a specific task without
 * fetching or inspecting the rest.
 */
export async function GET(request: Request) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }

  const granteeDid = authResult.identity.id;
  const purpose = new URL(request.url).searchParams.get('purpose');

  try {
    const grants = await listGrantsForGrantee({
      granteeDid,
      purpose: purpose ?? undefined,
    });
    return NextResponse.json({ grants });
  } catch (error) {
    log.error({ err: String(error), granteeDid, purpose }, 'Vault delegation/grants listing error');
    return toVaultErrorResponse(error, 'Failed to list delegation grants', 500);
  }
}
