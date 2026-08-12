import { describe, it, expect } from 'vitest';
import { ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES } from '../src/types/attestation';

describe('MECHANICAL_ATTESTATION_TYPES (#1822)', () => {
  it('contains session.created', () => {
    expect(MECHANICAL_ATTESTATION_TYPES).toContain('session.created');
  });

  it('every mechanical type is a known attestation type', () => {
    const known = new Set<string>(ATTESTATION_TYPES);
    for (const type of MECHANICAL_ATTESTATION_TYPES) {
      expect(known.has(type), `MECHANICAL_ATTESTATION_TYPES entry "${type}" is not in ATTESTATION_TYPES`).toBe(true);
    }
  });

  it('has no duplicate entries', () => {
    expect(MECHANICAL_ATTESTATION_TYPES.length).toBe(new Set(MECHANICAL_ATTESTATION_TYPES).size);
  });
});
