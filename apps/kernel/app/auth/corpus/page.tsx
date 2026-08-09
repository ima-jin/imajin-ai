import { redirect } from 'next/navigation';
import { getEffectiveDid } from '@/app/auth/lib/get-effective-did';
import CorpusManagerShell from './components/CorpusManagerShell';

/**
 * /auth/corpus — Corpus source management for the acting DID (#1731).
 *
 * A sibling of /auth/connectors, /auth/members, /auth/developer/apps: this is
 * a DID-level resource, not a personal-profile surface, so it lives under the
 * DID dashboard. The acting DID is resolved server-side from the session
 * (same `getEffectiveDid` pattern as /auth/members and
 * /auth/developer/apps) — scope-toggling and X-Acting-As/X-Acting-For work
 * the same way here as everywhere else on the dashboard.
 */
export default async function CorpusPage() {
  const { sessionDid, effectiveDid } = await getEffectiveDid();

  if (!sessionDid) {
    redirect('/auth/login');
  }

  // effectiveDid is non-null whenever sessionDid is non-null
  const did = effectiveDid ?? sessionDid!;

  return <CorpusManagerShell did={did} />;
}
