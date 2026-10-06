/**
 * #2565 — every kernel route whose CORS preflight used to be an `async`
 * handler with no `await` (typescript:S7503) now re-exports the shared
 * `corsOptions` handler: a synchronous 204 with CORS headers. Routes are
 * imported for real; only their heavy collaborators are stubbed.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';

// Some routes pull `@imajin/db` in at import time; the postgres client connects
// lazily, so a dummy URL is enough to import them without touching a database.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test:test@127.0.0.1:5432/test';
});
vi.mock('@/src/db', () => ({ db: {} }));

const ROUTES: Record<string, () => Promise<{ OPTIONS: (req: NextRequest) => unknown }>> = {
  'api/apps/claim': () => import('../api/apps/claim/route'),
  'api/apps/provision': () => import('../api/apps/provision/route'),
  'api/apps/signing-key/fetch': () => import('../api/apps/signing-key/fetch/route'),
  'api/inference/capture': () => import('../api/inference/capture/route'),
  'api/inference/confirm/[sessionId]': () => import('../api/inference/confirm/[sessionId]/route'),
  'api/inference/sessions': () => import('../api/inference/sessions/route'),
  'api/loops/[loopId]': () => import('../api/loops/[loopId]/route'),
  'api/loops': () => import('../api/loops/route'),
  'consent/api/requests/[requestId]/decision': () => import('../consent/api/requests/[requestId]/decision/route'),
  'consent/api/requests/[requestId]': () => import('../consent/api/requests/[requestId]/route'),
  'consent/api/requests': () => import('../consent/api/requests/route'),
  'discord/api/token': () => import('../discord/api/token/route'),
  'infer/v1/chat/completions': () => import('../infer/v1/chat/completions/route'),
  'infer/v1/messages/count_tokens': () => import('../infer/v1/messages/count_tokens/route'),
  'infer/v1/messages': () => import('../infer/v1/messages/route'),
  'infer/v1/models': () => import('../infer/v1/models/route'),
  'infer/v1/models/usable': () => import('../infer/v1/models/usable/route'),
  'jin/api/events': () => import('../jin/api/events/route'),
  'jin/api/grants': () => import('../jin/api/grants/route'),
  'jin/api/operator-approvals/[proposalId]/decision': () => import('../jin/api/operator-approvals/[proposalId]/decision/route'),
  'jin/api/operator-approvals': () => import('../jin/api/operator-approvals/route'),
  'jin/api/push-subscriptions': () => import('../jin/api/push-subscriptions/route'),
  'jin/api/vault-proposals': () => import('../jin/api/vault-proposals/route'),
  'local/api/settings': () => import('../local/api/settings/route'),
  'media/api/assets/[id]/access': () => import('../media/api/assets/[id]/access/route'),
  'media/api/assets/[id]/article': () => import('../media/api/assets/[id]/article/route'),
  'media/api/assets/[id]/grants': () => import('../media/api/assets/[id]/grants/route'),
  'media/api/assets/[id]/transcribe': () => import('../media/api/assets/[id]/transcribe/route'),
  'media/api/assets/bundle': () => import('../media/api/assets/bundle/route'),
  'media/api/assets': () => import('../media/api/assets/route'),
  'media/api/transcribe': () => import('../media/api/transcribe/route'),
  'stripe/api/disconnect': () => import('../stripe/api/disconnect/route'),
  'stripe/api/token': () => import('../stripe/api/token/route'),
  'supply/api/collected': () => import('../supply/api/collected/route'),
  'supply/api/declared': () => import('../supply/api/declared/route'),
  'supply/api/listed': () => import('../supply/api/listed/route'),
  'supply/api/lot/[correlationId]': () => import('../supply/api/lot/[correlationId]/route'),
  'supply/api/lots': () => import('../supply/api/lots/route'),
  'supply/api/processed': () => import('../supply/api/processed/route'),
  'supply/api/received': () => import('../supply/api/received/route'),
  'typesafe/api/decide': () => import('../typesafe/api/decide/route'),
  'typesafe/api/models': () => import('../typesafe/api/models/route'),
  'warp/api/dispatch': () => import('../warp/api/dispatch/route'),
  'warp/api/environment': () => import('../warp/api/environment/route'),
  'warp/api/runs/[runId]/cancel': () => import('../warp/api/runs/[runId]/cancel/route'),
  'warp/api/runs/[runId]/conversation': () => import('../warp/api/runs/[runId]/conversation/route'),
  'warp/api/runs/[runId]/followups': () => import('../warp/api/runs/[runId]/followups/route'),
  'warp/api/runs/[runId]': () => import('../warp/api/runs/[runId]/route'),
  'warp/api/runs/[runId]/transcript': () => import('../warp/api/runs/[runId]/transcript/route'),
  'warp/api/runs': () => import('../warp/api/runs/route'),
};

// Cold route imports belong in a hook with an explicit budget, not inside the
// first `it()` that triggers them: on a loaded CI runner that cost blew the 5s
// testTimeout elsewhere in the kernel suite (#2616).
const ROUTE_IMPORT_TIMEOUT_MS = 120_000;

type OptionsHandler = (req: NextRequest) => unknown;
const handlers: Record<string, OptionsHandler> = {};

describe('kernel route CORS preflight (S7503)', () => {
  beforeAll(async () => {
    await Promise.all(
      Object.entries(ROUTES).map(async ([name, load]) => {
        handlers[name] = (await load()).OPTIONS;
      }),
    );
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it.each(Object.keys(ROUTES))('%s OPTIONS returns a synchronous 204 with CORS headers', (name) => {
    const response = handlers[name](
      new NextRequest('http://localhost/x', { method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } }),
    ) as Response;
    // Not a Promise: the handler is synchronous now that it no longer awaits anything.
    expect(response).not.toBeInstanceOf(Promise);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS');
    expect(response.headers.get('Vary')).toBe('Origin');
  });
});
