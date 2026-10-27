import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, appAuthorizationCodes } from '@/src/db';

function hashCode(code: string) {
  return createHash('sha256').update(code).digest('hex');
}

interface CodeBinding {
  appDid: string;
  subjectDid: string;
  attestationId: string;
  callbackUrl: string;
  state: string;
}

export async function issueAppAuthorizationCode(binding: CodeBinding): Promise<string> {
  const code = randomBytes(32).toString('hex');
  try {
    await db.insert(appAuthorizationCodes).values({
      ...binding, codeHash: hashCode(code), expiresAt: new Date(Date.now() + 60_000),
    });
  } catch {
    throw new Error('App authorization code issuance unavailable');
  }
  return code;
}

/** App, callback, state, deadline and single-use checks are one atomic write. */
export async function consumeAppAuthorizationCode(input: {
  appDid: string; code: string; state: string; callbackUrl: string;
}) {
  const codeHash = hashCode(input.code);
  const binding = and(
    eq(appAuthorizationCodes.codeHash, codeHash),
    eq(appAuthorizationCodes.appDid, input.appDid),
    eq(appAuthorizationCodes.callbackUrl, input.callbackUrl),
    eq(appAuthorizationCodes.state, input.state),
  );
  const [consumed] = await db.update(appAuthorizationCodes)
    .set({ consumedAt: sql`now()` })
    .where(and(binding, isNull(appAuthorizationCodes.consumedAt), gt(appAuthorizationCodes.expiresAt, sql`now()`)))
    .returning();
  if (consumed) return { authorization: consumed } as const;
  const [existing] = await db.select({ consumedAt: appAuthorizationCodes.consumedAt })
    .from(appAuthorizationCodes).where(binding).limit(1);
  return { error: existing?.consumedAt ? 'code_used' : 'code_invalid' } as const;
}
