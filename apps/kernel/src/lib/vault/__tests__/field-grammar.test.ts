/**
 * Unit tests for the vault field-name grammar (#2699).
 *
 * Pins every field-name shape the kernel really mints or accepts, the exact
 * shapes it must refuse, and the "never transform" contract (#2445: a field
 * name is looked up by exact string match, so the parser may trim but never
 * case-fold or rewrite).
 */
import { describe, it, expect } from 'vitest';
import {
  INTERNAL_SECRET_FIELD_PREFIX,
  INTERNAL_SECRET_NAMESPACE,
  MINTED_KEY_NAMESPACE,
  VAULT_FIELD_NAME_RULE,
  isEnvStyleFieldName,
  isInternalSecretField,
  isMintedKeyField,
  isValidVaultFieldName,
  parseVaultFieldName,
  vaultFieldNamespace,
} from '../field-grammar';

describe('parseVaultFieldName', () => {
  it.each([
    ['legacy ENV_STYLE', 'GH_TOKEN', null, 'GH_TOKEN'],
    ['lowercase-hyphen', 'github-org-provisioning', null, 'github-org-provisioning'],
    ['single word', 'vapidkeys', null, 'vapidkeys'],
    ['namespaced internal secret, dotted purpose', 'internal-secret:kernel.attestation-internal-api-key', 'internal-secret', 'kernel.attestation-internal-api-key'],
    ['namespaced with a DID (name keeps its colons)', 'discord-bot-token:did:imajin:abc123', 'discord-bot-token', 'did:imajin:abc123'],
    ['mixed-case DID id', 'warp-agent-key:did:imajin:V1StGXR8_Z5jdHi6B-myT', 'warp-agent-key', 'did:imajin:V1StGXR8_Z5jdHi6B-myT'],
    ['dated window suffix', 'usage-rollup:did:imajin:79d9c6f1:2026-09-29', 'usage-rollup', 'did:imajin:79d9c6f1:2026-09-29'],
    ['minted key', 'vault-minted-key:did:imajin:0123456789abcdef', 'vault-minted-key', 'did:imajin:0123456789abcdef'],
  ])('accepts %s', (_label, input, namespace, name) => {
    const parsed = parseVaultFieldName(input);
    expect(parsed).toEqual({ ok: true, value: { field: input, namespace, name } });
  });

  it('trims surrounding whitespace and returns the trimmed field', () => {
    const parsed = parseVaultFieldName('  internal-secret:foo \n');
    expect(parsed).toEqual({ ok: true, value: { field: 'internal-secret:foo', namespace: 'internal-secret', name: 'foo' } });
  });

  it('never changes case', () => {
    const parsed = parseVaultFieldName('github-org-provisioning');
    expect(parsed.ok && parsed.value.field).toBe('github-org-provisioning');
    const upper = parseVaultFieldName('GITHUB-ORG-PROVISIONING');
    expect(upper.ok && upper.value.field).toBe('GITHUB-ORG-PROVISIONING');
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['an object', { field: 'x' }],
    ['an empty string', ''],
    ['whitespace only', '   '],
  ])('reports "required" for %s', (_label, input) => {
    expect(parseVaultFieldName(input)).toEqual({ ok: false, reason: 'required', message: 'field is required' });
  });

  it.each([
    ['trailing colon', 'internal-secret:'],
    ['leading colon', ':purpose'],
    ['empty middle segment', 'a::b'],
    ['inner whitespace', 'gh token'],
    ['segment starting with a separator char', '-foo'],
    ['segment starting with an underscore', '_foo'],
    ['segment starting with a dot', 'ns:.foo'],
    ['slash', 'a/b'],
    ['percent', 'a:b%20c'],
    ['newline inside', 'a\nb'],
    ['non-ASCII letter', 'caf\u00e9'],
  ])('reports "invalid" for %s', (_label, input) => {
    const parsed = parseVaultFieldName(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toBe('invalid');
      expect(parsed.message).toContain(VAULT_FIELD_NAME_RULE);
    }
  });
});

describe('isValidVaultFieldName', () => {
  it('is true exactly when parseVaultFieldName succeeds', () => {
    for (const candidate of ['GH_TOKEN', 'a:b:c', 'a::b', '', 7, null]) {
      expect(isValidVaultFieldName(candidate)).toBe(parseVaultFieldName(candidate).ok);
    }
  });
});

describe('vaultFieldNamespace', () => {
  it('returns the first segment of a namespaced field', () => {
    expect(vaultFieldNamespace('internal-secret:foo')).toBe('internal-secret');
    expect(vaultFieldNamespace('warp-agent-key:did:imajin:abc')).toBe('warp-agent-key');
  });

  it('returns null for a bare field and for an unparseable one', () => {
    expect(vaultFieldNamespace('GH_TOKEN')).toBeNull();
    expect(vaultFieldNamespace('internal-secret:')).toBeNull();
    expect(vaultFieldNamespace('')).toBeNull();
  });
});

describe('namespace predicates', () => {
  it('exposes the internal-secret prefix as namespace + separator', () => {
    expect(INTERNAL_SECRET_FIELD_PREFIX).toBe(`${INTERNAL_SECRET_NAMESPACE}:`);
  });

  it('isInternalSecretField is true only for the internal-secret namespace', () => {
    expect(isInternalSecretField('internal-secret:kernel.foreign-principal-pepper')).toBe(true);
    expect(isInternalSecretField('internal-secret:')).toBe(false);
    expect(isInternalSecretField('github-org-provisioning')).toBe(false);
    expect(isInternalSecretField('not-internal-secret:foo')).toBe(false);
    expect(isInternalSecretField('internal-secretx:foo')).toBe(false);
  });

  it('isMintedKeyField is true only for the vault-minted-key namespace', () => {
    expect(isMintedKeyField(`${MINTED_KEY_NAMESPACE}:did:imajin:abc`)).toBe(true);
    expect(isMintedKeyField('nostr-key:did:imajin:abc')).toBe(false);
    expect(isMintedKeyField('vault-minted-key')).toBe(false);
  });
});

describe('isEnvStyleFieldName', () => {
  it('accepts bare upper-case env names', () => {
    expect(isEnvStyleFieldName('GH_TOKEN')).toBe(true);
    expect(isEnvStyleFieldName('TOKEN2')).toBe(true);
  });

  it('rejects lower-case, mixed-case, namespaced, and invalid names', () => {
    expect(isEnvStyleFieldName('github-org-provisioning')).toBe(false);
    expect(isEnvStyleFieldName('Gh_Token')).toBe(false);
    expect(isEnvStyleFieldName('INTERNAL:SECRET')).toBe(false);
    expect(isEnvStyleFieldName('')).toBe(false);
  });
});
