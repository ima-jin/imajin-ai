/**
 * Unit tests for the vault field-name grammar (#2445).
 *
 * Pins the four live shapes as valid and the exact prod incident
 * (`GITHUB-ORG-PROVISIONING`, produced by the old `toUpperCase()`) as
 * invalid, so the validator never quietly starts accepting the very
 * mistake it exists to catch.
 */
import { describe, it, expect } from 'vitest';
import {
  isValidVaultFieldName,
  defaultCustodyForField,
  GITHUB_ORG_CREDENTIAL_FIELD_NAME,
} from '../field-grammar';

describe('isValidVaultFieldName', () => {
  it.each([
    ['lowercase-hyphen', 'github-org-provisioning'],
    ['namespaced, dotted purpose', 'internal-secret:kernel.attestation-internal-api-key'],
    ['connector, purpose:did', 'warp-agent-key:did:imajin:node-abc123'],
    ['legacy ENV_STYLE', 'GH_TOKEN'],
    ['single lowercase word', 'vapidkeys'],
    ['single legacy word', 'TOKEN'],
  ])('accepts %s (%s)', (_label, field) => {
    expect(isValidVaultFieldName(field)).toBe(true);
  });

  it.each([
    ['the prod incident — uppercased namespaced field', 'GITHUB-ORG-PROVISIONING'],
    ['mixed case single segment', 'GitHub_Token'],
    ['mixed case namespaced segment', 'internal-secret:Kernel.attestation'],
    ['spaces', 'gh token'],
    ['empty', ''],
    ['whitespace only', '   '],
    ['empty segment', 'internal-secret:'],
    ['leading colon', ':purpose'],
    ['starts with a digit', '2fast'],
  ])('rejects %s (%s)', (_label, field) => {
    expect(isValidVaultFieldName(field)).toBe(false);
  });
});

describe('defaultCustodyForField', () => {
  it('locks the org-provisioning credential to delegation-grant', () => {
    const result = defaultCustodyForField(GITHUB_ORG_CREDENTIAL_FIELD_NAME);
    expect(result.scheme).toBe('delegation-grant');
    expect(result.locked).toBe(true);
    expect(result.why).toBeDefined();
  });

  it('locks any internal-secret:* field to delegation-grant', () => {
    const result = defaultCustodyForField('internal-secret:kernel.foreign-principal-pepper');
    expect(result.scheme).toBe('delegation-grant');
    expect(result.locked).toBe(true);
  });

  it('defaults an unrecognized field to node-sealed, unlocked', () => {
    const result = defaultCustodyForField('GH_TOKEN');
    expect(result.scheme).toBe('node-sealed');
    expect(result.locked).toBe(false);
    expect(result.why).toBeUndefined();
  });
});
