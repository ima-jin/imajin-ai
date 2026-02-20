/**
 * Inlined auth module for registry service
 * 
 * TODO: Replace with @imajin/auth from npm when published
 * See: https://github.com/ima-jin/imajin-ai/issues/XX
 */

import * as ed25519 from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha512';

// Configure ed25519 to use sha512
ed25519.etc.sha512Sync = (...m) => sha512(ed25519.etc.concatBytes(...m));

// =============================================================================
// TIME HELPERS
// =============================================================================

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// =============================================================================
// CONSTANTS
// =============================================================================

export const SIGNED_MESSAGE_MAX_AGE = 5 * MINUTE;
export const FUTURE_TOLERANCE = 30 * SECOND;
export const NODE_REGISTRATION_TTL = 30 * DAY;
export const NODE_HEARTBEAT_INTERVAL = 24 * HOUR;
export const NODE_STALE_THRESHOLD = 3 * DAY;
export const NODE_UNREACHABLE_THRESHOLD = 7 * DAY;
export const NODE_GRACE_PERIOD = 7 * DAY;

// =============================================================================
// TYPES
// =============================================================================

export type IdentityType = 
  | 'human'
  | 'agent'
  | 'device'
  | 'org'
  | 'event'
  | 'service';

export type NodeService = 
  | 'auth'
  | 'pay'
  | 'profile'
  | 'shop'
  | 'fair'
  | 'media'
  | 'custom';

export interface SignedMessage<T = unknown> {
  from: string;
  type: IdentityType;
  timestamp: number;
  payload: T;
  signature: string;
}

export interface VerificationResult {
  valid: boolean;
  error?: string;
}

export interface NodeAttestation {
  nodeId: string;
  publicKey: string;
  buildHash: string;
  sourceCommit: string;
  version: string;
  hostname: string;
  services: NodeService[];
  capabilities: string[];
  timestamp: number;
  signature: string;
}

export interface NodeHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  services: Record<NodeService, 'up' | 'down' | 'degraded'>;
  uptime: number;
  metrics?: {
    requestsPerMinute?: number;
    errorRate?: number;
    latencyP50?: number;
    latencyP99?: number;
  };
}

export interface NodeHeartbeat {
  nodeId: string;
  timestamp: number;
  buildHash: string;
  version: string;
  health: NodeHealth;
  signature: string;
}

// =============================================================================
// CRYPTO HELPERS
// =============================================================================

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function isValidPublicKey(hex: string): boolean {
  if (typeof hex !== 'string') return false;
  if (hex.length !== 64) return false;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return false;
  return true;
}

function isValidSignature(hex: string): boolean {
  if (typeof hex !== 'string') return false;
  if (hex.length !== 128) return false;
  if (!/^[0-9a-fA-F]+$/.test(hex)) return false;
  return true;
}

function verifySignature(
  signature: string,
  message: string | Uint8Array,
  publicKeyHex: string
): boolean {
  try {
    const signatureBytes = hexToBytes(signature);
    const messageBytes = typeof message === 'string' ? stringToBytes(message) : message;
    const publicKey = hexToBytes(publicKeyHex);
    return ed25519.verify(signatureBytes, messageBytes, publicKey);
  } catch {
    return false;
  }
}

// =============================================================================
// CANONICALIZE
// =============================================================================

export function canonicalize(obj: unknown): string {
  if (obj === null) return 'null';
  if (obj === undefined) return 'undefined';
  
  if (typeof obj === 'boolean' || typeof obj === 'number') {
    return JSON.stringify(obj);
  }
  
  if (typeof obj === 'string') {
    return JSON.stringify(obj);
  }
  
  if (Array.isArray(obj)) {
    return '[' + obj.map(canonicalize).join(',') + ']';
  }
  
  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    const pairs = keys.map(k => 
      JSON.stringify(k) + ':' + canonicalize((obj as Record<string, unknown>)[k])
    );
    return '{' + pairs.join(',') + '}';
  }
  
  return String(obj);
}

// =============================================================================
// VERIFY
// =============================================================================

interface VerifyOptions {
  maxAge?: number;
  maxFuture?: number;
  skipTimestampCheck?: boolean;
}

function isValidMessageStructure(message: unknown): message is SignedMessage {
  if (typeof message !== 'object' || message === null) return false;
  
  const m = message as Record<string, unknown>;
  
  return (
    typeof m.from === 'string' &&
    (m.type === 'human' || m.type === 'agent' || m.type === 'device' || 
     m.type === 'org' || m.type === 'event' || m.type === 'service') &&
    typeof m.timestamp === 'number' &&
    typeof m.signature === 'string' &&
    'payload' in m
  );
}

export async function verify(
  message: SignedMessage,
  publicKey: string,
  options: VerifyOptions = {}
): Promise<VerificationResult> {
  try {
    if (!isValidMessageStructure(message)) {
      return { valid: false, error: 'Invalid message structure' };
    }
    
    if (!isValidPublicKey(publicKey)) {
      return { valid: false, error: 'Invalid public key format' };
    }
    
    if (!isValidSignature(message.signature)) {
      return { valid: false, error: 'Invalid signature format' };
    }
    
    if (!options.skipTimestampCheck) {
      const maxAge = options.maxAge ?? SIGNED_MESSAGE_MAX_AGE;
      const maxFuture = options.maxFuture ?? FUTURE_TOLERANCE;
      const now = Date.now();
      const age = now - message.timestamp;
      
      if (maxAge > 0 && age > maxAge) {
        return { valid: false, error: 'Message expired' };
      }
      
      if (age < -maxFuture) {
        return { valid: false, error: 'Timestamp in future' };
      }
    }
    
    const { signature, ...rest } = message;
    const canonical = canonicalize(rest);
    const valid = verifySignature(signature, canonical, publicKey);
    
    if (!valid) {
      return { valid: false, error: 'Invalid signature' };
    }
    
    return { valid: true };
  } catch (error) {
    return { 
      valid: false, 
      error: error instanceof Error ? error.message : 'Verification failed' 
    };
  }
}
