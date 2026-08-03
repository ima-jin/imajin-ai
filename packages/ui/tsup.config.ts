import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries, two bundles. src/index.ts is 'use client' top-to-bottom;
  // src/server.ts has none of that and must stay separate so Server
  // Component consumers (every app's root layout.tsx) don't get tainted by
  // the client bundle (see src/server.ts).
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  external: ['react', 'react-dom', 'next', '@imajin/config', '@mdxeditor/editor', 'react-markdown'],
  jsx: 'automatic',
});
