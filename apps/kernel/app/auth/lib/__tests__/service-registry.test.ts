import { describe, it, expect } from 'vitest';
import { buildEmbedSrc } from '../service-registry';

describe('service-registry (#2275, #2425 send-back)', () => {
  it('builds a relative dashboard path from the registry app base path', () => {
    expect(buildEmbedSrc('did:imajin:abc', '/learn')).toBe('/learn/dashboard?embed=hub&did=did%3Aimajin%3Aabc');
  });

  it('#2425: no literal app slug carries a hard-coded URL here — every non-kernel-native embed src is built from a caller-supplied baseUrl', () => {
    expect(buildEmbedSrc('did:imajin:abc', 'https://registry-resolved.example')).toBe(
      'https://registry-resolved.example/dashboard?embed=hub&did=did%3Aimajin%3Aabc',
    );
  });

  it('#2425 send-back: a baseUrl works for any slug, including one with no special-casing at all', () => {
    expect(buildEmbedSrc('did:imajin:abc', 'https://newapp.example')).toBe(
      'https://newapp.example/dashboard?embed=hub&did=did%3Aimajin%3Aabc',
    );
  });
});
