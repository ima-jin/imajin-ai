import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// The reactor is exercised with the REAL broker() latch (packages/bus) — this
// is a broker-backed test, modelled on packages/bus/tests/broker.test.ts. We
// only stub the I/O edges:
//   - node:fs/promises.readFile → the authored document bytes
//   - @/src/db → the drizzle projection write (article metadata home)
//   - @imajin/db → the raw SQL client the broker reactors reach through:
//       * bus_chain_configs SELECT → [] so broker() uses its default chain
//       * consent_grants  SELECT → a single grant that consents ONLY to `tagline`
//       * broker_audit_log INSERT → recorded, proving audit rows are written

const hoisted = vi.hoisted(() => {
  const auditInserts: unknown[][] = [];
  return { auditInserts };
});

// Drizzle projection write — capture what materializes into metadata.article.
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

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

// Raw SQL client used by the broker's consent/config/audit reactors.
vi.mock('@imajin/db', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join(' ');
    if (q.includes('broker_audit_log')) {
      hoisted.auditInserts.push(values);
      return Promise.resolve([]);
    }
    if (q.includes('bus_chain_configs')) {
      return Promise.resolve([]); // no DB chain row → broker uses its default chain
    }
    if (q.includes('consent_grants')) {
      // Path 2 (reach-ring class grants): none.
      if (q.includes('granted_to_class')) return Promise.resolve([]);
      // Path 1 (per-DID grants): consent to `tagline` ONLY.
      return Promise.resolve([
        {
          allowed_fields: ['tagline'],
          mode: 'attestation',
          consent_ref: 'consent-doc-tagline',
          granted_to: 'did:imajin:viewer',
          purpose: 'document.projection',
        },
      ]);
    }
    return Promise.resolve([]);
  };
  return { getClient: () => sql };
});

import { readFile } from 'node:fs/promises';
import { projectReactor } from '../projection-reactor';
import type { BusEvent } from '@imajin/bus';

// ─── Helpers ───────────────────────────────────────────────────────────────

// Mixed-tier authored document:
//   tagline  → on-consent (discloses_others), broker CONSENTS   → lands
//   homepage → silent (self, not sensitive)                     → lands
//   secret   → release: never                                   → absent
//   email    → on-consent (discloses_others), NOT consented     → absent
const DOC = `---
tagline: "Hello from the owner"
homepage: "https://example.com"
secret: "do not leak"
email: "owner@example.com"
release:
  tagline:
    discloses_others: true
    sensitive: false
  homepage:
    discloses_others: false
    sensitive: false
  secret:
    release: never
  email:
    discloses_others: true
    sensitive: false
---
Body content.
`;

function makeEvent(): BusEvent {
  return {
    type: 'document.changed',
    issuer: 'did:imajin:owner',
    subject: 'asset_doc',
    scope: 'media',
    payload: { path: '/mnt/media/owner/assets/asset_doc.md', cid: 'cid-new', prevCid: 'cid-old' },
    timestamp: new Date().toISOString(),
  };
}

function projectedArticle(): Record<string, unknown> {
  expect(mockSet).toHaveBeenCalledTimes(1);
  const call = mockSet.mock.calls[0] as unknown as unknown[];
  const setArg = call[0] as { metadata: { article: Record<string, unknown> } };
  return setArg.metadata.article;
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.auditInserts.length = 0;
  // Existing asset metadata (an already-derived article block, #1193).
  mockLimit.mockResolvedValue([{ metadata: { article: { slug: 'existing', title: 'Existing' } } }]);
  vi.mocked(readFile).mockResolvedValue(DOC as never);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('projectReactor — release-gated projection (#1207)', () => {
  it('materializes a released (consented) field into metadata.article', async () => {
    await projectReactor(makeEvent(), {});
    expect(projectedArticle()).toHaveProperty('tagline', 'Hello from the owner');
  });

  it('materializes a silent (freely-projectable) field without needing consent', async () => {
    await projectReactor(makeEvent(), {});
    expect(projectedArticle()).toHaveProperty('homepage', 'https://example.com');
  });

  it('never materializes a `never`-tier field (absent, not present-but-filtered)', async () => {
    await projectReactor(makeEvent(), {});
    const article = projectedArticle();
    expect(article).not.toHaveProperty('secret');
    expect(Object.keys(article)).not.toContain('secret');
  });

  it('never materializes an unconsented on-consent field', async () => {
    await projectReactor(makeEvent(), {});
    const article = projectedArticle();
    expect(article).not.toHaveProperty('email');
    expect(Object.keys(article)).not.toContain('email');
  });

  it('preserves the pre-existing article block (merges, does not clobber)', async () => {
    await projectReactor(makeEvent(), {});
    expect(projectedArticle()).toMatchObject({ slug: 'existing', title: 'Existing' });
  });

  it('writes a broker_audit_log row for the consent-gated decisions', async () => {
    await projectReactor(makeEvent(), {});
    // Audit writes are fire-and-forget inside the broker; let the microtasks flush.
    await vi.waitFor(() => expect(hoisted.auditInserts.length).toBeGreaterThanOrEqual(1));
  });

  it('projects nothing when the release policy is malformed (fail-closed)', async () => {
    vi.mocked(readFile).mockResolvedValueOnce('---\nrelease: "not-a-mapping"\n---\nbody' as never);
    await projectReactor(makeEvent(), {});
    expect(mockSet).not.toHaveBeenCalled();
  });
});
