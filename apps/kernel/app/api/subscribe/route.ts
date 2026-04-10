import { NextRequest, NextResponse } from 'next/server';
import { db, contacts, mailingLists, subscriptions } from '@/src/db';
import { eq } from 'drizzle-orm';
import { sendEmail } from '@imajin/email';
import { generateVerifyToken, verifyTokenExpiry } from '@/src/lib/www/subscribe-tokens';
import { verificationEmail, verificationEmailText } from '@/src/lib/www/verify-email-template';

// Simple email validation
function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Normalize email (lowercase, trim)
function normalizeEmail(email: string): string {
  return email.toLowerCase().trim();
}

async function sendVerificationEmail(email: string, baseUrl: string): Promise<void> {
  const expiresAt = verifyTokenExpiry();
  const token = generateVerifyToken(email, expiresAt);
  const verifyUrl = `${baseUrl}/api/subscribe/verify?email=${encodeURIComponent(email)}&token=${token}&expires=${expiresAt}`;

  await sendEmail({
    to: email,
    subject: 'Confirm your email — Imajin',
    html: verificationEmail(verifyUrl),
    text: verificationEmailText(verifyUrl),
  });
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

    const baseUrl = process.env.WWW_URL || process.env.NEXT_PUBLIC_URL || new URL(request.url).origin;

    // Get or create the default mailing list
    let defaultList = await db.query.mailingLists.findFirst({
      where: eq(mailingLists.slug, 'updates'),
    });

    if (!defaultList) {
      const [newList] = await db.insert(mailingLists).values({
        slug: 'updates',
        name: 'Imajin Updates',
        description: 'Progress updates on sovereign infrastructure',
      }).returning();
      defaultList = newList;
    }

    // Check if contact already exists
    const contact = await db.query.contacts.findFirst({
      where: eq(contacts.email, email),
    });

    if (contact) {
      const existingSub = await db.query.subscriptions.findFirst({
        where: eq(subscriptions.contactId, contact.id),
      });

      if (existingSub && existingSub.status === 'subscribed') {
        if (contact.isVerified) {
          return NextResponse.json({
            success: true,
            status: 'already_subscribed',
            message: "You're already on the list!",
          });
        }
        // Subscribed but not yet verified — re-send verification
        await sendVerificationEmail(email, baseUrl);
        return NextResponse.json({
          success: true,
          status: 'pending_verification',
          message: 'Check your inbox to confirm your email',
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

      if (contact.isVerified) {
        return NextResponse.json({
          success: true,
          status: 'resubscribed',
          message: "Welcome back! You're on the list.",
        });
      }

      // Not verified — send verification email
      await sendVerificationEmail(email, baseUrl);
      return NextResponse.json({
        success: true,
        status: 'pending_verification',
        message: 'Check your inbox to confirm your email',
      });
    }

    // Create new contact (unverified) and subscription
    const [newContact] = await db.insert(contacts).values({
      email,
      source,
      isVerified: false,
    }).returning();

    await db.insert(subscriptions).values({
      contactId: newContact.id,
      mailingListId: defaultList.id,
    });

    // Send verification email
    await sendVerificationEmail(email, baseUrl);

    return NextResponse.json({
      success: true,
      status: 'pending_verification',
      message: 'Check your inbox to confirm your email',
    });

  } catch (error) {
    console.error('Subscribe error:', error);
    return NextResponse.json(
      { error: 'Something went wrong' },
      { status: 500 }
    );
  }
}
