import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { GET } from '../route';
import { renderSpecRoute } from '@/src/lib/kernel/__tests__/spec-route-test-helpers';

afterEach(() => vi.restoreAllMocks());

describe('GET /media/api/spec — anonymous asset listing (#2721)', () => {
  it('serves the optional-auth contract and its safe anonymous descriptor', async () => {
    const { res, body } = await renderSpecRoute(() => Promise.resolve(GET()), import.meta.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/yaml');
    const spec = parse(body);
    const operation = spec.paths['/api/assets'].get;
    expect(operation.security).toEqual([
      { cookieAuth: [] }, { bearerAuth: [] }, { appTokenAuth: [] }, {},
    ]);
    expect(operation.description).toContain('Anonymous callers MUST supply a non-empty `did`');
    expect(operation.description).toContain('Anonymous and authenticated cross-DID responses');
    expect(operation.responses['200'].description).toContain('Owners and validated act-as delegates receive full Asset rows');
    expect(operation.parameters.find((param: { name: string }) => param.name === 'search').description)
      .toContain('% and _ are not wildcards');
    expect(operation.responses['401'].description).toContain('no non-empty did');
    expect(operation.responses['429']).toHaveProperty('headers.Retry-After');
    expect(spec.components.schemas.PublicAssetDescriptor.additionalProperties).toBe(false);
    expect(Object.keys(spec.components.schemas.PublicAssetDescriptor.properties).sort()).toEqual([
      'createdAt', 'filename', 'hash', 'id', 'mimeType', 'ownerDid', 'size', 'updatedAt',
    ]);
    expect(operation.responses['200'].content['application/json'].schema.properties.assets.items.anyOf)
      .toContainEqual({ $ref: '#/components/schemas/PublicAssetDescriptor' });
  });
});
