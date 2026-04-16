import { createRelay, createHttpPeerClient } from '@metalabel/dfos-web-relay';
import type { CreatedRelay, PeerConfig } from '@metalabel/dfos-web-relay';
import type { RelayIdentity, RelayStore } from '@metalabel/dfos-web-relay';

export async function createCustomRelay(options: {
  store: RelayStore;
  identity?: RelayIdentity;
  content?: boolean;
  peers?: PeerConfig[];
}): Promise<CreatedRelay> {
  return createRelay({
    ...options,
    peers: options.peers,
    peerClient: options.peers?.length ? createHttpPeerClient() : undefined,
  });
}
