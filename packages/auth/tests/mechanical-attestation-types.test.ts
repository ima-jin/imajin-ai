import { describe, it, expect } from 'vitest';
import { ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES } from '../src/types/attestation';

describe('MECHANICAL_ATTESTATION_TYPES (#1822)', () => {
  it('classifies signed connector removal as mechanical history, never a countersignature request', () => {
    expect(ATTESTATION_TYPES).toContain('connector.disconnected');
    expect(MECHANICAL_ATTESTATION_TYPES).toContain('connector.disconnected');
  });
  it('contains session.created', () => {
    expect(MECHANICAL_ATTESTATION_TYPES).toContain('session.created');
  });

  it('classifies declaration refresh history as mechanical, not a bilateral signing request', () => {
    expect(ATTESTATION_TYPES).toContain('apps.secrets.declarations-refreshed');
    expect(MECHANICAL_ATTESTATION_TYPES).toContain('apps.secrets.declarations-refreshed');
  });

  it('contains apps.signing-key.claimed (#2444)', () => {
    expect(MECHANICAL_ATTESTATION_TYPES).toContain('apps.signing-key.claimed');
    expect((ATTESTATION_TYPES as readonly string[]).includes('apps.signing-key.claimed')).toBe(true);
  });

  it('every mechanical type is a known attestation type', () => {
    const known = new Set<string>(ATTESTATION_TYPES);
    for (const type of MECHANICAL_ATTESTATION_TYPES) {
      expect(known.has(type), `MECHANICAL_ATTESTATION_TYPES entry "${type}" is not in ATTESTATION_TYPES`).toBe(true);
    }
  });

  it('has no duplicate entries', () => {
    expect(MECHANICAL_ATTESTATION_TYPES).toHaveLength(new Set(MECHANICAL_ATTESTATION_TYPES).size);
  });
});
