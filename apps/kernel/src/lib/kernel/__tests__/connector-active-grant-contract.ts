import { describe, it, expect } from 'vitest';

/** Minimal shape of the `whereMock` every connector test wires to `channelLinks.select().from().where()`. */
export interface ActiveGrantWhereMock {
  mockResolvedValue(value: unknown): unknown;
}

export interface ActiveGrantContractOpts {
  /** Connector label used in the describe block titles, e.g. `'google'`. */
  connectorLabel: string;
  owner: string;
  scope: string;
  otherScope: string;
  whereMock: ActiveGrantWhereMock;
  resolveActiveGrant: (did: string, scope: string) => Promise<boolean>;
  listActiveGrantOwners: (scope: string) => Promise<string[]>;
}

/**
 * Shared contract for `resolveActiveGrant` / `listActiveGrantOwners` (#2144
 * dedup) — both come straight from the generic `createConnectorOAuth`
 * factory, so every connector's own test file used to hand-copy the same
 * four cases against `channelLinks` with only the scope string literals
 * differing. Declaring them once here is what keeps a new OAuth connector's
 * test a same-shape call instead of another ~25-line near-identical clone.
 */
export function describeActiveGrantContract(opts: ActiveGrantContractOpts): void {
  const { connectorLabel, owner, scope, otherScope, whereMock, resolveActiveGrant, listActiveGrantOwners } = opts;

  describe(`${connectorLabel} resolveActiveGrant / listActiveGrantOwners (shared createConnectorOAuth contract)`, () => {
    it('resolveActiveGrant is true when an active row includes the scope', async () => {
      whereMock.mockResolvedValue([{ scopes: [scope] }]);
      expect(await resolveActiveGrant(owner, scope)).toBe(true);
    });

    it('resolveActiveGrant is false when no active row includes the scope', async () => {
      whereMock.mockResolvedValue([{ scopes: [otherScope] }]);
      expect(await resolveActiveGrant(owner, scope)).toBe(false);
    });

    it('listActiveGrantOwners returns distinct owner DIDs whose active row includes the scope', async () => {
      whereMock.mockResolvedValue([
        { did: owner, scopes: [scope] },
        { did: 'did:imajin:other', scopes: [otherScope] },
        { did: owner, scopes: [scope] },
      ]);
      expect(await listActiveGrantOwners(scope)).toEqual([owner]);
    });

    it('listActiveGrantOwners returns an empty list when no active rows include the scope', async () => {
      whereMock.mockResolvedValue([{ did: owner, scopes: [otherScope] }]);
      expect(await listActiveGrantOwners(scope)).toEqual([]);
    });
  });
}
