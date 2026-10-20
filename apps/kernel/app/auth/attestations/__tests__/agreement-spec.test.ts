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
