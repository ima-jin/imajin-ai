import { redirect } from 'next/navigation';
import { getClient } from '@imajin/db';
import { getEffectiveDid } from '@/app/auth/lib/get-effective-did';

const sql = getClient();

interface TokenDetails {
  id: string;
  channel: string;
  channelUid: string;
  appDid: string;
  requestedScopes: string[];
  expiresAt: Date;
  appName: string | null;
}

async function getTokenDetails(token: string): Promise<TokenDetails | null> {
  const rows = await sql<{
    id: string;
    channel: string;
    channel_uid: string;
    app_did: string;
    requested_scopes: string[];
    expires_at: Date;
    app_name: string | null;
  }[]>`
    SELECT
      t.id, t.channel, t.channel_uid, t.app_did, t.requested_scopes, t.expires_at,
      r.name AS app_name
    FROM auth.channel_link_tokens t
    LEFT JOIN auth.registry_apps r ON r.app_did = t.app_did
    WHERE t.token = ${token}
      AND t.consumed_at IS NULL
      AND t.expires_at > now()
    LIMIT 1
  `;
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    channel: r.channel,
    channelUid: r.channel_uid,
    appDid: r.app_did,
    requestedScopes: r.requested_scopes ?? [],
    expiresAt: r.expires_at,
    appName: r.app_name,
  };
}

function channelLabel(channel: string): string {
  return channel.charAt(0).toUpperCase() + channel.slice(1);
}

function maskUid(uid: string): string {
  if (uid.length <= 6) return '••••••';
  return uid.slice(0, 3) + '•'.repeat(Math.max(4, uid.length - 6)) + uid.slice(-3);
}

export default async function ChannelLinkApprovalPage({
  params,
  searchParams,
}: {
  params: { token: string };
  searchParams: { approved?: string; error?: string };
}) {
  const { effectiveDid } = await getEffectiveDid();

  // Not signed in — redirect to login, come back after.
  if (!effectiveDid) {
    const returnUrl = encodeURIComponent(`/auth/channel-link/${params.token}`);
    redirect(`/auth?redirect=${returnUrl}`);
  }

  const tokenDetails = await getTokenDetails(params.token);

  // Already approved flow.
  if (searchParams.approved === '1') {
    return (
      <main style={{ maxWidth: 480, margin: '80px auto', padding: '0 24px', fontFamily: 'sans-serif' }}>
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>✓ Account linked</h1>
        <p style={{ color: '#555' }}>
          Your {tokenDetails ? channelLabel(tokenDetails.channel) : 'messenger'} account is now linked to your Imajin identity.
          You can close this tab and return to the chat.
        </p>
        <p style={{ marginTop: 24 }}>
          <a href="/auth/settings" style={{ color: '#6366f1', textDecoration: 'none' }}>
            Manage your linked accounts →
          </a>
        </p>
      </main>
    );
  }

  // Token invalid / expired / consumed.
  if (!tokenDetails) {
    return (
      <main style={{ maxWidth: 480, margin: '80px auto', padding: '0 24px', fontFamily: 'sans-serif' }}>
        <h1 style={{ fontSize: 22, fontWeight: 600 }}>Link unavailable</h1>
        <p style={{ color: '#555' }}>
          This link has expired, already been used, or is invalid.
          Please ask the bot to generate a new link.
        </p>
      </main>
    );
  }

  const appName = tokenDetails.appName ?? tokenDetails.appDid.slice(0, 20) + '…';

  return (
    <main style={{ maxWidth: 480, margin: '80px auto', padding: '0 24px', fontFamily: 'sans-serif' }}>
      <h1 style={{ fontSize: 22, fontWeight: 600 }}>
        Link your {channelLabel(tokenDetails.channel)} account
      </h1>
      <p style={{ color: '#555', marginTop: 8 }}>
        <strong>{appName}</strong> wants to link your{' '}
        {channelLabel(tokenDetails.channel)} account (<code>{maskUid(tokenDetails.channelUid)}</code>) to your
        Imajin identity so it can act on your behalf.
      </p>

      {tokenDetails.requestedScopes.length > 0 && (
        <>
          <p style={{ marginTop: 20, fontWeight: 500 }}>Requested permissions:</p>
          <ul style={{ paddingLeft: 20, color: '#444' }}>
            {tokenDetails.requestedScopes.map((s) => (
              <li key={s}><code>{s}</code></li>
            ))}
          </ul>
        </>
      )}

      <p style={{ marginTop: 16, fontSize: 13, color: '#888' }}>
        This link expires at {new Date(tokenDetails.expiresAt).toLocaleTimeString()}.
        You can revoke this link any time from your account settings.
      </p>

      {searchParams.error && (
        <p style={{ color: '#e53e3e', marginTop: 12 }}>{searchParams.error}</p>
      )}

      {/* Approve form — POST to the API route */}
      <form
        action="/auth/api/channel-link/approve-redirect"
        method="POST"
        style={{ marginTop: 24 }}
      >
        <input type="hidden" name="token" value={params.token} />
        <input type="hidden" name="returnTo" value={`/auth/channel-link/${params.token}?approved=1`} />
        <button
          type="submit"
          style={{
            background: '#6366f1',
            color: '#fff',
            border: 'none',
            borderRadius: 6,
            padding: '10px 24px',
            fontSize: 15,
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          Approve
        </button>
        <a
          href="/"
          style={{ marginLeft: 16, color: '#888', fontSize: 14, textDecoration: 'none' }}
        >
          Cancel
        </a>
      </form>
    </main>
  );
}
