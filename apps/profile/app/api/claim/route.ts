import { NextRequest, NextResponse } from 'next/server';
import { db, profiles, connections } from '@/src/db';
import { eq, or } from 'drizzle-orm';
import { createHash } from 'crypto';

/**
 * POST /api/claim
 * 
 * Merge guest identity into full account.
 * User proves ownership of email/phone, and all guest connections
 * are transferred to their real identity.
 * 
 * Flow:
 * 1. User has full account (newDid)
 * 2. User proves they own the email/phone used for guest
 * 3. Guest connections merge into their account
 * 4. Guest profile is deleted
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { 
      newDid,           // Their full account DID
      email,            // Email to claim (verified externally)
      phone,            // Phone to claim (verified externally)
      verificationToken // Proof of ownership
    } = body;

    if (!newDid) {
      return NextResponse.json(
        { error: 'newDid required' },
        { status: 400 }
      );
    }

    if (!email && !phone) {
      return NextResponse.json(
        { error: 'Email or phone required to claim' },
        { status: 400 }
      );
    }

    // TODO: Verify the verification token
    // This should check against a verification service
    // For now, we'll trust the caller (internal use only)
    if (!verificationToken) {
      return NextResponse.json(
        { error: 'Verification required' },
        { status: 401 }
      );
    }

    // Find the guest DID
    const identifier = email || phone;
    const hash = createHash('sha256')
      .update(`imajin:guest:${identifier.toLowerCase().trim()}`)
      .digest('hex');
    const guestDid = `did:imajin:guest:${hash.slice(0, 32)}`;

    // Check if guest exists
    const [guestProfile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.did, guestDid))
      .limit(1);

    if (!guestProfile) {
      return NextResponse.json({
        claimed: false,
        message: 'No guest account found for this email/phone',
      });
    }

    // Check if new profile exists
    const [newProfile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.did, newDid))
      .limit(1);

    if (!newProfile) {
      return NextResponse.json(
        { error: 'Your account not found' },
        { status: 404 }
      );
    }

    // Transfer all connections FROM guest TO new account
    await db
      .update(connections)
      .set({ fromDid: newDid, updatedAt: new Date() })
      .where(eq(connections.fromDid, guestDid));

    // Transfer all connections TO guest TO new account
    await db
      .update(connections)
      .set({ toDid: newDid, updatedAt: new Date() })
      .where(eq(connections.toDid, guestDid));

    // Get count of transferred connections
    const transferredConnections = await db
      .select()
      .from(connections)
      .where(or(
        eq(connections.fromDid, newDid),
        eq(connections.toDid, newDid)
      ));

    // Delete guest profile
    await db
      .delete(profiles)
      .where(eq(profiles.did, guestDid));

    return NextResponse.json({
      claimed: true,
      guestDid,
      newDid,
      connectionsTransferred: transferredConnections.length,
      message: 'Guest identity merged successfully',
    });

  } catch (error) {
    console.error('Claim error:', error);
    return NextResponse.json(
      { error: 'Failed to claim guest identity' },
      { status: 500 }
    );
  }
}
