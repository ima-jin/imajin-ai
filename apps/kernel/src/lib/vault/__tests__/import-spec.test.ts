import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const spec = parse(readFileSync(resolve('apps/kernel/api-spec/vault.yaml'), 'utf8'));
const path = spec.paths['/api/vault/import'];

describe('vault import API contract (#2260)', () => {
  it('documents explicit owning identity, consumer, purpose and write-only input', () => {
    const body = path.post.requestBody.content['application/json'].schema;
    expect(body.required).toEqual(['ownerDid', 'secret']);
    expect(body.anyOf).toEqual([{ required: ['purpose', 'consumerDid'] }, { required: ['cloudflare'] }]);
    expect(body.properties.cloudflare.$ref).toBe('#/components/schemas/CloudflareAuthority');
    expect(spec.components.schemas.CloudflareAuthority.required).toEqual(['domain', 'zoneId', 'granteeDid', 'capabilities']);
    expect(body.additionalProperties).toBe(false);
    expect(body.properties.secret.writeOnly).toBe(true);
    expect(body.properties.purpose.maxLength).toBe(200);
    expect(body.properties.replacesField).toBeDefined();
    expect(body.properties.expiresAt).toBeDefined();
  });

  it('keeps fake credential bytes out of every host unit, workflow and command configuration', () => {
    const fixture = 'test-credential-not-a-token';
    const directory = 'deploy/infer-passthrough/';
    for (const name of [
      'infer-passthrough-deployment-read.service', 'infer-passthrough-bootstrap.service',
      'infer-passthrough-update.service', 'infer-passthrough-update.timer',
      'infer-passthrough.service', 'infer-passthrough.env.example',
    ]) expect(readFileSync(resolve(directory, name), 'utf8')).not.toContain(fixture);
    const unit = readFileSync(resolve(directory, 'infer-passthrough-deployment-read.service'), 'utf8');
    expect(unit).toContain('User=root');
    expect(unit).toContain('Group=root');
    expect(unit).toContain('UMask=0077');
    expect(unit).not.toMatch(/EnvironmentFile|GITHUB_TOKEN|GH_TOKEN/);
    expect(unit).toContain('flock --exclusive /run/lock/infer-passthrough-deployment-read.lock');
    expect(readFileSync(resolve(directory, 'update.sh'), 'utf8')).toContain('flock --exclusive /run/lock/infer-passthrough-deployment-read.lock');
  });

  it('returns metadata-only pending approval and documents the countersigned execution path', () => {
    const response = path.post.responses['201'].content['application/json'].schema;
    expect(response.required).toEqual(['status', 'proposalId', 'fingerprint', 'purpose']);
    expect(response.properties.secret).toBeUndefined();
    expect(path.post.description).toContain('principalDid = ownerDid');
    expect(path.post.description).toContain('granteeDid = consumerDid');
    for (const term of ['countersignature', 'list_grants', 'fetch', 'loadFromVault', 'acked', '.env.local']) {
      expect(path.post.description).toContain(term);
    }
  });

  it('documents the owner picker and imported grant lifecycle without ciphertext', () => {
    const response = path.get.responses['200'].content['application/json'].schema;
    expect(response.required).toEqual(['ownerDid', 'owners', 'cards']);
    const card = response.properties.cards.items;
    expect(card.properties.provenance.const).toBe('imported');
    expect(card.properties.timeline.items.properties.type.enum).toEqual(['imported', 'granted', 'fetched', 'acked', 'rotated', 'revoked']);
    expect(card.properties.encrypted).toBeUndefined();
    expect(card.properties.wrappedKey).toBeUndefined();
    expect(card.properties.secret).toBeUndefined();
  });

  it('documents repository/recipient-bound import and reuses the three delegation endpoints', () => {
    const body = path.post.requestBody.content['application/json'].schema;
    expect(body.properties.deploymentRead.properties.repository.const).toBe('ima-jin/imajin-ai');
    expect(body.properties.deploymentRead.required).toEqual(['repository', 'recipientDid']);
    expect(path.post.description).toContain('infer-passthrough/github-deploy-read');
    expect(spec.components.securitySchemes.deploymentRead.name).toBe('x-imajin-deployment-read');
    for (const [endpoint, method] of [
      ['/api/vault/delegation/grants', 'get'],
      ['/api/vault/delegation/grants/{grantId}/fetch', 'post'],
      ['/api/vault/delegation/grants/{grantId}/ack', 'post'],
    ]) {
      expect(spec.paths[endpoint][method].security).toContainEqual({ deploymentRead: [] });
      expect(spec.paths[endpoint][method].responses['200'].description).toContain('no-store');
    }
  });
});
