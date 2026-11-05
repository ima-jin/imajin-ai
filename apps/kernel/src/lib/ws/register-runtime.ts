import { eq } from 'drizzle-orm';
import { db, profiles } from '@/src/db';
import { resolveKernelSession } from '@/src/lib/auth/session-resolver';
import { resolveWsToken } from '@/src/lib/chat/ws-tokens';
import { provideWsRuntime } from './runtime';

/** No HTTP request while session resolution or presence uses the shared pool. */
export function registerWsRuntime(): void {
  provideWsRuntime({
    async session(token: string) {
      const result = await resolveKernelSession(token);
      return 'data' in result ? result.data.did : null;
    },
    token: resolveWsToken,
    async lastSeen(did: string) {
      await db.update(profiles).set({ lastSeenAt: new Date() }).where(eq(profiles.did, did));
    },
  });
}
