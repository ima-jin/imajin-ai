'use client';

// Separate entry point from ./index.ts. FairAccordion/FairEditor each carry
// their own 'use client' directive, which Next.js's RSC analysis only
// recognizes as the first statement of a bundled *file*. Re-exporting them
// from the main index.ts entry would merge their code (and hook usage) into
// the same dist/index.js bundle used by server-only consumers, and the
// directive doesn't survive being merged into the middle of that file —
// every server-only import of @imajin/fair would then be flagged as needing
// "use client" too. Keeping them in their own tsup entry (dist/react.js)
// preserves the boundary; import them via `@imajin/fair/react`.
export { FairAccordion } from './components/FairAccordion';
export { FairEditor } from './components/FairEditor';
export type { FairEditorProps } from './components/FairEditor';
