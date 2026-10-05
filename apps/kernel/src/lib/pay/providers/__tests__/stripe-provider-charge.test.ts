/**
 * #2563 — StripeProvider.charge: recipient resolution is now synchronous,
 * but errors must still surface as a rejected charge() promise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ createMock: vi.fn() }));

vi.mock('../stripe-client', () => ({
  getStripeClient: () => ({ paymentIntents: { create: state.createMock } }),
}));

import { StripeProvider } from '../stripe';
import type { ChargeRequest } from '../../types';

const provider = () => new StripeProvider({} as ConstructorParameters<typeof StripeProvider>[0]);

const intent = { id: 'pi_1', status: 'succeeded', amount: 500, created: 1_700_000_000, metadata: {}, client_secret: 'cs' };

describe('StripeProvider.charge recipient resolution', () => {
  beforeEach(() => state.createMock.mockReset().mockResolvedValue(intent));

  it('rejects (not throws) for a DID recipient', async () => {
    let returned: Promise<unknown> | undefined;
    expect(() => {
      returned = provider().charge({ amount: 500, currency: 'USD', to: { did: 'did:imajin:x' } } as ChargeRequest);
    }).not.toThrow();
    await expect(returned).rejects.toThrow('DID resolution not yet implemented');
    expect(state.createMock).not.toHaveBeenCalled();
  });

  it('passes a customer id through', async () => {
    const result = await provider().charge({
      amount: 500,
      currency: 'USD',
      to: { stripeCustomerId: 'cus_1' },
    } as ChargeRequest);
    expect(state.createMock.mock.calls[0][0]).toMatchObject({ customer: 'cus_1' });
    expect(result).toMatchObject({ id: 'pi_1', status: 'succeeded', clientSecret: 'cs' });
  });

  it('routes to a connected account', async () => {
    await provider().charge({ amount: 500, currency: 'USD', to: { stripeAccountId: 'acct_1' } } as ChargeRequest);
    expect(state.createMock.mock.calls[0][0]).toMatchObject({ transfer_data: { destination: 'acct_1' } });
  });

  it('charges with no recipient routing for an empty recipient', async () => {
    await provider().charge({ amount: 500, currency: 'USD', to: {} } as unknown as ChargeRequest);
    const params = state.createMock.mock.calls[0][0];
    expect(params.customer).toBeUndefined();
    expect(params.transfer_data).toBeUndefined();
  });
});
