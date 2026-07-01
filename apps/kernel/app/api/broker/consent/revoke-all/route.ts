import type { NextRequest } from 'next/server';
import { revokeAll } from '@/src/lib/broker/routes/revoke-all';

// POST /api/broker/consent/revoke-all — bulk-revoke by contact and/or data type (#1053).
// Static segment; takes precedence over the sibling dynamic /consent/[id] route.
export async function POST(request: NextRequest) {
  return revokeAll(request);
}
