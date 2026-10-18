import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const registry = parse(readFileSync(new URL('../../../../api-spec/registry.yaml', import.meta.url), 'utf8'));

describe('registry specification operational discovery contracts', () => {
  it.each([
    '/api/health',
    '/registry/api/health',
    '/.well-known/apple-app-site-association',
    '/.well-known/assetlinks.json',
  ])('documents %s at the node root instead of under the registry service', (path) => {
    expect(registry.paths[path].get.servers).toEqual([{ url: '/' }]);
    expect(registry.paths[path].get.responses['200']).toBeDefined();
  });

  it('documents server service kinds and unavailable-registry failures', () => {
    expect(registry.components.schemas.KernelServiceCheck.properties.kind.enum).toEqual(['core', 'app']);
    expect(registry.components.schemas.KernelServiceCheck.required).toContain('kind');
    expect(registry.paths['/api/health'].get.responses['503'].content['application/json'].schema.properties.error.const)
      .toBe('registry_unavailable');
  });
});
