import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

describe('Cloudflare discovery specification', () => {
  it('publishes the grantee-side metadata route without changing delegator discovery', () => {
    const spec = parse(readFileSync(resolve('apps/kernel/api-spec/cloudflare.yaml'), 'utf8'));
    const route = spec.paths['/api/grants'];
    expect(spec.servers).toContainEqual({ url: '/cloudflare' });
    expect(Object.keys(route)).toEqual(['get']);
    expect(route.get.operationId).toBe('cloudflareGranteeZoneGrants');
    expect(route.get.security).toEqual([{ cookieAuth: [] }, { bearerAuth: [] }]);
    for (const code of ['200', '401', '403', '503']) expect(route.get.responses[code]).toBeDefined();
    expect(route.get.responses['200'].content['application/json'].schema.properties.grants.items)
      .toEqual({ $ref: '#/components/schemas/ZoneGrant' });
    expect(route.get.description).toContain('never unseals');
    expect(route.get.description).toContain('Revoked capabilities are omitted');
    expect(route.get.description).toContain('appDid, never userDid');
    const auth = parse(readFileSync(resolve('apps/kernel/api-spec/auth.yaml'), 'utf8'));
    expect(auth.paths['/api/grants'].get).toBeDefined();
  });
  it('documents every operator resource with zone binding and revocation semantics', () => {
    const spec = parse(readFileSync(resolve('apps/kernel/api-spec/cloudflare.yaml'), 'utf8'));
    for (const resource of ['dns', 'dns/{id}', 'settings', 'cache-rules', 'custom-hostnames', 'custom-hostnames/{id}', 'bulk', 'history']) {
      const path = spec.paths[`/api/zones/{zoneId}/${resource}`];
      expect(path).toBeDefined();
      expect(path.parameters).toContainEqual({ $ref: '#/components/parameters/domain' });
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        if (!path[method]) continue;
        expect(path[method].responses['403']).toBeDefined();
        expect(path[method].responses['409']).toBeDefined();
      }
    }
    expect(spec.info.description).toContain('introspectGrant');
    expect(spec.info.description).toContain('Revoke');
    expect(spec.info.description).toContain('kernel-only');
    expect(spec.paths['/api/zones/{zoneId}/bulk'].post.description).toContain('never directly applies');
  });
});
