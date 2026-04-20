import { cookies } from 'next/headers';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { redirect } from 'next/navigation';
import AttestationList from '../components/AttestationList';

interface SearchParams {
  type?: string;
  role?: string;
  page?: string;
}

export default async function AttestationsPage({ searchParams }: { searchParams: SearchParams }) {
  const cookieConfig = getSessionCookieOptions();
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(cookieConfig.name)?.value;

  let sessionDid: string | null = null;
  if (sessionToken) {
    const session = await verifySessionToken(sessionToken);
    sessionDid = session?.sub ?? null;
  }

  if (!sessionDid) {
    redirect('/auth');
  }

  // Effective DID: actingAs cookie OR personal DID
  const actingAs = cookieStore.get('x-acting-as')?.value || null;
  const effectiveDid = actingAs || sessionDid;

  return <AttestationList sessionDid={effectiveDid} searchParams={searchParams} />;
}
