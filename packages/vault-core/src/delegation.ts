/**
 * Vault delegation key-wrapping primitives.
 *
 * Implements the crypto layer for the delegation-grant-sealed vault scheme
 * (#1242). A per-field random AES-256-GCM key is ECDH-wrapped to the
 * recipient's X25519 public key. The recipient unwraps it using their X25519
 * private key. No plaintext field key is ever stored on disk.
 *
 * Crypto stack (all via existing runtime deps — no new libraries):
 *   X25519 ECDH          @noble/curves/ed25519 (x25519 export)
 *   HKDF-SHA256          node:crypto hkdfSync
 *   AES-256-GCM wrap     node:crypto (same algorithm used throughout vault-core)
 *
 * Key encoding: all public/private keys are 32-byte raw values encoded as
 * lowercase hex strings, matching the convention in packages/auth and seal.ts.
 */
import { x25519 } from '@noble/curves/ed25519';
import { hkdfSync, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { extractPrivateKeySeed } from './signature.js';

// ── Constants ──────────────────────────────────────────────────────────────────

const DELEGATION_HKDF_SALT = Buffer.from('imajin-vault', 'utf8');
const DELEGATION_HKDF_INFO = Buffer.from('vault-delegation-v2', 'utf8');
const X25519_HKDF_SALT = Buffer.from('imajin-vault', 'utf8');

const FIELD_KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const X25519_KEY_LENGTH = 32;

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * An AES-256-GCM-wrapped field key produced by wrapFieldKey.
 *
 * encryptedKey  base64-encoded: GCM authTag (16 bytes) || AES ciphertext of fieldKey
 * nonce         base64-encoded: 12-byte random IV
 */
export interface DelegationWrappedKey {
    encryptedKey: string;
    nonce: string;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Wrap a 32-byte field key for a recipient using X25519 ECDH + AES-256-GCM.
 *
 * The wrapping key is derived via:
 *   sharedPoint  = X25519-ECDH(senderXPriv, recipientXPub)
 *   wrappingKey  = HKDF-SHA256(sharedPoint, salt='imajin-vault', info='vault-delegation-v2', 32)
 *
 * The field key is then encrypted with AES-256-GCM using the wrapping key.
 * The GCM auth tag is prepended to the ciphertext (same layout as sealSecret).
 *
 * @param fieldKey      32-byte raw AES key to wrap (Buffer)
 * @param recipientXPub 32-byte hex X25519 public key of the recipient (node/agent)
 * @param senderXPriv   32-byte hex X25519 private key of the sender (owner agent)
 */
export function wrapFieldKey(
    fieldKey: Buffer,
    recipientXPub: string,
    senderXPriv: string,
): DelegationWrappedKey {
    if (fieldKey.length !== FIELD_KEY_LENGTH) {
        throw new Error(`Field key must be ${FIELD_KEY_LENGTH} bytes; got ${fieldKey.length}`);
    }
    assertHex(recipientXPub, X25519_KEY_LENGTH, 'recipientXPub');
    assertHex(senderXPriv, X25519_KEY_LENGTH, 'senderXPriv');

    const sharedPoint = x25519.getSharedSecret(
        Buffer.from(senderXPriv, 'hex'),
        Buffer.from(recipientXPub, 'hex'),
    );
    const wrappingKey = deriveWrappingKey(sharedPoint);

    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', wrappingKey, iv);
    const encrypted = Buffer.concat([cipher.update(fieldKey), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
        encryptedKey: Buffer.concat([authTag, encrypted]).toString('base64'),
        nonce: Buffer.from(iv).toString('base64'),
    };
}

/**
 * Unwrap a field key produced by wrapFieldKey.
 *
 * The wrapping key is re-derived via:
 *   sharedPoint  = X25519-ECDH(recipientXPriv, senderXPub)
 *   wrappingKey  = HKDF-SHA256(sharedPoint, salt='imajin-vault', info='vault-delegation-v2', 32)
 *
 * Throws if the auth tag check fails (tampered or wrong key pair).
 *
 * @param wrapped       DelegationWrappedKey produced by wrapFieldKey
 * @param senderXPub    32-byte hex X25519 public key of the sender (owner agent)
 * @param recipientXPriv 32-byte hex X25519 private key of the recipient (this node)
 */
export function unwrapFieldKey(
    wrapped: DelegationWrappedKey,
    senderXPub: string,
    recipientXPriv: string,
): Buffer {
    assertHex(senderXPub, X25519_KEY_LENGTH, 'senderXPub');
    assertHex(recipientXPriv, X25519_KEY_LENGTH, 'recipientXPriv');

    const sharedPoint = x25519.getSharedSecret(
        Buffer.from(recipientXPriv, 'hex'),
        Buffer.from(senderXPub, 'hex'),
    );
    const wrappingKey = deriveWrappingKey(sharedPoint);

    const iv = Buffer.from(wrapped.nonce, 'base64');
    if (iv.length !== IV_LENGTH) {
        throw new Error(`Invalid nonce length: expected ${IV_LENGTH}, got ${iv.length}`);
    }

    const payload = Buffer.from(wrapped.encryptedKey, 'base64');
    if (payload.length < AUTH_TAG_LENGTH + FIELD_KEY_LENGTH) {
        throw new Error('Wrapped key payload too short');
    }

    const authTag = payload.subarray(0, AUTH_TAG_LENGTH);
    const ciphertext = payload.subarray(AUTH_TAG_LENGTH);

    const decipher = createDecipheriv('aes-256-gcm', wrappingKey, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Derive an X25519 keypair from an Ed25519 private key via HKDF-SHA256.
 *
 * Used to produce:
 *   - The owner agent's vault X25519 key  (info: 'vault-owner-x25519-v1')
 *   - The node's vault X25519 key         (info: 'vault-node-x25519-v1')
 *
 * The same Ed25519 seed can safely produce both derivations because HKDF
 * with distinct info strings domain-separates the outputs.
 *
 * @param ed25519PrivKey  64-char hex Ed25519 private key (raw seed or PKCS#8)
 * @param info            Domain-separation string for HKDF
 */
export function deriveXKeypairFromEd25519(
    ed25519PrivKey: string,
    info: string,
): { privateKey: string; publicKey: string } {
    const seed = Buffer.from(extractPrivateKeySeed(ed25519PrivKey), 'hex');
    const infoBuffer = Buffer.from(info, 'utf8');
    const xPrivBytes = Buffer.from(hkdfSync('sha256', seed, X25519_HKDF_SALT, infoBuffer, X25519_KEY_LENGTH));
    const xPubBytes = x25519.getPublicKey(xPrivBytes);
    return {
        privateKey: xPrivBytes.toString('hex'),
        publicKey: Buffer.from(xPubBytes).toString('hex'),
    };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function deriveWrappingKey(sharedPoint: Uint8Array): Buffer {
    return Buffer.from(
        hkdfSync('sha256', sharedPoint, DELEGATION_HKDF_SALT, DELEGATION_HKDF_INFO, FIELD_KEY_LENGTH),
    );
}

function assertHex(value: string, expectedBytes: number, name: string): void {
    const expectedChars = expectedBytes * 2;
    if (!/^[0-9a-f]+$/i.test(value) || value.length !== expectedChars) {
        throw new Error(`${name} must be ${expectedChars} hex chars; got ${value.length}`);
    }
}
