import { vi } from 'vitest';

// Mock global fetch — real services are not available in test env.
// Route handlers call profile service and connections service (non-fatal).
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }),
);
