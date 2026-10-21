import type { GrantCard } from '@/src/lib/jin/grants-lane';

/** In-memory fixture only: never forwards to the network or changes credentials. */
export function createGrantsFixtureTransport(): typeof fetch {
  if (process.env.NODE_ENV !== 'development') throw new Error('Grants fixture is development-only');
  const revoked = new Set<string>();
  const ids = Array.from({ length: 10 }, (_, index) => `fixture-karaoke-${index}`);
  const base: GrantCard = {
    id: 'app-authorization:fixture-karaoke-9',
    source: 'app-authorization',
    grantee: 'Karaoke',
    appDid: 'did:imajin:fixture-karaoke',
    capabilities: ['profile:read', 'media:read'],
    issuedAt: '2026-10-20T10:09:00.000Z',
    lastUsedAt: null,
    ackState: null,
    ackEvidence: null,
    status: 'active',
    revocable: true,
    revoke: { method: 'POST', path: '/api/auth/revoke', body: { attestationId: ids[9] } },
  };
  return (input, init) => Promise.resolve().then(() => {
    if (process.env.NODE_ENV !== 'development') throw new Error('Grants fixture is development-only');
    if (input === '/api/auth/revoke' && init?.method === 'POST') {
      if (typeof init.body !== 'string') return Response.json({ error: 'Expected fixture JSON body' }, { status: 400 });
      const { attestationId } = JSON.parse(init.body) as { attestationId: string };
      if (!ids.includes(attestationId)) return Response.json({ error: 'Unknown fixture grant' }, { status: 404 });
      if (revoked.has(attestationId)) return Response.json({ error: 'Already revoked' }, { status: 409 });
      revoked.add(attestationId);
      return Response.json({ ok: true });
    }
    if (input === '/jin/api/grants' && (!init?.method || init.method === 'GET')) {
      const live = ids.filter(id => !revoked.has(id)).reverse();
      const grants: GrantCard[] = live.length ? [{
        ...base,
        id: `app-authorization:${live[0]}`,
        surplusGrantIds: live.slice(1),
        revoke: { method: 'POST', path: '/api/auth/revoke', body: { attestationId: live[0] } },
      }] : [];
      grants.push({
        ...base, id: 'app-authorization:fixture-other-app', appDid: 'did:imajin:fixture-other-app',
        grantee: 'Karaoke', capabilities: ['profile:read'], revocable: false, revoke: null,
      }, {
        ...base, id: 'app-authorization:fixture-expired', status: 'expired', revocable: false, revoke: null,
      }, {
        ...base, id: 'app-authorization:fixture-history', status: 'revoked', revocable: false, revoke: null,
      });
      for (const id of revoked) grants.push({
        ...base, id: `app-authorization:${id}`, status: 'revoked', revocable: false, revoke: null,
      });
      return Response.json({ isOperator: true, grants });
    }
    throw new Error('Unexpected fixture request; no network request was sent');
  });
}
