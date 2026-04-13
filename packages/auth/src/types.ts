export interface Identity {
  id: string;
  scope: string;                // 'actor' | 'family' | 'community' | 'business'
  subtype?: string;             // scope-dependent: 'human' | 'agent' | 'device' | etc.
  name?: string;
  handle?: string;
  tier?: "soft" | "preliminary" | "established";
  chainVerified?: boolean;
  actingAs?: string;            // DID of group the caller is acting on behalf of
  actingAsServices?: string[];  // Services this controller can access (undefined = full access)
}

export interface AuthResult {
  identity: Identity;
}

export interface AuthError {
  error: string;
  status: number;
}

export type IdentityScope = "actor" | "family" | "community" | "business";
export type IdentityType = "human" | "agent"; // used in SignedMessage only — not identity table

export interface Keypair {
  privateKey: string; // 64-char hex (32 bytes)
  publicKey: string;  // 64-char hex (32 bytes)
}

export interface SignedMessage<T = unknown> {
  from: string;        // DID of signer
  type: IdentityType;
  timestamp: number;   // Unix ms
  payload: T;
  signature: string;   // 128-char hex (64 bytes)
}

export interface VerificationResult {
  valid: boolean;
  error?: string;
}
