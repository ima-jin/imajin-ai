import { db, identities } from '@/src/db';
import { getEffectiveDid } from '../lib/get-effective-did';
import { eq } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import TaxRegistrationsTab from './components/TaxRegistrationsTab';

/**
 * /auth/tax — the Tax registrations tab (#2420): list/add/remove
 * `tax_registrations` on the business profile. Neutral shell surface,
 * gated to `scope === 'business'` next to the Money tab (#2211), the same
 * way Money is gated on scope alone rather than on `enabledServices`.
 */
export default async function TaxPage() {
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

  if (identity?.scope !== 'business') {
    return (
      <div className="text-zinc-500 text-sm py-8">
        Tax registrations are only available for business identities. Switch to (or create) a business identity to manage them.
      </div>
    );
  }

  return <TaxRegistrationsTab profileDid={did} />;
}
