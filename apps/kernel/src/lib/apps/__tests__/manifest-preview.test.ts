/**
 * Tests for apps/kernel/src/lib/apps/manifest-preview.ts (#2663) — the proposal-time
 * read that puts providesScopes/dependsOn on the card before the operator approves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetchAppManifestMock: vi.fn(),
  tryGetInstallationTokenMock: vi.fn(),
  validateAppDeclarationsMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: mocks.warnMock, error: vi.fn() }) }));
vi.mock('@/src/lib/github/org-provisioning', () => ({
  fetchAppManifest: mocks.fetchAppManifestMock,
  tryGetInstallationToken: mocks.tryGetInstallationTokenMock,
}));
vi.mock('@/src/lib/kernel/app-declarations', () => ({ validateAppDeclarations: mocks.validateAppDeclarationsMock }));

import { previewManifestDeclarations } from '../manifest-preview';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tryGetInstallationTokenMock.mockResolvedValue('installation-token');
  mocks.fetchAppManifestMock.mockResolvedValue(null);
  mocks.validateAppDeclarationsMock.mockImplementation(async (input: { providesScopes?: string[]; dependsOn?: unknown[] }) => ({
    ok: { providesScopes: input.providesScopes ?? [], dependsOn: input.dependsOn ?? [], requestedScopes: [] },
  }));
});

describe('previewManifestDeclarations (#2663)', () => {
  it('returns the validated declarations from the manifest, checked against the slug', async () => {
    const dependsOn = [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }];
    mocks.fetchAppManifestMock.mockResolvedValue({ providesScopes: ['dykil:read'], dependsOn });

    const result = await previewManifestDeclarations('dykil');

    expect(result).toEqual({ ok: { providesScopes: ['dykil:read'], dependsOn, emittableEvents: [] } });
    expect(mocks.fetchAppManifestMock).toHaveBeenCalledWith('dykil', 'installation-token');
    expect(mocks.validateAppDeclarationsMock).toHaveBeenCalledWith({ providesScopes: ['dykil:read'], dependsOn, slug: 'dykil' });
  });

  it('returns the validator\'s normalised list, not the raw manifest value', async () => {
    mocks.fetchAppManifestMock.mockResolvedValue({ providesScopes: ['dykil:read', 'dykil:read'] });
    mocks.validateAppDeclarationsMock.mockResolvedValue({
      ok: { providesScopes: ['dykil:read'], dependsOn: [], requestedScopes: [] },
    });

    expect(await previewManifestDeclarations('dykil')).toEqual({
      ok: { providesScopes: ['dykil:read'], dependsOn: [], emittableEvents: [] },
    });
  });

  it('returns the empty list for a readable manifest that declares nothing', async () => {
    mocks.fetchAppManifestMock.mockResolvedValue({ name: 'Dykil' });

    expect(await previewManifestDeclarations('dykil')).toEqual({ ok: { providesScopes: [], dependsOn: [], emittableEvents: [] } });
  });

  it('#2638: puts the emittableEvents the manifest asks for on the card, normalised', async () => {
    mocks.fetchAppManifestMock.mockResolvedValue({ emittableEvents: ['tip.sent', 'tip.granted', 'tip.sent'] });

    expect(await previewManifestDeclarations('coffee')).toEqual({
      ok: { providesScopes: [], dependsOn: [], emittableEvents: ['tip.granted', 'tip.sent'] },
    });
  });

  it.each([
    ['a wildcard', ['tip.*']],
    ['an uppercase type', ['Tip.Granted']],
    ['a non-string entry', [7]],
    ['a non-array value', 'tip.granted'],
  ])('#2638: rejects a manifest whose emittableEvents has %s, so the card never shows an unapprovable list', async (_label, emittableEvents) => {
    mocks.fetchAppManifestMock.mockResolvedValue({ emittableEvents });

    expect(await previewManifestDeclarations('coffee')).toEqual({ error: expect.stringContaining('emittableEvents') });
  });

  it('returns null — "nothing was read" — when there is no manifest', async () => {
    mocks.fetchAppManifestMock.mockResolvedValue(null);

    expect(await previewManifestDeclarations('dykil')).toEqual({ ok: null });
    expect(mocks.validateAppDeclarationsMock).not.toHaveBeenCalled();
  });

  it('returns null when the org credential is unsealed (no token)', async () => {
    mocks.tryGetInstallationTokenMock.mockResolvedValue(null);

    expect(await previewManifestDeclarations('dykil')).toEqual({ ok: null });
    expect(mocks.fetchAppManifestMock).toHaveBeenCalledWith('dykil', null);
  });

  it.each([
    ['the credential is malformed', 'tryGetInstallationTokenMock'],
    ['the manifest read throws', 'fetchAppManifestMock'],
  ])('degrades to null, never throws, when %s', async (_label, which) => {
    mocks[which as 'tryGetInstallationTokenMock' | 'fetchAppManifestMock'].mockRejectedValue(new Error('boom'));

    expect(await previewManifestDeclarations('dykil')).toEqual({ ok: null });
    expect(mocks.warnMock).toHaveBeenCalled();
  });

  it('returns the error when a readable manifest declares something invalid', async () => {
    mocks.fetchAppManifestMock.mockResolvedValue({ providesScopes: ['media:write'] });
    mocks.validateAppDeclarationsMock.mockResolvedValue({ error: 'providesScopes rejected: media:write' });

    expect(await previewManifestDeclarations('dykil')).toEqual({ error: 'providesScopes rejected: media:write' });
  });
});
