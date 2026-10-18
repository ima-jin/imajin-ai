import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const spec = parse(readFileSync(resolve('apps/kernel/api-spec/vault.yaml'), 'utf8'));
const path = spec.paths['/api/vault/import'];

describe('vault import API contract (#2260)', () => {
  it('documents explicit owning identity, consumer, purpose and write-only input', () => {
    const body = path.post.requestBody.content['application/json'].schema;
    expect(body.required).toEqual(['ownerDid', 'purpose', 'consumerDid', 'secret']);
    expect(body.additionalProperties).toBe(false);
    expect(body.properties.secret.writeOnly).toBe(true);
    expect(body.properties.purpose.maxLength).toBe(200);
    expect(body.properties.replacesField).toBeDefined();
    expect(body.properties.expiresAt).toBeDefined();
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
});
