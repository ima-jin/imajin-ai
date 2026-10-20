import { afterEach, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { GET } from '@/app/auth/api/spec/route';

const kernelRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

afterEach(() => { vi.restoreAllMocks(); });

async function servedSpec() {
  vi.spyOn(process, 'cwd').mockReturnValue(kernelRoot);
  const response = await GET();
  expect(response.headers.get('content-type')).toBe('text/yaml');
  return parse(await response.text());
}

describe('served grants /spec act-as contract (#2997)', () => {
  it.each([
    ['/api/grants', 'post'],
    ['/api/grants', 'get'],
    ['/api/grants/{grantId}', 'delete'],
    ['/api/grants/{grantId}/renew', 'post'],
    ['/api/grants/{grantId}/capabilities/{capability}', 'put'],
    ['/api/grants/{grantId}/capabilities/{capability}', 'delete'],
  ])('%s %s names the effective delegator and separate actor', async (path, method) => {
    const operation = (await servedSpec()).paths[path][method];
    expect(operation.description).toContain('X-Acting-As');
    expect(operation.description).toContain('x-acting-as cookie');
    expect(operation.description).toContain('identity.actingAs ?? identity.id');
    expect(operation.description).toContain('actorDid');
    expect(operation.description).toContain('allowed_services');
    expect(operation.description).toMatch(/\bauth\b/);
    expect(operation.security).toEqual([{ cookieAuth: [] }, { bearerAuth: [] }]);
  });

  it('documents atomic signed lifecycle proof without agent membership', async () => {
    const issue = (await servedSpec()).paths['/api/grants'].post;
    expect(issue.description).toContain('No agent membership is required or');
    expect(issue.description).toContain('created by issuance');
    expect(issue.description).toContain('delegation.grant.<event>');
    expect(issue.description).toContain('subjectDid is the delegator DID');
    expect(issue.description).toContain('{grantId, delegatorDid, actorDid, event, capability?}');
    expect(issue.description).toContain('failure rolls back');
  });
});
