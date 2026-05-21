export type VaultReloadStatus = 'confirmed' | 'pending';
export type VaultHistoryAction = 'set' | 'rotate';

export interface VaultSecretRow {
  field: string;
  hint: string;
  cid: string;
  setBy: string;
  updatedAt: string;
  status: VaultReloadStatus;
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
  setBy: string;
}

export interface RotateSecretInput {
  field: string;
  setBy: string;
}
