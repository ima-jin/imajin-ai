import type { NextRequest } from 'next/server';
import { publishSupplyStage } from '@/src/lib/supply';

export function POST(request: NextRequest) {
  return publishSupplyStage(request, 'supply.processed');
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
