import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const lookupMock = vi.fn();

vi.mock('node:dns', () => ({
  promises: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

import { checkEgressTarget, __internal, PRIVATE_ALLOWLIST_ENV_VAR } from '../egress-guard';

function mockResolves(addresses: { address: string; family: number }[]) {
  lookupMock.mockResolvedValueOnce(addresses);
}

describe('checkEgressTarget', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    delete process.env[PRIVATE_ALLOWLIST_ENV_VAR];
  });

  afterEach(() => {
    delete process.env[PRIVATE_ALLOWLIST_ENV_VAR];
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

  // ── Unconditional denials (no allowlist entry can ever re-open these) ──────

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

  it('denies the AWS IMDSv6 metadata address (fd00:ec2::254) even with a wildcard allowlist', async () => {
    process.env[PRIVATE_ALLOWLIST_ENV_VAR] = '*';
    mockResolves([{ address: 'fd00:ec2::254', family: 6 }]);
    const result = await checkEgressTarget('http://[fd00:ec2::254]:80');
    expect(result).toMatchObject({ ok: false, reason: 'metadata' });
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
    process.env[PRIVATE_ALLOWLIST_ENV_VAR] = '*';
    mockResolves([
      { address: '192.168.1.50', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    const result = await checkEgressTarget('http://multi.example:11434');
    expect(result).toMatchObject({ ok: false, reason: 'loopback' });
  });

  // ── Private space: denied BY DEFAULT ────────────────────────────────────────

  it('denies RFC1918 10.0.0.0/8 by default', async () => {
    mockResolves([{ address: '10.1.2.3', family: 4 }]);
    const result = await checkEgressTarget('http://imajin-ml.lan:11434');
    expect(result).toMatchObject({ ok: false, reason: 'private' });
  });

  it('denies RFC1918 172.16.0.0/12 by default', async () => {
    mockResolves([{ address: '172.20.5.5', family: 4 }]);
    const result = await checkEgressTarget('http://pgx.lan:8000');
    expect(result).toMatchObject({ ok: false, reason: 'private' });
  });

  it('denies RFC1918 192.168.0.0/16 by default', async () => {
    mockResolves([{ address: '192.168.1.50', family: 4 }]);
    const result = await checkEgressTarget('http://ollama.local:11434');
    expect(result).toMatchObject({ ok: false, reason: 'private' });
  });

  it('denies IPv6 unique-local (fc00::/7, excluding the metadata carve-out) by default', async () => {
    mockResolves([{ address: 'fd12:3456:789a::1', family: 6 }]);
    const result = await checkEgressTarget('http://ipv6-lan.example:11434');
    expect(result).toMatchObject({ ok: false, reason: 'private' });
  });

  it('names the allowlist env var in the denial message', async () => {
    mockResolves([{ address: '10.1.2.3', family: 4 }]);
    const result = await checkEgressTarget('http://imajin-ml.lan:11434');
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toContain('LOCAL_INFER_PRIVATE_ALLOWLIST');
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

  // ── Operator allowlist (LOCAL_INFER_PRIVATE_ALLOWLIST) ─────────────────────

  describe('operator allowlist', () => {
    it('allows a private address when its exact host is listed', async () => {
      process.env[PRIVATE_ALLOWLIST_ENV_VAR] = '192.168.1.50';
      mockResolves([{ address: '192.168.1.50', family: 4 }]);
      const result = await checkEgressTarget('http://ollama.local:11434');
      expect(result).toMatchObject({ ok: true, ip: '192.168.1.50' });
    });

    it('allows a private address when a CIDR block covering it is listed', async () => {
      process.env[PRIVATE_ALLOWLIST_ENV_VAR] = '10.0.0.0/8';
      mockResolves([{ address: '10.1.2.3', family: 4 }]);
      const result = await checkEgressTarget('http://imajin-ml.lan:11434');
      expect(result).toMatchObject({ ok: true, ip: '10.1.2.3' });
    });

    it('denies a private address outside every listed CIDR block', async () => {
      process.env[PRIVATE_ALLOWLIST_ENV_VAR] = '10.0.0.0/8';
      mockResolves([{ address: '192.168.1.50', family: 4 }]);
      const result = await checkEgressTarget('http://ollama.local:11434');
      expect(result).toMatchObject({ ok: false, reason: 'private' });
    });

    it('allows an IPv6 private address when a CIDR block covering it is listed', async () => {
      process.env[PRIVATE_ALLOWLIST_ENV_VAR] = 'fc00::/7';
      mockResolves([{ address: 'fd12:3456:789a::1', family: 6 }]);
      const result = await checkEgressTarget('http://ipv6-lan.example:11434');
      expect(result).toMatchObject({ ok: true, ip: 'fd12:3456:789a::1' });
    });

    it('a port-specific entry allows only that port', async () => {
      process.env[PRIVATE_ALLOWLIST_ENV_VAR] = '192.168.1.50:11434';

      mockResolves([{ address: '192.168.1.50', family: 4 }]);
      const allowed = await checkEgressTarget('http://192.168.1.50:11434');
      expect(allowed).toMatchObject({ ok: true });

      lookupMock.mockReset();
      mockResolves([{ address: '192.168.1.50', family: 4 }]);
      const denied = await checkEgressTarget('http://192.168.1.50:9999');
      expect(denied).toMatchObject({ ok: false, reason: 'private' });
    });

    it('a host-only entry (no port) allows every port on that host', async () => {
      process.env[PRIVATE_ALLOWLIST_ENV_VAR] = '192.168.1.50';
      mockResolves([{ address: '192.168.1.50', family: 4 }]);
      const result = await checkEgressTarget('http://192.168.1.50:9999');
      expect(result).toMatchObject({ ok: true });
    });

    it('allows a hostname entry matched against the original (pre-resolution) host', async () => {
      process.env[PRIVATE_ALLOWLIST_ENV_VAR] = 'ollama.lan:11434';
      mockResolves([{ address: '192.168.1.50', family: 4 }]);
      const result = await checkEgressTarget('http://ollama.lan:11434');
      expect(result).toMatchObject({ ok: true, ip: '192.168.1.50' });
    });

    it('* allows every private address', async () => {
      process.env[PRIVATE_ALLOWLIST_ENV_VAR] = '*';
      mockResolves([{ address: '10.1.2.3', family: 4 }]);
      const result = await checkEgressTarget('http://imajin-ml.lan:11434');
      expect(result).toMatchObject({ ok: true, ip: '10.1.2.3' });
    });

    it('* still denies loopback, link-local, and metadata (unconditional classes)', async () => {
      process.env[PRIVATE_ALLOWLIST_ENV_VAR] = '*';

      mockResolves([{ address: '127.0.0.1', family: 4 }]);
      expect(await checkEgressTarget('http://localhost:11434')).toMatchObject({ ok: false, reason: 'loopback' });

      lookupMock.mockReset();
      mockResolves([{ address: '169.254.169.254', family: 4 }]);
      expect(await checkEgressTarget('http://metadata.internal:80')).toMatchObject({ ok: false, reason: 'link_local' });
    });

    it('leaves a public address unaffected by any allowlist setting', async () => {
      process.env[PRIVATE_ALLOWLIST_ENV_VAR] = '192.168.1.50';
      mockResolves([{ address: '93.184.216.34', family: 4 }]);
      const result = await checkEgressTarget('https://example.com');
      expect(result).toMatchObject({ ok: true, ip: '93.184.216.34' });
    });

    it('ignores a malformed entry rather than failing the whole allowlist', async () => {
      process.env[PRIVATE_ALLOWLIST_ENV_VAR] = 'not a valid entry!!, 192.168.1.50';
      mockResolves([{ address: '192.168.1.50', family: 4 }]);
      const result = await checkEgressTarget('http://ollama.local:11434');
      expect(result).toMatchObject({ ok: true });
    });
  });

  // ── Allowlist parsing/matching unit coverage ────────────────────────────────

  describe('__internal allowlist parsing', () => {
    it('parses a wildcard entry', () => {
      expect(__internal.parseAllowlistEntry('*')).toEqual({ kind: 'wildcard' });
    });

    it('parses an IPv4 CIDR entry', () => {
      expect(__internal.parseAllowlistEntry('10.0.0.0/8')).toMatchObject({ kind: 'cidr', family: 4, prefixLen: 8 });
    });

    it('parses an IPv6 CIDR entry', () => {
      expect(__internal.parseAllowlistEntry('fc00::/7')).toMatchObject({ kind: 'cidr', family: 6, prefixLen: 7 });
    });

    it('parses a bracketed IPv6 literal with a port', () => {
      expect(__internal.parseAllowlistEntry('[fc00::1]:11434')).toEqual({ kind: 'literal', host: 'fc00::1', port: 11434 });
    });

    it('parses a bare IPv6 literal with no port (ambiguous otherwise)', () => {
      expect(__internal.parseAllowlistEntry('fc00::1')).toEqual({ kind: 'literal', host: 'fc00::1', port: undefined });
    });

    it('parses a hostname with a port', () => {
      expect(__internal.parseAllowlistEntry('ollama.lan:11434')).toEqual({ kind: 'literal', host: 'ollama.lan', port: 11434 });
    });

    it('rejects a malformed CIDR (bad prefix length)', () => {
      expect(__internal.parseAllowlistEntry('10.0.0.0/999')).toBeUndefined();
    });

    it('rejects an entry with a non-numeric port', () => {
      expect(__internal.parseAllowlistEntry('ollama.lan:not-a-port')).toBeUndefined();
    });

    it('drops empty entries when loading a comma-separated list', () => {
      expect(__internal.loadAllowlistEntries('10.0.0.0/8, , 192.168.1.50')).toHaveLength(2);
    });

    it('isPrivateAddressAllowed matches a CIDR entry regardless of hostname', () => {
      const entries = __internal.loadAllowlistEntries('10.0.0.0/8');
      expect(__internal.isPrivateAddressAllowed(entries, '10.5.5.5', 4, 'anything.example', 80)).toBe(true);
      expect(__internal.isPrivateAddressAllowed(entries, '192.168.1.1', 4, 'anything.example', 80)).toBe(false);
    });
  });
});
