import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import SwaggerParser from '@apidevtools/swagger-parser';
import { GET } from '../route';
import { renderSpecRoute } from '@/src/lib/kernel/__tests__/spec-route-test-helpers';

afterEach(() => vi.restoreAllMocks());

describe('inference discovery spec (#3027)', () => {
  it('serves the YAML contract including OpenAI ids and picked metadata', async () => {
    const { res, body } = await renderSpecRoute(async () => GET(), import.meta.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/yaml');
    const spec = parse(body);
    const listing = spec.paths['/v1/models/usable'].get;
    expect(listing.security).toEqual([{ appToken: [] }]);
    expect(listing.description).toContain('infer:completions');
    expect(listing.responses['200'].content['application/json'].schema.oneOf).toEqual([
      { $ref: '#/components/schemas/UsableModelList' },
      { $ref: '#/components/schemas/InferenceRouteList' },
    ]);
    expect(listing.parameters).toContainEqual(expect.objectContaining({ name: 'explain', in: 'query' }));
    expect(spec.components.schemas.InferenceRouteList.properties.routes.items.properties.kind.enum).toEqual(['own', 'A', 'B', 'C']);
    const schema = spec.components.schemas.UsableModelList;
    expect(schema.properties.object.const).toBe('list');
    const entry = schema.properties.data.items;
    expect(entry.required).toEqual(['id', 'object', 'owned_by', 'created', 'imajin']);
    expect(entry.properties.imajin.required).toContain('picked');
    expect(entry.properties.imajin.properties.picked.type).toBe('boolean');
    const self = spec.paths['/v1/self'].get;
    expect(self.security).toEqual(listing.security);
    expect(self.description).toContain('infer:completions');
    expect(self.parameters.map((parameter: { name: string }) => parameter.name)).toEqual(['x-acting-as', 'x-acting-for']);
    expect(self.responses['200'].content['application/json'].schema).toEqual({ $ref: '#/components/schemas/SelfDiscovery' });
    expect(spec.components.schemas.SelfDiscovery.additionalProperties).toBe(false);
    expect(spec.components.schemas.SelfDiscoveryConnector.properties.authority.enum)
      .toEqual(['own-key', 'org-held', 'delegated', 'member-grant', null]);
    await SwaggerParser.validate(spec);
  });
});
