import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { GET } from '@/app/jin/api/spec/route';

const kernelRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..');
afterEach(() => { vi.restoreAllMocks(); });

describe('served listRecordEvents /spec contract (#3033)', () => {
  it('documents the act-as principal, service/access boundary and existing read sources', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(kernelRoot);
    const response = GET();
    expect(response.headers.get('content-type')).toBe('text/yaml');
    const operation = parse(await response.text()).paths['/api/events'].get;
    expect(operation.operationId).toBe('listRecordEvents');
    for (const term of [
      'identity.actingAs ?? identity.id', 'X-Acting-As', 'x-acting-as cookie',
      'never by X-Acting-For', 'owner/admin', 'allowed_services', 'jin',
      'counterparties', 'other orgs', 'registry.system_events', 'payload.actingAs',
      'payload.grantId', 'payload.principal', 'approvals', 'never widen',
      'without copying or writing data', 'Agent membership never',
    ]) {
      expect(operation.description).toContain(term);
    }
    expect(operation.security).toEqual([{ cookieAuth: [] }]);
    expect(operation.responses['403'].description).toContain('no personal fallback');
  });

  it('serves the attribution and scope-safe reference fields (#3034)', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(kernelRoot);
    const spec = parse(await GET().text());
    const schemas = spec.components.schemas;
    expect(schemas.RecordEvent.required).toEqual(expect.arrayContaining(['kind', 'who', 'grantRef', 'approvalRef']));
    expect(schemas.RecordEvent.properties.kind.enum).toEqual(['person', 'agent']);
    expect(schemas.RecordEvent.properties.who.type).toBe('string');
    expect(schemas.RecordEvent.properties.grantRef.allOf[0].$ref).toBe('#/components/schemas/RecordGrantRef');
    expect(schemas.RecordGrantRef.required).toEqual(['grantId', 'href']);
    expect(schemas.ApprovalRef.required).toContain('href');
    for (const text of ['auth-service access', 'Revoked/expired', 'never infer']) {
      expect(schemas.RecordGrantRef.description).toContain(text);
    }
    expect(schemas.ApprovalRef.description).toContain('only when addressed to the read principal');
  });
});
