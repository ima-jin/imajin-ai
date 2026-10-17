import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  verified: vi.fn(), routable: vi.fn(), rows: [] as Record<string, unknown>[],
}));
vi.mock('../service', () => ({
  normalizeDomain: (input: string) => {
    if (!input.includes('.')) throw new Error('Invalid domain');
    return input.toLowerCase().replace(/\.$/, '');
  },
  resolveVerifiedDomain: mocks.verified,
  resolveRoutableDomain: mocks.routable,
}));
vi.mock('@/src/db', () => {
  const limit = async () => mocks.rows;
  const where = () => ({ limit });
  const from = () => ({ where });
  return {
    db: { select: () => ({ from }) },
    registryApps: { entryUrl: 'entryUrl', ownerDid: 'ownerDid', appDid: 'appDid', status: 'status' },
    forestConfig: { landingService: 'landingService', groupDid: 'groupDid' },
  };
});
vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn() }));
import { domainFromHost, domainLanding, publicDomainEvidence, safeLanding } from '../routing';

beforeEach(() => { vi.clearAllMocks(); mocks.rows = []; });
describe('Host parsing and safe registry destinations', () => {
  it.each([null, '', 'example.com/evil', 'example.com@evil.test', '::1', 'localhost'])('rejects %s', (host) => {
    expect(domainFromHost(host)).toBeNull();
  });
  it('normalizes a Host and drops its port', () => {
    expect(domainFromHost('GBS.Example:443')).toBe('gbs.example');
  });
  it.each([
    '/', '/?view=home', '/./', '/app/..', '/#home', 'https://gbs.example./',
    '//evil.test', '/\\evil.test', '/\nredirect', 'javascript:alert(1)',
    'http://evil.test', 'https://user:pass@evil.test', 'https://gbs.example/', 'broken',
  ])('refuses %s', (entry) => {
    expect(safeLanding(entry, 'gbs.example')).toBeNull();
  });
  it('accepts safe local and HTTPS registry entries', () => {
    expect(safeLanding('/events', 'gbs.example')).toBe('/events');
    expect(safeLanding('https://app.example/start', 'gbs.example')).toBe('https://app.example/start');
    expect(safeLanding('https://gbs.example./start?view=1#page', 'gbs.example')).toBe('/start?view=1#page');
  });
});
describe('public proof and verified routing', () => {
  it('returns neither evidence nor a destination for an unverified host', async () => {
    mocks.verified.mockResolvedValue(null); mocks.routable.mockResolvedValue(null);
    expect(await publicDomainEvidence('gbs.example')).toBeNull();
    expect(await domainLanding('gbs.example')).toBeNull();
  });
  it('does not turn an unsigned row into public evidence', async () => {
    mocks.verified.mockResolvedValue({ status: 'legacy', attestation: null });
    expect(await publicDomainEvidence('gbs.example')).toBeNull();
  });
  it('returns the two parties and signed attestation without internal fields', async () => {
    mocks.verified.mockResolvedValue({
      siteOwner: 'did:site', zoneOwner: 'did:zone', appDid: 'did:app', attestation: { signature: 'signed' }, internal: 'hidden',
    });
    expect(await publicDomainEvidence('gbs.example')).toEqual({
      siteOwner: 'did:site', zoneOwner: 'did:zone', appDid: 'did:app', attestation: { signature: 'signed' },
    });
  });
  it('routes only an active app still owned by the recorded site owner', async () => {
    mocks.routable.mockResolvedValue({ appDid: 'did:app', siteOwner: 'did:site' });
    expect(await domainLanding('gbs.example')).toBeNull();
    mocks.rows = [{ entryUrl: '/gbs', ownerDid: 'did:new-owner' }];
    expect(await domainLanding('gbs.example')).toBeNull();
    mocks.rows = [{ entryUrl: null, ownerDid: 'did:site' }];
    expect(await domainLanding('gbs.example')).toBeNull();
    mocks.rows = [{ entryUrl: '/gbs', ownerDid: 'did:site' }];
    expect(await domainLanding('gbs.example')).toBe('/gbs');
  });
  it('preserves forest landing and scope only after the shared routing gate', async () => {
    mocks.routable.mockResolvedValue({ appDid: null, siteOwner: 'did:forest' });
    expect(await domainLanding('gbs.example')).toBe('/auth?scope=did%3Aforest');
    mocks.rows = [{ landingService: 'events' }];
    expect(await domainLanding('gbs.example')).toBe('/events?scope=did%3Aforest');
    mocks.rows = [{ landingService: '../evil' }];
    expect(await domainLanding('gbs.example')).toBe('/auth?scope=did%3Aforest');
  });
});
