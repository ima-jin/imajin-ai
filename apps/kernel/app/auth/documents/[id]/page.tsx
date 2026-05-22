import { cookies } from 'next/headers';
import { getSessionCookieOptions, verifySessionToken } from '@/src/lib/auth/jwt';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { and, eq, inArray } from 'drizzle-orm';
import { attestations, attestationSignatures, db, identities } from '@/src/db';
import DocumentSigningCard, { type DocumentAttestation, type Signature } from '../../attestations/components/DocumentSigningCard';

interface PageProps {
  params: Promise<{ id: string }>;
}

const DOCUMENT_TYPES = ['document.created', 'document.amended'] as const;

export default async function DocumentDetailPage({ params }: Readonly<PageProps>) {
  const { id } = await params;

  const cookieConfig = getSessionCookieOptions();
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(cookieConfig.name)?.value;

  let sessionDid: string | null = null;
  if (sessionToken) {
    const session = await verifySessionToken(sessionToken);
    sessionDid = session?.sub ?? null;
  }

  if (!sessionDid) {
    redirect('/auth');
  }

  const actingAs = cookieStore.get('x-acting-as')?.value || null;
  const effectiveDid = actingAs || sessionDid;

  const [attestation] = await db
    .select()
    .from(attestations)
    .where(
      and(
        eq(attestations.id, id),
        inArray(attestations.type, [...DOCUMENT_TYPES])
      )
    )
    .limit(1);

  const [mySignature] = attestation
    ? await db
        .select({ id: attestationSignatures.id })
        .from(attestationSignatures)
        .where(
          and(
            eq(attestationSignatures.attestationId, attestation.id),
            eq(attestationSignatures.signerDid, effectiveDid)
          )
        )
        .limit(1)
    : [];

  const canAccess = !!attestation && (attestation.issuerDid === effectiveDid || !!mySignature);

  if (!canAccess || !attestation) {
    return (
      <div className="space-y-4">
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-8 text-center text-zinc-500">
          Document not found or access denied.
        </div>
        <Link href="/auth/documents" className="text-sm text-zinc-500 hover:text-amber-400 transition-colors">
          ← Back to documents
        </Link>
      </div>
    );
  }

  const signatures = await db
    .select()
    .from(attestationSignatures)
    .where(eq(attestationSignatures.attestationId, attestation.id));

  const signerDids = [...new Set(signatures.map((signature) => signature.signerDid))];
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

  const signaturesWithIdentity: Signature[] = signatures.map((signature) => ({
    ...signature,
    identity: signerIdentityMap.get(signature.signerDid) ?? null,
  }));
  const cardAttestation: DocumentAttestation = attestation;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Document</h2>
        <Link href="/auth/documents" className="text-sm text-zinc-500 hover:text-amber-400 transition-colors">
          ← Back to documents
        </Link>
      </div>
      <DocumentSigningCard
        attestation={cardAttestation}
        signatures={signaturesWithIdentity}
        sessionDid={effectiveDid}
        defaultExpanded
      />
    </div>
  );
}
