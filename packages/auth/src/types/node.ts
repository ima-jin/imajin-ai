/**
 * Node Registration Types
 * 
 * Types for the federated node network where anyone running
 * a signed Imajin build can register for a subdomain.
 */

import type { IdentityType } from '../types.js';

// =============================================================================
// NODE IDENTITY
// =============================================================================

/**
 * A node in the Imajin network.
 * Represents a self-hosted instance running Imajin services.
 */
export interface Node {
  /** Node DID (did:imajin:xxx) */
  id: string;
  
  /** Ed25519 public key (hex) */
  publicKey: string;
  
  /** Requested/assigned subdomain */
  hostname: string;
  
  /** Full subdomain URL */
  subdomain: string; // e.g., "jin.imajin.ai"
  
  /** Services this node runs */
  services: NodeService[];
  
  /** Node capabilities */
  capabilities: string[];
  
  /** Current status */
  status: NodeStatus;
  
  /** Registration timestamp */
  registeredAt: number;
  
  /** Last heartbeat timestamp */
  lastHeartbeat: number;
  
  /** Registration expiry timestamp */
  expiresAt: number;
  
  /** Current build attestation */
  attestation: NodeAttestation;
}

/**
 * Services a node can run
 */
export type NodeService = 
  | 'auth'      // Identity service
  | 'pay'       // Payment service
  | 'profile'   // User profiles
  | 'shop'      // E-commerce
  | 'fair'      // Attribution tracking
  | 'media'     // Media hosting
  | 'custom';   // Custom services

/**
 * Node status in the network
 */
export type NodeStatus =
  | 'pending'      // Awaiting verification
  | 'active'       // Verified and healthy
  | 'stale'        // Missed 3+ heartbeats
  | 'unreachable'  // Missed 7+ heartbeats
  | 'expired'      // Registration expired (in grace period)
  | 'revoked'      // Manually or automatically revoked
  | 'suspended';   // Temporarily suspended

// =============================================================================
// BUILD ATTESTATION
// =============================================================================

/**
 * Cryptographic attestation of what build a node is running.
 * Proves the node runs official/approved Imajin software.
 */
export interface NodeAttestation {
  /** Node DID */
  nodeId: string;
  
  /** Node's public key */
  publicKey: string;
  
  /** SHA256 hash of running binary/container */
  buildHash: string;
  
  /** Git commit SHA of source (for verification) */
  sourceCommit: string;
  
  /** Semantic version */
  version: string;
  
  /** Requested hostname */
  hostname: string;
  
  /** Services this node will run */
  services: NodeService[];
  
  /** Capabilities this node offers */
  capabilities: string[];
  
  /** Attestation timestamp */
  timestamp: number;
  
  /** Ed25519 signature over all fields */
  signature: string;
}

/**
 * Result of build verification
 */
export interface BuildVerification {
  /** Is the build hash known/approved? */
  valid: boolean;
  
  /** Source of verification */
  source: 'official' | 'fork' | 'unknown';
  
  /** If fork, who approved it */
  approvedBy?: string;
  
  /** Error message if invalid */
  error?: string;
}

// =============================================================================
// REGISTRATION
// =============================================================================

/**
 * Node registration request
 */
export interface NodeRegistrationRequest {
  /** The attestation to verify */
  attestation: NodeAttestation;
}

/**
 * Node registration response
 */
export interface NodeRegistrationResponse {
  /** Registration status */
  status: 'verified' | 'pending' | 'rejected';
  
  /** Assigned subdomain (if verified) */
  subdomain?: string;
  
  /** When registration expires */
  expiresAt?: number;
  
  /** Error message (if rejected) */
  error?: string;
  
  /** Hint for fixing rejection */
  hint?: string;
}

/**
 * Stored registration record
 */
export interface NodeRegistration {
  /** Node DID */
  nodeId: string;
  
  /** Assigned hostname */
  hostname: string;
  
  /** Full attestation */
  attestation: NodeAttestation;
  
  /** Current status */
  status: NodeStatus;
  
  /** Verification timestamp */
  verifiedAt?: number;
  
  /** Last heartbeat */
  lastHeartbeat: number;
  
  /** Registration expiry */
  expiresAt: number;
  
  /** Grace period expiry (after registration expires) */
  graceExpiresAt: number;
  
  /** Creation timestamp */
  createdAt: number;
  
  /** Last update timestamp */
  updatedAt: number;
}

// =============================================================================
// HEARTBEAT
// =============================================================================

/**
 * Node heartbeat request
 */
export interface NodeHeartbeat {
  /** Node DID */
  nodeId: string;
  
  /** Current timestamp */
  timestamp: number;
  
  /** Current build hash (for drift detection) */
  buildHash: string;
  
  /** Current version */
  version: string;
  
  /** Node health status */
  health: NodeHealth;
  
  /** Signature */
  signature: string;
}

/**
 * Node health information
 */
export interface NodeHealth {
  /** Overall status */
  status: 'healthy' | 'degraded' | 'unhealthy';
  
  /** Services and their status */
  services: Record<NodeService, 'up' | 'down' | 'degraded'>;
  
  /** Uptime in seconds */
  uptime: number;
  
  /** Optional metrics */
  metrics?: {
    requestsPerMinute?: number;
    errorRate?: number;
    latencyP50?: number;
    latencyP99?: number;
  };
}

/**
 * Heartbeat response
 */
export interface HeartbeatResponse {
  /** Acknowledged */
  ack: boolean;
  
  /** Next expected heartbeat */
  nextHeartbeat: number;
  
  /** Any actions required */
  actions?: HeartbeatAction[];
}

/**
 * Actions the registry may request from a node
 */
export type HeartbeatAction =
  | { type: 'upgrade'; targetVersion: string; reason: string }
  | { type: 'reattest'; reason: string }
  | { type: 'renew'; expiresIn: number };

// =============================================================================
// MESH TRUST (Optical Verification)
// =============================================================================

/**
 * Trust relationship between two nodes established via optical verification.
 * From LIGHT_AUTH_SPEC.md device-to-device verification.
 */
export interface NodeTrust {
  /** Source node DID */
  fromNode: string;
  
  /** Target node DID */
  toNode: string;
  
  /** When trust was established */
  establishedAt: number;
  
  /** How trust was verified */
  verificationMethod: 'optical' | 'network' | 'manual';
  
  /** Trust strength (0.0 - 1.0) */
  strength: number;
  
  /** Last verification */
  lastVerified: number;
  
  /** Signatures from both parties */
  signatures: {
    from: string;
    to: string;
  };
}

/**
 * Local trust network a node maintains
 */
export interface LocalTrustNetwork {
  /** This node's DID */
  nodeId: string;
  
  /** Known trusted nodes */
  trustedNodes: NodeTrust[];
  
  /** Last sync with central registry */
  lastSync?: number;
}
