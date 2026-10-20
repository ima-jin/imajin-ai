import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  manifest: vi.fn(),
  token: vi.fn(),
  source: vi.fn(),
}));
vi.mock('@/src/lib/github/org-provisioning', () => ({
  fetchAppManifest: mocks.manifest,
  tryGetInstallationToken: mocks.token,
  resolveSourceRepo: mocks.source,
}));

import { readEventDeclarations } from '../event-declarations';

const app = { slug: 'coffee', sourceRepo: null };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.token.mockResolvedValue(null);
  mocks.manifest.mockResolvedValue({ ok: {} });
});

describe('readEventDeclarations', () => {
  it.each([null, 'installation-token'])('reads the registered slug with the default org and token %s', async (token) => {
    mocks.token.mockResolvedValue(token);
    mocks.manifest.mockResolvedValue({ ok: { emittableEvents: ['tip.sent', 'tip.granted', 'tip.sent'] } });
    expect(await readEventDeclarations(app)).toEqual({ declaredEmittableEvents: ['tip.granted', 'tip.sent'] });
    expect(mocks.manifest).toHaveBeenCalledTimes(1);
    expect(mocks.manifest).toHaveBeenCalledWith('coffee', token);
    expect(mocks.source).not.toHaveBeenCalled();
  });

  it.each([{}, { emittableEvents: [] }])('distinguishes readable empty declarations from a failed read: %j', async (manifest) => {
    mocks.manifest.mockResolvedValue({ ok: manifest });
    expect(await readEventDeclarations(app)).toEqual({ declaredEmittableEvents: [] });
  });

  it('does not validate unrelated scopes, dependencies, or secret recipes', async () => {
    // fetchAppManifest owns manifest shape checks. Do not additionally run the
    // provisioning validators (scope vocabulary, audience DB lookups, secrets).
    mocks.manifest.mockResolvedValue({ ok: {
      providesScopes: ['not-a-vocabulary-scope'], dependsOn: [{ aud: 'unregistered' }],
      secrets: [{ name: 'not validated here' }], emittableEvents: ['tip.sent'],
    } });
    expect(await readEventDeclarations(app)).toEqual({ declaredEmittableEvents: ['tip.sent'] });
  });

  it.each([null, '', '..', 'a/b', '%2e%2e', 'Uppercase'])('refuses missing/unsafe registered slug %j before credentials or fetch', async (slug) => {
    expect(await readEventDeclarations({ slug, sourceRepo: null })).toEqual({
      declaredEmittableEvents: null, eventDeclarationError: expect.any(String),
    });
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.manifest).not.toHaveBeenCalled();
  });

  it.each([null, 'source-installation-token'])('prefers explicit external source with its own token %s even without a slug', async (token) => {
    mocks.source.mockResolvedValue({ token });
    expect(await readEventDeclarations({ slug: null, sourceRepo: 'other-owner/website' }))
      .toEqual({ declaredEmittableEvents: [] });
    expect(mocks.source).toHaveBeenCalledTimes(1);
    expect(mocks.source).toHaveBeenCalledWith('other-owner/website');
    expect(mocks.manifest).toHaveBeenCalledTimes(1);
    expect(mocks.manifest).toHaveBeenCalledWith('website', token, 'other-owner');
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it('does not replace an unreadable explicit source manifest with the registered slug', async () => {
    mocks.source.mockResolvedValue({ token: null });
    mocks.manifest.mockResolvedValue({ error: 'unreadable', status: 404 });
    expect(await readEventDeclarations({ ...app, sourceRepo: 'other-owner/website' })).toEqual({
      declaredEmittableEvents: null,
      eventDeclarationError: 'App manifest could not be read; event declarations are unavailable',
    });
    expect(mocks.manifest).toHaveBeenCalledTimes(1);
    expect(mocks.manifest).toHaveBeenCalledWith('website', null, 'other-owner');
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it('never falls back to a slug or template when an explicit source fails safety/access checks', async () => {
    mocks.source.mockRejectedValue(new Error('provider details and credential placeholder'));
    expect(await readEventDeclarations({ ...app, sourceRepo: '../unsafe' })).toEqual({
      declaredEmittableEvents: null,
      eventDeclarationError: 'App repository or manifest could not be read; event declarations are unavailable',
    });
    expect(mocks.manifest).not.toHaveBeenCalled();
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it.each([
    { error: 'unreadable', status: 404 },
    { error: 'unreadable', status: 503 },
    { error: 'invalid' },
  ])('reports failed manifests as unknown declarations, without template fallback: %j', async (failure) => {
    mocks.manifest.mockResolvedValue(failure);
    expect(await readEventDeclarations(app)).toEqual({
      declaredEmittableEvents: null, eventDeclarationError: expect.any(String),
    });
    expect(mocks.manifest).toHaveBeenCalledTimes(1);
  });

  it.each([
    { emittableEvents: ['tip.*'] }, { emittableEvents: ['Tip.Granted'] },
    { emittableEvents: [7] }, { emittableEvents: 'tip.sent' },
    { emittableEvents: ['payment_request.paid'] },
    { emittableEvents: ['tip.sent', 'loop.completed'] },
  ])('reports malformed events as unknown declarations: %j', async ({ emittableEvents }) => {
    mocks.manifest.mockResolvedValue({ ok: { emittableEvents } });
    expect(await readEventDeclarations(app)).toEqual({
      declaredEmittableEvents: null, eventDeclarationError: 'App manifest event declarations are invalid',
    });
  });

  it.each(['token', 'manifest'] as const)('sanitizes unexpected %s failures', async (edge) => {
    mocks[edge].mockRejectedValue(new Error('provider details and credential placeholder'));
    expect(await readEventDeclarations(app)).toEqual({
      declaredEmittableEvents: null,
      eventDeclarationError: 'App repository or manifest could not be read; event declarations are unavailable',
    });
  });
});
