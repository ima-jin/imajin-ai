import { describe, it, expect } from 'vitest';
import { isKernelNativeService, buildEmbedSrc } from '../service-registry';

describe('service-registry (#2275, #2425 send-back)', () => {
  it('treats pay and media as kernel-native, and userspace apps as not', () => {
    expect(isKernelNativeService('pay')).toBe(true);
    expect(isKernelNativeService('media')).toBe(true);
    expect(isKernelNativeService('coffee')).toBe(false);
    expect(isKernelNativeService('unknown-service')).toBe(false);
  });

  it('builds a same-origin (no host) embed src for kernel-native services under their own path', () => {
    expect(buildEmbedSrc('pay', 'did:imajin:abc')).toBe('/pay?embed=hub&did=did%3Aimajin%3Aabc');
    expect(buildEmbedSrc('media', 'did:imajin:abc')).toBe('/media?embed=hub&did=did%3Aimajin%3Aabc');
  });

  it('falls back to a relative /dashboard path when no base URL is supplied', () => {
    expect(buildEmbedSrc('learn', 'did:imajin:abc')).toBe('/dashboard?embed=hub&did=did%3Aimajin%3Aabc');
  });

  it('#2425: no literal app slug carries a hard-coded URL here — every non-kernel-native embed src is built from a caller-supplied baseUrl', () => {
    expect(buildEmbedSrc('coffee', 'did:imajin:abc', 'https://registry-resolved.example')).toBe(
      'https://registry-resolved.example/dashboard?embed=hub&did=did%3Aimajin%3Aabc',
    );
  });

  it('#2425 send-back: a baseUrl works for any slug, including one with no special-casing at all', () => {
    expect(buildEmbedSrc('a-brand-new-app', 'did:imajin:abc', 'https://newapp.example')).toBe(
      'https://newapp.example/dashboard?embed=hub&did=did%3Aimajin%3Aabc',
    );
  });
});
