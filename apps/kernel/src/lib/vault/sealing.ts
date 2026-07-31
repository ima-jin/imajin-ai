/**
 * Vault sealing key derivation and node signing identity.
 *
 * CUSTODY DISCLOSURE (honest, intentional):
 *   Secrets are sealed with a key derived from AUTH_PRIVATE_KEY.
 *   This means the node operator CAN decrypt stored secrets to act on the
 *   owner's behalf. Secrets are encrypted at rest, access-controlled, and
 *   provenance-signed — but this is NOT zero-custody.
 *   Zero-custody (owner-sealed) is the separate hardening track filed as A4.
 */
import { createHash } from 'node:crypto';
import { crypto as authCrypto } from '@imajin/auth';
import { deriveSealKey, extractPrivateKeySeed, deriveXKeypairFromEd25519 } from '@imajin/vault-core';

export interface NodeSigningIdentity {
    /** Hex-encoded Ed25519 private key (raw 32-byte seed format). */
    privateKeyHex: string;
    /** Hex-encoded Ed25519 public key (32 bytes). */
    senderPubkey: string;
    /** did:imajin:<first-16-hex-chars-of-senderPubkey> */
    senderDid: string;
}

// HKDF info strings for X25519 key derivation — domain-separated from seal key and signing key.
const NODE_X25519_INFO = 'vault-node-x25519-v1';
const OWNER_X25519_INFO = 'vault-owner-x25519-v1';

/**
 * Return AUTH_PRIVATE_KEY, refusing the dev fallback in production.
 *
 * Every derivation below (seal key, signing identity, node/owner X25519 keys)
 * has a deterministic dev fallback so development is self-consistent without a
 * configured key. In production that fallback is catastrophic in two distinct
 * ways, both of which are silent:
 *
 *   1. Correctness — the fallback is a DIFFERENT node identity than the one that
 *      sealed the existing entries, so every stored vault entry instantly fails
 *      signature verification. The platform loses read access to all secrets
 *      with no error at boot.
 *   2. Security — the fallback seed is a hardcoded constant, making the node's
 *      signing identity and sealing key publicly predictable.
 *
 * So in production the absence of the key is a boot failure, not a fallback.
 * Failing loudly here is strictly better than serving traffic with the wrong
 * cryptographic identity.
 */
function requireAuthPrivateKeyInProduction(): string | undefined {
    const rawKey = process.env.AUTH_PRIVATE_KEY;
    if (!rawKey && process.env.NODE_ENV === 'production') {
        throw new Error(
            'AUTH_PRIVATE_KEY is required in production: refusing to derive vault keys from the deterministic dev seed. ' +
            'A dev-seed identity cannot read any existing vault entry and is publicly predictable. ' +
            'Ensure the process environment carries AUTH_PRIVATE_KEY (node server.js does NOT load .env.local by itself).',
        );
    }
    return rawKey;
}

// Process-lifetime caches — reading AUTH_PRIVATE_KEY once per process is correct.
let cachedSealKey: Buffer | undefined;
let cachedIdentity: NodeSigningIdentity | undefined;
let cachedNodeXKeypair: { privateKey: string; publicKey: string } | undefined;
let cachedOwnerXKeypair: { privateKey: string; publicKey: string } | undefined;

/**
 * Derive a 32-byte AES-256-GCM sealing key from AUTH_PRIVATE_KEY.
 *
 * Uses HKDF-SHA256 with a fixed salt and info string so the sealing key is
 * domain-separated from the raw signing key. The same seed never serves two
 * different cryptographic purposes directly.
 *
 * Dev fallback (AUTH_PRIVATE_KEY unset, non-production only): a deterministic
 * key derived from a known dev seed — equivalent to auth/encrypt.ts' dev-mode
 * behaviour. Never use the fallback with real secrets; in production the missing
 * key throws instead (see requireAuthPrivateKeyInProduction).
 */
export function getSealKey(): Buffer {
    if (cachedSealKey !== undefined) {
        return cachedSealKey;
    }
    // Single source of truth for seal-key derivation lives in @imajin/vault-core.
    // deriveSealKey has its own dev fallback, so the production guard runs first.
    cachedSealKey = deriveSealKey(requireAuthPrivateKeyInProduction());
    return cachedSealKey;
}

/**
 * Derive the node's signing identity from AUTH_PRIVATE_KEY.
 *
 * senderDid = did:imajin:<first-16-hex-chars-of-Ed25519-pubkey>
 * senderPubkey = hex-encoded 32-byte Ed25519 public key
 *
 * This identity is what signs vault entries. The DID-to-key binding check in
 * vault-core passes because senderDid is derived directly from senderPubkey.
 *
 * Dev fallback (AUTH_PRIVATE_KEY unset, non-production only): a deterministic
 * key derived from the same dev seed used above, so sign/verify is
 * self-consistent in development. In production the missing key throws.
 */
export function getNodeSigningIdentity(): NodeSigningIdentity {
    if (cachedIdentity !== undefined) {
        return cachedIdentity;
    }
    const rawKey = requireAuthPrivateKeyInProduction();
    let seedHex: string;
    if (rawKey) {
        seedHex = extractPrivateKeySeed(rawKey);
    } else {
        // Dev fallback: deterministic seed from a known string
        seedHex = createHash('sha256').update('dev-vault-signing-key-imajin').digest('hex');
    }
    const senderPubkey = authCrypto.getPublicKey(seedHex);
    const senderDid = `did:imajin:${senderPubkey.slice(0, 16)}`;
    cachedIdentity = { privateKeyHex: seedHex, senderPubkey, senderDid };
    return cachedIdentity;
}

/**
 * Return the owner agent's X25519 public key (hex) for vault delegation (Tier 0).
 *
 * In Tier 0, the node acts as its own owner agent. The owner X25519 key is
 * derived from AUTH_PRIVATE_KEY with info 'vault-owner-x25519-v1', intentionally
 * distinct from the node X25519 key (vault-node-x25519-v1) so the two roles
 * are always cryptographically separate — even when both are on the same server.
 *
 * When upgrading to Tier 1, the owner's vault X25519 key moves to the owner
 * agent (imajin-cli vault serve / mobile app / Unit). The protocol and grant
 * table structure stay identical; only the key holder changes.
 */
export function getOwnerXPublicKey(): string {
    return getOwnerXKeypair().publicKey;
}

/**
 * Return the owner agent's X25519 private key (hex) for vault delegation (Tier 0).
 *
 * Used only when creating a new delegation grant (sealing a v2 entry). Never
 * logged or exposed. In Tier 1 this key lives exclusively on the owner agent.
 */
export function getOwnerXPrivateKey(): string {
    return getOwnerXKeypair().privateKey;
}

function getOwnerXKeypair(): { privateKey: string; publicKey: string } {
    if (cachedOwnerXKeypair !== undefined) {
        return cachedOwnerXKeypair;
    }
    const rawKey = requireAuthPrivateKeyInProduction();
    if (rawKey) {
        cachedOwnerXKeypair = deriveXKeypairFromEd25519(rawKey, OWNER_X25519_INFO);
    } else {
        const devSeed = createHash('sha256').update('dev-vault-signing-key-imajin').digest('hex');
        cachedOwnerXKeypair = deriveXKeypairFromEd25519(devSeed, OWNER_X25519_INFO);
    }
    return cachedOwnerXKeypair;
}

/**
 * Return the node's X25519 public key (hex) for vault delegation.
 *
 * The key is derived from AUTH_PRIVATE_KEY via HKDF-SHA256 with a fixed info
 * string, domain-separated from the Ed25519 signing identity and the AES seal
 * key so the same seed never serves two cryptographic purposes directly.
 *
 * Owner agents use this key as `recipientXPub` when wrapping a field key for
 * this node. The node uses the corresponding private key to unwrap at unseal time.
 *
 * Dev fallback (AUTH_PRIVATE_KEY unset, non-production only): a deterministic
 * key derived from the same dev seed used by getSealKey, so wrap/unwrap is
 * self-consistent in dev. In production the missing key throws.
 */
export function getNodeXPublicKey(): string {
    return getNodeXKeypair().publicKey;
}

/**
 * Return the node's X25519 private key (hex) for vault delegation.
 *
 * Never log or expose this value. Used only inside loadAndUnseal to unwrap
 * the per-field AES key from a vault_delegation_grants row.
 */
export function getNodeXPrivateKey(): string {
    return getNodeXKeypair().privateKey;
}

function getNodeXKeypair(): { privateKey: string; publicKey: string } {
    if (cachedNodeXKeypair !== undefined) {
        return cachedNodeXKeypair;
    }
    const rawKey = requireAuthPrivateKeyInProduction();
    if (rawKey) {
        cachedNodeXKeypair = deriveXKeypairFromEd25519(rawKey, NODE_X25519_INFO);
    } else {
        // Dev fallback: deterministic seed matching the dev seal key derivation.
        const devSeed = createHash('sha256').update('dev-vault-signing-key-imajin').digest('hex');
        cachedNodeXKeypair = deriveXKeypairFromEd25519(devSeed, NODE_X25519_INFO);
    }
    return cachedNodeXKeypair;
}

/** Reset caches — only for use in tests. */
export function _resetSealingCache(): void {
    cachedSealKey = undefined;
    cachedIdentity = undefined;
    cachedNodeXKeypair = undefined;
    cachedOwnerXKeypair = undefined;
}

// ── Tier 1 helpers ——————————————————————————————————————————————————

/**
 * Return true when the kernel is configured for Tier 1 vault custody.
 *
 * Tier 1 is active when both VAULT_OWNER_X_PUB (the external owner agent's
 * X25519 pubkey) and VAULT_OWNER_ED_PUB (their Ed25519 pubkey for signature
 * verification) are set as environment variables.
 *
 * In Tier 1, sealAndStoreV2 skips the self-grant and instead emits a
 * vault.grant.requested event so the owner agent (imajin-cli vault serve)
 * can create the delegation grant externally.
 */
export function isVaultTier1(): boolean {
    return Boolean(process.env.VAULT_OWNER_X_PUB && process.env.VAULT_OWNER_ED_PUB);
}

/**
 * Return the external owner agent's X25519 public key (hex) for Tier 1.
 *
 * Reads VAULT_OWNER_X_PUB — the X25519 pubkey of the owner agent running
 * `imajin-cli vault serve`.  The node wraps the per-field AES key to this
 * pubkey when creating a grant request, so only the owner agent can recover it.
 *
 * Throws if VAULT_OWNER_X_PUB is not set (i.e. not in Tier 1 mode).
 */
export function getExternalOwnerXPublicKey(): string {
    const pub = process.env.VAULT_OWNER_X_PUB;
    if (!pub) {
        throw new Error('VAULT_OWNER_X_PUB is required for Tier 1 vault operations (set it to the ownerXPub from imajin-cli vault pubkey)');
    }
    return pub;
}

/**
 * Return the external owner agent's Ed25519 public key (hex) for Tier 1
 * signature verification.
 *
 * Reads VAULT_OWNER_ED_PUB — the Ed25519 pubkey of the owner agent.
 * Used by POST /api/vault/delegation/grant to verify the ownerSignature
 * on incoming grants from the CLI owner agent.
 *
 * Throws if VAULT_OWNER_ED_PUB is not set.
 */
export function getExternalOwnerEdPublicKey(): string {
    const pub = process.env.VAULT_OWNER_ED_PUB;
    if (!pub) {
        throw new Error('VAULT_OWNER_ED_PUB is required for Tier 1 vault operations (set it to the ownerEdPub from imajin-cli vault pubkey)');
    }
    return pub;
}
