import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireDocumentActor } from '@/src/lib/auth/document-authorization';
import { nodeUrl } from '@/src/lib/http/node-url';
import LegalEntityForm from './components/LegalEntityForm';

export const dynamic = 'force-dynamic';

export default async function LegalEntityPage() {
  const request = new Request(`${nodeUrl()}/auth/legal-entity`, { headers: await headers() });
  const actor = await requireDocumentActor(request, { write: true });
  if (actor instanceof Response) {
    if (actor.status === 401) redirect('/auth');
    return <p role="alert" className="text-sm text-zinc-400 py-8">An active owner or admin with auth access is required to manage this identity&apos;s legal details.</p>;
  }
  return <LegalEntityForm key={actor.effectiveDid} did={actor.effectiveDid} />;
}
