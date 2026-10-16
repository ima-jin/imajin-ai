import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import { ingestLoopEvent } from './ingest';
import type { LoopEnvelope, LoopLifecycleType } from './types';

const log = createLogger('kernel:loop-emit');

/** Internal observations use the node witness, never impersonate the principal. */
export async function emitKernelLoopEvent(type: LoopLifecycleType, payload: LoopEnvelope): Promise<void> {
  try {
    const identity = getNodeSigningIdentity();
    const result = await ingestLoopEvent({
      type,
      payload,
      publisherDid: identity.senderDid,
      signature: {
        keyId: identity.senderPubkey.toLowerCase(),
        alg: 'ed25519',
        sig: authCrypto.signSync(canonicalize({ type, payload }), identity.privateKeyHex).toLowerCase(),
      },
    });
    if (!result.ok) log.warn({ type, loopId: payload.loopId, reason: result.error }, 'Loop observation rejected');
  } catch (err) {
    log.error({ type, loopId: payload.loopId, err: String(err) }, 'Loop observation failed (non-fatal)');
  }
}
