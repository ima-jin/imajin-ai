import { requireAuth, resolveActingDid } from '@imajin/auth';
import { parseDfosAuthorization, verifyDfosWrite, type DfosWriteAuthDeps } from './dfos-write-auth';

/**
 * AuthZ for the mounted DFOS web relay (#454, #2132).
 *
 * The relay is proxied wholesale at `/registry/relay/*`, so we cannot annotate
 * individual library routes. Instead we gate by HTTP method: every mutating
 * verb must carry either a verified Imajin DID (session cookie or Bearer
 * token, via the same `requireAuth` used by every other kernel service
 * route) or a DFOS protocol proof (`Authorization: DFOS <proof>`, #2132)
 * from an attested peer DID. Reads stay open so the proof log remains
 * publicly verifiable.
 *
 * Relay write surface in @metalabel/dfos-web-relay 0.13.x:
 *   POST /proof/v1/operations
 *   PUT  /content/:contentId/blob/:operationCID
 *
 * PATCH/DELETE are gated too even though the library exposes none today — a
 * future relay version must not become writable by accident.
 */
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Header carrying the authorized writer's DID to the relay, for audit. */
export const RELAY_WRITER_DID_HEADER = 'x-imajin-relay-writer';

/** True when the request mutates relay state and therefore needs a verified DID. */
export function isRelayWrite(method: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase());
}

export interface RelayWriteAuthorized {
  /** Effective DID for the write — resolves agent/group delegation. */
  did: string;
  /** DID of the credential holder that actually made the call. */
  callerDid: string;
}

export interface RelayWriteDenied {
  error: string;
  status: number;
}

export type RelayWriteAuth = RelayWriteAuthorized | RelayWriteDenied;

export function isRelayWriteDenied(result: RelayWriteAuth): result is RelayWriteDenied {
  return 'error' in result;
}

export interface RelayWriteAuthDeps {
  /** Deps for verifying an `Authorization: DFOS <proof>` write (#2132). */
  dfos: DfosWriteAuthDeps;
}

/**
 * Authorize a relay write. Returns the effective DID on success, or an
 * `{ error, status }` pair (401 unauthenticated/invalid proof, 403 bad
 * delegation or an unattested DFOS peer, 503 auth service down) that the
 * caller should render as-is.
 *
 * An `Authorization: DFOS <proof>` header (#2132) is checked first and, if
 * present, is authoritative — it never falls through to the Imajin auth
 * path, matching or failing on its own terms. Any other scheme (or none)
 * falls through to the pre-existing `requireAuth` behavior unchanged.
 */
export async function authorizeRelayWrite(request: Request, deps: RelayWriteAuthDeps): Promise<RelayWriteAuth> {
  const dfosProof = parseDfosAuthorization(request.headers.get('authorization'));
  if (dfosProof !== null) {
    const result = await verifyDfosWrite(dfosProof, deps.dfos);
    if (!result.ok) {
      return { error: result.error, status: result.status };
    }
    return { did: result.did, callerDid: result.did };
  }

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return { error: authResult.error, status: authResult.status };
  }

  return {
    did: resolveActingDid(authResult.identity),
    callerDid: authResult.identity.id,
  };
}
