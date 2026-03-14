export interface FairSignature {
  algorithm: 'ed25519';
  value: string; // 128 hex chars (64 bytes)
  publicKeyRef: string; // DID of the signer
}

export interface FairEntry {
  did: string;
  role: string; // creator, collaborator, producer, performer, platform, venue, etc.
  share: number; // 0.0 to 1.0
  note?: string;
}

export interface FairTransfer {
  allowed: boolean;
  refundable?: boolean;
  resaleRoyalty?: number; // 0.0 to 1.0, royalty to original creator
  faceValueCap?: boolean; // prevent scalping above face value
}

export interface FairAccess {
  type: "public" | "private" | "trust-graph" | "conversation";
  allowedDids?: string[]; // for private access
  conversationDid?: string; // for conversation-scoped access
}

export interface FairIntegrity {
  hash: string; // sha256:...
  size: number; // bytes
}

export interface FairIntent {
  purpose: string;
  constraints?: Record<string, unknown>;
}

export interface FairManifest {
  fair: string; // version, e.g. "1.0"
  id: string; // asset/event ID
  type: string; // mime type or "event", "ticket", etc.
  owner: string; // DID of owner
  created: string; // ISO 8601
  source?: string; // "upload", "create", etc.
  access: FairAccess | "public" | "private";
  transfer?: FairTransfer;
  attribution: FairEntry[];
  distributions?: FairEntry[];
  integrity?: FairIntegrity;
  terms?: string; // license URL or text
  intent?: FairIntent; // stated purpose and optional constraints
  signature?: FairSignature; // creator signature (required in Phase 1)
  platformSignature?: FairSignature; // platform endorsement signature
  // backward compat with existing events code
  version?: string;
  chain?: FairEntry[]; // alias for attribution
}
