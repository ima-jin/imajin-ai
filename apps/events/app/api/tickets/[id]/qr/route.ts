import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { generateQRCode } from '@/src/lib/email';

const log = createLogger('events');

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const qrCodeDataUri = await generateQRCode(params.id);
    if (!qrCodeDataUri) {
      return NextResponse.json({ error: 'Failed to generate QR code' }, { status: 500 });
    }
    return NextResponse.json({ qrCodeDataUri });
  } catch (error) {
    log.error({ err: String(error) }, 'QR generation error');
    return NextResponse.json({ error: 'Failed to generate QR code' }, { status: 500 });
  }
}
