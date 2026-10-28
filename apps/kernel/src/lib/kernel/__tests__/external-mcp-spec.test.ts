import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES } from '@imajin/auth';
import { scopeEntry, isServiceEligibleScope } from '@imajin/auth/scope-vocabulary';
import { isPrivateCustodyField } from '@/src/lib/vault/field-grammar';
import { isSweepField } from '@/src/lib/vault/rotation-handoff';
import { listApiSpecs } from '../api-specs';
import { GET } from '@/app/connections/api/spec/route';
const kernelRoot = resolve('apps/kernel');

afterEach(() => vi.restoreAllMocks());
it('discovers the member-held external MCP routes through the existing connections spec', async () => {
  vi.spyOn(process, 'cwd').mockReturnValue(kernelRoot);
  const routes = ['/api/external-mcp/postman', '/api/external-mcp/postman/rpc'];
  const spec = parse(await (await GET()).text());
  for (const route of routes) {
    expect(listApiSpecs().find(item => item.service === 'connections')?.paths).toContain(route);
    expect(spec.paths[route]).toBeDefined();
  }
  const connection = spec.paths[routes[0]];
  for (const method of ['get', 'post', 'delete']) expect(connection[method].security).toEqual([{ cookieAuth: [] }]);
  expect(connection.post.requestBody.content['application/json'].schema.properties.secret.writeOnly).toBe(true);
  for (const file of ['llms.txt', 'llms-full.txt']) {
    expect(readFileSync(resolve(kernelRoot, 'public', file), 'utf8')).toContain('/connections/api/external-mcp/postman/rpc');
  }
});
it('registers explicit app consent without self-grantable service authority and mechanical audit types', () => {
  expect(scopeEntry('connectors:mcp:read')?.connector).toBeNull();
  expect(isServiceEligibleScope('connectors:mcp:read')).toBe(false);
  expect(ATTESTATION_TYPES).toContain('connector.external-mcp');
  expect(MECHANICAL_ATTESTATION_TYPES).toContain('connector.external-mcp');
});
it('keeps member keys off generic custody lifecycle, export and renewal surfaces', () => {
  const field = 'external-mcp-key:fixture:did:imajin:member';
  expect(isPrivateCustodyField(field)).toBe(true);
  expect(isSweepField(field)).toBe(false);
  expect(isPrivateCustodyField('ordinary:fixture')).toBe(false);
});
