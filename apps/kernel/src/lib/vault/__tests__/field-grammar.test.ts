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
  isInternalSecretField,
  GITHUB_ORG_CREDENTIAL_FIELD_NAME,
} from '../field-grammar';

describe('isValidVaultFieldName', () => {
  it.each([
    ['lowercase-hyphen', 'github-org-provisioning'],
    ['namespaced, dotted purpose', 'internal-secret:kernel.attestation-internal-api-key'],
    ['connector, lowercase toy did', 'warp-agent-key:did:imajin:node-abc123'],
    // Real-shaped DIDs (#2450 review): base58 (bs58.encode, auth/crypto.ts)
    // and nanoid(44) (default alphabet A-Za-z0-9_-, foreign-principal-stub.ts)
    // are both genuinely mixed-case — an id-segment regex that only accepted
    // lowercase rejected every DID the kernel actually mints.
    ['connector, real base58-shaped did', 'stripe-webhook-secret:did:imajin:2NEpo7TZRRrLZSi2U'],
    ['connector, real nanoid-shaped did (mixed case, underscore, hyphen)', 'warp-agent-key:did:imajin:V1StGXR8_Z5jdHi6B-myT'],
    ['connector with a yyyy-mm-dd window suffix, id starts with a digit', 'usage-rollup:did:imajin:79d9c6f1a2b3c4d5:2026-09-29'],
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
    ['connector, uppercase purpose', 'Warp-Agent-Key:did:imajin:abc123'],
    ['connector, missing the did literal', 'warp-agent-key:notdid:imajin:abc123'],
    ['connector, uppercase method', 'warp-agent-key:did:Imajin:abc123'],
    ['connector, malformed date suffix', 'usage-rollup:did:imajin:abc123:not-a-date'],
    ['too many segments', 'a:did:imajin:abc:2026-09-29:extra'],
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

describe('isInternalSecretField', () => {
  it('is true for the internal-secret:* namespace', () => {
    expect(isInternalSecretField('internal-secret:kernel.foreign-principal-pepper')).toBe(true);
  });

  it('is false for everything else, including a field that merely contains the substring', () => {
    expect(isInternalSecretField('github-org-provisioning')).toBe(false);
    expect(isInternalSecretField('warp-agent-key:did:imajin:abc123')).toBe(false);
    expect(isInternalSecretField('not-internal-secret:foo')).toBe(false);
  });
});
