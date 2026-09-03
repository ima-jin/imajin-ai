import { describe, expect, it, vi, beforeEach } from 'vitest';

const lookupMock = vi.fn();

vi.mock('node:dns', () => ({
  promises: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

import { checkEgressTarget, __internal } from '../egress-guard';

function mockResolves(addresses: { address: string; family: number }[]) {
  lookupMock.mockResolvedValueOnce(addresses);
}

describe('checkEgressTarget', () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it('denies non-http(s) schemes', async () => {
    const result = await checkEgressTarget('file:///etc/passwd');
    expect(result).toMatchObject({ ok: false, reason: 'invalid_scheme' });
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('denies an unparseable URL', async () => {
    const result = await checkEgressTarget('not a url');
    expect(result).toMatchObject({ ok: false, reason: 'invalid_url' });
  });

  it('denies when DNS resolution fails', async () => {
    lookupMock.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const result = await checkEgressTarget('http://nonexistent.invalid:11434');
    expect(result).toMatchObject({ ok: false, reason: 'dns_resolution_failed' });
  });

  it('denies loopback (IPv4)', async () => {
    mockResolves([{ address: '127.0.0.1', family: 4 }]);
    const result = await checkEgressTarget('http://localhost:11434');
    expect(result).toMatchObject({ ok: false, reason: 'loopback' });
  });

  it('denies loopback (IPv6 ::1)', async () => {
    mockResolves([{ address: '::1', family: 6 }]);
    const result = await checkEgressTarget('http://ip6-localhost:11434');
    expect(result).toMatchObject({ ok: false, reason: 'loopback' });
  });

  it('denies the unspecified address', async () => {
    mockResolves([{ address: '0.0.0.0', family: 4 }]);
    const result = await checkEgressTarget('http://0.0.0.0:11434');
    expect(result).toMatchObject({ ok: false, reason: 'unspecified' });
  });

  it('denies link-local, including the cloud metadata IP', async () => {
    mockResolves([{ address: '169.254.169.254', family: 4 }]);
    const result = await checkEgressTarget('http://metadata.internal:80');
    expect(result).toMatchObject({ ok: false, reason: 'link_local' });
  });

  it('denies IPv6 link-local (fe80::/10)', async () => {
    mockResolves([{ address: 'fe80::1', family: 6 }]);
    const result = await checkEgressTarget('http://[fe80::1]:11434');
    expect(result).toMatchObject({ ok: false, reason: 'link_local' });
  });

  it('denies IPv6 unique-local metadata range (fd00::/8)', async () => {
    mockResolves([{ address: 'fd00:ec2::254', family: 6 }]);
    const result = await checkEgressTarget('http://[fd00:ec2::254]:80');
    expect(result).toMatchObject({ ok: false, reason: 'unique_local_metadata' });
  });

  it('denies multicast (IPv4)', async () => {
    mockResolves([{ address: '224.0.0.1', family: 4 }]);
    const result = await checkEgressTarget('http://mcast.example:11434');
    expect(result).toMatchObject({ ok: false, reason: 'multicast' });
  });

  it('denies IPv6 multicast (ff00::/8)', async () => {
    mockResolves([{ address: 'ff02::1', family: 6 }]);
    const result = await checkEgressTarget('http://[ff02::1]:11434');
    expect(result).toMatchObject({ ok: false, reason: 'multicast' });
  });

  it('denies reserved IPv4 space (240.0.0.0/4) and the broadcast address', async () => {
    mockResolves([{ address: '240.0.0.1', family: 4 }]);
    expect(await checkEgressTarget('http://reserved.example:11434')).toMatchObject({ ok: false, reason: 'reserved' });

    lookupMock.mockReset();
    mockResolves([{ address: '255.255.255.255', family: 4 }]);
    expect(await checkEgressTarget('http://broadcast.example:11434')).toMatchObject({ ok: false, reason: 'reserved' });
  });

  it('denies an IPv4-mapped IPv6 loopback address (::ffff:127.0.0.1)', async () => {
    mockResolves([{ address: '::ffff:127.0.0.1', family: 6 }]);
    const result = await checkEgressTarget('http://mapped.example:11434');
    expect(result).toMatchObject({ ok: false, reason: 'loopback' });
  });

  it('denies a hostname when ANY resolved address is denied, even if another is fine', async () => {
    mockResolves([
      { address: '192.168.1.50', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const result = await checkEgressTarget('http://multi.example:11434');
    expect(result).toMatchObject({ ok: false, reason: 'loopback' });
  });

  it('allows RFC1918 10.0.0.0/8', async () => {
    mockResolves([{ address: '10.1.2.3', family: 4 }]);
    const result = await checkEgressTarget('http://imajin-ml.lan:11434');
    expect(result).toMatchObject({ ok: true, ip: '10.1.2.3', family: 4 });
  });

  it('allows RFC1918 172.16.0.0/12', async () => {
    mockResolves([{ address: '172.20.5.5', family: 4 }]);
    const result = await checkEgressTarget('http://pgx.lan:8000');
    expect(result).toMatchObject({ ok: true, ip: '172.20.5.5', family: 4 });
  });

  it('allows RFC1918 192.168.0.0/16', async () => {
    mockResolves([{ address: '192.168.1.50', family: 4 }]);
    const result = await checkEgressTarget('http://ollama.local:11434');
    expect(result).toMatchObject({ ok: true, ip: '192.168.1.50', family: 4 });
  });

  it('does NOT treat 172.15.x.x or 172.32.x.x as RFC1918 (boundary check)', () => {
    expect(__internal.isRfc1918('172.15.0.1')).toBe(false);
    expect(__internal.isRfc1918('172.32.0.1')).toBe(false);
    expect(__internal.isRfc1918('172.16.0.1')).toBe(true);
    expect(__internal.isRfc1918('172.31.255.255')).toBe(true);
  });

  it('allows a public address', async () => {
    mockResolves([{ address: '93.184.216.34', family: 4 }]);
    const result = await checkEgressTarget('https://example.com');
    expect(result).toMatchObject({ ok: true, ip: '93.184.216.34', family: 4 });
  });

  it('allows a literal RFC1918 IP with no DNS round trip needed conceptually (still goes through dns.lookup)', async () => {
    mockResolves([{ address: '10.0.0.5', family: 4 }]);
    const result = await checkEgressTarget('http://10.0.0.5:8000/v1/models');
    expect(result).toMatchObject({ ok: true, ip: '10.0.0.5' });
  });
});
