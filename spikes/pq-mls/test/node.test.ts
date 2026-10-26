import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireXWing, roundTrip } from '../src/round-trip.test.ts';

test('Node 24: X-Wing create → add → commit → messages', async () => {
  assert.equal(Number(process.versions.node.split('.')[0]), 24);
  const result = await roundTrip();
  assert.equal(result.suite, 83);
  assert.equal(result.messages.length, 3);
  console.log(JSON.stringify(result));
});

test('refuses classic-only and other non-pinned suites', () => {
  assert.throws(() => requireXWing('MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519'), /Only the pinned X-Wing/);
  assert.throws(() => requireXWing('MLS_256_MLKEM768_AES256GCM_SHA384_Ed25519'), /Only the pinned X-Wing/);
});
