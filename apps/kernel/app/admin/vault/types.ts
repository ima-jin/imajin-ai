export type VaultReloadStatus = 'confirmed' | 'pending';
export type VaultHistoryAction = 'set' | 'rotate';
export type VaultCustodyScheme = 'node-sealed' | 'delegation-grant';
export type VaultGrantStatus = 'active' | 'none';

export interface VaultSecretRow {
  field: string;
  hint: string;
  cid: string;
  setBy: string;
  updatedAt: string;
  status: VaultReloadStatus;
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
  status: VaultReloadStatus;
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

export interface AdminEventRow {
  action: string;
  payload: Record<string, unknown> | null;
}

export interface AdminEventsApiResponse {
  rows: AdminEventRow[];
  total: number;
}
