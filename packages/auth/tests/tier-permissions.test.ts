/**
 * Core invariant tests for tier permissions (#325).
 *
 * The expected matrix below is deliberately written out by hand rather than
 * derived from `requiredTier()`: if someone loosens a permission (e.g. lets a
 * `soft` identity `create_event`), this table fails instead of silently
 * agreeing with the new code.
 *
 *   soft         — session-only, no keypair
 *   preliminary  — keypair registered, not yet established
 *   established  — fully onboarded
 *   steward / operator — superset of established
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({ requireAuthMock: vi.fn() }));
vi.mock('../src/require-auth', () => ({ requireAuth: mocks.requireAuthMock }));

import { canDo, hasTier, requiredTier } from '../src/permissions';
import type { Action, Tier } from '../src/permissions';
import { requireEstablishedDID } from '../src/require-established-did';
import type { AuthError, AuthResult } from '../src/types';

type CallerTier = 'soft' | 'preliminary' | 'established' | 'steward' | 'operator';

const TIERS: readonly CallerTier[] = ['soft', 'preliminary', 'established', 'steward', 'operator'];
const CONNECTIONS_URL = 'https://connections.test';
const DID = 'did:imajin:caller';

// Actions that need only a tier — no trust-graph lookup. Value = lowest tier allowed.
const TIER_ONLY: ReadonlyArray<[Action, CallerTier]> = [
  ['buy_ticket', 'soft'],
  ['view_tickets', 'soft'],
  ['event_lobby_chat', 'soft'],
  ['edit_profile', 'preliminary'],
  ['create_event', 'established'],
  ['send_invite', 'established'],
];

// Actions that need an established tier AND membership in the trust graph.
const GRAPH_GATED: readonly Action[] = ['dm', 'pod_chat', 'create_pod', 'connections'];

function allows(lowest: CallerTier, tier: CallerTier): boolean {
  return TIERS.indexOf(tier) >= TIERS.indexOf(lowest);
}

// ─── canDo: tier-only actions ───────────────────────────────────────────────

describe('canDo — tier-only actions (tier × action matrix)', () => {
  const rows = TIER_ONLY.flatMap(([action, lowest]) =>
    TIERS.map((tier) => ({ action, tier, expected: allows(lowest, tier) })),
  );

  it.each(rows)('$tier → $action: $expected', async ({ action, tier, expected }) => {
    expect(await canDo(DID, action, tier)).toBe(expected);
  });

  it('spells out the matrix explicitly for the soft / preliminary / established boundary', async () => {
    const expected: Record<string, [boolean, boolean, boolean]> = {
      // action: [soft, preliminary, established]
      buy_ticket: [true, true, true],
      view_tickets: [true, true, true],
      event_lobby_chat: [true, true, true],
      edit_profile: [false, true, true],
      create_event: [false, false, true],
      send_invite: [false, false, true],
    };

    for (const [action, [soft, preliminary, established]] of Object.entries(expected)) {
      expect(await canDo(DID, action as Action, 'soft'), `soft ${action}`).toBe(soft);
      expect(await canDo(DID, action as Action, 'preliminary'), `preliminary ${action}`).toBe(preliminary);
      expect(await canDo(DID, action as Action, 'established'), `established ${action}`).toBe(established);
    }
  });

  it('never consults the connections service for a tier-only action', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await canDo(DID, 'create_event', 'established', CONNECTIONS_URL);

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

// ─── canDo: graph-gated actions ─────────────────────────────────────────────

describe('canDo — graph-gated actions (tier AND trust-graph membership)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  function graphResponds(inGraph: boolean) {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ inGraph }), { status: 200 }));
  }

  const rows = GRAPH_GATED.flatMap((action) =>
    TIERS.map((tier) => ({ action, tier, expected: allows('established', tier) })),
  );

  it.each(rows)('$tier → $action when IN the graph: $expected', async ({ action, tier, expected }) => {
    graphResponds(true);

    expect(await canDo(DID, action, tier, CONNECTIONS_URL)).toBe(expected);
  });

  it.each(rows)('$tier → $action when NOT in the graph: always false', async ({ action, tier }) => {
    graphResponds(false);

    expect(await canDo(DID, action, tier, CONNECTIONS_URL)).toBe(false);
  });

  it('rejects soft and preliminary callers without ever asking the connections service', async () => {
    graphResponds(true);

    expect(await canDo(DID, 'dm', 'soft', CONNECTIONS_URL)).toBe(false);
    expect(await canDo(DID, 'dm', 'preliminary', CONNECTIONS_URL)).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('looks the caller up by URL-encoded DID', async () => {
    graphResponds(true);

    await canDo('did:imajin:a b/c', 'dm', 'established', CONNECTIONS_URL);

    expect(fetchSpy).toHaveBeenCalledWith(`${CONNECTIONS_URL}/api/connections/status/did%3Aimajin%3Aa%20b%2Fc`);
  });

  it('fails closed when the connections service errors', async () => {
    fetchSpy.mockResolvedValue(new Response('boom', { status: 500 }));

    expect(await canDo(DID, 'dm', 'established', CONNECTIONS_URL)).toBe(false);
  });

  it('fails closed when the connections service is unreachable', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));

    expect(await canDo(DID, 'dm', 'operator', CONNECTIONS_URL)).toBe(false);
  });

  it('fails closed when inGraph is anything other than literally true', async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ inGraph: 'yes' }), { status: 200 }));

    expect(await canDo(DID, 'dm', 'established', CONNECTIONS_URL)).toBe(false);
  });

  it('throws (rather than silently allowing) when an eligible caller has no connectionsServiceUrl', async () => {
    await expect(canDo(DID, 'dm', 'established')).rejects.toThrow(/connectionsServiceUrl is required/);
  });
});

// ─── requiredTier / hasTier consistency ─────────────────────────────────────

describe('requiredTier ↔ hasTier agree with the hand-written matrix', () => {
  it.each(TIER_ONLY)('%s requires %s', (action, lowest) => {
    expect(requiredTier(action)).toBe(lowest);
    for (const tier of TIERS) {
      expect(hasTier(tier, requiredTier(action)), `${tier} / ${action}`).toBe(allows(lowest, tier));
    }
  });

  it.each(GRAPH_GATED)('%s is gated on established+graph, and hasTier checks the tier half only', (action) => {
    const required: Tier = requiredTier(action);

    expect(required).toBe('established+graph');
    expect(hasTier('preliminary', required)).toBe(false);
    expect(hasTier('established', required)).toBe(true);
  });

  it('is strictly ordered: none < soft < preliminary < established < steward < operator', () => {
    const ordered = ['none', 'soft', 'preliminary', 'established', 'steward', 'operator'] as const;

    ordered.forEach((have, haveIdx) => {
      ordered.forEach((need, needIdx) => {
        expect(hasTier(have, need), `${have} vs ${need}`).toBe(haveIdx >= needIdx);
      });
    });
  });
});

// ─── requireEstablishedDID ──────────────────────────────────────────────────

describe('requireEstablishedDID', () => {
  const request = new Request('https://kernel.test/api/anything');

  function identityOf(tier: CallerTier): AuthResult {
    return { identity: { id: DID, scope: 'actor', tier } };
  }

  beforeEach(() => {
    mocks.requireAuthMock.mockReset();
  });

  it.each(['soft', 'preliminary'] as const)('rejects a %s identity with 403', async (tier) => {
    mocks.requireAuthMock.mockResolvedValue(identityOf(tier));

    const result = await requireEstablishedDID(request);

    expect(result).toEqual({ error: 'This action requires an established identity', status: 403 });
  });

  it.each(['established', 'steward', 'operator'] as const)('admits a %s identity unchanged', async (tier) => {
    const auth = identityOf(tier);
    mocks.requireAuthMock.mockResolvedValue(auth);

    const result = await requireEstablishedDID(request);

    expect(result).toBe(auth);
  });

  it('passes an authentication failure straight through without reinterpreting it', async () => {
    const failure: AuthError = { error: 'Not authenticated', status: 401 };
    mocks.requireAuthMock.mockResolvedValue(failure);

    const result = await requireEstablishedDID(request);

    expect(result).toBe(failure);
  });

  it('authenticates the same request it was handed', async () => {
    mocks.requireAuthMock.mockResolvedValue(identityOf('established'));

    await requireEstablishedDID(request);

    expect(mocks.requireAuthMock).toHaveBeenCalledWith(request);
  });
});
