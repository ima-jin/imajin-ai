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
});
