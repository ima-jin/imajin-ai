import { describe, expect, it } from 'vitest';
import { CLOUDFLARE_CAPABILITIES, cloudflarePurpose, cloudflareZoneDid, isCloudflareImport, isCloudflareZoneAudience, isCloudflareZoneId } from '../contract';

describe('Cloudflare public contract', () => {
  it('has stable zone-only resource identifiers and exact closed operation capabilities', () => {
    const zoneId = '0123456789abcdef'.repeat(2);
    expect(isCloudflareZoneId(zoneId)).toBe(true);
    expect(cloudflarePurpose(zoneId)).toBe(`dns.cloudflare:${zoneId}`);
    expect(cloudflareZoneDid(zoneId)).toBe(`did:imajin:cloudflare-${zoneId}`);
    expect(CLOUDFLARE_CAPABILITIES).toEqual(['cloudflare:read', 'cloudflare:dns', 'cloudflare:cache', 'cloudflare:ssl', 'cloudflare:custom-hostnames']);
    for (const invalid of ['', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), '../zones', null, 4]) {
      expect(isCloudflareZoneId(invalid)).toBe(false);
      expect(() => cloudflarePurpose(invalid as string)).toThrow('Invalid Cloudflare zone');
      expect(() => cloudflareZoneDid(invalid as string)).toThrow('Invalid Cloudflare zone');
    }
  });

  it('accepts only an exact single deterministic zone audience', () => {
    const did = cloudflareZoneDid('a'.repeat(32));
    expect(isCloudflareZoneAudience({ type: 'dids', values: [did] })).toBe(true);
    for (const audience of [null, [], {}, { type: 'all' }, { type: 'dids', values: [] },
      { type: 'dids', values: [did, did] }, { type: 'dids', values: ['did:imajin:person'] },
      { type: 'dids', values: [4] }]) expect(isCloudflareZoneAudience(audience)).toBe(false);
  });

  it('keeps the import metadata DB-free and rejects all unrecognized authority fields', () => {
    const input = { domain: 'example.com', zoneId: 'a'.repeat(32), granteeDid: 'did:web:external.example', capabilities: [...CLOUDFLARE_CAPABILITIES] };
    expect(isCloudflareImport(input)).toBe(true);
    for (const value of [null, [], 'zone', {}, { ...input, domain: '127.0.0.1' }, { ...input, token: 'FAKE_NOT_ALLOWED' },
      { ...input, capabilities: ['cloudflare:*'] }, { ...input, capabilities: [] }]) expect(isCloudflareImport(value)).toBe(false);
  });
});
