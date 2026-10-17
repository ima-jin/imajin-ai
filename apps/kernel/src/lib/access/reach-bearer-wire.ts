/** Public inbox metadata only: never include bearer credentials or token hashes. */
export interface ReachBearerKnock {
  requestId: string;
  requesterDid: string;
  principalDid: string;
  agentLabel: string;
  onBehalfOf: {
    platform: string;
    externalRef: string;
    selfDescription?: string;
  };
  claimVerified: false;
  issuedAt: string;
  expiresAt: string;
  hardCapAt: string;
  status: string;
}

export function reachBearerKnockMetadata(knock: ReachBearerKnock): ReachBearerKnock {
  return {
    requestId: knock.requestId,
    requesterDid: knock.requesterDid,
    principalDid: knock.principalDid,
    agentLabel: knock.agentLabel,
    onBehalfOf: {
      platform: knock.onBehalfOf.platform,
      externalRef: knock.onBehalfOf.externalRef,
      ...(knock.onBehalfOf.selfDescription === undefined ? {} : { selfDescription: knock.onBehalfOf.selfDescription }),
    },
    claimVerified: false,
    issuedAt: knock.issuedAt,
    expiresAt: knock.expiresAt,
    hardCapAt: knock.hardCapAt,
    status: knock.status,
  };
}
