// Separate entry point from ./index.ts. index.ts is a single 'use client'
// bundle (every export there is a component or hook). These utilities are
// plain functions/constants with no hook usage and are safe to import from
// Server Components (every current in-repo consumer imports them straight
// into a root app/layout.tsx). Keeping them out of index.ts avoids merging
// them into a client-tainted bundle — Next.js's RSC analysis operates on the
// whole bundled *file*, not per-export, so a server-only import from the
// same file as a hook-using component gets flagged too (see packages/fair's
// src/react.ts for the same story). Import these via `@imajin/ui/server`.
export { themeInitScript } from './theme-init';
export { getActingAs, setActingAs, getActingAsHeaders } from './acting-as';
export { defaultViewport, buildServiceMetadata, getServiceRuntimeEnv } from './service-layout';
export { BRAND } from './brand';
