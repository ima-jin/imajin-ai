import { canonicalize, SIGNED_MESSAGE_MAX_AGE, FUTURE_TOLERANCE } from '@imajin/auth';
import { verifySignature } from './crypto';
import { resolveReachRequester } from './reach-authority';

export interface SignedReachStatusRequest {
  requesterDid: string;
  /** did:web callers supply a key verified against their DID document. */
  publicKey?: string;
  issuedAt: string;
  signature: string;
}

/** Bind the signature to the operation, principal and exact receipt; status remains requester-private. */
export function reachStatusTranscript(
  principalDid: string,
  reachId: string,
  request: Pick<SignedReachStatusRequest, 'requesterDid' | 'issuedAt' | 'publicKey'>,
): string {
  return canonicalize({
    type: 'reach_status', principalDid, reachId,
    requesterDid: request.requesterDid, issuedAt: request.issuedAt,
    ...(request.publicKey === undefined ? {} : { publicKey: request.publicKey }),
  });
}

export function parseSignedReachStatus(raw: unknown): SignedReachStatusRequest | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { requesterDid, publicKey, issuedAt, signature } = raw as Record<string, unknown>;
  if (typeof requesterDid !== 'string' || !requesterDid.startsWith('did:')) return null;
  if (typeof issuedAt !== 'string' || !Number.isFinite(Date.parse(issuedAt))) return null;
  if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/i.test(signature)) return null;
  if (publicKey !== undefined && (typeof publicKey !== 'string' || !/^[0-9a-f]{64}$/i.test(publicKey))) return null;
  return { requesterDid, issuedAt, signature, ...(publicKey === undefined ? {} : { publicKey }) };
}

export async function authenticateSignedReachStatus(
  principalDid: string,
  reachId: string,
  input: SignedReachStatusRequest,
): Promise<boolean> {
  const age = Date.now() - Date.parse(input.issuedAt);
  if (!Number.isFinite(age) || age > SIGNED_MESSAGE_MAX_AGE || age < -FUTURE_TOLERANCE) return false;
  const requester = await resolveReachRequester(input.requesterDid, input.publicKey);
  if (!requester) return false;
  return verifySignature(reachStatusTranscript(principalDid, reachId, input), input.signature, requester.publicKey);
}
