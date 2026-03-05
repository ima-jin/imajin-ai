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
  type: "public" | "private" | "trust-graph";
  allowedDids?: string[]; // for private access
}

export interface FairIntegrity {
  hash: string; // sha256:...
  size: number; // bytes
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
  // backward compat with existing events code
  version?: string;
  chain?: FairEntry[]; // alias for attribution
}
