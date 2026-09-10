'use client';

// Every component export in this file runs in the browser (resolveAssetUrl/
// resolveMediaRef are plain functions, safe to import from either side).
// Declared here so tsup's single-bundle output still carries the directive
// as the first statement of dist/index.js — esbuild does not hoist per-file
// 'use client' directives across module boundaries when bundling (see
// packages/ui/src/index.ts for the established pattern).
export { MediaBrowser } from './MediaBrowser';
export type { MediaBrowserProps } from './MediaBrowser';
export { AssetCard } from './AssetCard';
export type { AssetCardProps } from './AssetCard';
export { resolveAssetUrl, resolveMediaRef } from './resolve';
export type { MediaPreset } from './resolve';
export { AssetImage } from './components/AssetImage';
export type { AssetImageProps } from './components/AssetImage';
