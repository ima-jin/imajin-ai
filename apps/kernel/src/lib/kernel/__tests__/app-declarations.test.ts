/**
 * Tests for apps/kernel/src/lib/kernel/app-declarations.ts (#2663).
 *
 * The auth-package rules (what makes a scope or dependency valid) are covered by
 * packages/auth/tests/app-scopes.test.ts; this file covers the registry-backed
 * half: a dependency audience must be a registered, active app.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ resolveActiveAppByAudienceMock: vi.fn() }));

vi.mock('@/src/lib/kernel/app-registry', () => ({
  resolveActiveAppByAudience: mocks.resolveActiveAppByAudienceMock,
}));

import { validateAppDeclarations } from '../app-declarations';

const MEDIA = 'jin.imajin.ai';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveActiveAppByAudienceMock.mockResolvedValue({ id: 'app_kernel', status: 'active' });
});

describe('validateAppDeclarations (#2663)', () => {
  it('accepts an app that declares nothing', async () => {
    expect(await validateAppDeclarations({})).toEqual({
      ok: { providesScopes: [], dependsOn: [], requestedScopes: [] },
    });
    expect(mocks.resolveActiveAppByAudienceMock).not.toHaveBeenCalled();
  });

  it('keeps the app\'s own scopes through the requestedScopes clamp, and drops unknown ones', async () => {
    const result = await validateAppDeclarations({
      providesScopes: ['dykil:read', 'dykil:write'],
      requestedScopes: ['dykil:read', 'dykil:write', 'media:read', 'not-a-scope'],
      slug: 'dykil',
    });

    expect(result).toEqual({
      ok: {
        providesScopes: ['dykil:read', 'dykil:write'],
        dependsOn: [],
        requestedScopes: ['dykil:read', 'dykil:write', 'media:read'],
      },
    });
  });

  it('drops an app-style scope from requestedScopes when the app did not declare it', async () => {
    const result = await validateAppDeclarations({ requestedScopes: ['dykil:read', 'profile:read'] });

    expect(result).toEqual({ ok: { providesScopes: [], dependsOn: [], requestedScopes: ['profile:read'] } });
  });

  it('rejects providesScopes that collide with the platform vocabulary', async () => {
    const result = await validateAppDeclarations({ providesScopes: ['media:write'], slug: 'dykil' });

    expect(result).toEqual({ error: expect.stringContaining('media:write') });
  });

  describe('namespaces are reserved by slug (#2674)', () => {
    it('rejects a slug-less app declaring ANOTHER app\'s namespace (dykil:read)', async () => {
      const result = await validateAppDeclarations({ providesScopes: ['dykil:read'] });

      expect(result).toEqual({ error: expect.stringContaining('dykil:read') });
      expect((result as { error: string }).error).toMatch(/without a registered slug/);
    });

    it('rejects a slug-less app declaring any app-namespaced scope, even an unclaimed one', async () => {
      expect(await validateAppDeclarations({ providesScopes: ['brand-new:read'], slug: null })).toEqual({
        error: expect.stringContaining('brand-new:read'),
      });
    });

    it('names the foreign namespace, without the no-slug hint, for a slugged app', async () => {
      const result = await validateAppDeclarations({ providesScopes: ['dykil:read'], slug: 'links' });

      expect(result).toEqual({ error: expect.stringContaining('dykil:read') });
      expect((result as { error: string }).error).not.toMatch(/without a registered slug/);
    });

    it('accepts a slug-less app that declares nothing', async () => {
      expect(await validateAppDeclarations({ providesScopes: [], requestedScopes: ['profile:read'] })).toEqual({
        ok: { providesScopes: [], dependsOn: [], requestedScopes: ['profile:read'] },
      });
    });
  });

  it('rejects providesScopes outside the app\'s slug namespace', async () => {
    const result = await validateAppDeclarations({ providesScopes: ['links:read'], slug: 'dykil' });

    expect(result).toEqual({ error: expect.stringContaining('links:read') });
  });

  it('accepts a dependsOn whose audience is a registered app, and checks it against the registry', async () => {
    const result = await validateAppDeclarations({ dependsOn: [{ aud: MEDIA, scopes: ['media:read'] }] });

    expect(result).toEqual({
      ok: { providesScopes: [], dependsOn: [{ aud: MEDIA, scopes: ['media:read'] }], requestedScopes: [] },
    });
    expect(mocks.resolveActiveAppByAudienceMock).toHaveBeenCalledWith(MEDIA);
  });

  it('rejects a dependsOn whose audience is not a registered, active app', async () => {
    mocks.resolveActiveAppByAudienceMock.mockResolvedValue(null);

    const result = await validateAppDeclarations({ dependsOn: [{ aud: 'unregistered.example.com', scopes: ['media:read'] }] });

    expect(result).toEqual({ error: expect.stringContaining('unregistered.example.com') });
  });

  it('names every unregistered audience, not just the first', async () => {
    mocks.resolveActiveAppByAudienceMock.mockImplementation(async (aud: string) => (aud === MEDIA ? { id: 'app_kernel' } : null));

    const result = await validateAppDeclarations({
      dependsOn: [
        { aud: 'a.example.com', scopes: ['media:read'] },
        { aud: MEDIA, scopes: ['media:read'] },
        { aud: 'b.example.com', scopes: ['media:read'] },
      ],
    });

    expect(result).toEqual({ error: expect.stringMatching(/a\.example\.com.*b\.example\.com/) });
    expect((result as { error: string }).error).not.toContain(MEDIA);
  });

  it('rejects a malformed dependsOn without touching the registry', async () => {
    const result = await validateAppDeclarations({ dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:admin'] }] });

    expect(result).toEqual({ error: expect.stringContaining('dependsOn') });
    expect(mocks.resolveActiveAppByAudienceMock).not.toHaveBeenCalled();
  });
});
