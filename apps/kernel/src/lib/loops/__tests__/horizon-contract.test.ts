import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { STEP_EVENT_TYPES } from '../step-types';

const spec = parse(readFileSync(new URL('../../../../api-spec/jin.yaml', import.meta.url), 'utf8'));
const detail = spec.paths['/api/loops/{loopId}'].get;

describe('published horizon API contract', () => {
  it('requires loop/events/horizon on loop detail, not on the unchanged Record response', () => {
    const schema = detail.responses['200'].content['application/json'].schema;
    expect(schema.required).toEqual(['loop', 'events', 'horizon']);
    expect(schema.properties.horizon.$ref).toBe('#/components/schemas/Horizon');
    const record = spec.paths['/api/events'].get.responses['200'].content['application/json'].schema;
    expect(record.required ?? []).not.toContain('horizon');
    expect(record.properties).not.toHaveProperty('horizon');
  });
  it('publishes every accepted step type and the opt-in exited audit flag', () => {
    const ingest = spec.paths['/api/loops'].post.requestBody.content['application/json'].schema;
    expect(ingest.properties.type.enum).toEqual(expect.arrayContaining([...STEP_EVENT_TYPES]));
    expect(detail.parameters.find((parameter: { name: string }) => parameter.name === 'includeExited').schema)
      .toEqual({ type: 'boolean', default: false });
    expect(spec.components.schemas.Horizon.properties.depth.readOnly).toBe(true);
    expect(spec.components.schemas.StepUpdate.properties).not.toHaveProperty('zone');
  });
});
