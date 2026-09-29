export type { VaultCustodyScheme } from '@/src/lib/vault/field-grammar';
import type { VaultCustodyScheme } from '@/src/lib/vault/field-grammar';

export type VaultHistoryAction = 'set' | 'rotate';
export type VaultGrantStatus = 'active' | 'none';

export interface VaultSecretRow {
  field: string;
  hint: string;
  cid: string;
  setBy: string;
  updatedAt: string;
  custodyScheme: VaultCustodyScheme;
  /** Only present when custodyScheme === 'delegation-grant' */
  grantedTo?: string | null;
  expiresAt?: string | null;
  grantStatus?: VaultGrantStatus;
}

export interface VaultHistoryEntry {
  field: string;
  cid: string;
  setBy: string;
  updatedAt: string;
  action: VaultHistoryAction;
}

export interface SetSecretInput {
  field: string;
  value: string;
  hint: string;
  custodyScheme: VaultCustodyScheme;
}

export interface RotateSecretInput {
  field: string;
  value: string;
  hint: string;
}

export interface VaultListApiRow {
  field: string;
  hint: string;
  cid: string;
  senderDid: string;
  timestamp: string;
  status: 'active' | 'deleted';
  custodyScheme: VaultCustodyScheme;
  grantedTo?: string | null;
  expiresAt?: string | null;
  grantStatus?: VaultGrantStatus;
}

export interface VaultHistoryApiRow {
  cid: string;
  previousCid: string | null;
  senderDid: string;
  timestamp: string;
}

export interface VaultHistoryApiResponse {
  field: string;
  chain: VaultHistoryApiRow[];
}

export interface VaultWriteApiResponse {
  field: string;
  cid: string;
  timestamp: string;
  senderDid: string;
  status: 'confirmed' | 'pending';
  custodyScheme?: VaultCustodyScheme;
  grantId?: string;
}

export interface UpgradeCustodyApiResponse {
  field: string;
  cid: string;
  timestamp: string;
  senderDid: string;
  custodyScheme: 'delegation-grant';
  grantId: string;
  grantedTo: string;
}

export interface DeleteVaultApiResponse {
  ok: true;
  field: string;
  cid: string;
  timestamp: string;
}

/** A field the kernel is known to read by a fixed name (#2445 defect 4) — see GET /api/vault/known-fields. */
export interface KnownVaultFieldApiRow {
  field: string;
  description: string;
  requiredCustody?: VaultCustodyScheme;
  why?: string;
}

export interface KnownVaultFieldsApiResponse {
  fields: KnownVaultFieldApiRow[];
}
