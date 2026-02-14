import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { registrationTokens, partners } from '@/db/schema';
import { eq } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: { token: string } }
) {
  try {
    const { token } = params;

    // Find the token
    const tokenRecord = await db.query.registrationTokens.findFirst({
      where: eq(registrationTokens.id, token),
      with: {
        partner: true,
      },
    });

    if (!tokenRecord) {
      return NextResponse.json(
        { error: 'Token not found' },
        { status: 404 }
      );
    }

    // Check expiry
    if (tokenRecord.expiresAt && new Date(tokenRecord.expiresAt) < new Date()) {
      return NextResponse.json(
        { error: 'Token expired' },
        { status: 410 }
      );
    }

    // Increment scan count
    await db
      .update(registrationTokens)
      .set({ scans: (tokenRecord.scans || 0) + 1 })
      .where(eq(registrationTokens.id, token));

    return NextResponse.json({
      token: tokenRecord,
      partner: tokenRecord.partner,
    });
  } catch (error) {
    console.error('Error validating token:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
