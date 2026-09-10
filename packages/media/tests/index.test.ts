import { describe, expect, it } from 'vitest';
import { MediaBrowser, AssetCard, AssetImage, resolveAssetUrl, resolveMediaRef } from '../src/index';

// Smoke-import the real barrel (not vi.mock'd) so the package's actual
// source — including the top-of-file 'use client' directive required for
// tsup's single-bundle dist/index.js (#2142) — is exercised by the suite.
// Every other consumer of @imajin/media in this monorepo mocks the module
// entirely (see apps/market's route tests), so without this file the real
// src/index.ts never loads under test.
describe('@imajin/media main entry', () => {
  it('exports MediaBrowser and AssetCard as components', () => {
    expect(MediaBrowser).toBeTypeOf('function');
    expect(AssetCard).toBeTypeOf('function');
  });

  it('exports AssetImage as a component', () => {
    expect(AssetImage).toBeTypeOf('function');
  });

  it('exports resolveAssetUrl and resolveMediaRef as functions', () => {
    expect(resolveAssetUrl).toBeTypeOf('function');
    expect(resolveMediaRef).toBeTypeOf('function');
    expect(resolveAssetUrl('asset_123', 'card')).toContain('/api/assets/asset_123?w=400');
    expect(resolveMediaRef('https://example.com/x.png')).toBe('https://example.com/x.png');
  });
});
