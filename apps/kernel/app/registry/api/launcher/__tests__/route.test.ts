/**
 * GET /registry/api/launcher (#2434).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({ buildLauncherEntries: vi.fn() }));

vi.mock('@/src/lib/kernel/launcher', () => ({ buildLauncherEntries: mocks.buildLauncherEntries }));

import { GET, OPTIONS } from '../route';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /registry/api/launcher', () => {
  it('returns the launcher entries under `services`, unauthenticated', async () => {
    const entries = [{ name: 'registry-only-app', source: 'registry' }];
    mocks.buildLauncherEntries.mockResolvedValue(entries);

    const res = await GET(new NextRequest('http://localhost/registry/api/launcher'));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ services: entries });
  });

  it('answers CORS preflight', async () => {
    const res = await OPTIONS(new NextRequest('http://localhost/registry/api/launcher', { method: 'OPTIONS' }));

    expect(res.status).toBeLessThan(300);
  });
});
