import { describe, expect, it } from 'vitest';
import { isSpf, mergeSpf } from '../spf';

const required = 'v=spf1 include:postal.example.com ~all';

describe('send-only SPF merge', () => {
  it('preserves Microsoft 365 and strict policy, with a single version', () => {
    expect(mergeSpf('v=spf1 include:spf.protection.outlook.com -all', required))
      .toBe('v=spf1 include:spf.protection.outlook.com include:postal.example.com -all');
  });

  it('deduplicates case-insensitive mechanisms and explicit positive qualifiers', () => {
    const merged = mergeSpf('V=SPF1 include:other.example.com +include:POSTAL.example.com include:other.example.com -all', required);
    expect(merged).toBe('v=spf1 include:other.example.com +include:POSTAL.example.com -all');
    expect(mergeSpf(merged, required)).toBe(merged);
  });

  it.each(['-all', '~all', '?all', '+all', 'all'])('keeps the existing %s policy', (policy) => {
    expect(mergeSpf(`v=spf1 mx ip4:192.0.2.0/24 ${policy} exp=explain.example.com`, required))
      .toBe(`v=spf1 mx ip4:192.0.2.0/24 include:postal.example.com ${policy} exp=explain.example.com`);
  });

  it('preserves redirects instead of replacing them with the provider all policy', () => {
    expect(mergeSpf('v=spf1 redirect=example.net', required))
      .toBe('v=spf1 redirect=example.net include:postal.example.com');
  });

  it('does not collapse SPF macros whose uppercase form has different semantics', () => {
    expect(mergeSpf('v=spf1 exists:%{l}.example.net exists:%{L}.example.net -all', required))
      .toBe('v=spf1 exists:%{l}.example.net exists:%{L}.example.net include:postal.example.com -all');
  });

  it('creates a deduplicated policy only when none exists', () => {
    expect(mergeSpf(undefined, `${required.replace(' ~all', '')} include:postal.example.com ~all`)).toBe(required);
  });

  it.each([
    'v=spf1 -all ~all', 'v=spf1 redirect=a.example redirect=b.example',
    'v=spf1 -all include:other.example', 'v=spf1 v=spf1 -all',
    'v=spf1 -include:postal.example.com -all', 'not an SPF record',
  ])('fails closed on ambiguous or conflicting existing SPF: %s', (existing) => {
    expect(() => mergeSpf(existing, required)).toThrow();
  });

  it.each([
    'v=spf1 +all', 'v=spf1 all', 'v=spf1 redirect=example.com', 'v=spf1 ip4:192.0.2.1 -all',
    'v=spf1 -all ~all', 'v=spf1 -all include:postal.example.com',
    'v=spf1 include:invalid -all', 'v=spf1 v=spf1 -all',
  ])('refuses unsupported provider policy: %s', (addition) => {
    expect(() => mergeSpf(undefined, addition)).toThrow();
  });

  it('does not confuse similarly named TXT records with SPF', () => {
    expect(isSpf('v=spf10 include:example.com')).toBe(false);
    expect(isSpf('  V=SPF1 -all ')).toBe(true);
  });
});
