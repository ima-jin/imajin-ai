import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Revoke-on-delete / reconcile (#1208) ───────────────────────────────────
//
// Sibling of projection-reactor.test.ts. Where that suite exercises the REAL
// broker latch to prove GATING, this suite proves the RECONCILE/REVOKE half:
// removing a field (data line deleted or newly `never`-gated) de-materializes
// it from metadata.article AND fires the surface's downstream revocation, and
// re-adding it re-grants. We use `silent` / `never` tiers so no broker call is
// needed — the reconcile decision is deterministic — and mock @imajin/bus so we
// can spy on publish() (the revoke seam) without running the real chain.

const mockLimit = vi.fn();
const mockSelectWhere = vi.fn(() => ({ limit: mockLimit }));
const mockSelectFrom = vi.fn(() => ({ where: mockSelectWhere }));
const mockUpdateWhere = vi.fn().mockResolvedValue(undefined);
const mockSet = vi.fn(() => ({ where: mockUpdateWhere }));

vi.mock('@/src/db', () => ({
  db: {
    select: vi.fn(() => ({ from: mockSelectFrom })),
    update: vi.fn(() => ({ set: mockSet })),
  },
  assets: { id: 'assets.id', metadata: 'assets.metadata' },
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));

vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() })),
}));

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));

// Bus surface: spy on publish (the revoke seam). broker is not exercised here
// (silent/never tiers don't call it); registerReactor is a no-op. `mockPublish`
// is created via vi.hoisted so it exists before the hoisted vi.mock factory runs.
const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn(() => Promise.resolve()) }));
vi.mock('@imajin/bus', () => ({
  publish: mockPublish,
  broker: vi.fn(() => Promise.resolve({ status: 'rejected', reason: 'no_consent' })),
  registerReactor: vi.fn(),
  isBrokerRelease: (r: { status?: string } | null | undefined) => r?.status === 'released',
}));

import { readFile } from 'node:fs/promises';
import { projectReactor } from '../projection-reactor';
import type { BusEvent } from '@imajin/bus';

const ASSET_ID = 'asset_doc';

function makeEvent(): BusEvent {
  return {
    type: 'document.changed',
    issuer: 'did:imajin:owner',
    subject: ASSET_ID,
    scope: 'media',
    payload: { path: '/mnt/media/owner/assets/asset_doc.md', cid: 'cid-new', prevCid: 'cid-old' },
    timestamp: new Date().toISOString(),
  };
}

/** The `article` object written by the (single) db.update in this run. */
function writtenArticle(): Record<string, unknown> {
  expect(mockSet).toHaveBeenCalledTimes(1);
  const call = mockSet.mock.calls[0] as unknown as unknown[];
  const setArg = call[0] as { metadata: { article: Record<string, unknown> } };
  return setArg.metadata.article;
}

// tagline was previously projected (present in metadata.article).
const PRIOR_METADATA = { article: { slug: 'existing', title: 'Existing', tagline: 'Hello' } };

beforeEach(() => {
  vi.clearAllMocks();
  mockLimit.mockResolvedValue([{ metadata: PRIOR_METADATA }]);
});

describe('projectReactor — revoke-on-delete / reconcile (#1208)', () => {
  it('de-materializes a field that becomes `never`-gated and fires the revoke event', async () => {
    // tagline is still declared but now sealed `never` → reconciled OUT.
    vi.mocked(readFile).mockResolvedValue(
      ['---', 'tagline: "Hello"', 'release:', '  tagline:', '    release: never', '---', 'body'].join('\n') as never,
    );

    await projectReactor(makeEvent(), {});

    const article = writtenArticle();
    expect(article).not.toHaveProperty('tagline');
    // Sibling (un-managed) keys are preserved.
    expect(article).toMatchObject({ slug: 'existing', title: 'Existing' });

    // Surface-owned revocation fired via the existing broker.consent.revoked seam.
    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [type, envelope] = mockPublish.mock.calls[0] as unknown as [string, { payload: Record<string, unknown> }];
    expect(type).toBe('broker.consent.revoked');
    expect(envelope.payload).toMatchObject({ consentId: `${ASSET_ID}:tagline`, context_id: ASSET_ID, context_type: 'consent' });
  });

  it('de-materializes a field whose data line was deleted (value absent)', async () => {
    // tagline declared in the release block but its data line is gone.
    vi.mocked(readFile).mockResolvedValue(
      ['---', 'release:', '  tagline:', '    discloses_others: false', '    sensitive: false', '---', 'body'].join('\n') as never,
    );

    await projectReactor(makeEvent(), {});

    expect(writtenArticle()).not.toHaveProperty('tagline');
    expect(mockPublish).toHaveBeenCalledWith('broker.consent.revoked', expect.objectContaining({
      payload: expect.objectContaining({ consentId: `${ASSET_ID}:tagline` }),
    }));
  });

  it('re-adding a removed field re-grants (materializes) it without revoking', async () => {
    // tagline currently absent from the projection, re-declared silent → lands.
    mockLimit.mockResolvedValue([{ metadata: { article: { slug: 'existing' } } }]);
    vi.mocked(readFile).mockResolvedValue(
      ['---', 'tagline: "Hello again"', 'release:', '  tagline:', '    discloses_others: false', '    sensitive: false', '---', 'body'].join('\n') as never,
    );

    await projectReactor(makeEvent(), {});

    expect(writtenArticle()).toHaveProperty('tagline', 'Hello again');
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('does not write or revoke a gated field that was never projected here', async () => {
    // secret is gated but was never materialized → remove() is a full no-op.
    mockLimit.mockResolvedValue([{ metadata: { article: { slug: 'existing' } } }]);
    vi.mocked(readFile).mockResolvedValue(
      ['---', 'secret: "do not leak"', 'release:', '  secret:', '    release: never', '---', 'body'].join('\n') as never,
    );

    await projectReactor(makeEvent(), {});

    expect(mockSet).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
