import { NextRequest, NextResponse } from 'next/server';
import { db, contacts, mailingLists, subscriptions } from '@/db';
import { eq } from 'drizzle-orm';

// Simple email validation
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Normalize email (lowercase, trim)
function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email: rawEmail, source = 'register' } = body;

    // Validate
    if (!rawEmail || typeof rawEmail !== 'string') {
      return NextResponse.json(
        { error: 'Email is required' },
        { status: 400 }
      );
    }

    const email = normalizeEmail(rawEmail);

    if (!isValidEmail(email)) {
      return NextResponse.json(
        { error: 'Invalid email address' },
        { status: 400 }
      );
    }

    // Get or create the default mailing list
    let defaultList = await db.query.mailingLists.findFirst({
      where: eq(mailingLists.slug, 'updates'),
    });

    if (!defaultList) {
      // Create default list if it doesn't exist
      const [newList] = await db.insert(mailingLists).values({
        slug: 'updates',
        name: 'Imajin Updates',
        description: 'Progress updates on sovereign infrastructure',
      }).returning();
      defaultList = newList;
    }

    // Check if contact already exists
    let contact = await db.query.contacts.findFirst({
      where: eq(contacts.email, email),
    });

    if (contact) {
      // Check if already subscribed
      const existingSub = await db.query.subscriptions.findFirst({
        where: eq(subscriptions.contactId, contact.id),
      });

      if (existingSub && existingSub.status === 'subscribed') {
        return NextResponse.json({
          success: true,
          message: 'You\'re already on the list!',
        });
      }

      // Resubscribe if previously unsubscribed
      if (existingSub) {
        await db.update(subscriptions)
          .set({ 
            status: 'subscribed', 
            subscribedAt: new Date(),
            unsubscribedAt: null,
          })
          .where(eq(subscriptions.id, existingSub.id));
      } else {
        await db.insert(subscriptions).values({
          contactId: contact.id,
          mailingListId: defaultList.id,
        });
      }
    } else {
      // Create new contact and subscription
      const [newContact] = await db.insert(contacts).values({
        email,
        source,
      }).returning();

      await db.insert(subscriptions).values({
        contactId: newContact.id,
        mailingListId: defaultList.id,
      });
    }

    return NextResponse.json({
      success: true,
      message: 'You\'re on the list!',
    });

  } catch (error) {
    console.error('Subscribe error:', error);
    return NextResponse.json(
      { error: 'Something went wrong' },
      { status: 500 }
    );
  }
}
