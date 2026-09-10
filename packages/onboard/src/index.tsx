'use client';

// Declared here so tsup's single-bundle output still carries the directive
// as the first statement of dist/index.js — esbuild does not hoist per-file
// 'use client' directives across module boundaries when bundling (see
// packages/ui/src/index.ts for the established pattern).
export { OnboardGate } from './OnboardGate';
export type { OnboardGateProps } from './OnboardGate';
