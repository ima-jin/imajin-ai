import type { NextRequest } from 'next/server';
import { publishReceiptStage } from '@/src/lib/supply';

export function POST(request: NextRequest) {
  return publishReceiptStage(request);
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
