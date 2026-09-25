/**
 * GET /api/health (#2384): this route is now a one-line call into the
 * shared `createAppHealthHandler` factory (packages/db/src/health-route.ts,
 * covered in depth by packages/db/tests/health-route.test.ts). This test
 * only proves links' own route wires that factory with the right service
 * name and that the response always carries a well-formed `migrationHead`
 * field, even with no DATABASE_URL configured in this test environment.
 */
import { describe, it, expect } from 'vitest';

describe('GET /api/health (links)', () => {
  it('reports its own service name and a well-formed migrations.migrationHead field', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    const body = await res.json() as {
      service: string;
      status: string;
      migrations: { migrationHead: string | null; appliedCount: number; pendingCount: number | null };
    };

    expect(body.service).toBe('links');
    expect(['ok', 'degraded']).toContain(body.status);
    expect(body.migrations).toHaveProperty('migrationHead');
    expect(body.migrations.migrationHead === null || typeof body.migrations.migrationHead === 'string').toBe(true);
    expect(typeof body.migrations.appliedCount).toBe('number');
  });
});
