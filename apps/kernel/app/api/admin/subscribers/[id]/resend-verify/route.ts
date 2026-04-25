import { NextRequest, NextResponse } from 'next/server';
import { getClient } from '@imajin/db';
import { generateVerifyToken, verifyTokenExpiry } from '@/src/lib/www/subscribe-tokens';
import { sendEmail } from '@imajin/email';
import { verificationEmail, verificationEmailText } from '@/src/lib/www/verify-email-template';
import { requireAdmin } from '@imajin/auth';

const sql = getClient();

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAdmin();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;

  const [contact] = await sql`
    SELECT id, email, is_verified FROM www.contacts WHERE id = ${id} LIMIT 1
  `;
  if (!contact) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (contact.is_verified) return NextResponse.json({ error: 'Already verified' }, { status: 400 });

  const email = contact.email as string;
  const expiresAt = verifyTokenExpiry();
  const token = generateVerifyToken(email, expiresAt);

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? 'https://imajin.ai';
  const verifyUrl = `${baseUrl}/api/subscribe/verify?email=${encodeURIComponent(email)}&token=${token}&expires=${expiresAt}`;

  await sendEmail({
    to: email,
    subject: 'Confirm your email — Imajin',
    html: verificationEmail(verifyUrl),
    text: verificationEmailText(verifyUrl),
  });

  return NextResponse.json({ ok: true });
}
