import type { NextRequest } from 'next/server';
import { handleLotsBySupplierGet } from '@/src/lib/supply';

export function GET(request: NextRequest) {
  return handleLotsBySupplierGet(request);
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
