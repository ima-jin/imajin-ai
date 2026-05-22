import { db, attestations, attestationSignatures, identities } from '@/src/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import DocumentSigningCard from './DocumentSigningCard';

type DocumentRoleFilter = 'created' | 'needs-signature';

const DOCUMENT_TYPES = ['document.created', 'document.amended'] as const;

interface Props {
  sessionDid: string;
  role: DocumentRoleFilter;
}

export default async function DocumentList({ sessionDid, role }: Props) {
  let rows: typeof attestations.$inferSelect[] = [];

  if (role === 'created') {
    rows = await db
      .select()
      .from(attestations)
      .where(
        and(
          inArray(attestations.type, [...DOCUMENT_TYPES]),
          eq(attestations.issuerDid, sessionDid)
        )
      )
      .orderBy(desc(attestations.issuedAt))
      .limit(50);
  } else {
    const pendingRows = await db
      .select({ attestationId: attestationSignatures.attestationId })
      .from(attestationSignatures)
      .where(
        and(
          eq(attestationSignatures.signerDid, sessionDid),
          eq(attestationSignatures.status, 'pending')
        )
      );

    const pendingIds = [...new Set(pendingRows.map((row) => row.attestationId))];
    if (pendingIds.length > 0) {
      rows = await db
        .select()
        .from(attestations)
        .where(
          and(
            inArray(attestations.id, pendingIds),
            inArray(attestations.type, [...DOCUMENT_TYPES]),
            eq(attestations.attestationStatus, 'collecting')
          )
        )
        .orderBy(desc(attestations.issuedAt))
        .limit(50);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-10 text-center text-zinc-500">
        {role === 'created' ? 'No documents created yet' : 'No documents currently need your signature'}
      </div>
    );
  }

  const attestationIds = rows.map((row) => row.id);
  const signatures = await db
    .select()
    .from(attestationSignatures)
    .where(inArray(attestationSignatures.attestationId, attestationIds));

  const signerDids = [...new Set(signatures.map((sig) => sig.signerDid))];
  const signerIdentities = signerDids.length
    ? await db
        .select({
          id: identities.id,
          handle: identities.handle,
          name: identities.name,
          avatarUrl: identities.avatarUrl,
        })
        .from(identities)
        .where(inArray(identities.id, signerDids))
    : [];
  const signerIdentityMap = new Map(signerIdentities.map((identity) => [identity.id, identity]));

  const signaturesByAttestation = new Map<string, typeof signatures>();
  for (const signature of signatures) {
    const existing = signaturesByAttestation.get(signature.attestationId) ?? [];
    existing.push(signature);
    signaturesByAttestation.set(signature.attestationId, existing);
  }

  return (
    <div className="space-y-3">
      {rows.map((attestation) => {
        const signaturesForAttestation = (signaturesByAttestation.get(attestation.id) ?? []).map((signature) => ({
          ...signature,
          identity: signerIdentityMap.get(signature.signerDid) ?? null,
        }));

        return (
          <div key={attestation.id} className="space-y-2">
            <DocumentSigningCard
              attestation={attestation as any}
              signatures={signaturesForAttestation}
              sessionDid={sessionDid}
            />
            <div className="px-1">
              <Link
                href={`/auth/documents/${attestation.id}`}
                className="text-xs text-zinc-500 hover:text-amber-400 transition-colors"
              >
                Open document detail →
              </Link>
            </div>
          </div>
        );
      })}
    </div>
  );
}
