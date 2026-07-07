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

// Process-lifetime caches — reading AUTH_PRIVATE_KEY once per process is correct.
let cachedSealKey: Buffer | undefined;
let cachedIdentity: NodeSigningIdentity | undefined;
let cachedNodeXKeypair: { privateKey: string; publicKey: string } | undefined;

/**
 * Derive a 32-byte AES-256-GCM sealing key from AUTH_PRIVATE_KEY.
 *
 * Uses HKDF-SHA256 with a fixed salt and info string so the sealing key is
 * domain-separated from the raw signing key. The same seed never serves two
 * different cryptographic purposes directly.
 *
 * Dev fallback (AUTH_PRIVATE_KEY unset): a deterministic key derived from a
 * known dev seed — equivalent to auth/encrypt.ts' dev-mode behaviour.
 * Never use the fallback with real secrets.
 */
export function getSealKey(): Buffer {
    if (cachedSealKey !== undefined) {
        return cachedSealKey;
    }
    // Single source of truth for seal-key derivation lives in @imajin/vault-core.
    cachedSealKey = deriveSealKey(process.env.AUTH_PRIVATE_KEY);
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
 * Dev fallback (AUTH_PRIVATE_KEY unset): a deterministic key derived from the
 * same dev seed used above, so sign/verify is self-consistent in development.
 */
export function getNodeSigningIdentity(): NodeSigningIdentity {
    if (cachedIdentity !== undefined) {
        return cachedIdentity;
    }
    const rawKey = process.env.AUTH_PRIVATE_KEY;
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
 * Return the node's X25519 public key (hex) for vault delegation.
 *
 * The key is derived from AUTH_PRIVATE_KEY via HKDF-SHA256 with a fixed info
 * string, domain-separated from the Ed25519 signing identity and the AES seal
 * key so the same seed never serves two cryptographic purposes directly.
 *
 * Owner agents use this key as `recipientXPub` when wrapping a field key for
 * this node. The node uses the corresponding private key to unwrap at unseal time.
 *
 * Dev fallback (AUTH_PRIVATE_KEY unset): a deterministic key derived from the
 * same dev seed used by getSealKey, so wrap/unwrap is self-consistent in dev.
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
    const rawKey = process.env.AUTH_PRIVATE_KEY;
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
}
