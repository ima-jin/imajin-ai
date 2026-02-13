/**
 * Core types for Imajin Auth
 */

export type IdentityType = 'human' | 'agent';

export interface Identity {
  /** Unique identifier (did:imajin:xxx or legacy ID) */
  id: string;
  
  /** Type of identity */
  type: IdentityType;
  
  /** Ed25519 public key (hex or base64) */
  publicKey: string;
  
  /** Optional metadata */
  metadata?: IdentityMetadata;
  
  /** Creation timestamp */
  createdAt?: Date;
}

export interface IdentityMetadata {
  /** Display name */
  name?: string;
  
  /** Avatar URL */
  avatar?: string;
  
  /** For agents: what they can do */
  capabilities?: string[];
  
  /** For agents: who owns them */
  ownerId?: string;
  
  /** Arbitrary extra data */
  [key: string]: unknown;
}

export interface SignedMessage<T = unknown> {
  /** Identity ID of sender */
  from: string;
  
  /** Type of sender */
  type: IdentityType;
  
  /** Unix timestamp (ms) */
  timestamp: number;
  
  /** The actual payload */
  payload: T;
  
  /** Ed25519 signature of canonical JSON */
  signature: string;
}

export interface Keypair {
  /** Public key (hex) */
  publicKey: string;
  
  /** Private key (hex) - keep secret! */
  privateKey: string;
}

export interface VerificationResult {
  /** Was the signature valid? */
  valid: boolean;
  
  /** The identity if found */
  identity?: Identity;
  
  /** Error message if invalid */
  error?: string;
}

export interface AuthChallenge {
  /** Challenge ID */
  id: string;
  
  /** Random string to sign */
  challenge: string;
  
  /** When this expires */
  expiresAt: Date;
}
