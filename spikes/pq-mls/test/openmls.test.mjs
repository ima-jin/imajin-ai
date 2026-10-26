import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import init, { is_allowed_suite, round_trip } from '../openmls/pkg/pq_mls_openmls_spike.js';

test('Node 24: OpenMLS/libcrux wasm X-Wing create → add → commit → messages', async () => {
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
  await init({ module_or_path: await readFile(new URL('../openmls/pkg/pq_mls_openmls_spike_bg.wasm', import.meta.url)) });
  const result = JSON.parse(round_trip());
  assert.equal(result.suite, 77);
  assert.equal(result.version, '0.9.2');
  assert.equal(is_allowed_suite(77), true);
  assert.equal(is_allowed_suite(1), false);
  assert.equal(is_allowed_suite(0xF042), false);
  assert.equal(result.originalAfterTamper, true);
  assert.equal(result.members, 2);
  assert.equal(result.messages.length, 3);
  console.log(JSON.stringify(result));
});
