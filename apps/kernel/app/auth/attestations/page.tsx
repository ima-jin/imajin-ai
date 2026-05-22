import { cookies } from 'next/headers';
import { verifySessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import AttestationList from '../components/AttestationList';
import CreateDocumentForm from './components/CreateDocumentForm';
import DocumentList from './components/DocumentList';

interface SearchParams {
  type?: string;
  role?: string;
  page?: string;
  view?: string;
  doc_role?: string;
}

export default async function AttestationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const resolvedSearchParams = await searchParams;
  const cookieConfig = getSessionCookieOptions();
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(cookieConfig.name)?.value;

  let sessionDid: string | null = null;
  if (sessionToken) {
    const session = await verifySessionToken(sessionToken);
    sessionDid = session?.sub ?? null;
  }

  if (!sessionDid) {
    redirect('/auth');
  }

  // Effective DID: actingAs cookie OR personal DID
  const actingAs = cookieStore.get('x-acting-as')?.value || null;
  const effectiveDid = actingAs || sessionDid;
  const view = resolvedSearchParams.view === 'documents' ? 'documents' : 'attestations';
  const documentRole = resolvedSearchParams.doc_role === 'created' ? 'created' : 'needs-signature';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-white">Attestations</h2>
        <CreateDocumentForm sessionDid={effectiveDid} />
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
        <AttestationList sessionDid={effectiveDid} searchParams={resolvedSearchParams} excludeDocumentTypes />
      )}
    </div>
  );
}
