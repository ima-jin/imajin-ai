/**
 * 0.6.0-conformant relay factory
 *
 * Wraps the 0.5.0 base relay (from @metalabel/dfos-web-relay) and overrides:
 * - POST /operations   → 0.6.0 ingest (status rename, fork/DAG, temporal guards)
 * - GET  /log          → pagination fix (unknown cursor → empty page)
 * - GET  /.well-known/dfos-relay → version bumped to 0.6.0
 *
 * All other routes fall through to the 0.5.0 base relay unchanged.
 */

import { createRelay } from '@metalabel/dfos-web-relay';
import type { RelayStore, RelayIdentity } from '@metalabel/dfos-web-relay';
import { Hono } from 'hono';
import { z } from 'zod';
import { ingestOperations060 } from './ingest';

const IngestBody = z.object({
  operations: z.array(z.string()).min(1).max(100),
});

export async function createCustomRelay(options: {
  store: RelayStore;
  identity?: RelayIdentity;
  content?: boolean;
}): Promise<Hono> {
  const { store } = options;

  // Bootstrap the 0.5.0 base relay for identity/auth setup and non-overridden routes
  const baseRelay = await createRelay(options);

  const app = new Hono();

  // ── Version bump ──────────────────────────────────────────────────────────
  app.get('/.well-known/dfos-relay', async (c) => {
    const req = new Request(new URL('/.well-known/dfos-relay', 'http://localhost'));
    const baseResponse = await baseRelay.fetch(req);
    const data = (await baseResponse.json()) as Record<string, unknown>;
    return c.json({ ...data, version: '0.6.0' });
  });

  // ── 0.6.0 operation ingestion ─────────────────────────────────────────────
  app.post('/operations', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }

    const parsed = IngestBody.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid request', details: parsed.error.issues }, 400);
    }

    const results = await ingestOperations060(parsed.data.operations, store);
    return c.json({ results });
  });

  // ── Pagination fix: unknown cursor → empty page ───────────────────────────
  app.get('/log', async (c) => {
    const afterParam = c.req.query('after');
    const limit = Math.min(Number(c.req.query('limit') || 100), 1000);
    const result = await store.readLog(afterParam ? { after: afterParam, limit } : { limit });
    return c.json(result);
  });

  // ── Fall through to base relay for all other routes ───────────────────────
  app.all('*', (c) => baseRelay.fetch(c.req.raw));

  return app;
}
