import { NextRequest, NextResponse } from 'next/server';
import { eq, and } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { db, contactMetadata } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';

const VALID_RELATIONSHIP_TYPES = new Set(['business', 'group', 'person', 'collective']);

/**
 * PUT /api/broker/contacts/[did]/metadata — upsert label and relationship type
 * for a contact in the disclosure dashboard (#1220).
 *
 * Auth: subject only — callers can only set metadata for their own contacts.
 *
 * Body:
 *   label?            string  — human-readable display name (e.g. "Acme Restaurant")
 *   relationshipType? string  — 'business' | 'group' | 'person' | 'collective'
 *
 * Passing null for either field clears it.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: { did: string } },
) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const subject = resolveActingDid(authResult.identity);

  const contactDid = decodeURIComponent(params.did).trim();
  if (!contactDid) {
    return NextResponse.json({ error: 'did is required' }, { status: 400 });
  }

  let body: { label?: string | null; relationshipType?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (
    body.relationshipType !== undefined &&
    body.relationshipType !== null &&
    !VALID_RELATIONSHIP_TYPES.has(body.relationshipType)
  ) {
    return NextResponse.json(
      { error: "relationshipType must be 'business', 'group', 'person', or 'collective'" },
      { status: 400 },
    );
  }

  const now = new Date();

  // Upsert: insert or update on (subject, did) conflict.
  const [existing] = await db
    .select({ id: contactMetadata.id })
    .from(contactMetadata)
    .where(
      and(
        eq(contactMetadata.subject, subject),
        eq(contactMetadata.did, contactDid),
      ),
    )
    .limit(1);

  let row;
  if (existing) {
    [row] = await db
      .update(contactMetadata)
      .set({
        ...('label' in body ? { label: body.label ?? null } : {}),
        ...('relationshipType' in body ? { relationshipType: body.relationshipType ?? null } : {}),
        updatedAt: now,
      })
      .where(eq(contactMetadata.id, existing.id))
      .returning();
  } else {
    [row] = await db
      .insert(contactMetadata)
      .values({
        id: generateId('cm'),
        subject,
        did: contactDid,
        label: body.label ?? null,
        relationshipType: body.relationshipType ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
  }

  return NextResponse.json({ metadata: row });
}
