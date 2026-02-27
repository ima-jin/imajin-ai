export type PodType = 'personal' | 'shared';
export type PodVisibility = 'private' | 'trust-bound';
export type PodRole = 'owner' | 'admin' | 'member';

export interface Pod {
  id: string;
  name: string;
  description: string | null;
  avatar: string | null;
  ownerDid: string;
  type: PodType;
  visibility: PodVisibility;
  createdAt: Date;
  updatedAt: Date;
}

export interface PodMember {
  podId: string;
  did: string;
  role: PodRole;
  addedBy: string | null;
  joinedAt: Date;
  removedAt: Date | null;
}

export interface PodLink {
  parentPodId: string;
  childPodId: string;
  linkedBy: string | null;
  linkedAt: Date;
  unlinkedAt: Date | null;
}

export interface PodKey {
  podId: string;
  version: number;
  rotatedAt: Date;
  rotatedBy: string | null;
}

export interface PodMemberKey {
  podId: string;
  version: number;
  did: string;
  encryptedPodKey: string;
}
