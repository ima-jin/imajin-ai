import type { AppDeclaredSecretStatus } from './self-secrets';

export interface AppSecretsProvenance {
  created: { at: string | null; by: string | null };
  provisioned: { at: string | null; proposedBy: string | null; approvedBy: string | null };
  claimed: { at: string | null; by: string | null };
  lastSeen: { at: string | null; by: string | null };
}

export interface OperatorAppSecrets {
  appDid: string | null;
  slug: string | null;
  name: string;
  claimed: boolean;
  active: boolean;
  claimExpiresAt: string | null;
  provisionFailed?: boolean;
  provenance: AppSecretsProvenance;
  secrets: AppDeclaredSecretStatus[];
}

/** Defense at the HTTP boundary: never spread ledger, approval or vault records. */
export function publicAppSecrets(app: OperatorAppSecrets): OperatorAppSecrets {
  const { created, provisioned, claimed, lastSeen } = app.provenance;
  return {
    appDid: app.appDid, slug: app.slug, name: app.name, claimed: app.claimed, active: app.active,
    claimExpiresAt: app.claimExpiresAt,
    ...(app.provisionFailed === undefined ? {} : { provisionFailed: app.provisionFailed }),
    provenance: {
      created: { at: created.at, by: created.by },
      provisioned: { at: provisioned.at, proposedBy: provisioned.proposedBy, approvedBy: provisioned.approvedBy },
      claimed: { at: claimed.at, by: claimed.by },
      lastSeen: { at: lastSeen.at, by: lastSeen.by },
    },
    secrets: app.secrets.map(({ name, kind, status, timeline }) => ({
      name, kind, status,
      timeline: timeline.map(({ phase, at, operatorDid, via, grantId }) => ({
        phase, at, ...(operatorDid ? { operatorDid } : {}), ...(via ? { via } : {}), ...(grantId ? { grantId } : {}),
      })),
    })),
  };
}
