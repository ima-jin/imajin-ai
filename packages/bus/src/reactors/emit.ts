/**
 * Emit reactor — wraps createEmitter from @imajin/emit.
 *
 * Records system events to the events log (postgres adapter).
 */

import { createEmitter } from '@imajin/emit';
import type { IdentityRegisteredPayload, ConnectionAcceptedPayload } from '../types';

const emitter = createEmitter('bus');

export function onIdentityRegistered(payload: IdentityRegisteredPayload): void {
  emitter.emit({
    action: 'identity.register',
    did: payload.did,
    payload: { scope: payload.scope, subtype: payload.subtype, tier: payload.tier },
  });
}

export function onConnectionAccepted(payload: ConnectionAcceptedPayload): void {
  emitter.emit({
    action: 'connection.create',
    did: payload.did,
    payload: { otherDid: payload.fromDid, source: 'invite' },
  });
}
