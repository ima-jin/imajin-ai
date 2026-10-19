import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ loadCredentials: vi.fn(), listActiveGrantOwners: vi.fn() }));
vi.mock('@/src/lib/kernel/connector-token-paste', () => ({
  createConnectorTokenPaste: () => mocks,
}));
import { loadMoonshotBillingCredentials, listBillingGrantOwners, MOONSHOT_BILLING_SCOPE } from '../connector';
import { connectorScopeDescriptors, requiresConsentRow } from '@/src/lib/kernel/scope-projections';

beforeEach(() => vi.resetAllMocks());

it('uses the existing sealed Moonshot credential with an independent explicit billing grant', async () => {
  mocks.loadCredentials.mockResolvedValue(undefined);
  expect(await loadMoonshotBillingCredentials('did:owner')).toBeUndefined();
  expect(mocks.loadCredentials).toHaveBeenCalledWith('did:owner', 'moonshot:billing');
  expect(MOONSHOT_BILLING_SCOPE).toBe('moonshot:billing');
});

it('enumerates only active billing-scope owners through the canonical connector factory', async () => {
  mocks.listActiveGrantOwners.mockResolvedValue(['did:owner']);
  expect(await listBillingGrantOwners()).toEqual(['did:owner']);
  expect(mocks.listActiveGrantOwners).toHaveBeenCalledWith('moonshot:billing');
});

it('projects billing into the connector manifest and requires owner consent', () => {
  expect(connectorScopeDescriptors('moonshot')).toHaveProperty('moonshot:billing');
  expect(requiresConsentRow('moonshot', 'moonshot:billing')).toBe(true);
});
