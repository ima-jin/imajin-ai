interface Signer {
  id: string;
  signerDid: string;
  status: string;
  role: string;
  signedAt: Date | null;
  identity?: {
    handle: string | null;
    name: string | null;
    avatarUrl: string | null;
  } | null;
}

interface Props {
  signers: Signer[];
  sessionDid: string;
}

function resolvedName(signer: Signer): string {
  if (signer.identity?.handle) return `@${signer.identity.handle}`;
  if (signer.identity?.name) return signer.identity.name;
  return signer.signerDid.slice(0, 22) + '…';
}

function statusIcon(status: string): string {
  switch (status) {
    case 'signed': return '✅';
    case 'declined': return '❌';
    case 'pending': return '⏳';
    default: return '⏳';
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case 'signed': return 'Signed';
    case 'declined': return 'Declined';
    case 'pending': return 'Pending';
    default: return 'Pending';
  }
}

function statusClasses(status: string): string {
  switch (status) {
    case 'signed': return 'bg-green-900/30 text-green-400 border-green-800';
    case 'declined': return 'bg-red-900/30 text-red-400 border-red-800';
    case 'pending': return 'bg-amber-900/30 text-amber-400 border-amber-800';
    default: return 'bg-zinc-800 text-zinc-400 border-zinc-700';
  }
}

export default function SignerList({ signers, sessionDid }: Props) {
  return (
    <div className="space-y-2">
      {signers.map((signer) => (
        <div
          key={signer.id}
          className="flex items-center gap-3 px-3 py-2 bg-black/20 rounded-lg"
        >
          <span className="text-sm" title={statusLabel(signer.status)}>
            {statusIcon(signer.status)}
          </span>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-zinc-300 truncate">
              {resolvedName(signer)}
              {signer.signerDid === sessionDid && (
                <span className="text-xs text-amber-500 ml-1.5">(you)</span>
              )}
            </div>
            <div className="text-xs text-zinc-600 font-mono truncate">
              {signer.signerDid}
            </div>
          </div>
          <span
            className={`text-xs px-2 py-0.5 rounded-full border ${statusClasses(signer.status)}`}
          >
            {statusLabel(signer.status)}
          </span>
          {signer.signedAt && (
            <span className="text-xs text-zinc-600 shrink-0">
              {new Date(signer.signedAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
