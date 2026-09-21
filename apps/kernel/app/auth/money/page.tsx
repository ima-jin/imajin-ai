import { db, identities } from '@/src/db';
import { getEffectiveDid } from '../lib/get-effective-did';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import MoneyTab from './components/MoneyTab';

/**
 * /auth/money — the Money tab (#2211): create/send/list/mark-settled/void
 * payment_requests, scoped to the acting identity. Neutral shell surface —
 * no vertical-specific code — for the business-DID receivable primitive
 * `pay.payment_request` (#2206/#2207/#2208/#2210).
 *
 * Gated to `scope === 'business'`, mirroring the settings/members pages'
 * scope guard: rather than a 404/redirect, a direct nav to this route on a
 * non-business identity gets a short explanatory message instead.
 */
export default async function MoneyPage() {
  const { sessionDid, effectiveDid } = await getEffectiveDid();

  if (!sessionDid) {
    redirect('/auth');
  }

  // effectiveDid is non-null whenever sessionDid is non-null
  const did = effectiveDid ?? sessionDid!;

  const [identity] = await db
    .select({ scope: identities.scope })
    .from(identities)
    .where(eq(identities.id, did))
    .limit(1);

  if (!identity || identity.scope !== 'business') {
    return (
      <div className="text-zinc-500 text-sm py-8">
        Money is only available for business identities. Switch to (or create) a business identity to create and manage payment requests.
      </div>
    );
  }

  return <MoneyTab issuerDid={did} />;
}
