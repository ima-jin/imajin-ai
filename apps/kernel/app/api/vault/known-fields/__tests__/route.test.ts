/**
 * Unit tests for GET /api/vault/known-fields (#2700).
 *
 * Gated by requireAdmin like every other /api/vault/** route; returns the
 * registry as `{ fields: [{ name, label, description, namespace }] }`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRequireAdmin } = vi.hoisted(() => ({
  mockRequireAdmin: vi.fn(async () => true),
}));

vi.mock('@imajin/auth', () => ({ requireAdmin: mockRequireAdmin }));

vi.mock('@/src/lib/vault/known-fields', () => ({
  KNOWN_VAULT_FIELDS: [
    { name: 'github-org-provisioning', label: 'GitHub org credential', description: 'stub', namespace: 'github' },
    { name: 'internal-secret:stub', label: 'Stub secret', description: 'stub', namespace: 'internal-secret' },
  ],
}));

import { GET } from '../route.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockRequireAdmin.mockResolvedValue(true);
});

describe('GET /api/vault/known-fields', () => {
  it('returns 401 when not an admin, without leaking any field data', async () => {
    mockRequireAdmin.mockResolvedValue(false);

    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(401);
    expect(body).toEqual({ error: 'Unauthorized' });
    expect(body).not.toHaveProperty('fields');
  });

  it('returns 200 with the known-fields registry when an admin', async () => {
    const response = await GET();
    const body = (await response.json()) as { fields: unknown[] };

    expect(response.status).toBe(200);
    expect(body.fields).toEqual([
      { name: 'github-org-provisioning', label: 'GitHub org credential', description: 'stub', namespace: 'github' },
      { name: 'internal-secret:stub', label: 'Stub secret', description: 'stub', namespace: 'internal-secret' },
    ]);
  });

  it('shapes every field as { name, label, description, namespace } strings', async () => {
    const response = await GET();
    const body = (await response.json()) as { fields: Array<Record<string, unknown>> };

    expect(Object.keys(body)).toEqual(['fields']);
    for (const field of body.fields) {
      expect(Object.keys(field).sort()).toEqual(['description', 'label', 'name', 'namespace']);
      for (const value of Object.values(field)) {
        expect(typeof value).toBe('string');
      }
    }
  });
});
