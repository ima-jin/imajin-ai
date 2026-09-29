/**
 * Unit tests for GET /api/vault/known-fields (#2445).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAdmin } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(async () => true),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mockRequireAdmin }));

vi.mock('@/src/lib/vault/known-fields', () => ({
  KNOWN_VAULT_FIELDS: [
    { field: 'github-org-provisioning', description: 'stub', requiredCustody: 'delegation-grant', why: 'stub' },
  ],
}));

import { GET } from '../route.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(true);
});

describe('GET /api/vault/known-fields', () => {
  it('returns 401 when not an admin', async () => {
    mockRequireAdmin.mockResolvedValue(false);
    const response = await GET();
    expect(response.status).toBe(401);
  });

  it('returns the known-fields registry', async () => {
    const response = await GET();
    const body = (await response.json()) as { fields: unknown[] };
    expect(response.status).toBe(200);
    expect(body.fields).toEqual([
      { field: 'github-org-provisioning', description: 'stub', requiredCustody: 'delegation-grant', why: 'stub' },
    ]);
  });
});
