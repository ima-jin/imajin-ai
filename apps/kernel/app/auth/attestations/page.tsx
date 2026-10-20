import { redirect } from 'next/navigation';
import Link from 'next/link';
import AttestationList from '../components/AttestationList';
import CreateDocumentForm from './components/CreateDocumentForm';
import DocumentList from './components/DocumentList';
import { getDocumentPageActor } from '../lib/get-document-page-actor';
import { db, identities } from '@/src/db';
import { inArray } from 'drizzle-orm';

interface SearchParams {
  type?: string;
  role?: string;
  page?: string;
  view?: string;
  doc_role?: string;
}

export default async function AttestationsPage(props: Readonly<{ searchParams: Promise<SearchParams> }>) {
  const resolvedSearchParams = await props.searchParams;
  const actor = await getDocumentPageActor();
  if (!actor) {
    redirect('/auth');
  }
  const { actingHumanDid: sessionDid, effectiveDid } = actor;
  const view = resolvedSearchParams.view === 'documents' ? 'documents' : 'attestations';
  const documentRole = resolvedSearchParams.doc_role === 'created' ? 'created' : 'needs-signature';
  const identityRows = await db.select({ id: identities.id, name: identities.name, handle: identities.handle })
    .from(identities).where(inArray(identities.id, [...new Set([sessionDid, effectiveDid])]));
  const nameFor = (did: string) => {
    const identity = identityRows.find((row) => row.id === did);
    return identity?.name || (identity?.handle ? `@${identity.handle}` : null);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-xl font-bold text-white">Attestations</h2>
        <CreateDocumentForm key={effectiveDid} sessionDid={effectiveDid} authorName={nameFor(effectiveDid)}
          actingHumanDid={sessionDid} actingHumanName={nameFor(sessionDid)} />
      </div>

      <div className="flex items-center gap-2">
        <Link
          href="/auth/attestations"
          className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
            view === 'attestations'
              ? 'bg-amber-500/20 border-amber-500 text-amber-300'
              : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Attestations
        </Link>
        <Link
          href={`/auth/attestations?view=documents&doc_role=${documentRole}`}
          className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
            view === 'documents'
              ? 'bg-amber-500/20 border-amber-500 text-amber-300'
              : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
          }`}
        >
          Documents
        </Link>
      </div>

      {view === 'documents' ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Link
              href="/auth/attestations?view=documents&doc_role=needs-signature"
              className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                documentRole === 'needs-signature'
                  ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                  : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Needs my signature
            </Link>
            <Link
              href="/auth/attestations?view=documents&doc_role=created"
              className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                documentRole === 'created'
                  ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                  : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              Created by me
            </Link>
          </div>
          <DocumentList sessionDid={effectiveDid} role={documentRole} />
        </div>
      ) : (
        <AttestationList sessionDid={effectiveDid} viewerDid={sessionDid} searchParams={resolvedSearchParams} excludeDocumentTypes />
      )}
    </div>
  );
}
