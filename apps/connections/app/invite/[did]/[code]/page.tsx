import { notFound } from 'next/navigation';
import { AcceptSection } from './AcceptSection';

const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const AUTH_URL = `${SERVICE_PREFIX}auth.${DOMAIN}`;

async function getInvite(code: string) {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 3003}`;
  try {
    const res = await fetch(`${baseUrl}/api/invites/${code}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export default async function InvitePage({
  params,
}: {
  params: { did: string; code: string };
}) {
  const invite = await getInvite(params.code);

  if (!invite) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-6">
          <div className="text-6xl mb-6">🔗</div>
          <h1 className="text-2xl font-bold text-white mb-3">Invalid Invite Link</h1>
          <p className="text-gray-400">
            This invite link is not valid or has been removed.
          </p>
          <a
            href={`${SERVICE_PREFIX}www.${DOMAIN}`}
            className="inline-block mt-6 px-6 py-2.5 bg-white/10 hover:bg-white/15 text-white rounded-lg transition"
          >
            Go to Imajin
          </a>
        </div>
      </div>
    );
  }

  if (invite.used) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-6">
          <div className="text-6xl mb-6">✅</div>
          <h1 className="text-2xl font-bold text-white mb-3">Invite Already Used</h1>
          <p className="text-gray-400">
            This invite has already been accepted.
          </p>
          <a
            href={`${SERVICE_PREFIX}connections.${DOMAIN}`}
            className="inline-block mt-6 px-6 py-2.5 bg-amber-500 hover:bg-amber-600 text-black font-medium rounded-lg transition"
          >
            View Your Connections
          </a>
        </div>
      </div>
    );
  }

  const displayName = invite.fromHandle ? `@${invite.fromHandle}` : invite.fromDid.slice(0, 20) + '...';
  const connectionsUrl = `${SERVICE_PREFIX}connections.${DOMAIN}`;
  const acceptUrl = `/api/invites/${params.code}/accept`;
  const loginUrl = `${AUTH_URL}/login?redirect=${encodeURIComponent(`${connectionsUrl}/invite/${params.did}/${params.code}`)}`;

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
      <div className="text-center max-w-md mx-auto px-6">
        <div className="text-6xl mb-6">🟠</div>
        <h1 className="text-2xl font-bold text-white mb-3">
          {displayName} wants to connect with you on Imajin
        </h1>
        {invite.note && (
          <p className="text-gray-300 mb-4 italic">&ldquo;{invite.note}&rdquo;</p>
        )}
        <p className="text-gray-400 mb-8 text-sm">
          Accept this invite to create a trusted connection.
        </p>

        <AcceptSection loginUrl={loginUrl} code={params.code} connectionsUrl={connectionsUrl} />
      </div>
    </div>
  );
}
