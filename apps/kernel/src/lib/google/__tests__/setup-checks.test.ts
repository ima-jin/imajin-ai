import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_SETUP_STEPS } from '../setup-content';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), status: vi.fn(), sites: vi.fn(), enabled: vi.fn(),
}));
vi.mock('../setup', () => ({ readGoogleSetup: mocks.read }));
vi.mock('../features', () => ({ isBusinessProfileEnabled: mocks.enabled }));
vi.mock('../search-console', () => ({ listSites: mocks.sites }));
vi.mock('@/src/lib/vault', () => ({ vaultFieldStatus: mocks.status }));
vi.mock('../connector', () => ({
  configField: (did: string, slot: string) => `google-config:${did}:${slot}`,
  oauthVaultField: (did: string, slot: string) => `google-oauth:${did}:${slot}`,
}));

import { checkSearchConsoleSetup, readGoogleSetupView } from '../setup-checks';
import { currentConnectionSlot } from '@/src/lib/kernel/connector-connection-context';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ version: 1, steps: Object.fromEntries(GOOGLE_SETUP_STEPS.map(({ id }) => [id, { status: 'not_started', updatedAt: null, pendingSince: null }])) });
  mocks.status.mockResolvedValue('ready');
  mocks.sites.mockResolvedValue({ sites: [] });
  mocks.enabled.mockReturnValue(false);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('setup capability checks', () => {
  it('reports actual slot-specific vault readiness separately from admin approval', async () => {
    mocks.status.mockResolvedValueOnce('pending-grant').mockResolvedValueOnce('missing');
    const view = await readGoogleSetupView('did:imajin:org', 'work');
    expect(view).toMatchObject({ slot: 'work', configSealed: false, tokenSealed: false, credentialPending: true, businessProfileAvailable: false });
    expect(mocks.status).toHaveBeenCalledWith('google-config:did:imajin:org:work');
    expect(mocks.status).toHaveBeenCalledWith('google-oauth:did:imajin:org:work');
  });

  it('requires both operator enablement and per-slot approval', async () => {
    const state = await mocks.read();
    state.steps['business-access'].status = 'approved';
    expect((await readGoogleSetupView('owner', 'work')).businessProfileAvailable).toBe(false);
    mocks.enabled.mockReturnValue(true);
    expect((await readGoogleSetupView('owner', 'work')).businessProfileAvailable).toBe(true);
    state.steps['business-access'].status = 'pending_google';
    expect((await readGoogleSetupView('owner', 'work')).businessProfileAvailable).toBe(false);
  });

  it('tests Search Console independently of Business approval or deployment flag', async () => {
    mocks.sites.mockImplementation(async (did: string) => {
      expect(currentConnectionSlot('google', did)).toBe('work');
      return { sites: [] };
    });
    const result = await checkSearchConsoleSetup('did:imajin:org', 'work');
    expect(result.status).toBe('passed');
    expect(result.message).toContain('not OAuth verification or Business Profile approval');
    expect(mocks.sites).toHaveBeenCalledWith('did:imajin:org');
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.enabled).not.toHaveBeenCalled();
  });

  it('never echoes provider error bodies or credential exceptions', async () => {
    mocks.sites.mockRejectedValueOnce(new Error('sensitive provider content'));
    expect(await checkSearchConsoleSetup('owner', 'work')).toMatchObject({ status: 'failed' });
    mocks.sites.mockRejectedValueOnce(new Error('sensitive credential content'));
    const result = await checkSearchConsoleSetup('owner', 'work');
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });
});
