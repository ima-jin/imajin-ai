import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import type { LoopIngestRequest } from './types';

/** Node witnesses a collision; it never impersonates either holder's signer. */
export function signSurfaceConflict(request: LoopIngestRequest, conflictingLoopId: string): LoopIngestRequest {
  const identity = getNodeSigningIdentity();
  const type = 'surface.conflicted';
  const payload = {
    ...request.payload,
    refs: { ...request.payload.refs, conflictingLoopId },
    summary: 'Surface is already leased by another loop (warning only)',
  };
  return {
    type, payload, publisherDid: identity.senderDid,
    signature: {
      keyId: identity.senderPubkey.toLowerCase(),
      alg: 'ed25519',
      sig: authCrypto.signSync(canonicalize({ type, payload }), identity.privateKeyHex).toLowerCase(),
    },
  };
}
