import { NextRequest, NextResponse } from 'next/server';
import { generateQRCode } from '@/src/lib/email';

export async function GET(
  _request: NextRequest,
  { params }: { params: { ticketId: string } }
) {
  try {
    const qrCodeDataUri = await generateQRCode(params.ticketId);
    if (!qrCodeDataUri) {
      return NextResponse.json({ error: 'Failed to generate QR code' }, { status: 500 });
    }
    return NextResponse.json({ qrCodeDataUri });
  } catch (error) {
    console.error('QR generation error:', error);
    return NextResponse.json({ error: 'Failed to generate QR code' }, { status: 500 });
  }
}
