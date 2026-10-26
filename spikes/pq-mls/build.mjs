import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

await mkdir('dist', { recursive: true });
const result = await build({
  entryPoints: ['src/browser.ts'], bundle: true, format: 'esm',
  platform: 'browser', target: 'es2022', minify: true,
  outfile: 'dist/browser.js', metafile: true,
  external: ['../openmls/pkg/pq_mls_openmls_spike.js'],
});
await cp('openmls/pkg', 'dist/openmls/pkg', { recursive: true });
// Keep the wasm binding URL relative to the built browser entry point.
const entry = await readFile('dist/browser.js', 'utf8');
await writeFile('dist/browser.js', entry.replace('../openmls/pkg/', './openmls/pkg/'));
await writeFile('dist/metafile.json', JSON.stringify(result.metafile, null, 2));
await writeFile('dist/index.html', '<!doctype html><meta charset="utf-8"><title>PQ-MLS running</title><h1>Isolated PQ-MLS runtime tests</h1><pre>Running…</pre><script type="module" src="./browser.js"></script>');
const bundle = await readFile('dist/browser.js');
console.log(JSON.stringify({ bytes: bundle.length, gzip: gzipSync(bundle, { level: 9 }).length }));
for (const name of ['pq_mls_openmls_spike.js', 'pq_mls_openmls_spike_bg.wasm']) {
  const file = await readFile(`openmls/pkg/${name}`);
  console.log(JSON.stringify({ name, bytes: file.length, gzip: gzipSync(file, { level: 9 }).length }));
}
