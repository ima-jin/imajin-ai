import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { corsHeaders } from '@imajin/config';
import { db, attestations, assets } from '@/src/db';
import { requireDocumentActor, canReadDocument } from '@/src/lib/auth/document-authorization';

export const dynamic = 'force-dynamic';

function previewMime(mimeType: string): string {
  if (mimeType.startsWith('text/')) return 'text/plain; charset=utf-8';
  if (['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) return mimeType;
  return 'application/octet-stream';
}

/** A signing invitation exposes one immutable document, never its owner's library. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const cors = corsHeaders(request);
  const actor = await requireDocumentActor(request);
  if (actor instanceof Response) return actor;
  const { id } = await params;
  const [document] = await db.select().from(attestations).where(eq(attestations.id, id)).limit(1);
  if (!document?.documentAssetId || !document.documentHash) {
    return NextResponse.json({ error: 'Document not found' }, { status: 404, headers: cors });
  }
  if (!await canReadDocument(id, document.issuerDid, actor)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403, headers: cors });
  }
  const [asset] = await db.select().from(assets).where(eq(assets.id, document.documentAssetId)).limit(1);
  if (asset?.status !== 'active') {
    return NextResponse.json({ error: 'Document asset not found' }, { status: 404, headers: cors });
  }
  let file: Buffer;
  try {
    file = await readFile(asset.storagePath);
  } catch {
    return NextResponse.json({ error: 'Document file unavailable' }, { status: 404, headers: cors });
  }
  if (createHash('sha256').update(file).digest('hex') !== document.documentHash) {
    return NextResponse.json({ error: 'Document hash mismatch — stored file has changed' }, { status: 409, headers: cors });
  }
  const headers = new Headers(cors);
  const download = request.nextUrl.searchParams.get('download') === 'true';
  headers.set('Content-Type', previewMime(asset.mimeType));
  headers.set('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(asset.filename)}`);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', "sandbox; default-src 'none'");
  headers.set('X-Document-Hash', document.documentHash);
  return new NextResponse(new Uint8Array(file), { headers });
}

export { preflight as OPTIONS } from '@/app/auth/lib/preflight';
