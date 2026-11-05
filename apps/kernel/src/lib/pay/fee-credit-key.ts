interface FeeCreditIdentity {
  transactionId: string;
  role: string;
  recipientDid: string;
  /** Absolute manifest position: caller-supplied chains may repeat a role/DID. */
  chainIndex?: number;
}

/** Payment/manifest identity shared by wallet claims and ledger receipts. */
export function feeCreditKey({ transactionId, role, recipientDid, chainIndex }: FeeCreditIdentity): string {
  const key = `fee:${transactionId}:${role}:${recipientDid}`;
  return chainIndex === undefined ? key : `${key}:${chainIndex}`;
}

export type { FeeCreditIdentity };
