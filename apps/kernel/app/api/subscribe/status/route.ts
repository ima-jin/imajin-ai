/**
 * GET /api/subscribe/status?email=...
 * Returns the subscription status for an email address.
 *
 * PATCH /api/subscribe/status
 * Toggle subscription on/off. Body: { email, subscribed: boolean }
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, contacts, subscriptions, mailingLists } from '@/src/db';
import { eq, and } from 'drizzle-orm';

export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get('email');
  if (!email) {
    return NextResponse.json({ subscribed: false });
  }

  const normalized = email.toLowerCase().trim();

  const contact = await db.query.contacts.findFirst({
    where: eq(contacts.email, normalized),
  });

  if (!contact) {
    return NextResponse.json({ subscribed: false });
  }

  const [sub] = await db
    .select({ status: subscriptions.status, listName: mailingLists.name })
    .from(subscriptions)
    .innerJoin(mailingLists, eq(mailingLists.id, subscriptions.mailingListId))
    .where(and(
      eq(subscriptions.contactId, contact.id),
      eq(mailingLists.slug, 'updates'),
    ))
    .limit(1);

  return NextResponse.json({
    subscribed: sub?.status === 'subscribed',
  });
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  const { email: rawEmail, subscribed } = body;

  if (!rawEmail || typeof rawEmail !== 'string') {
    return NextResponse.json({ error: 'email required' }, { status: 400 });
  }

  const email = rawEmail.toLowerCase().trim();

  // Get or create the updates mailing list
  let list = await db.query.mailingLists.findFirst({
    where: eq(mailingLists.slug, 'updates'),
  });
  if (!list) {
    const [newList] = await db.insert(mailingLists).values({
      slug: 'updates',
      name: 'Imajin Updates',
      description: 'Progress updates on sovereign infrastructure',
    }).returning();
    list = newList;
  }

  // Get or create contact
  let contact = await db.query.contacts.findFirst({
    where: eq(contacts.email, email),
  });
  if (!contact) {
    const [newContact] = await db.insert(contacts).values({
      email,
      source: 'profile',
      isVerified: true, // they're logged in and it's their profile email
    }).returning();
    contact = newContact;
  }

  // Find existing subscription
  const existingSub = await db.query.subscriptions.findFirst({
    where: and(
      eq(subscriptions.contactId, contact.id),
      eq(subscriptions.mailingListId, list.id),
    ),
  });

  if (subscribed) {
    if (existingSub) {
      await db.update(subscriptions)
        .set({ status: 'subscribed', subscribedAt: new Date(), unsubscribedAt: null })
        .where(eq(subscriptions.id, existingSub.id));
    } else {
      await db.insert(subscriptions).values({
        contactId: contact.id,
        mailingListId: list.id,
      });
    }
  } else {
    if (existingSub) {
      await db.update(subscriptions)
        .set({ status: 'unsubscribed', unsubscribedAt: new Date() })
        .where(eq(subscriptions.id, existingSub.id));
    }
  }

  return NextResponse.json({ subscribed: !!subscribed });
}
