import { cookies } from 'next/headers';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';

export async function getEffectiveDid(): Promise<{ sessionDid: string | null; effectiveDid: string | null }> {
  const cookieConfig = getSessionCookieOptions();
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(cookieConfig.name)?.value;

  let sessionDid: string | null = null;
  if (sessionToken) {
    const session = await verifySessionToken(sessionToken);
    sessionDid = session?.sub ?? null;
  }

  const actingAs = cookieStore.get('x-acting-as')?.value || null;
  const effectiveDid = actingAs || sessionDid;

  return { sessionDid, effectiveDid };
}
