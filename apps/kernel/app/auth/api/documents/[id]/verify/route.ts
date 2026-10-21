import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { db, attestations, attestationSignatures, identities } from '@/src/db';
import { eq, inArray } from 'drizzle-orm';
import { requireDocumentActor, canReadDocument } from '@/src/lib/auth/document-authorization';
import { verifyDocumentFile } from '@/src/lib/auth/verify-document';

export const dynamic = 'force-dynamic';
const MAX_VERIFY_BYTES = 25 * 1024 * 1024;

/** Party-only verification never discloses unrelated assets or org documents. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const cors = corsHeaders(request);
  const actor = await requireDocumentActor(request);
  if (actor instanceof Response) return actor;
  const { id } = await params;
  const [document] = await db.select().from(attestations).where(eq(attestations.id, id)).limit(1);
  if (!document?.documentHash) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404, headers: cors });
  }
  const signatures = await db.select().from(attestationSignatures)
    .where(eq(attestationSignatures.attestationId, id));
  if (!await canReadDocument(id, document.issuerDid, actor)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403, headers: cors });
  }
  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get('file');
  } catch {
    return NextResponse.json({ error: 'Upload a file to verify' }, { status: 400, headers: cors });
  }
  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: 'file required' }, { status: 400, headers: cors });
  }
  if (file.size > MAX_VERIFY_BYTES) {
    return NextResponse.json({ error: 'File exceeds 25 MB verification limit' }, { status: 413, headers: cors });
  }
  const signerDids = signatures.map((signature) => signature.signerDid);
  const keys = signerDids.length ? await db.select({ id: identities.id, publicKey: identities.publicKey })
    .from(identities).where(inArray(identities.id, signerDids)) : [];
  const result = await verifyDocumentFile(new Uint8Array(await file.arrayBuffer()), document, signatures,
    new Map(keys.map((key) => [key.id, key.publicKey])));
  return NextResponse.json(result, { headers: cors });
}

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
