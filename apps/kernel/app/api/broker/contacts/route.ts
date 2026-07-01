import type { NextRequest } from 'next/server';
import { getContacts } from '@/src/lib/broker/routes/contacts';

// GET /api/broker/contacts — aggregated recipients you have disclosures with (#1053).
export async function GET(request: NextRequest) {
  return getContacts(request);
}
