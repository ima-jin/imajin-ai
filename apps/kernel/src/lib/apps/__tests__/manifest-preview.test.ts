import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  manifest: vi.fn(),
  token: vi.fn(),
  declarations: vi.fn(),
}));
vi.mock('@/src/lib/github/org-provisioning', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/src/lib/github/org-provisioning')>(),
  fetchAppManifest: mocks.manifest,
  tryGetInstallationToken: mocks.token,
}));
vi.mock('@/src/lib/kernel/app-declarations', () => ({ validateAppDeclarations: mocks.declarations }));
vi.mock('@/src/lib/vault', () => ({ loadAndUnseal: vi.fn() }));

import { previewManifestDeclarations } from '../manifest-preview';

const empty = { providesScopes: [], dependsOn: [], emittableEvents: [] };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.token.mockResolvedValue('installation-token');
  mocks.manifest.mockResolvedValue({ error: 'unreadable', status: 404 });
  mocks.declarations.mockImplementation(async (input: { providesScopes?: string[]; dependsOn?: unknown[] }) => ({
    ok: { providesScopes: input.providesScopes ?? [], dependsOn: input.dependsOn ?? [], requestedScopes: [] },
  }));
});

describe('manifest declarations preview (#2813)', () => {
  it.each([null, 'installation-token'])('snapshots the template source for a fresh repository with token %s', async (token) => {
    mocks.token.mockResolvedValue(token);
    const secrets = [{ name: 'SESSION_SECRET', kind: 'random-32B' }];
    mocks.manifest.mockResolvedValueOnce({ error: 'unreadable', status: 404 })
      .mockResolvedValueOnce({ ok: { secrets } });
    expect(await previewManifestDeclarations('fresh-app', 'ima-jin/imajin-app-template'))
      .toEqual({ ok: { ...empty, secrets } });
    expect(mocks.manifest).toHaveBeenNthCalledWith(1, 'fresh-app', token);
    expect(mocks.manifest).toHaveBeenNthCalledWith(2, 'imajin-app-template', token, 'ima-jin');
  });

  it('uses public reads without credentials and snapshots secret names and declarations', async () => {
    mocks.token.mockResolvedValue(null);
    const secrets = [{ name: 'SESSION_SECRET', kind: 'random-32B' }];
    const dependsOn = [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }];
    mocks.manifest.mockResolvedValue({ ok: { secrets, providesScopes: ['coffee:read'], dependsOn } });
    expect(await previewManifestDeclarations('coffee'))
      .toEqual({ ok: { ...empty, secrets, providesScopes: ['coffee:read'], dependsOn } });
    expect(mocks.manifest).toHaveBeenCalledWith('coffee', null);
    expect(mocks.declarations).toHaveBeenCalledWith({ providesScopes: ['coffee:read'], dependsOn, slug: 'coffee' });
  });

  it('snapshots normalized declarations rather than raw manifest values', async () => {
    mocks.manifest.mockResolvedValue({ ok: { providesScopes: ['coffee:read', 'coffee:read'] } });
    mocks.declarations.mockResolvedValue({ ok: { providesScopes: ['coffee:read'], dependsOn: [] } });
    expect(await previewManifestDeclarations('coffee')).toEqual({ ok: { ...empty, providesScopes: ['coffee:read'] } });
  });

  it.each([{}, { name: 'Coffee' }, { secrets: [] }])('accepts a readable manifest declaring no secrets: %j', async (manifest) => {
    mocks.manifest.mockResolvedValue({ ok: manifest });
    expect(await previewManifestDeclarations('coffee')).toEqual({ ok: empty });
  });

  it('normalizes declared event types', async () => {
    mocks.manifest.mockResolvedValue({ ok: { emittableEvents: ['tip.sent', 'tip.granted', 'tip.sent'] } });
    expect(await previewManifestDeclarations('coffee'))
      .toEqual({ ok: { ...empty, emittableEvents: ['tip.granted', 'tip.sent'] } });
  });

  it.each([
    { error: 'unreadable', status: 404 },
    { error: 'unreadable', status: 503 },
    { error: 'unreadable' },
    { error: 'invalid' },
  ])('returns a names-only failure, never an empty snapshot: %j', async (failure) => {
    mocks.token.mockResolvedValue(null);
    mocks.manifest.mockResolvedValue(failure);
    const result = await previewManifestDeclarations('coffee');
    const status = failure.status ? ` (HTTP ${failure.status})` : '';
    expect(result).toEqual({ error: `App 'coffee' manifest ${failure.error}${status}` });
    expect(mocks.declarations).not.toHaveBeenCalled();
    if (failure.status !== 404) expect(mocks.manifest).toHaveBeenCalledTimes(1);
  });

  it('does not mask an invalid app manifest with the template', async () => {
    mocks.manifest.mockResolvedValueOnce({ error: 'invalid' }).mockResolvedValueOnce({ ok: {} });
    expect(await previewManifestDeclarations('coffee')).toEqual({ error: "App 'coffee' manifest invalid" });
    expect(mocks.manifest).toHaveBeenCalledTimes(1);
  });

  it.each(['token', 'manifest'] as const)('sanitizes unexpected %s failures', async (edge) => {
    mocks[edge].mockRejectedValue(new Error('obviously-fake-provider-placeholder'));
    expect(await previewManifestDeclarations('coffee')).toEqual({ error: "App 'coffee' manifest unreadable" });
  });

  it('does not surface validator content', async () => {
    mocks.manifest.mockResolvedValue({ ok: { providesScopes: ['coffee:read'] } });
    mocks.declarations.mockResolvedValue({ error: 'obviously-fake-provider-placeholder' });
    expect(await previewManifestDeclarations('coffee')).toEqual({ error: "App 'coffee' manifest invalid" });
  });

  it.each([
    { secrets: 'bad' },
    { emittableEvents: ['tip.*'] },
    { emittableEvents: ['Tip.Granted'] },
    { emittableEvents: [7] },
    { emittableEvents: 'tip.granted' },
    { emittableEvents: ['payment_request.paid'] },
    { emittableEvents: ['tip.granted', 'loop.completed'] },
  ])('rejects invalid declarations with a names-only class: %j', async (manifest) => {
    mocks.manifest.mockResolvedValue({ ok: manifest });
    expect(await previewManifestDeclarations('coffee')).toEqual({ error: "App 'coffee' manifest invalid" });
  });
});
