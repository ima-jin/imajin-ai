import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { listApiSpecs, readApiSpec } from '@/src/lib/kernel/api-specs';
import { ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES } from '@imajin/auth';

const root = resolve('apps/kernel');
const spec = parse(readFileSync(resolve(root, 'api-spec/vault.yaml'), 'utf8'));
afterEach(() => vi.restoreAllMocks());

it.each(['', '/rotate', '/revoke', '/trusted-keys'])('discovers the live SSH CA route %s in the spec catalogue', suffix => {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const path = `/api/vault/ssh-ca${suffix}`;
  expect(listApiSpecs().find(item => item.service === 'vault')?.paths).toContain(path);
  expect(readApiSpec('vault')?.content).toContain(`${path}:`);
  expect(existsSync(resolve(root, `app${path}/route.ts`))).toBe(true);
  const method = suffix === '/trusted-keys' ? 'get' : 'post';
  expect(spec.paths[path][method].operationId).toBeTruthy();
  expect(spec.paths[path][method].security).toEqual(method === 'get' ? [] : [{ cookieAuth: [] }, { bearerAuth: [] }]);
});

it('documents only public responses, no caller-supplied key or consumer', () => {
  const mint = spec.paths['/api/vault/ssh-ca'].post;
  expect(mint.requestBody.content['application/json'].schema).toMatchObject({
    additionalProperties: false, required: ['purpose'],
  });
  expect(Object.keys(mint.requestBody.content['application/json'].schema.properties)).toEqual(['purpose']);
  expect(spec.components.schemas.SshCa.required).toEqual(['caId', 'purpose', 'status', 'publicKey', 'fingerprint']);
  expect(spec.paths['/api/vault/ssh-ca/trusted-keys'].get.responses['200'].content['text/plain']).toBeDefined();
  expect(spec.paths['/api/vault/ssh-ca/rotate'].post.description).toContain('900 seconds');
});

it.each(['minted', 'rotated', 'revoked', 'retired'] as const)('registers %s as a mechanical signed event', action => {
  expect(ATTESTATION_TYPES).toContain(`vault.ssh-ca.${action}`);
  expect(MECHANICAL_ATTESTATION_TYPES).toContain(`vault.ssh-ca.${action}`);
});
