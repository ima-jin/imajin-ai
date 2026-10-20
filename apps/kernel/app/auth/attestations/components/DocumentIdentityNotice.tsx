interface Props {
  authorDid: string;
  authorName?: string | null;
  actingHumanDid?: string;
  actingHumanName?: string | null;
  signatureModel?: string;
}

export default function DocumentIdentityNotice({ authorDid, authorName, actingHumanDid, actingHumanName, signatureModel }: Readonly<Props>) {
  return (
    <div className="border border-zinc-700 bg-black/30 p-3 text-sm space-y-2">
      <div>
        <div className="text-zinc-400 text-xs">Author and first signer</div>
        <div className="text-white font-medium">{authorName || authorDid}</div>
        <div className="font-mono text-xs text-zinc-400 break-all">{authorDid}</div>
      </div>
      {actingHumanDid && (
        <div>
          <div className="text-zinc-400 text-xs">Acting human</div>
          <div className="text-zinc-300">{actingHumanName || actingHumanDid}</div>
          <div className="font-mono text-xs text-zinc-500 break-all">{actingHumanDid}</div>
        </div>
      )}
      <p className="text-xs text-zinc-400">
        {signatureModel === 'did-key'
          ? 'Recorded signature model: DID-key signature. Use file verification to check the signature and hash.'
          : 'Server signing records a node-witnessed action on behalf of this identity. It is not a signature made with the organization’s or human’s own private key.'}
      </p>
    </div>
  );
}
