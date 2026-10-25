import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { afterEach, expect, it, vi } from 'vitest';
import { listApiSpecs, readApiSpec } from '@/src/lib/kernel/api-specs';
import * as specReader from '@/src/lib/kernel/api-specs';
import { GET as serveVaultSpec } from '@/app/vault/api/spec/route';
import { ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES } from '@imajin/auth';

const root = resolve('apps/kernel');
const spec = parse(readFileSync(resolve(root, 'api-spec/vault.yaml'), 'utf8'));
afterEach(() => vi.restoreAllMocks());

it('serves the real contract at the endpoint advertised by the catalogue', async () => {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const catalogue = listApiSpecs().find(item => item.service === 'vault');
  expect(catalogue?.endpoint).toBe('/vault/api/spec');
  expect(spec.paths[catalogue!.endpoint].get.operationId).toBe('vaultApiSpec');
  const response = serveVaultSpec();
  expect(response.status).toBe(200);
  expect(response.headers.get('Content-Type')).toBe('text/yaml');
  expect(parse(await response.text())).toEqual(spec);
});

it('documents verified GitHub job auth and mutually exclusive repo/environment grants', () => {
  const sign = spec.paths['/api/vault/ssh-ca/sign'].post;
  expect(spec.components.securitySchemes.githubOidc.name).toBe('x-github-oidc-token');
  expect(sign.description).toContain('urn:imajin:vault:ssh-cert');
  expect(sign.requestBody.content['application/json'].schema.required).not.toContain('job');
  const grant = spec.paths['/api/vault/ssh-ca/grants'].post.requestBody.content['application/json'].schema;
  expect(grant.oneOf[1].required).toEqual(['repository', 'environment']);
  expect(grant.oneOf[1].not.required).toEqual(['grantee']);
});

it.each(['issued', 'refused', 'grant-issued', 'grant-revoked'] as const)('registers SSH cert %s as a signed mechanical event', action => {
  expect(ATTESTATION_TYPES).toContain(`vault.ssh-cert.${action}`);
  expect(MECHANICAL_ATTESTATION_TYPES).toContain(`vault.ssh-cert.${action}`);
});

it('advertises the fixed certificate policy and rejects caller options in the contract', () => {
  const sign = spec.paths['/api/vault/ssh-ca/sign'].post;
  const schema = sign.requestBody.content['application/json'].schema;
  expect(schema.additionalProperties).toBe(false);
  expect(schema.properties.ttl).toEqual({ type: 'integer', minimum: 1, maximum: 900, default: 600 });
  expect(schema.properties.extensions).toBeUndefined();
  expect(schema.properties.criticalOptions).toBeUndefined();
  expect(sign.description).toContain('force-command');
});

it('fails closed when the vault spec is not available', () => {
  vi.spyOn(specReader, 'readApiSpec').mockReturnValue(null);
  expect(serveVaultSpec().status).toBe(503);
});

it.each(['', '/rotate', '/revoke', '/trusted-keys', '/sign', '/grants', '/grants/revoke'])('discovers the live SSH CA route %s in the spec catalogue', suffix => {
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  const path = `/api/vault/ssh-ca${suffix}`;
  expect(listApiSpecs().find(item => item.service === 'vault')?.paths).toContain(path);
  expect(readApiSpec('vault')?.content).toContain(`${path}:`);
  expect(existsSync(resolve(root, `app${path}/route.ts`))).toBe(true);
  const method = suffix === '/trusted-keys' ? 'get' : 'post';
  expect(spec.paths[path][method].operationId).toBeTruthy();
  const security: Record<string, never[]>[] = [{ cookieAuth: [] }, { bearerAuth: [] }];
  if (suffix === '/sign') security.push({ githubOidc: [] });
  expect(spec.paths[path][method].security).toEqual(method === 'get' ? [] : security);
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
