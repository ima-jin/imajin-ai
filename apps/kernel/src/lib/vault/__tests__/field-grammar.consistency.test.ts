/**
 * Drift guard for field-grammar.ts's client-safe literal mirror (#2445).
 *
 * field-grammar.ts hardcodes `GITHUB_ORG_CREDENTIAL_FIELD_NAME` instead of
 * importing `GITHUB_ORG_CREDENTIAL_FIELD` from org-provisioning.ts, because
 * that module pulls in libsodium/node:crypto and must never reach the
 * set-secret-dialog client bundle. This test is the only place the two are
 * imported together, so a rename on either side fails loudly here instead of
 * silently reintroducing the exact "add dialog disagrees with the kernel's
 * real field name" defect #2445 was filed for.
 */
import { describe, it, expect, vi } from 'vitest';

// org-provisioning.ts only needs `loadAndUnseal` from the vault barrel; mocking
// it here avoids pulling in the real db schemas (drizzle) this test has no use
// for — the same seam apps/kernel/src/lib/github/__tests__/org-provisioning.test.ts
// already uses.
vi.mock('@/src/lib/vault', () => ({ loadAndUnseal: vi.fn() }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { GITHUB_ORG_CREDENTIAL_FIELD } from '@/src/lib/github/org-provisioning';
import { GITHUB_ORG_CREDENTIAL_FIELD_NAME } from '../field-grammar';

describe('field-grammar literal mirrors', () => {
  it('GITHUB_ORG_CREDENTIAL_FIELD_NAME matches the real org-provisioning.ts export', () => {
    expect(GITHUB_ORG_CREDENTIAL_FIELD_NAME).toBe(GITHUB_ORG_CREDENTIAL_FIELD);
  });
});
