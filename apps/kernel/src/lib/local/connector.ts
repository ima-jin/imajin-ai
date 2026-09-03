/**
 * Local inference connector backend library (#1957).
 *
 * An OpenAI-compatible endpoint (Ollama on imajin-ml `:11434`, vLLM/Nemotron
 * on PGX `:8000`) reachable at an owner-configured `baseUrl`, with NO sealed
 * key required — an optional bearer token is the only credential-grade
 * material this connector ever holds.
 *
 * This deliberately does NOT reuse `createConnectorTokenPaste`
 * (`../kernel/connector-token-paste.ts`): that factory's whole contract is
 * built around a MANDATORY sealed API key — `loadCredentials` returns
 * `undefined` whenever the key field is unset, which is exactly backwards
 * for a connector whose entire point is working with no key at all. Instead:
 *
 *   - `local-base-url:{did}` + `local-pinned-ip:{did}` + `local-model-id:{did}`
 *     — v1 node-sealed (`sealAndStore`/`loadAndUnseal`), the same custody
 *     class `warpEnvironmentField` uses for a non-secret preference: none of
 *     these three is secret or authority-bearing, so paying the
 *     delegation-grant machinery for them would buy no security (see
 *     `connector-token-paste.ts`'s header for the full "two custody
 *     classes" reasoning this mirrors).
 *   - `local-api-key:{did}` — v2 delegation-grant (`sealAndStoreV2`), the
 *     one genuinely secret field. Named `-api-key` (not `-bearer-token`)
 *     specifically so `revokeVaultDelegationGrantsForConnector('local', did)`
 *     — which matches on the `${id}-%-key:${did}` pattern every other brain
 *     connector's key already uses — finds and revokes it on disconnect
 *     without a bespoke query.
 *
 * `baseUrl` is the gate every other connector's API key is: `loadCredentials`
 * returns `undefined` (no usable connection) when it is unset, exactly like
 * every other connector reports "nothing sealed". A missing bearer token is
 * NOT that condition — `apiKey` resolves to `''` (never `undefined`) so a
 * `local` connection with no token is a normal, successful resolution.
 *
 * `baseUrl` is validated by `checkEgressTarget` (`../kernel/egress-guard.ts`)
 * before it is ever sealed: private/RFC1918 addresses are DENIED unless the
 * operator has opted them in via `LOCAL_INFER_PRIVATE_ALLOWLIST` — on a
 * hosted kernel, any DID that can grant itself `local:infer` and save a
 * `baseUrl` would otherwise get a read-SSRF primitive into the platform's
 * own LAN. See that module's header for the full threat model and the
 * allowlist's `host[:port]`/CIDR/`*` syntax.
 */
import { and, eq } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { db, channelLinks } from '@/src/db';
import {
  sealAndStore,
  sealAndStoreV2,
  loadAndUnseal,
  deleteFromVault,
  vaultFieldStatus,
  revokeVaultDelegationGrantsForConnector,
} from '@/src/lib/vault';
import { VaultDelegationError } from '@/src/lib/vault/errors';
import {
  recordConnectorRegistration,
  revokeConnectorRegistration,
} from '@/src/lib/kernel/connector-registry-store';
import { checkEgressTarget } from '@/src/lib/kernel/egress-guard';
import { CONNECTOR_DIDS, CONNECTOR_CHANNELS } from '@imajin/auth/scope-vocabulary';

const log = createLogger('kernel:local-connector');

/** Connector app DID — matches the scope-manifest for the local connector. */
export const LOCAL_CONNECTOR_DID = CONNECTOR_DIDS.local;

/** Channel label in `auth.channel_links`. */
export const LOCAL_CHANNEL = CONNECTOR_CHANNELS.local;

/** Scope the owner grants to let this connector be used for inference. */
export const LOCAL_INFER_SCOPE = 'local:infer';

const baseUrlField = (ownerDid: string) => `local-base-url:${ownerDid}`;
const pinnedIpField = (ownerDid: string) => `local-pinned-ip:${ownerDid}`;
const modelIdField = (ownerDid: string) => `local-model-id:${ownerDid}`;
const apiKeyField = (ownerDid: string) => `local-api-key:${ownerDid}`;

/** Credentials resolved for one DID. `apiKey` is `''` when no bearer token is sealed. */
export interface LocalCredentials {
  apiKey: string;
  baseUrl?: string;
  modelId?: string;
  /** The address validated (and pinned) when `baseUrl` was last saved. */
  pinnedIp?: string;
}

/**
 * Thrown by {@link saveBaseUrl} when `checkEgressTarget` denies the URL.
 * The message is safe to return to the owner who typed it in — it names the
 * denial reason, never anything about the kernel's own network position.
 */
export class LocalBaseUrlRejectedError extends Error {
  readonly reason: string;

  constructor(reason: string, message: string) {
    super(`local_invalid_base_url: ${message}`);
    this.name = 'LocalBaseUrlRejectedError';
    this.reason = reason;
  }
}

/** Read a non-secret v1 config field, treating any failure as "not set" (mirrors `connector-token-paste.ts`). */
async function loadOptionalConfig(field: string): Promise<string | undefined> {
  try {
    return await loadAndUnseal(field);
  } catch (err) {
    log.warn({ err: String(err), field }, 'local connector: config field unreadable — treating as unset');
    return undefined;
  }
}

/**
 * Validate `baseUrl` (scheme, DNS resolution, deny-list) and, on success,
 * seal it alongside the address it resolved to — the "host pin after first
 * save" contract (#1957): every later call reuses this pinned address with
 * no fresh DNS resolution, so a DNS-rebinding attempt against an
 * already-approved hostname cannot redirect a live connector. Re-saving
 * (this function again) is the only way to point it anywhere else.
 *
 * Throws {@link LocalBaseUrlRejectedError} when the URL is denied.
 */
export async function saveBaseUrl(ownerDid: string, baseUrl: string): Promise<{ baseUrl: string; pinnedIp: string }> {
  const check = await checkEgressTarget(baseUrl);
  if (!check.ok) {
    throw new LocalBaseUrlRejectedError(check.reason, check.message);
  }

  await sealAndStore(baseUrlField(ownerDid), baseUrl);
  await sealAndStore(pinnedIpField(ownerDid), check.ip);
  log.info({ ownerDid }, 'local connector: baseUrl saved and pinned');
  return { baseUrl, pinnedIp: check.ip };
}

/** Read the sealed `baseUrl` + pinned IP for this DID, or `undefined` when unset. */
export async function readBaseUrl(ownerDid: string): Promise<{ baseUrl: string; pinnedIp?: string } | undefined> {
  const baseUrl = await loadOptionalConfig(baseUrlField(ownerDid));
  if (!baseUrl) return undefined;
  const pinnedIp = await loadOptionalConfig(pinnedIpField(ownerDid));
  return { baseUrl, ...(pinnedIp !== undefined && { pinnedIp }) };
}

/** Whether this DID has a usable `baseUrl` configured — the connector's actual "ready" signal. */
export async function baseUrlConfigured(ownerDid: string): Promise<boolean> {
  return (await readBaseUrl(ownerDid)) !== undefined;
}

/** Clear the sealed `baseUrl` + pinned IP. Idempotent; returns whether anything was cleared. */
export async function clearBaseUrl(ownerDid: string): Promise<boolean> {
  const a = await deleteFromVault(baseUrlField(ownerDid));
  const b = await deleteFromVault(pinnedIpField(ownerDid));
  return a !== undefined || b !== undefined;
}

/** Update just the sealed model id for this DID (#1769 model picker), leaving everything else untouched. */
export async function setModelId(ownerDid: string, modelId: string): Promise<void> {
  await sealAndStore(modelIdField(ownerDid), modelId);
}

/**
 * Seal an optional bearer token for this DID. `baseUrl`/`modelId`, if given,
 * are saved through the same paths {@link saveBaseUrl}/{@link setModelId}
 * use — interface parity with every other connector's token route, which
 * accepts all three in one POST.
 */
export async function sealBearerToken(
  ownerDid: string,
  token: string,
  baseUrl?: string,
  modelId?: string,
): Promise<void> {
  await sealAndStoreV2(apiKeyField(ownerDid), token);
  if (baseUrl) await saveBaseUrl(ownerDid, baseUrl);
  if (modelId) await setModelId(ownerDid, modelId);

  await recordConnectorRegistration({
    ownerDid,
    provider: 'local',
    sealedKeyField: apiKeyField(ownerDid),
  });
}

/** Whether a bearer token is sealed AND readable for this DID (#1724 precedent). */
export async function bearerTokenSealed(ownerDid: string): Promise<boolean> {
  return (await vaultFieldStatus(apiKeyField(ownerDid))) === 'ready';
}

/** Whether a bearer token is sealed but still awaiting owner grant approval. */
export async function bearerTokenPending(ownerDid: string): Promise<boolean> {
  return (await vaultFieldStatus(apiKeyField(ownerDid))) === 'pending-grant';
}

async function resolveActiveGrant(ownerDid: string): Promise<boolean> {
  const rows = await db
    .select({ scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, LOCAL_CHANNEL),
        eq(channelLinks.did, ownerDid),
        eq(channelLinks.appDid, LOCAL_CONNECTOR_DID),
        eq(channelLinks.status, 'active'),
      ),
    );

  return rows.some((row: { scopes: unknown }) => {
    const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
    return scopes.includes(LOCAL_INFER_SCOPE);
  });
}

/**
 * Assemble `{ apiKey, baseUrl, modelId, pinnedIp }` for this DID, or
 * `undefined` when no `baseUrl` is configured — the only condition that
 * means "no usable connection" for `local`. A v2 bearer token pending Tier 1
 * approval (`VaultDelegationError`) is treated as "no token", not as a
 * blocking condition: unlike every other connector, the token here is
 * optional, so its own custody state must never prevent `baseUrl` alone
 * from resolving a usable brain.
 */
async function readCredentials(ownerDid: string): Promise<LocalCredentials | undefined> {
  const base = await readBaseUrl(ownerDid);
  if (!base) return undefined;

  let apiKey: string | undefined;
  try {
    apiKey = await loadAndUnseal(apiKeyField(ownerDid));
  } catch (err) {
    if (err instanceof VaultDelegationError) {
      log.info({ ownerDid }, 'local connector: bearer token sealed but awaiting owner grant approval — proceeding without it');
      apiKey = undefined;
    } else {
      throw err;
    }
  }

  const modelId = await loadOptionalConfig(modelIdField(ownerDid));

  return {
    apiKey: apiKey ?? '',
    baseUrl: base.baseUrl,
    ...(base.pinnedIp !== undefined && { pinnedIp: base.pinnedIp }),
    ...(modelId !== undefined && { modelId }),
  };
}

/**
 * Resolve credentials for `resolveBrain` (#1621): requires an active
 * `local:infer` grant, exactly like every other brain connector's
 * `loadCredentials`. Returns `undefined` — not a throw — when the grant is
 * missing OR `baseUrl` is unset, so the walk can try the next connector.
 */
export async function loadLocalCredentials(ownerDid: string): Promise<LocalCredentials | undefined> {
  const hasGrant = await resolveActiveGrant(ownerDid);
  if (!hasGrant) return undefined;
  return readCredentials(ownerDid);
}

/**
 * Resolve `{ apiKey, baseUrl, modelId, pinnedIp }` WITHOUT requiring an
 * active `local:infer` grant (#1773 precedent) — for the model picker only,
 * which is the owner asking what THEIR OWN endpoint can do, not spending
 * the connection on anyone's behalf.
 */
export function loadLocalSealedCredentials(ownerDid: string): Promise<LocalCredentials | undefined> {
  return readCredentials(ownerDid);
}

async function revokeActiveChannelLinks(ownerDid: string): Promise<number> {
  const revoked = await db
    .update(channelLinks)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(channelLinks.channel, LOCAL_CHANNEL),
        eq(channelLinks.did, ownerDid),
        eq(channelLinks.appDid, LOCAL_CONNECTOR_DID),
        eq(channelLinks.status, 'active'),
      ),
    )
    .returning({ id: channelLinks.id });
  return revoked.length;
}

/**
 * Full disconnect: revokes the bearer token's delegation grant (if any) and
 * every active `local:infer` channel_links row, then clears `baseUrl` +
 * pinned IP + model id — unlike a token-only connector's disconnect, there
 * is nothing left worth keeping once the endpoint itself is disconnected.
 * Returns whether anything was actually revoked or cleared.
 */
export async function disconnect(ownerDid: string): Promise<boolean> {
  const revokedGrants = await revokeVaultDelegationGrantsForConnector('local', ownerDid);
  const revokedLinks = await revokeActiveChannelLinks(ownerDid);
  const clearedSettings = await clearBaseUrl(ownerDid);
  await deleteFromVault(modelIdField(ownerDid));
  await revokeConnectorRegistration(ownerDid, 'local');
  return revokedGrants > 0 || revokedLinks > 0 || clearedSettings;
}
