import { randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { deriveXKeypairFromEd25519, wrapFieldKey, sealSecret } from '@imajin/vault-core';
import { verifyBootstrapFetchAuth } from '@/src/lib/apps/bootstrap-fetch-auth';
import { fetchAppDeclaredSecret, listAppDeclaredSecrets } from '@/src/lib/apps/self-secrets';
import { corsHeaders } from '@/src/lib/kernel/cors';

export const dynamic = 'force-dynamic';

/** Sealed-only transport, authenticated with the bound keystore key, not the app signing key. */
export async function POST(request: NextRequest) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  const refuse = (status: number) => NextResponse.json({ error: 'App secret access refused' }, { status, headers });
  try {
    // TLS is enforced by the SDK and deployment ingress. Next's internal URL
    // may be HTTP behind that ingress; do not trust client forwarding headers
    // or confuse an internal transport URL with the public TLS boundary.
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !['domain', 'appDid', 'keys', 'recipientXPub', 'nonce', 'timestamp', 'signature'].includes(key))
      || body.domain !== 'app-self-secrets-v1' || typeof body.appDid !== 'string'
      || body.appDid.length === 0 || body.appDid.length > 256
      || !Array.isArray(body.keys) || body.keys.length === 0 || body.keys.length > 32
      || body.keys.some((name: unknown) => typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name))
      || new Set(body.keys).size !== body.keys.length
      || typeof body.recipientXPub !== 'string' || !/^[0-9a-f]{64}$/.test(body.recipientXPub)
      || typeof body.timestamp !== 'number' || !Number.isSafeInteger(body.timestamp)
      || typeof body.nonce !== 'string' || body.nonce.length === 0 || body.nonce.length > 200
      || typeof body.signature !== 'string' || !/^[0-9a-f]{128}$/.test(body.signature)) return refuse(400);
    const { domain, appDid, keys, recipientXPub, nonce, timestamp, signature } = body;
    const auth = await verifyBootstrapFetchAuth({ domain, appDid, keys, recipientXPub, nonce, timestamp, signature });
    if (auth.status !== 'ok') return refuse(403);
    const declared = await listAppDeclaredSecrets(appDid);
    if (keys.some((name: string) => !declared.some((entry) => entry.name === name && entry.status === 'active'))) {
      return refuse(403);
    }

    const values: Record<string, string> = Object.create(null);
    const missing: string[] = [];
    for (const name of keys) {
      values[name] = (await fetchAppDeclaredSecret(appDid, name)).value;
    }
    // Ephemeral sender key and field key; nothing new is persisted in the vault.
    const sender = deriveXKeypairFromEd25519(randomBytes(32).toString('hex'), 'app-self-secrets-sender-v1');
    const fieldKey = randomBytes(32);
    try {
      return NextResponse.json({
        version: 1, senderXPub: sender.publicKey,
        wrappedKey: wrapFieldKey(fieldKey, recipientXPub, sender.privateKey),
        sealed: sealSecret(JSON.stringify({ domain, appDid, nonce, keys, values, missing }), fieldKey),
      }, { headers });
    } finally {
      fieldKey.fill(0);
    }
  } catch {
    // No logger and no provider errors: even thrown secret-shaped text stays private.
    return refuse(403);
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
