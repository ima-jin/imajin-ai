import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getEffectiveDid: vi.fn(),
  limit: vi.fn(),
  resolveNavAppsForIdentity: vi.fn(),
}));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.limit }) }) }) },
  identities: { id: 'id' },
  identityMembers: {},
  forestConfig: {},
}));
vi.mock('../lib/get-effective-did', () => ({ getEffectiveDid: mocks.getEffectiveDid }));
vi.mock('@imajin/config', () => ({ buildPublicUrl: (slug: string) => `/${slug}` }));
vi.mock('@/src/lib/kernel/app-nav', () => ({
  resolveNavAppsForIdentity: mocks.resolveNavAppsForIdentity,
  filterByPlacement: (apps: unknown[]) => apps,
}));
vi.mock('../components/IdentitySwitcher', () => ({ default: () => null }));
vi.mock('../components/IdentityDetail', () => ({ default: () => null }));
vi.mock('../components/PlacesMaintained', () => ({ default: () => null }));
vi.mock('../components/IdentityTabBar', () => ({ default: () => null }));
vi.mock('../components/AuthLayoutShell', () => ({ default: () => null }));
import AuthLayout from '../layout';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveNavAppsForIdentity.mockResolvedValue([]);
});

describe('identity management layout', () => {
  it.each(['actor', 'group'])('does not pass hardcoded kernel service tabs for %s identities', async (scope) => {
    const did = `did:imajin:${scope}`;
    mocks.getEffectiveDid.mockResolvedValue({ sessionDid: 'did:imajin:actor', effectiveDid: did });
    mocks.limit
      .mockResolvedValueOnce([{ name: 'Actor' }])
      .mockResolvedValueOnce([{ scope }]);
    if (scope === 'group') {
      mocks.limit
        .mockResolvedValueOnce([{ enabledServices: ['pay', 'media'], landingService: 'pay' }])
        .mockResolvedValueOnce([{ role: 'admin' }]);
    }
    const layout = await AuthLayout({ children: 'Profile' }) as React.ReactElement;
    expect(layout.props.tabBar.props).not.toHaveProperty('showPay');
    expect(layout.props.tabBar.props).not.toHaveProperty('showMedia');
    expect(layout.props.tabBar.props.showMembers).toBe(scope === 'group');
    expect(layout.props.landingService).toBe(scope === 'group' ? 'pay' : null);
    expect(mocks.resolveNavAppsForIdentity).toHaveBeenCalledWith(did);
  });

  it('leaves unauthenticated routes outside the identity shell', async () => {
    mocks.getEffectiveDid.mockResolvedValue({ sessionDid: null, effectiveDid: null });
    const layout = await AuthLayout({ children: 'Login' });
    expect(layout).toBe('Login');
    expect(mocks.limit).not.toHaveBeenCalled();
  });
});
