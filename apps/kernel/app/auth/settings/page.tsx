import { db, identities, identityMembers } from '@/src/db';
import { getEffectiveDid } from '@/app/auth/lib/get-effective-did';
import { eq, and, isNull } from 'drizzle-orm';
import { redirect } from 'next/navigation';
import IdentitySettingsPanel from '../components/IdentitySettingsPanel';
import DomainsSection from '../components/DomainsSection';
import { canManageIdentityDomains } from '@/src/lib/domains/access';
import IdentityOwnershipPanel from '../components/IdentityOwnershipPanel';

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

  if (!identity) {
    return (
      <div className="text-zinc-500 text-sm py-8">
        Account settings are available via the tabs above.
      </div>
    );
  }

  const canManageDomains = await canManageIdentityDomains(did, sessionDid);
  if (identity.scope === 'actor') {
    return canManageDomains ? <DomainsSection key={did} did={did} /> : (
      <div className="text-zinc-500 text-sm py-8">
        You need owner or admin access to manage domains for this identity.
      </div>
    );
  }

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
      <IdentityOwnershipPanel groupDid={did} />
      {canManageDomains ? <DomainsSection key={did} did={did} /> : (
        <p className="text-zinc-500 text-sm py-8">You need owner or admin access to manage domains for this identity.</p>
      )}
      {membership?.role === 'owner' ? <IdentitySettingsPanel groupDid={did} /> : (
        <p className="text-zinc-500 text-sm py-8">You need owner access to manage other settings for this identity.</p>
      )}
    </div>
  );
}
