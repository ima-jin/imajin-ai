import { describe, expect, it } from 'vitest';
import { ManualDnsProvider } from '../manual';
import { scopedRecords, type DnsProvider, type DnsRecord } from '../types';

const proof: DnsRecord = { type: 'TXT', name: '_imajin.example.com', content: 'did:imajin:owner' };
const dkim: DnsRecord = { type: 'TXT', name: 'selector._domainkey.example.com', content: 'v=DKIM1; p=public-key' };

describe('manual adapter contract', () => {
  it('shows copyable records and safe instructions, never a written/verified result', async () => {
    const provider: DnsProvider = new ManualDnsProvider('example.com');
    const result = await provider.apply([proof, dkim]);
    expect(result).toMatchObject({ mode: 'manual', status: 'action-required', records: [proof, dkim] });
    expect(result.instructions.join(' ')).toContain('never publish a second SPF record');
    expect(result.instructions.join(' ')).toContain('do not change MX');
    expect(await provider.apply([proof, dkim])).toEqual(result);
  });

  it('normalizes names and returns a fresh deduplicated plan', async () => {
    const input = { ...proof, name: '_IMAJIN.EXAMPLE.COM.' };
    const result = await new ManualDnsProvider('EXAMPLE.COM').apply([input, proof]);
    expect(result.records).toEqual([proof]);
    expect(input.name).toBe('_IMAJIN.EXAMPLE.COM.');
    expect(scopedRecords('example.com', [{ type: 'CNAME', name: 'rp.example.com', content: 'POSTAL.EXAMPLE.NET.' }]))
      .toEqual([{ type: 'CNAME', name: 'rp.example.com', content: 'postal.example.net' }]);
  });

  it.each([
    { ...proof, name: 'notexample.com' }, { ...proof, name: 'example.com.attacker.net' },
    { ...proof, name: '*.example.com' }, { ...proof, name: 'bad/.example.com' },
    { ...proof, name: `${'a'.repeat(64)}.example.com` },
    { ...proof, content: '' }, { ...proof, content: 'line\nbreak' }, { ...proof, content: 'x'.repeat(8193) },
    { type: 'MX', name: 'example.com', content: 'mail.example.net' },
    { type: 'CNAME', name: 'example.com', content: 'postal.example.net' },
    { type: 'CNAME', name: 'rp.example.com', content: 'rp.example.com.' },
    { type: 'CNAME', name: 'rp.example.com', content: 'https://postal.example.net' },
  ])('rejects unsafe record %#', (record) => {
    expect(() => scopedRecords('example.com', [record as DnsRecord])).toThrow();
  });

  it('bounds plan size and refuses conflicting planned records', () => {
    expect(() => scopedRecords('example.com', Array.from({ length: 51 }, () => proof))).toThrow('invalid_dns_records');
    expect(() => scopedRecords('example.com', [
      proof, { type: 'CNAME', name: proof.name, content: 'postal.example.net' },
    ])).toThrow('conflicting_dns_plan');
    expect(() => scopedRecords('example.com', [
      { type: 'TXT', name: 'example.com', content: 'v=spf1 include:a.example -all' },
      { type: 'TXT', name: 'example.com', content: 'v=spf1 include:b.example -all' },
    ])).toThrow('conflicting_dns_plan');
  });
});
