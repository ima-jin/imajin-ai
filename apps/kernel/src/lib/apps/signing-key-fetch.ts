/**
 * Shared "fetch the app-signing-key grant and hand back the plaintext key"
 * core (#2411) — used by BOTH `POST /api/apps/claim` (first boot) and
 * `POST /api/apps/signing-key/fetch` (every later boot), which differ only
 * in how they authenticate the caller (a one-time claim code vs. a
 * bootstrap-key signature — see `bootstrap-fetch-auth.ts`). Extracted so
 * neither route hand-copies the grant-fetch + purpose-check + HTTP-status
 * mapping logic.
 */
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { fetchGrantSecret, type GrantFetchOutcome } from '../vault';
import { getMintedKeyByDid } from '../vault/key-cards';
import { APP_SIGNING_KEY_PURPOSE } from './signing-key-claims';

const log = createLogger('kernel:apps:signing-key-fetch');

export type SigningKeyFetchStatus = GrantFetchOutcome['status'] | 'wrong_purpose';

export type SigningKeyFetchOutcome =
  | { status: 'ok'; appDid: string; privateKey: string; publicKey: string | null }
  | { status: Exclude<SigningKeyFetchStatus, 'ok'> };

/**
 * Fetches the sealed value behind `grantId` for `appDid` and defensively
 * confirms it's actually purpose-bound to `app-signing-key` (a claim/
 * binding always names the grantId it was issued for, but this guards
 * against a row somehow pointing at an unrelated grant). Never throws for
 * an ordinary refusal.
 */
export async function resolveSigningKeyForGrant(params: {
  grantId: string;
  appDid: string;
}): Promise<SigningKeyFetchOutcome> {
  const grantOutcome = await fetchGrantSecret({ grantId: params.grantId, granteeDid: params.appDid });
  if (grantOutcome.status !== 'ok') {
    return { status: grantOutcome.status };
  }
  if (grantOutcome.grant.purpose !== APP_SIGNING_KEY_PURPOSE) {
    return { status: 'wrong_purpose' };
  }

  const mintedKey = await getMintedKeyByDid(params.appDid);
  return {
    status: 'ok',
    appDid: params.appDid,
    privateKey: grantOutcome.value,
    publicKey: mintedKey?.publicKey ?? null,
  };
}

/** HTTP status for every non-'ok' {@link SigningKeyFetchOutcome}. */
export function statusForSigningKeyFetchOutcome(status: Exclude<SigningKeyFetchStatus, 'ok'>): number {
  switch (status) {
    case 'not_found':
    case 'not_grantee':
      return 404;
    case 'consumed':
      return 410;
    case 'wrong_purpose':
      return 500;
    case 'inactive':
    case 'expired':
    default:
      return 403;
  }
}

/** Value-free error message for every non-'ok' {@link SigningKeyFetchOutcome}. */
export function errorForSigningKeyFetchOutcome(status: Exclude<SigningKeyFetchStatus, 'ok'>): string {
  switch (status) {
    case 'not_found':
    case 'not_grantee':
      return 'The app-signing-key grant no longer exists';
    case 'consumed':
      return 'The app-signing-key grant has already been fetched';
    case 'inactive':
      return 'The app-signing-key grant is no longer active (revoked)';
    case 'expired':
      return 'The app-signing-key grant has expired';
    case 'wrong_purpose':
      return 'Unable to fetch the app-signing-key grant';
    default:
      return 'Unable to fetch the app-signing-key grant';
  }
}

/** Which authentication path a signing-key fetch used — the final link in the minted -> granted -> claimed/re-authenticated -> fetched chain. */
export type SigningKeyFetchVia = 'claim' | 'bootstrap-key';

/**
 * Emits `apps.signing-key.fetched` for BOTH routes that can produce one,
 * tagged with `via` so the /jin timeline and audit log can tell a
 * first-boot claim exchange apart from an ordinary restart re-fetch.
 * Fire-and-forget, matching every other vault/apps event in this codebase.
 */
export function emitSigningKeyFetchedEvent(params: {
  nodeDid: string;
  slug: string;
  appDid: string;
  grantId: string;
  outcome: SigningKeyFetchStatus;
  via: SigningKeyFetchVia;
}): void {
  const { nodeDid, slug, appDid, grantId, outcome, via } = params;
  publish('apps.signing-key.fetched', {
    issuer: nodeDid,
    subject: appDid,
    scope: 'apps',
    payload: { slug, appDid, grantId, outcome, via, context_id: appDid, context_type: 'apps.signing-key' },
  }).catch((err: unknown) => log.error({ err: String(err), slug, appDid, via }, 'Bus publish error for apps.signing-key.fetched'));
}
