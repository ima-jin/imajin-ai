/**
 * Unit tests for the known-vault-fields registry (#2700).
 *
 * The registry's names must come from the same constants the real readers use,
 * so these tests pin them against those constants rather than string literals.
 */
import { describe, it, expect, vi } from 'vitest';

// The real reader modules (imported for their field constants) transitively
// import the db client, which refuses to load without DATABASE_URL.
vi.mock('@/src/db', () => ({ db: {} }));
import { GITHUB_ORG_CREDENTIAL_FIELD } from '@/src/lib/github/org-provisioning';
import { ATTESTATION_INTERNAL_API_KEY_PURPOSE } from '@/src/lib/auth/require-internal-api-key';
import { PEPPER_PURPOSE } from '@/src/lib/auth/foreign-principal-stub';
import { VAPID_KEYS_PURPOSE } from '@/src/lib/notify/vapid';
import { internalSecretField } from '../internal-secret';
import { isInternalSecretField, isValidVaultFieldName, parseVaultFieldName } from '../field-grammar';
import { KNOWN_VAULT_FIELDS } from '../known-fields';

describe('KNOWN_VAULT_FIELDS', () => {
  it('lists the fields the kernel reads, named from the real reader constants', () => {
    expect(KNOWN_VAULT_FIELDS.map((f) => f.name)).toEqual([
      GITHUB_ORG_CREDENTIAL_FIELD,
      internalSecretField(ATTESTATION_INTERNAL_API_KEY_PURPOSE),
      internalSecretField(PEPPER_PURPOSE),
      internalSecretField(VAPID_KEYS_PURPOSE),
    ]);
  });

  it('pins the exact field names the kernel reads (guards against an undefined reader constant)', () => {
    expect(KNOWN_VAULT_FIELDS.map((f) => f.name)).toEqual([
      'github-org-provisioning',
      'internal-secret:kernel.attestation-internal-api-key',
      'internal-secret:kernel.foreign-principal-pepper',
      'internal-secret:notify.web-push-vapid-keys',
    ]);
  });

  it('gives every entry a non-empty name, label, description and a known namespace', () => {
    for (const field of KNOWN_VAULT_FIELDS) {
      expect(field.name.length).toBeGreaterThan(0);
      expect(field.label.length).toBeGreaterThan(0);
      expect(field.description.length).toBeGreaterThan(0);
      expect(['github', 'internal-secret']).toContain(field.namespace);
    }
  });

  it('has unique names', () => {
    const names = KNOWN_VAULT_FIELDS.map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names every entry with a field that parses under the vault field grammar', () => {
    for (const field of KNOWN_VAULT_FIELDS) {
      expect(isValidVaultFieldName(field.name)).toBe(true);
      const parsed = parseVaultFieldName(field.name);
      expect(parsed.ok && parsed.value.field).toBe(field.name);
    }
  });

  it('keeps namespace consistent with the field name', () => {
    for (const field of KNOWN_VAULT_FIELDS) {
      expect(isInternalSecretField(field.name)).toBe(field.namespace === 'internal-secret');
    }
  });

  it('is frozen so a caller cannot mutate the shared registry', () => {
    expect(Object.isFrozen(KNOWN_VAULT_FIELDS)).toBe(true);
  });
});
