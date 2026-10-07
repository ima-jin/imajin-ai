import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;

const { state, mockPublish } = vi.hoisted(() => ({
  state: {
    identity: null as Row | null,
    grants: [] as Row[],
    identityUpdates: [] as Row[],
    grantInserts: [] as Row[],
    grantRevokes: 0,
  },
  mockPublish: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@imajin/bus', () => ({ publish: mockPublish }));
vi.mock('@/src/lib/kernel/id', () => {
  let n = 0;
  return { generateId: (prefix: string) => `${prefix}_${++n}` };
});
vi.mock('drizzle-orm', () => ({ and: (...a: unknown[]) => a, eq: (...a: unknown[]) => a }));

vi.mock('@/src/db', () => {
  const identities = { id: 'id', metadata: 'metadata' };
  const consentGrants = { id: 'id' };
  const whereResult = (table: unknown) => {
    const rows = table === identities ? (state.identity ? [state.identity] : []) : state.grants;
    return Object.assign(Promise.resolve(rows), { limit: (n: number) => Promise.resolve(rows.slice(0, n)) });
  };
  const db = {
    select: () => ({ from: (table: unknown) => ({ where: () => whereResult(table) }) }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => {
          if (table === identities) state.identityUpdates.push(values);
          else state.grantRevokes += 1;
          return Promise.resolve();
        },
      }),
    }),
    insert: () => ({
      values: (values: Row) => {
        state.grantInserts.push(values);
        return Promise.resolve();
      },
    }),
  };
  return { db, identities, consentGrants };
});

import {
  defaultFrontDoorConfig,
  deriveGateTopics,
  frontDoorTopicOptions,
  gateTierForIdentityTier,
  isGateOpen,
  isTierAdmitted,
  publishedTopicLabels,
  readFrontDoorConfig,
  resolveFrontDoorConfig,
  validateFrontDoorConfig,
  writeFrontDoorConfig,
  type FrontDoorConfig,
} from '../front-door';

const DID = 'did:imajin:operator';

function body(overrides: Record<string, unknown> = {}) {
  const config = defaultFrontDoorConfig();
  return { tiers: config.tiers, topics: config.topics, dailyCap: config.dailyCap, ...overrides };
}

function openConfig(): FrontDoorConfig {
  const config = defaultFrontDoorConfig();
  config.tiers.preliminary = true;
  config.topics.collaboration = { open: true, published: true, mode: 'deliver' };
  config.topics.speaking = { open: true, published: false, mode: 'decline' };
  return config;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPublish.mockResolvedValue(undefined);
  state.identity = { id: DID, metadata: { keep: 'me' } };
  state.grants = [];
  state.identityUpdates = [];
  state.grantInserts = [];
  state.grantRevokes = 0;
});

describe('defaults', () => {
  it('lists every contact_topic vocabulary term, closed and unpublished, deliver by default', () => {
    const config = defaultFrontDoorConfig();
    expect(Object.keys(config.topics)).toEqual(frontDoorTopicOptions().map((o) => o.term));
    for (const topic of Object.values(config.topics)) {
      expect(topic).toEqual({ open: false, published: false, mode: 'deliver' });
    }
    expect(isGateOpen(config)).toBe(false);
    expect(config.tiers.anonymous).toBe(false);
  });
});

describe('validateFrontDoorConfig', () => {
  it('accepts a complete body and normalizes topic aliases', () => {
    const result = validateFrontDoorConfig(
      body({ topics: { collab: { open: true, published: true, mode: 'deliver' } }, tiers: { preliminary: true } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.topics.collaboration).toEqual({ open: true, published: true, mode: 'deliver' });
      expect(result.config.topics.speaking.open).toBe(false);
      expect(result.config.tiers).toEqual({ anonymous: false, soft: false, preliminary: true, established: false });
    }
  });

  it('never advertises a closed topic', () => {
    const result = validateFrontDoorConfig(body({ topics: { speaking: { open: false, published: true, mode: 'deliver' } } }));
    expect(result.ok && result.config.topics.speaking.published).toBe(false);
  });

  it('accepts a null (uncapped) daily cap', () => {
    const result = validateFrontDoorConfig(body({ dailyCap: null }));
    expect(result.ok && result.config.dailyCap).toBeNull();
  });

  it.each([
    ['non-object body', 'nope', 'body must be an object'],
    ['array body', [], 'body must be an object'],
    ['missing tiers', body({ tiers: undefined }), 'tiers must be an object'],
    ['non-boolean tier', body({ tiers: { soft: 'yes' } }), 'tiers.soft must be a boolean'],
    ['unknown tier', body({ tiers: { royal: true } }), 'unknown tier: royal'],
    ['admitted anonymous tier', body({ tiers: { anonymous: true } }), 'the anonymous tier is reach_card only and cannot be admitted'],
    ['missing topics', body({ topics: undefined }), 'topics must be an object'],
    ['unknown topic', body({ topics: { gossip: { open: true, published: false, mode: 'deliver' } } }), 'unknown topic: gossip'],
    ['non-object topic', body({ topics: { speaking: true } }), 'topics.speaking must be an object'],
    ['non-boolean open', body({ topics: { speaking: { open: 1, published: false, mode: 'deliver' } } }), 'topics.speaking.open must be a boolean'],
    ['non-boolean published', body({ topics: { speaking: { open: true, published: 1, mode: 'deliver' } } }), 'topics.speaking.published must be a boolean'],
    ['bad mode', body({ topics: { speaking: { open: true, published: false, mode: 'raw' } } }), 'topics.speaking.mode must be one of: deliver, decline'],
    ['missing cap', body({ dailyCap: undefined }), 'dailyCap must be null or an integer between 1 and 1000'],
    ['zero cap', body({ dailyCap: 0 }), 'dailyCap must be null or an integer between 1 and 1000'],
    ['fractional cap', body({ dailyCap: 1.5 }), 'dailyCap must be null or an integer between 1 and 1000'],
    ['huge cap', body({ dailyCap: 1001 }), 'dailyCap must be null or an integer between 1 and 1000'],
  ])('rejects %s', (_name, input, error) => {
    expect(validateFrontDoorConfig(input)).toEqual({ ok: false, error });
  });
});

describe('derivations', () => {
  it('derives the raw gate value from open topics only, in vocabulary order', () => {
    expect(deriveGateTopics(openConfig())).toEqual(['collaboration', 'speaking']);
    expect(deriveGateTopics(defaultFrontDoorConfig())).toEqual([]);
  });

  it('is open when any of soft, preliminary or established is admitted', () => {
    const config = defaultFrontDoorConfig();
    config.tiers.established = true;
    expect(isGateOpen(config)).toBe(true);
  });

  it('publishes only labels of open + published topics', () => {
    const config = openConfig();
    expect(publishedTopicLabels({ agentReachGate: config })).toEqual(['Collaboration']);
  });

  it('publishes nothing when there is no stored config, or it is malformed', () => {
    expect(publishedTopicLabels(undefined)).toEqual([]);
    expect(publishedTopicLabels({ agentReachTopics: ['collaboration'] })).toEqual([]);
    expect(publishedTopicLabels({ agentReachGate: { tiers: 'x' } })).toEqual([]);
  });
});

describe('tier mapping (#2598)', () => {
  it.each([
    ['soft', 'soft'],
    ['preliminary', 'preliminary'],
    ['hard', 'preliminary'],
    ['established', 'established'],
    ['steward', 'established'],
    ['operator', 'established'],
  ])('maps identity tier %s to gate tier %s', (identityTier, gateTier) => {
    expect(gateTierForIdentityTier(identityTier)).toBe(gateTier);
  });

  it.each([['anonymous'], ['verified'], ['attested'], ['toString'], ['__proto__'], [''], [undefined], [null], [7]])(
    'maps %s to no gate tier (fail closed)',
    (identityTier) => {
      expect(gateTierForIdentityTier(identityTier)).toBeNull();
    },
  );

  it('admits per the stored gate and leaves a never-authored gate unrestricted', () => {
    const config = defaultFrontDoorConfig();
    config.tiers.preliminary = true;
    expect(isTierAdmitted({ agentReachGate: config }, 'preliminary')).toBe(true);
    expect(isTierAdmitted({ agentReachGate: config }, 'soft')).toBe(false);
    expect(isTierAdmitted({ agentReachGate: config }, 'steward')).toBe(false);
    expect(isTierAdmitted({ agentReachGate: { nope: true } }, 'preliminary')).toBe(false);
    expect(isTierAdmitted({ agentReachTopics: ['speaking'] }, 'soft')).toBe(true);
    expect(isTierAdmitted(null, 'soft')).toBe(true);
  });
});

describe('resolveFrontDoorConfig', () => {
  it('prefers the stored agentReachGate', () => {
    expect(resolveFrontDoorConfig({ agentReachGate: openConfig() }, false)).toEqual(openConfig());
  });

  it('seeds from legacy agentReachTopics: open, deliver, unpublished, tiers follow the grant', () => {
    const config = resolveFrontDoorConfig({ agentReachTopics: ['business', 'collaboration', 'bogus', 7] }, true);
    expect(config.topics.business_development).toEqual({ open: true, published: false, mode: 'deliver' });
    expect(config.topics.collaboration.open).toBe(true);
    expect(config.topics.speaking.open).toBe(false);
    expect(config.tiers).toEqual({ anonymous: false, soft: true, preliminary: true, established: true });
  });

  it('is fully closed for an identity with no gate at all', () => {
    expect(resolveFrontDoorConfig(null, false)).toEqual(defaultFrontDoorConfig());
  });
});

describe('readFrontDoorConfig', () => {
  it('returns null for an unknown principal', async () => {
    state.identity = null;
    expect(await readFrontDoorConfig(DID)).toBeNull();
  });

  it('reflects an existing active strangers grant on a legacy-seeded principal', async () => {
    state.identity = { id: DID, metadata: { agentReachTopics: ['speaking'] } };
    state.grants = [{ id: 'cgrant_old' }];
    const config = await readFrontDoorConfig(DID);
    expect(config?.topics.speaking.open).toBe(true);
    expect(config?.tiers.soft).toBe(true);
  });
});

describe('writeFrontDoorConfig', () => {
  it('returns false for an unknown principal and writes nothing', async () => {
    state.identity = null;
    expect(await writeFrontDoorConfig(DID, openConfig())).toBe(false);
    expect(state.identityUpdates).toHaveLength(0);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('writes metadata (preserving other keys), keeps agentReachTopics derived, and creates the grant', async () => {
    const config = openConfig();
    expect(await writeFrontDoorConfig(DID, config)).toBe(true);

    expect(state.identityUpdates).toEqual([
      { metadata: { keep: 'me', agentReachGate: config, agentReachTopics: ['collaboration', 'speaking'] } },
    ]);
    expect(state.grantRevokes).toBe(0);
    expect(state.grantInserts).toHaveLength(1);
    expect(state.grantInserts[0]).toMatchObject({
      subject: DID,
      grantedTo: null,
      grantedToClass: 'strangers',
      purpose: 'agent.reach',
      allowedFields: ['contact_topics'],
      mode: 'attestation',
      status: 'active',
    });
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'broker.consent.created',
      expect.objectContaining({ issuer: DID, subject: DID, scope: 'broker' }),
    );
  });

  it('replaces an existing active grant: revoke event then created event', async () => {
    state.grants = [{ id: 'cgrant_old' }];
    await writeFrontDoorConfig(DID, openConfig());

    expect(state.grantRevokes).toBe(1);
    expect(state.grantInserts).toHaveLength(1);
    expect(mockPublish.mock.calls.map((c) => c[0])).toEqual(['broker.consent.revoked', 'broker.consent.created']);
    expect(mockPublish.mock.calls[0][1].payload.consentId).toBe('cgrant_old');
  });

  it('closes the door when no non-anonymous tier is admitted: revokes and does not re-create', async () => {
    state.grants = [{ id: 'cgrant_old' }];
    await writeFrontDoorConfig(DID, defaultFrontDoorConfig());

    expect(state.grantRevokes).toBe(1);
    expect(state.grantInserts).toHaveLength(0);
    expect(mockPublish.mock.calls.map((c) => c[0])).toEqual(['broker.consent.revoked']);
    expect((state.identityUpdates[0].metadata as Row).agentReachTopics).toEqual([]);
  });

  it('tolerates a null metadata blob and a failing bus publish', async () => {
    state.identity = { id: DID, metadata: null };
    mockPublish.mockRejectedValue(new Error('bus down'));
    expect(await writeFrontDoorConfig(DID, openConfig())).toBe(true);
    expect(state.grantInserts).toHaveLength(1);
  });
});
