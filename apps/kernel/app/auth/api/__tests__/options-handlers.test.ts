/**
 * OPTIONS preflight handlers across the kernel auth routes (#2562).
 *
 * These handlers are deliberately plain (non-async) functions: they do no
 * awaiting, so Sonar S7503 forbids `async`. This table-driven test pins the
 * contract every one of them must keep — a 204 with CORS headers — so the
 * `async` removal is covered for all of them.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';

// Several routes import the db client at module load, which only checks that the
// URL is set (it connects lazily). OPTIONS never touches the database.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= 'postgres://test:test@localhost:5432/test';
});

type OptionsHandler = (request: NextRequest) => Response | Promise<Response>;

const routes: Record<string, () => Promise<{ OPTIONS?: OptionsHandler }>> = {
  'access/[did]': () => import('../access/[did]/route'),
  'access/bearers/[id]/revoke': () => import('../access/bearers/[id]/revoke/route'),
  'access/bearers': () => import('../access/bearers/route'),
  'access/knock': () => import('../access/knock/route'),
  'account/methods': () => import('../account/methods/route'),
  'apps/token': () => import('../apps/token/route'),
  'apps/token/service': () => import('../apps/token/service/route'),
  'apps/token/verify': () => import('../apps/token/verify/route'),
  'attestations/[did]': () => import('../attestations/[did]/route'),
  'attestations/[did]/revoke': () => import('../attestations/[did]/revoke/route'),
  'attestations/countersign': () => import('../attestations/countersign/route'),
  'attestations/decline': () => import('../attestations/decline/route'),
  'attestations/nostr/[npub]': () => import('../attestations/nostr/[npub]/route'),
  'attestations': () => import('../attestations/route'),
  'attestations/types': () => import('../attestations/types/route'),
  'attestations/usage': () => import('../attestations/usage/route'),
  'devices/[id]': () => import('../devices/[id]/route'),
  'devices/[id]/trust': () => import('../devices/[id]/trust/route'),
  'devices': () => import('../devices/route'),
  'documents/[id]/amend': () => import('../documents/[id]/amend/route'),
  'documents/[id]/decline': () => import('../documents/[id]/decline/route'),
  'documents/[id]': () => import('../documents/[id]/route'),
  'documents/[id]/sign': () => import('../documents/[id]/sign/route'),
  'documents': () => import('../documents/route'),
  'identity/[did]/chain': () => import('../identity/[did]/chain/route'),
  'identity/[did]/credential-status': () => import('../identity/[did]/credential-status/route'),
  'identity/[did]/did.json': () => import('../identity/[did]/did.json/route'),
  'identity/[did]/keys': () => import('../identity/[did]/keys/route'),
  'identity/[did]/rotate': () => import('../identity/[did]/rotate/route'),
  'identity/[did]': () => import('../identity/[did]/route'),
  'identity/[did]/verify': () => import('../identity/[did]/verify/route'),
  'keys/retrieve': () => import('../keys/retrieve/route'),
  'keys/store': () => import('../keys/store/route'),
  'keys/stored': () => import('../keys/stored/route'),
  'login/mfa': () => import('../login/mfa/route'),
  'logout': () => import('../logout/route'),
  'lookup/[id]': () => import('../lookup/[id]/route'),
  'mfa/email/disable': () => import('../mfa/email/disable/route'),
  'mfa/email/send': () => import('../mfa/email/send/route'),
  'mfa/email/setup': () => import('../mfa/email/setup/route'),
  'mfa/email/verify-setup': () => import('../mfa/email/verify-setup/route'),
  'mfa/totp/challenge': () => import('../mfa/totp/challenge/route'),
  'mfa/totp/disable': () => import('../mfa/totp/disable/route'),
  'mfa/totp/setup': () => import('../mfa/totp/setup/route'),
  'mfa/totp/verify': () => import('../mfa/totp/verify/route'),
  'onboard/claim': () => import('../onboard/claim/route'),
  'onboard/generate': () => import('../onboard/generate/route'),
  'onboard/poll': () => import('../onboard/poll/route'),
  'onboard': () => import('../onboard/route'),
  'recovery-codes/challenge': () => import('../recovery-codes/challenge/route'),
  'recovery-codes/generate': () => import('../recovery-codes/generate/route'),
  'recovery-codes/status': () => import('../recovery-codes/status/route'),
  'recovery-codes/verify': () => import('../recovery-codes/verify/route'),
  'resolve/dfos/[dfosDid]': () => import('../resolve/dfos/[dfosDid]/route'),
  'search': () => import('../search/route'),
  'session/act-as': () => import('../session/act-as/route'),
  'session': () => import('../session/route'),
  'session/soft': () => import('../session/soft/route'),
  'stored-keys': () => import('../stored-keys/route'),
  'tokens/app': () => import('../tokens/app/route'),
  'tokens/app/verify': () => import('../tokens/app/verify/route'),
};

// Each route handler's first `import()` is a cold transitive load (db client,
// auth, bus, vault...). Doing that inside the `it()` bodies put the first test
// of the run on the clock for it and blew the 5s testTimeout on a loaded CI
// runner (#2616: `access/bearers/[id]/revoke`, 5015ms; ~0.3s idle). That is
// cold-import cost, not a hang, so load every handler once in a hook with an
// explicit budget; the tests below then only measure the handler itself.
const ROUTE_IMPORT_TIMEOUT_MS = 120_000;

const handlers: Record<string, OptionsHandler | undefined> = {};

describe('kernel auth OPTIONS preflight handlers', () => {
  beforeAll(async () => {
    await Promise.all(
      Object.entries(routes).map(async ([name, load]) => {
        handlers[name] = (await load()).OPTIONS;
      }),
    );
  }, ROUTE_IMPORT_TIMEOUT_MS);

  it.each(Object.keys(routes))('%s responds 204 with CORS headers', async (name) => {
    const OPTIONS = handlers[name];
    expect(typeof OPTIONS).toBe('function');

    const request = new NextRequest('https://test.imajin.ai/auth/api/x', {
      method: 'OPTIONS',
      headers: { origin: 'https://test.imajin.ai' },
    });
    const res = await OPTIONS!(request);

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://test.imajin.ai');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });
});
