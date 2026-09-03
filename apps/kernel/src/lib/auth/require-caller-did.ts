/**
 * Shared auth preamble for the envelope provisioner routes (#1933).
 *
 * Every provisioner route (`POST/GET /auth/api/agents/provision`,
 * `GET/DELETE .../[id]`, `GET .../[id]/bundle`) starts the same way:
 * `requireAuth()`, translate a failure into `authErrorResponse()`, then
 * resolve the caller's effective DID (`actingAs ?? id`). Factored out once
 * rather than repeated five times across route files.
 */
import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { requireAuth, authErrorResponse, type Identity } from '@imajin/auth';

export interface CallerIdentity {
  identity: Identity;
  callerDid: string;
}

export interface CallerIdentityError {
  errorResponse: NextResponse;
}

/**
 * Resolve the authenticated caller's identity and effective DID
 * (`identity.actingAs ?? identity.id`), or a ready-to-return error response
 * when authentication fails.
 */
export async function resolveCallerIdentity(request: NextRequest): Promise<CallerIdentity | CallerIdentityError> {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return { errorResponse: authErrorResponse(authResult) };
  }
  const { identity } = authResult;
  return { identity, callerDid: identity.actingAs ?? identity.id };
}

export function isCallerIdentityError(result: CallerIdentity | CallerIdentityError): result is CallerIdentityError {
  return 'errorResponse' in result;
}
