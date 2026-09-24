/**
 * The projection reactor must forward the acting delegate to the broker (#2366).
 *
 * `document.changed` carries `payload.appDid` — the `azp` of the app that drove
 * the edit (e.g. an MCP/OAuth client publishing a scope-manifest via #1804's
 * `projectConsentedScopes`). The reactor puts it on every `BrokerRequest` it
 * makes so the consent gate's owner alert can name that delegate instead of
 * rendering the owner as their own requester.
 *
 * Only the broker is stubbed here (the latch itself is covered by
 * projection-reactor.test.ts); these tests assert the request shape that
 * reaches it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockBroker } = vi.hoisted(() => ({
  mockBroker: vi.fn(),
}));

vi.mock('@imajin/bus', () => ({
  broker: mockBroker,
  publish: vi.fn().mockResolvedValue(undefined),
  registerReactor: vi.fn(),
  isBrokerRelease: (r: { status: string }) => r.status === 'released',
}));

// Drizzle double, written as flat named steps rather than a nested arrow
// chain — the projection write itself is not what these tests assert.
const { selectChain, updateChain } = vi.hoisted(() => {
  const limit = () => Promise.resolve([{ metadata: {} }]);
  const where = () => ({ limit });
  const from = () => ({ where });
  const updateWhere = () => Promise.resolve(undefined);
  const set = () => ({ where: updateWhere });
  return { selectChain: () => ({ from }), updateChain: () => ({ set }) };
});

vi.mock('@/src/db', () => ({
  db: { select: selectChain, update: updateChain },
  assets: { id: 'assets.id', metadata: 'assets.metadata' },
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

import { readFile } from 'node:fs/promises';
import { projectReactor } from '../projection-reactor';
import type { BusEvent } from '@imajin/bus';

const OWNER = 'did:imajin:88kPzzzzzzzzzzzzzzzzzzzzzzzzzzzzNWXU';
const ACTING_APP = 'did:imajin:ADEKzzzzzzzzzzzzzzzzzzzzzzzzzzzzn54k';

/** One on-consent field, so exactly one broker call is made. */
const MANIFEST = `---
"moonshot:infer": "gated"
release:
  "moonshot:infer":
    discloses_others: true
    sensitive: false
---
Body.
`;

function makeEvent(payload: Record<string, unknown>): BusEvent {
  return {
    type: 'document.changed',
    issuer: OWNER,
    subject: 'asset_manifest',
    scope: 'media',
    payload: { path: '/mnt/media/owner/assets/asset_manifest.md', cid: 'cid-new', prevCid: null, ...payload },
    timestamp: new Date().toISOString(),
  };
}

/** The single `BrokerRequest` the reactor handed the broker. */
function brokerRequest(): Record<string, unknown> {
  expect(mockBroker).toHaveBeenCalledTimes(1);
  const [, request] = mockBroker.mock.calls[0] as [string, Record<string, unknown>];
  return request;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockBroker.mockResolvedValue({ status: 'rejected', reason: 'no_consent' });
  vi.mocked(readFile).mockResolvedValue(MANIFEST as never);
});

describe('projectReactor — acting delegate propagation (#2366)', () => {
  it('forwards payload.appDid onto the broker request', async () => {
    await projectReactor(makeEvent({ appDid: ACTING_APP }), {});
    expect(brokerRequest()).toMatchObject({
      requester: OWNER,
      subject: OWNER,
      appDid: ACTING_APP,
      purpose: 'document.projection',
    });
  });

  it('omits appDid entirely for a first-party edit', async () => {
    await projectReactor(makeEvent({}), {});
    const request = brokerRequest();
    expect(request).toMatchObject({ requester: OWNER, subject: OWNER });
    expect(Object.keys(request)).not.toContain('appDid');
  });

  it('keeps the delegate out of the consent decision itself', async () => {
    await projectReactor(makeEvent({ appDid: ACTING_APP }), {});
    // requester/subject — the pair the consent lookup is keyed on — are
    // untouched by the attribution field.
    expect(brokerRequest()).toMatchObject({ requester: OWNER, subject: OWNER });
  });
});
