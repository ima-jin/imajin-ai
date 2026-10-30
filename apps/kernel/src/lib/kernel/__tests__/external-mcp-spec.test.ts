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
it('serves org-held lifecycle contracts with write-only input and metadata-only responses', async () => {
  vi.spyOn(process, 'cwd').mockReturnValue(kernelRoot);
  const spec = parse(await (await GET()).text());
  const routes = ['/api/org-held', '/api/org-held/{provider}'];
  for (const route of routes) {
    expect(listApiSpecs().find(item => item.service === 'connections')?.paths).toContain(route);
    expect(spec.paths[route]).toBeDefined();
  }
  const item = spec.paths[routes[1]];
  const input = item.post.requestBody.content['application/json'].schema;
  expect(input.additionalProperties).toBe(false);
  expect(Object.keys(input.properties)).toEqual(['secret']);
  expect(input.properties.secret).toMatchObject({ writeOnly: true, maxLength: 4096 });
  expect(input.properties.secret).not.toHaveProperty('example');
  const metadata = spec.components.schemas.OrgHeldConnection;
  expect(metadata.additionalProperties).toBe(false);
  expect(Object.keys(metadata.properties)).toEqual(['provider', 'loadedByDid', 'loadedAt', 'status']);
  expect(metadata.properties.status.const).toBe('loaded');
  for (const [verb, status] of [['get', '200'], ['post', '201']]) {
    expect(item[verb].security).toEqual([{ cookieAuth: [] }]);
    expect(item[verb].responses[status].content['application/json'].schema.$ref)
      .toBe('#/components/schemas/OrgHeldConnection');
  }
  expect(item.delete.security).toEqual([{ cookieAuth: [] }]);
  expect(ATTESTATION_TYPES).toContain('connector.org-held');
  expect(MECHANICAL_ATTESTATION_TYPES).toContain('connector.org-held');
  for (const file of ['llms.txt', 'llms-full.txt']) {
    const text = readFileSync(resolve(kernelRoot, 'public', file), 'utf8');
    expect(text).toContain('/connections/api/org-held/{provider}');
    expect(text).toContain('including for the loading admin');
  }
});
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
it('discovers all app upstream routes and documents separate read/write authority', async () => {
  vi.spyOn(process, 'cwd').mockReturnValue(kernelRoot);
  const spec = parse(await (await GET()).text());
  for (const route of ['/api/upstreams', '/api/upstreams/connection', '/api/upstreams/call']) {
    expect(spec.paths[route]).toBeDefined();
    expect(listApiSpecs().find(item => item.service === 'connections')?.paths).toContain(route);
    for (const file of ['llms.txt', 'llms-full.txt']) {
      expect(readFileSync(resolve(kernelRoot, 'public', file), 'utf8')).toContain(`/connections${route}`);
    }
  }
  expect(spec.paths['/api/upstreams/call'].post.description).toContain('connectors:upstream:write');
  expect(spec.paths['/api/upstreams/connection'].post.requestBody.content['application/json'].schema.properties.secret.writeOnly).toBe(true);
  expect(spec.paths['/api/upstreams'].put.requestBody.content['application/json'].schema.properties.upstreams.items.$ref)
    .toBe('#/components/schemas/AppUpstream');
  for (const [verb, status] of [['get', '200'], ['post', '201']]) {
    expect(spec.paths['/api/upstreams/connection'][verb].responses[status].content['application/json'].schema.$ref)
      .toBe('#/components/schemas/AppUpstreamConnection');
  }
  expect(spec.components.schemas.AppUpstreamConnection.required).toContain('permissions');
  expect(spec.components.schemas.AppUpstreamConnection.properties.permissions.items.example).toBe('GET /me');
  expect(spec.paths['/api/upstreams/call'].post.description).toContain('Successful calls are recorded');
  for (const file of ['llms.txt', 'llms-full.txt']) {
    const text = readFileSync(resolve(kernelRoot, 'public', file), 'utf8');
    expect(text).toContain('Successful calls are');
    expect(text).toContain('refusals write nothing permanent');
    expect(text).toContain('permissions such as ["GET /me"]');
    expect(text).not.toContain('call attempt is signed');
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
