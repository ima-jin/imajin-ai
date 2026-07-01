import type { NextRequest } from 'next/server';
import { getGrants } from '@/src/lib/broker/routes/grants';

// GET /api/broker/grants — aggregated active grants by data type (#1053).
export async function GET(request: NextRequest) {
  return getGrants(request);
}
