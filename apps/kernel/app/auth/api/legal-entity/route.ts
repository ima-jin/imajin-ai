import { NextRequest, NextResponse } from 'next/server';
import { requireDocumentActor } from '@/src/lib/auth/document-authorization';
import { getOwnerLegalEntity, saveLegalEntity } from '@/src/lib/profile/legal-entity';
import {
  LEGAL_ENTITY_MAX_BYTES, LegalEntityValidationError, validateLegalEntityInput,
} from '@/src/lib/profile/legal-entity-schema';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

async function readInput(request: Request): Promise<unknown> {
  const tooLarge = () => new LegalEntityValidationError('legalEntity', `exceeds ${LEGAL_ENTITY_MAX_BYTES} bytes`);
  if (Number(request.headers.get('content-length')) > LEGAL_ENTITY_MAX_BYTES) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new LegalEntityValidationError('legalEntity', 'invalid JSON');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > LEGAL_ENTITY_MAX_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    if (error instanceof LegalEntityValidationError) throw error;
    throw new LegalEntityValidationError('legalEntity', 'invalid JSON');
  } finally {
    reader.releaseLock();
  }
}

function failure(error: unknown): NextResponse {
  if (error instanceof LegalEntityValidationError) {
    return NextResponse.json({ error: error.message, field: error.field }, { status: 400, headers });
  }
  // Never echo legal fields, storage paths, credentials or signer internals.
  return NextResponse.json({ error: 'Legal-entity document unavailable; no unsigned save is permitted' }, { status: 503, headers });
}

export async function GET(request: NextRequest) {
  const actor = await requireDocumentActor(request, { write: true });
  if (actor instanceof Response) return actor;
  try {
    return NextResponse.json({ document: await getOwnerLegalEntity(actor.effectiveDid) }, { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function PUT(request: NextRequest) {
  const actor = await requireDocumentActor(request, { write: true });
  if (actor instanceof Response) return actor;
  try {
    const input = validateLegalEntityInput(await readInput(request));
    await saveLegalEntity(actor.effectiveDid, actor.actingHumanDid, input);
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(request: NextRequest) {
  const actor = await requireDocumentActor(request, { write: true });
  if (actor instanceof Response) return actor;
  try {
    await saveLegalEntity(actor.effectiveDid, actor.actingHumanDid, null);
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) {
    return failure(error);
  }
}
