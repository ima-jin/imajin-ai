import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import type { LoopIngestRequest } from './types';
import type { SurfaceConflict } from './surface-lease';

/** Node witnesses a collision; it never impersonates either holder's signer. */
export function signSurfaceConflict(request: LoopIngestRequest, conflict: SurfaceConflict): LoopIngestRequest {
  const identity = getNodeSigningIdentity();
  const type = 'surface.conflicted';
  const payload = {
    ...request.payload,
    refs: {
      ...request.payload.refs, conflictingLoopId: conflict.loopId,
      ...(conflict.holderDid ? { conflictingHolderDid: conflict.holderDid } : {}),
    },
    summary: 'Surface is already leased by another holder (warning only)',
  };
  // Never echo caller-supplied holder metadata into a node-witnessed conflict.
  if (!conflict.holderDid) delete payload.refs.conflictingHolderDid;
  return {
    type, payload, publisherDid: identity.senderDid,
    signature: {
      keyId: identity.senderPubkey.toLowerCase(),
      alg: 'ed25519',
      sig: authCrypto.signSync(canonicalize({ type, payload }), identity.privateKeyHex).toLowerCase(),
    },
  };
}
