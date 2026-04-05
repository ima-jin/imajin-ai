import { createRelay } from '@metalabel/dfos-web-relay';
import type { CreatedRelay } from '@metalabel/dfos-web-relay';
import type { RelayIdentity, RelayStore } from '@metalabel/dfos-web-relay';

export async function createCustomRelay(options: {
  store: RelayStore;
  identity?: RelayIdentity;
  content?: boolean;
}): Promise<CreatedRelay> {
  return createRelay(options);
}
