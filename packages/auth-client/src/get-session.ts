import { cookies } from 'next/headers';
import { sessionCookieName, verifySessionToken, type SessionUser, type SessionConfig } from './session';

export async function getSession(config: SessionConfig): Promise<SessionUser | null> {
  const name = sessionCookieName(config);
  const cookieStore = await cookies();
  const token = cookieStore.get(name)?.value;
  if (!token) return null;
  return verifySessionToken(token, config);
}
