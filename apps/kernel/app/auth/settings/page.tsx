import { db, identities, identityMembers } from '@/src/db';
import { getEffectiveDid } from '@/app/auth/lib/get-effective-did';
import { eq, and, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import IdentitySettingsPanel from '../components/IdentitySettingsPanel';
import DomainsSection from '../components/DomainsSection';
import { canManageIdentityDomains } from '@/src/lib/domains/access';

export default async function SettingsPage() {
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

  const canManageDomains = await canManageIdentityDomains(did, sessionDid);
  if (!canManageDomains) {
    return (
      <div className="text-zinc-500 text-sm py-8">
        You need owner or admin access to manage domains for this identity.
      </div>
    );
  }

  if (identity?.scope === 'actor') return <DomainsSection key={did} did={did} />;

  // Existing group settings remain owner-only; domains also permit admins.
  const [membership] = await db
    .select({ role: identityMembers.role })
    .from(identityMembers)
    .where(
      and(
        eq(identityMembers.identityDid, did),
        eq(identityMembers.memberDid, sessionDid),
        isNull(identityMembers.removedAt)
      )
    )
    .limit(1);

  return (
    <div className="space-y-6">
      <DomainsSection key={did} did={did} />
      {membership?.role === 'owner' && <IdentitySettingsPanel groupDid={did} />}
    </div>
  );
}
