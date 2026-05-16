import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: false,
  clean: true,
  external: ['react', 'react-dom', 'next', '@imajin/config', '@mdxeditor/editor', 'react-markdown'],
  jsx: 'automatic',
});
