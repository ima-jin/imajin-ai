import { describe, it, expect } from 'vitest';
import { encodeAttestationCursor, parseAttestationCursor } from '../attestation-cursor';

describe('attestation cursor (#2533)', () => {
  it('encodes issued_at (ISO, ms precision) and id', () => {
    expect(encodeAttestationCursor({ issuedAt: new Date('2026-10-06T10:00:02.123Z'), id: 'att_abc' })).toBe(
      '2026-10-06T10:00:02.123Z,att_abc',
    );
  });

  it('round-trips encode -> parse', () => {
    const row = { issuedAt: new Date('2026-10-06T10:00:02.123Z'), id: 'att_abc' };

    expect(parseAttestationCursor(encodeAttestationCursor(row))).toEqual({
      issuedAt: '2026-10-06T10:00:02.123Z',
      id: 'att_abc',
    });
  });

  it('normalises an equivalent timestamp spelling to canonical ISO', () => {
    expect(parseAttestationCursor('2026-10-06T12:00:02.000+02:00,att_1')).toEqual({
      issuedAt: '2026-10-06T10:00:02.000Z',
      id: 'att_1',
    });
  });

  it('splits on the first comma only', () => {
    expect(parseAttestationCursor('2026-10-06T10:00:02.000Z,att_a,b')?.id).toBe('att_a,b');
  });

  it.each(['', 'att_1', ',att_1', '2026-10-06T10:00:02.000Z', '2026-10-06T10:00:02.000Z,', 'nope,att_1'])(
    'returns null for malformed input %j',
    (raw) => {
      expect(parseAttestationCursor(raw)).toBeNull();
    },
  );
});
