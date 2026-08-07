import type { NextRequest } from 'next/server';
import { getContactDisclosures } from '@/src/lib/broker/routes/contact-disclosures';

// GET /api/broker/contacts/[did]/disclosures — disclosure timeline for one recipient (#1053).
export async function GET(request: NextRequest, props: { params: Promise<{ did: string }> }) {
  const params = await props.params;
  return getContactDisclosures(request, params.did);
}
