import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import SwaggerParser from '@apidevtools/swagger-parser';

const spec = YAML.parse(readFileSync(resolve(process.cwd(), 'apps/kernel/api-spec/auth.yaml'), 'utf8'));
const paths = Object.fromEntries(Object.entries(spec.paths).filter(([path]) =>
  path.startsWith('/api/documents') || path === '/api/attestations/types'
  || path === '/api/identity/{did}/sign' || path === '/api/attestations/{id}/revoke'));

describe('agreement auth OpenAPI contracts', () => {
  it('publishes the private hash-checked document content contract', () => {
    const content = spec.paths['/api/documents/{id}/content'].get;
    expect(content.security).toEqual([{ cookieAuth: [] }]);
    expect(content.parameters).toContainEqual(expect.objectContaining({ name: 'id', in: 'path', required: true }));
    expect(content.parameters).toContainEqual(expect.objectContaining({ name: 'download', in: 'query' }));
    expect(content.description).toContain('active member');
    expect(content.description).toContain("not the organization's other assets");
    expect(content.responses['200'].headers['Cache-Control'].schema.const).toBe('private, no-store');
    expect(content.responses['200'].headers['Content-Disposition']).toBeDefined();
    expect(content.responses['200'].headers['X-Document-Hash']).toBeDefined();
    expect(content.responses['200'].content['application/pdf'].schema.format).toBe('binary');
    for (const status of ['401', '403', '404', '409']) expect(content.responses[status]).toBeDefined();
    expect(content.responses['409'].description).toContain('hash mismatch');
  });
  it.each(['decline', 'amend'])('requires the same session and auth-scoped act-as policy for %s', (operation) => {
    const contract = spec.paths[`/api/documents/{id}/${operation}`].post;
    expect(contract.security).toEqual([{ cookieAuth: [] }]);
    expect(contract.description).toContain('auth-scoped act-as');
    expect(contract.description).toContain('403 before writes');
    expect(contract.responses['403']).toBeDefined();
  });
  it('discloses cookie-only compatibility, content-only proof and business-only agreement completion', () => {
    expect(spec.paths['/api/documents'].description).toContain('bearer-only');
    const create = spec.paths['/api/documents'].post.description;
    expect(create).toContain('Personal and non-business group');
    expect(create).toContain('not a request id');
    expect(create).toContain('without a hash collision');
    expect(spec.paths['/api/documents/{id}/verify'].post.responses['413']).toBeDefined();
  });
  it('validates the changed document/identity/revoke paths as OpenAPI 3.1', async () => {
    await expect(SwaggerParser.validate({ ...spec, paths })).resolves.toBeDefined();
  });
  it('requires multipart file and describes the four explicit verification booleans', () => {
    const verify = spec.paths['/api/documents/{id}/verify'].post;
    const input = verify.requestBody.content['multipart/form-data'].schema;
    expect(input.required).toEqual(['file']);
    expect(input.properties.file.format).toBe('binary');
    const output = verify.responses['200'].content['application/json'].schema;
    expect(output.required).toEqual(['valid', 'hashMatches', 'signaturesValid', 'revoked']);
    expect(Object.values(output.properties).every((property) => (property as { type: string }).type === 'boolean')).toBe(true);
    expect(verify.description).toContain('node witness');
  });
  it('documents auth-scoped act-as refusal, agreement type and either-party revocation without deleting history', () => {
    expect(spec.paths['/api/documents'].description).toContain('403 before writes');
    expect(spec.paths['/api/documents'].description).toContain('auth-scoped');
    expect(spec.paths['/api/attestations/types'].get.description).toContain('agreement');
    expect(spec.paths['/api/attestations/{id}/revoke'].post.description).toContain('either recorded agreement party');
    expect(spec.paths['/api/attestations/{id}/revoke'].post.description).toContain('without deleting');
  });
});
