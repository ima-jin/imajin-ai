import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
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
    expect(listing.responses['200'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/UsableModelList',
    });
    const schema = spec.components.schemas.UsableModelList;
    expect(schema.properties.object.const).toBe('list');
    const entry = schema.properties.data.items;
    expect(entry.required).toEqual(['id', 'object', 'owned_by', 'created', 'imajin']);
    expect(entry.properties.imajin.required).toContain('picked');
    expect(entry.properties.imajin.properties.picked.type).toBe('boolean');
  });
});
