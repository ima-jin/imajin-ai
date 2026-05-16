import { cookies } from 'next/headers';
import { verifySessionToken, type SessionUser, type SessionConfig } from './session';

const DEFAULT_COOKIE_NAME = 'imajin_session';

export async function getSession(config: SessionConfig): Promise<SessionUser | null> {
  const cookieStore = cookies();
  const token = cookieStore.get(config.cookieName ?? DEFAULT_COOKIE_NAME)?.value;
  if (!token) return null;
  return verifySessionToken(token, config);
}
