import { describe, it, expect } from 'vitest';
import { dedupeAttestationsBySubject } from '../grant-dedupe';

const row = (id: string, subjectDid: string, issuedAt: Date, revokedAt: Date | null = null) => ({
  id,
  subjectDid,
  payload: null,
  issuedAt,
  revokedAt,
});

describe('dedupeAttestationsBySubject', () => {
  it('collapses to one row per subject', () => {
    const out = dedupeAttestationsBySubject([
      row('a1', 'did:app:1', new Date('2026-01-01')),
      row('a2', 'did:app:1', new Date('2026-02-01')),
    ]);
    expect(out).toHaveLength(1);
  });

  it('prefers an active grant over a revoked one, regardless of recency', () => {
    const out = dedupeAttestationsBySubject([
      row('active-old', 'did:app:1', new Date('2026-01-01'), null),
      row('revoked-new', 'did:app:1', new Date('2026-03-01'), new Date('2026-03-02')),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('active-old');
  });

  it('prefers the most recently issued when both are active', () => {
    const out = dedupeAttestationsBySubject([
      row('old', 'did:app:1', new Date('2026-01-01')),
      row('new', 'did:app:1', new Date('2026-02-01')),
    ]);
    expect(out[0].id).toBe('new');
  });

  it('keeps distinct subjects', () => {
    const out = dedupeAttestationsBySubject([
      row('a', 'did:app:1', new Date('2026-01-01')),
      row('b', 'did:app:2', new Date('2026-01-01')),
    ]);
    expect(out.map((r) => r.subjectDid).sort()).toEqual(['did:app:1', 'did:app:2']);
  });
});
