'use client';

import { useEffect, useState } from 'react';
import CreateDocumentForm from '../../auth/attestations/components/CreateDocumentForm';
import DocumentSigningCard, { type DocumentAttestation, type Signature } from '../../auth/attestations/components/DocumentSigningCard';

const ORG = 'did:imajin:fixture-organization';
const HUMAN = 'did:imajin:fixture-controller';
const PARTY = 'did:imajin:fixture-counterparty';
const HASH = '2319d2233fdf5762f8e6545f16986941a4156f27c39cb049398db6e981b5eed9';
export const FIXTURE_CONTENT = 'FIXTURE ONLY — Service agreement\nImajin Studio and Alex agree to a two-week design engagement.\n';

const document: DocumentAttestation = {
  id: 'fixture-agreement', type: 'agreement', issuerDid: ORG, subjectDid: PARTY,
  payload: { title: 'Design services agreement', actingHumanDid: HUMAN,
    signedBy: { [ORG]: { actingHumanDid: HUMAN, signatureModel: 'node-witness' } } }, attestationStatus: 'collecting',
  documentHash: HASH, documentAssetId: 'fixture-document', totalSigners: 2,
  issuedAt: new Date('2026-10-20T10:00:00Z'), expiresAt: null, revokedAt: null,
};
const initialSignatures: Signature[] = [
  { id: 'fixture-author', signerDid: ORG, role: 'author', status: 'signed', signedAt: new Date('2026-10-20T10:00:00Z'),
    identity: { name: 'Imajin Studio', handle: 'fixture-studio', avatarUrl: null } },
  { id: 'fixture-party', signerDid: PARTY, role: 'signer', status: 'pending', signedAt: null,
    identity: { name: 'Alex Morgan', handle: 'fixture-alex', avatarUrl: null } },
];

function fixtureResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export default function AgreementPreview() {
  const [ready, setReady] = useState(false);
  const [account, setAccount] = useState(PARTY);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const originalFetch = globalThis.fetch;
    let revoked = false;
    let signed = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if ([ORG, PARTY].some((did) => url === `/auth/api/identity/${encodeURIComponent(did)}/sign`)) {
        return fixtureResponse({ signature: 'fixture-node-witness-not-real' });
      }
      if (url.startsWith('/auth/api/search?')) return fixtureResponse({
        results: [{ did: PARTY, handle: 'fixture-alex', name: 'Alex Morgan', scope: 'actor',
          subtype: null, avatarUrl: null, avatarAssetId: null }],
      });
      if (url === '/media/api/assets') return fixtureResponse({ id: 'fixture-upload', hash: HASH });
      if (url === '/auth/api/documents') return fixtureResponse({ attestation: document }, 201);
      if (url.endsWith('/fixture-agreement/verify')) {
        const file = (init?.body as FormData).get('file') as File | null;
        const hashMatches = !!file && await file.text() === FIXTURE_CONTENT;
        return fixtureResponse({ valid: hashMatches && !revoked, hashMatches, signaturesValid: true, revoked });
      }
      if (url.endsWith('/fixture-agreement/revoke')) {
        revoked = true;
        return fixtureResponse({ revokedAt: new Date().toISOString() });
      }
      if (url.endsWith('/fixture-agreement/sign')) {
        signed = true;
        return fixtureResponse({ status: 'executed' });
      }
      if (url.endsWith('/fixture-agreement/decline')) return fixtureResponse({});
      if (url.endsWith('/fixture-agreement')) return fixtureResponse({
        attestation: { ...document, attestationStatus: signed ? 'executed' : 'collecting', revokedAt: revoked ? new Date().toISOString() : null },
        signatures: initialSignatures.map((sig) => sig.signerDid === PARTY && signed
          ? { ...sig, status: 'signed', signedAt: new Date().toISOString() } : sig),
      });
      return originalFetch(input, init);
    };
    setReady(true);
    return () => { globalThis.fetch = originalFetch; };
  }, [generation]);

  return (
    <main className="max-w-4xl mx-auto p-4 space-y-6 text-zinc-200">
      <header className="border border-amber-700 p-4 space-y-2">
        <h1 className="font-mono text-xl">Agreement fixture preview</h1>
        <p className="text-sm text-amber-300">Development fixture only — not live data, real signatures, or proof of a cryptographic round-trip.</p>
        <div className="flex flex-wrap gap-2">
          <button className="border border-zinc-600 px-3 py-2" onClick={() => { setAccount(PARTY); setGeneration((value) => value + 1); }}>Counterparty account</button>
          <button className="border border-zinc-600 px-3 py-2" onClick={() => { setAccount(ORG); setGeneration((value) => value + 1); }}>Organization account</button>
          <a className="border border-zinc-600 px-3 py-2" href="/dev/agreement-preview/document" download="fixture-agreement.txt">Download matching fixture</a>
        </div>
      </header>
      <section className="space-y-3">
        <h2 className="font-mono text-lg">Organization creates an agreement</h2>
        <CreateDocumentForm sessionDid={ORG} authorName="Imajin Studio" actingHumanDid={HUMAN}
          actingHumanName="Sam Controller" defaultOpen onCreated={() => setGeneration((value) => value + 1)} />
      </section>
      <section className="space-y-3">
        <h2 className="font-mono text-lg">{account === PARTY ? 'Counterparty' : 'Organization'} attestations</h2>
        {ready && <DocumentSigningCard key={`${account}-${generation}`} attestation={document}
          signatures={initialSignatures} sessionDid={account} actingHumanDid={account === ORG ? HUMAN : PARTY}
          previewUrl="/dev/agreement-preview/document" defaultExpanded />}
      </section>
    </main>
  );
}
