/**
 * Unit tests for `resolveWithdrawDestination` (#2190).
 *
 * Exercises every branch of the ownership contract against a minimal fake
 * Drizzle executor (same convention as `ledger.test.ts`): owned account
 * passes, foreign account is refused, an omitted `account_id` falls back to
 * the DID's connected account, and no connected account at all is a
 * distinct (never-500) error from a foreign `account_id`.
 */
import { describe, it, expect, vi } from 'vitest';

function makeExecutor(rows: Array<{ did: string; stripeAccountId: string }>) {
  const limit = (_n: number) => Promise.resolve(rows);
  const where = () => ({ limit });
  const from = () => ({ where });
  return { select: () => ({ from }) };
}

const state = vi.hoisted(() => ({ rows: [] as Array<{ did: string; stripeAccountId: string }> }));

vi.mock('@/src/db', async () => {
  const { connectedAccounts } = await import('@/src/db/schemas/pay');
  return {
    get db() {
      return makeExecutor(state.rows);
    },
    connectedAccounts,
  };
});

import { resolveWithdrawDestination } from '../withdraw-destination';

const DID = 'did:imajin:owner';

function setConnectedAccount(row?: { did: string; stripeAccountId: string }) {
  state.rows = row ? [row] : [];
}

describe('resolveWithdrawDestination', () => {
  it('resolves the DID\'s own connected account when account_id is omitted (default mode)', async () => {
    setConnectedAccount({ did: DID, stripeAccountId: 'acct_owned' });

    const result = await resolveWithdrawDestination(DID, undefined);

    expect(result).toEqual({ ok: true, destination: 'acct_owned', resolutionMode: 'default' });
  });

  it('fails with no_connected_account (never a 500-worthy throw) when account_id is omitted and the DID has no connected account', async () => {
    setConnectedAccount(undefined);

    const result = await resolveWithdrawDestination(DID, undefined);

    expect(result).toEqual({ ok: false, error: 'no_connected_account' });
  });

  it('resolves account_id when it matches the DID\'s own connected account (selected mode)', async () => {
    setConnectedAccount({ did: DID, stripeAccountId: 'acct_owned' });

    const result = await resolveWithdrawDestination(DID, 'acct_owned');

    expect(result).toEqual({ ok: true, destination: 'acct_owned', resolutionMode: 'selected' });
  });

  it('fails closed with forbidden_destination when account_id does not match the DID\'s own connected account — never falls back to the supplied value', async () => {
    setConnectedAccount({ did: DID, stripeAccountId: 'acct_owned' });

    const result = await resolveWithdrawDestination(DID, 'acct_foreign');

    expect(result).toEqual({ ok: false, error: 'forbidden_destination' });
  });

  it('fails closed with forbidden_destination when account_id is supplied but the DID has no connected account at all', async () => {
    setConnectedAccount(undefined);

    const result = await resolveWithdrawDestination(DID, 'acct_foreign');

    expect(result).toEqual({ ok: false, error: 'forbidden_destination' });
  });

  it('only ever resolves against the given did — a delegate\'s own connected account is irrelevant (delegation is the caller\'s responsibility via resolveActingDid)', async () => {
    setConnectedAccount({ did: 'did:imajin:principal', stripeAccountId: 'acct_principal' });

    const result = await resolveWithdrawDestination('did:imajin:principal', undefined);

    expect(result).toEqual({ ok: true, destination: 'acct_principal', resolutionMode: 'default' });
  });
});
