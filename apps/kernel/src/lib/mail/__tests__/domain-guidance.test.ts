import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ txt: vi.fn() }));
vi.mock('node:dns/promises', () => ({ Resolver: class { resolveTxt = state.txt; } }));
// Guidance has no database work; keep its pure exports independent in this unit test.
vi.mock('../postal-domains', async () => await import('../postal-contract'));
import { mailDomainGuidance } from '../domain-guidance';
import { mergeSpfInclude, publishableMailRecords } from '../postal-contract';
import { statusFixture } from './postal-fixture';

beforeEach(() => { vi.clearAllMocks(); });

describe('send-only DNS guidance', () => {
  it('includes ownership SPF DKIM return-path exactly, preserving all raw values and never MX', () => {
    const status = statusFixture();
    expect(publishableMailRecords(status)).toEqual(status.records.slice(0, 4));
    expect(publishableMailRecords(status).map(record => record.kind)).toEqual(['ownership', 'spf', 'dkim', 'return_path']);
  });
  it.each([
    [null, 'v=spf1 include:postal.example ~all'],
    ['v=spf1 include:spf.protection.outlook.com -all', 'v=spf1 include:spf.protection.outlook.com include:postal.example -all'],
    ['v=spf1 mx ~all', 'v=spf1 mx include:postal.example ~all'],
    ['v=spf1 a ?all', 'v=spf1 a include:postal.example ?all'],
    ['v=spf1 a +all', 'v=spf1 a include:postal.example +all'],
    ['v=spf1 a', 'v=spf1 a include:postal.example'],
    [' v=spf1  include:postal.example -all ', ' v=spf1  include:postal.example -all '],
    ['v=spf1 +include:postal.example -all', 'v=spf1 +include:postal.example -all'],
  ])('merges %s without replacing the existing provider', (existing, expected) => {
    expect(mergeSpfInclude(existing, 'include:postal.example')).toBe(expected);
  });
  it('does not confuse a substring with an existing include', () => {
    expect(mergeSpfInclude('v=spf1 include:postal.example.evil -all', 'include:postal.example'))
      .toBe('v=spf1 include:postal.example.evil include:postal.example -all');
    expect(mergeSpfInclude('v=spf1 INCLUDE:POSTAL.EXAMPLE -all', 'include:postal.example'))
      .toBe('v=spf1 INCLUDE:POSTAL.EXAMPLE -all');
  });
  it.each(['', 'not spf', 'v=spf2 -all'])('refuses invalid existing SPF %s', existing => {
    expect(() => mergeSpfInclude(existing, 'include:postal.example')).toThrow('invalid_spf_record');
  });
  it.each(['', 'postal.example', 'include:example.org -all', 'include:https://example.org'])('refuses invalid include %s', include => {
    expect(() => mergeSpfInclude(null, include)).toThrow('invalid_spf_include');
  });
  it('reads current chunked DNS SPF and merges M365 -all without mutating stored records', async () => {
    const status = statusFixture();
    state.txt.mockResolvedValue([['unrelated TXT'], ['v=spf1 include:spf.protection.', 'outlook.com -all']]);
    const result = await mailDomainGuidance(status);
    expect(state.txt).toHaveBeenCalledWith('example.org');
    expect(result.records.find(record => record.kind === 'spf')?.value)
      .toBe('v=spf1 include:spf.protection.outlook.com include:spf.postal.example -all');
    expect(status.records[1].value).toBe('v=spf1 include:spf.postal.example ~all');
    expect(result.records.some(record => record.kind === 'mx')).toBe(false);
  });
  it.each(['ENODATA', 'ENOTFOUND'])('creates a policy only when DNS confirms absence (%s)', async code => {
    state.txt.mockRejectedValue({ code });
    const result = await mailDomainGuidance(statusFixture());
    expect(result.error).toBeNull();
    expect(result.records.find(record => record.kind === 'spf')?.value).toBe('v=spf1 include:spf.postal.example ~all');
  });
  it('treats a successful TXT answer without SPF as absence', async () => {
    state.txt.mockResolvedValue([['unrelated TXT']]);
    expect((await mailDomainGuidance(statusFixture())).error).toBeNull();
  });
  it.each(['ETIMEOUT', 'SERVFAIL'])('withholds SPF on DNS failure %s', async code => {
    state.txt.mockRejectedValue({ code });
    const result = await mailDomainGuidance(statusFixture());
    expect(result.error).toBe('spf_lookup_unavailable');
    expect(result.records.map(record => record.kind)).toEqual(['ownership', 'dkim', 'return_path']);
  });
  it('withholds ambiguous multiple policies or a missing include', async () => {
    state.txt.mockResolvedValue([['v=spf1 -all'], ['v=spf1 ~all']]);
    expect((await mailDomainGuidance(statusFixture())).error).toBe('spf_lookup_unavailable');
    state.txt.mockResolvedValue([]);
    const status = statusFixture();
    delete status.records[1].include;
    expect((await mailDomainGuidance(status)).error).toBe('spf_lookup_unavailable');
  });
  it('does not query DNS for disabled domains or absent SPF', async () => {
    expect(await mailDomainGuidance({ ...statusFixture(), state: 'disabled' })).toEqual({ records: [], error: null });
    const status = { ...statusFixture(), records: [] };
    expect(await mailDomainGuidance(status)).toEqual({ records: [], error: null });
    expect(state.txt).not.toHaveBeenCalled();
  });
});
