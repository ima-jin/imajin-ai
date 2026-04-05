import { createRelay } from '@metalabel/dfos-web-relay';
import type { RelayIdentity, RelayStore } from '@metalabel/dfos-web-relay';
import type { Hono } from 'hono';

export async function createCustomRelay(options: {
  store: RelayStore;
  identity?: RelayIdentity;
  content?: boolean;
}): Promise<Hono> {
  const { app } = await createRelay(options);
  return app;
}
