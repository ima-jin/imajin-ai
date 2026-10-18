import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { GET } from '@/app/connections/api/spec/route';

afterEach(() => { vi.restoreAllMocks(); });

describe('served connections /spec relationship contract (#2945)', () => {
  async function spec() {
    vi.spyOn(process, 'cwd').mockReturnValue(resolve('apps/kernel'));
    const response = GET();
    expect(response.headers.get('content-type')).toBe('text/yaml');
    return parse(await response.text());
  }

  it('documents the own-side label and management capability on the existing list', async () => {
    const list = (await spec()).paths['/api/connections'].get;
    const result = list.responses['200'].content['application/json'].schema;
    expect(result.required).toContain('canManageRelationshipLabels');
    expect(result.properties.connections.items.properties.relationshipLabel).toEqual({
      type: ['string', 'null'], enum: ['client', 'vendor', 'partner', 'other', null],
    });
    expect(list.description).toContain("counterparty's label is never returned");
    expect(list.description).toContain('Labels grant no membership');
    expect(list.security).toContainEqual({ bearerAuth: [] });
  });

  it('documents set/change/clear, direct controller targeting and signed private history', async () => {
    const patch = (await spec()).paths['/api/connections/{did}'].patch;
    const body = patch.requestBody.content['application/json'].schema;
    expect(body.required).toEqual(['relationshipLabel']);
    expect(body.properties.relationshipLabel.enum).toEqual(['client', 'vendor', 'partner', 'other', null]);
    expect(body.properties.orgDid.type).toBe('string');
    expect(patch.description).toContain('connection.relationship.label.changed');
    expect(patch.description).toContain("original authenticated actor's live owner/admin membership");
    expect(patch.description).toContain("restricted to the org's live controllers");
    expect(Object.keys(patch.responses)).toEqual(['200', '400', '401', '403', '404', '500']);
  });

  it('keeps disconnect on the same connection DID resource', async () => {
    const paths = (await spec()).paths;
    expect(paths['/api/connections/{did}'].delete.operationId).toBe('disconnect');
    expect(paths['/api/connections/{podId}']).toBeUndefined();
  });
});
