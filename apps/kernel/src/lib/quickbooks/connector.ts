/**
 * QuickBooks Online connector backend (#1210, Phase 1 — read-mostly).
 *
 * Connects a human DID's QuickBooks Online account (OAuth2), sealing the token
 * bundle in imajin-vault, gated by an active `auth.channel_links` row for the
 * quickbooks connector app DID + `quickbooks:read`. Reads the supplier's
 * invoices as settlement signals. NO write-back to QuickBooks in Phase 1.
 *
 * Mirrors the #1228 GitHub connector's security shape:
 * - Fail-closed on every gate: no active grant OR no sealed tokens ⇒ throw.
 * - Tokens are NEVER logged, NEVER returned to external callers.
 * - Per-DID vault field isolation: `quickbooks-oauth:${ownerDid}`.
 *
 * Credentials come from env (never hard-coded): QUICKBOOKS_CLIENT_ID,
 * QUICKBOOKS_CLIENT_SECRET, QUICKBOOKS_REDIRECT_URI, QUICKBOOKS_ENVIRONMENT
 * (`sandbox` | `production`).
 */
import { createLogger } from '@imajin/logger';
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { sealAndStore, loadAndUnseal } from '@/src/lib/vault';

const log = createLogger('kernel');

/** Connector app DID — the selectable "QuickBooks" connector identity. */
export const QUICKBOOKS_CONNECTOR_DID = 'did:imajin:quickbooks-connector';

/** channel_links channel name for QuickBooks grants. */
const QUICKBOOKS_CHANNEL = 'quickbooks';

/** Intuit OAuth2 + Accounting API scope. */
export const QUICKBOOKS_OAUTH_SCOPE = 'com.intuit.quickbooks.accounting';

/** Intuit OAuth2 endpoints (same across environments). */
const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

/** Accounting API base differs by environment. */
function apiBase(): string {
  const env = process.env.QUICKBOOKS_ENVIRONMENT ?? 'sandbox';
  return env === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`quickbooks_config: ${name} is not set`);
  }
  return value;
}

// ── Token bundle (sealed per-DID) ─────────────────────────────────────────────

export interface QuickBooksTokens {
  accessToken: string;
  refreshToken: string;
  realmId: string;
  /** epoch ms at which the access token expires. */
  expiresAt: number;
}

/** Per-DID vault field — encoding ownerDid guarantees per-DID isolation. */
export function vaultField(ownerDid: string): string {
  return `quickbooks-oauth:${ownerDid}`;
}

async function storeTokens(ownerDid: string, tokens: QuickBooksTokens): Promise<void> {
  await sealAndStore(vaultField(ownerDid), JSON.stringify(tokens));
}

async function loadTokens(ownerDid: string): Promise<QuickBooksTokens | undefined> {
  const raw = await loadAndUnseal(vaultField(ownerDid));
  if (raw === undefined) {
    return undefined;
  }
  return JSON.parse(raw) as QuickBooksTokens;
}

// ── OAuth2 flows ──────────────────────────────────────────────────────────────

/** Build the Intuit authorize URL for the connect route. `state` binds the DID. */
export function buildAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: requireEnv('QUICKBOOKS_CLIENT_ID'),
    response_type: 'code',
    scope: QUICKBOOKS_OAUTH_SCOPE,
    redirect_uri: requireEnv('QUICKBOOKS_REDIRECT_URI'),
    state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

function basicAuthHeader(): string {
  const id = requireEnv('QUICKBOOKS_CLIENT_ID');
  const secret = requireEnv('QUICKBOOKS_CLIENT_SECRET');
  return `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
}

interface IntuitTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function postToken(body: URLSearchParams): Promise<IntuitTokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: basicAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`quickbooks_token: Intuit token endpoint ${res.status} ${res.statusText}: ${text}`);
  }
  return res.json() as Promise<IntuitTokenResponse>;
}

/**
 * Exchange an authorization code for tokens and seal them under ownerDid.
 * `realmId` is supplied by Intuit as a callback query param (not in the token body).
 */
export async function exchangeCodeAndStore(
  ownerDid: string,
  code: string,
  realmId: string,
): Promise<void> {
  const data = await postToken(new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: requireEnv('QUICKBOOKS_REDIRECT_URI'),
  }));

  await storeTokens(ownerDid, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    realmId,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
  log.info({ ownerDid, realmId }, 'QuickBooks account connected');
}

/** Refresh an expired access token and re-seal. Returns the fresh bundle. */
async function refreshTokens(ownerDid: string, tokens: QuickBooksTokens): Promise<QuickBooksTokens> {
  const data = await postToken(new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
  }));

  const refreshed: QuickBooksTokens = {
    accessToken: data.access_token,
    // Intuit rotates refresh tokens periodically; keep the newest.
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    realmId: tokens.realmId,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  await storeTokens(ownerDid, refreshed);
  return refreshed;
}

// ── Grant gate ────────────────────────────────────────────────────────────────

/**
 * True only when an ACTIVE channel_links row for the quickbooks channel + the
 * quickbooks connector app DID contains the required scope. Fail-closed: any
 * DB error propagates.
 */
export async function resolveActiveGrant(ownerDid: string, requiredScope: string): Promise<boolean> {
  const rows = await db
    .select({ scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, QUICKBOOKS_CHANNEL),
        eq(channelLinks.did, ownerDid),
        eq(channelLinks.appDid, QUICKBOOKS_CONNECTOR_DID),
        eq(channelLinks.status, 'active'),
      ),
    );

  return rows.some((row) => {
    const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
    return scopes.includes(requiredScope);
  });
}

/**
 * Resolve the grant + a valid (refreshed if needed) access token. Fail-closed.
 * The returned token is for internal API use only — never log or return it.
 *
 * Throws:
 *   - `quickbooks_no_grant` — no active channel_links row for ownerDid + scope.
 *   - `quickbooks_no_tokens` — no sealed tokens for ownerDid.
 */
async function requireGrantAndTokens(ownerDid: string, scope: string): Promise<QuickBooksTokens> {
  const hasGrant = await resolveActiveGrant(ownerDid, scope);
  if (!hasGrant) {
    throw new Error(
      `quickbooks_no_grant: DID ${ownerDid} has no active '${scope}' grant — ` +
      `enable the connector scope in the scope-manifest`,
    );
  }

  const tokens = await loadTokens(ownerDid);
  if (tokens === undefined) {
    throw new Error(
      `quickbooks_no_tokens: no QuickBooks tokens sealed for DID ${ownerDid} — connect the account first`,
    );
  }

  // Refresh slightly ahead of expiry to avoid mid-request 401s.
  if (Date.now() >= tokens.expiresAt - 60_000) {
    return refreshTokens(ownerDid, tokens);
  }
  return tokens;
}

// ── Read: invoices as settlement signals ──────────────────────────────────────

export interface QuickBooksInvoice {
  id: string;
  docNumber: string | null;
  customerName: string | null;
  totalAmount: number;
  currency: string | null;
  txnDate: string | null;
}

interface RawInvoice {
  Id: string;
  DocNumber?: string;
  TotalAmt?: number;
  CurrencyRef?: { value?: string };
  TxnDate?: string;
  CustomerRef?: { name?: string };
}

function normalizeInvoice(raw: Readonly<RawInvoice>): QuickBooksInvoice {
  return {
    id: raw.Id,
    docNumber: raw.DocNumber ?? null,
    customerName: raw.CustomerRef?.name ?? null,
    totalAmount: typeof raw.TotalAmt === 'number' ? raw.TotalAmt : 0,
    currency: raw.CurrencyRef?.value ?? null,
    txnDate: raw.TxnDate ?? null,
  };
}

/**
 * Read the owner's recent QuickBooks invoices (read-only). `sinceIsoDate`
 * (YYYY-MM-DD) optionally bounds the query. Gated by `quickbooks:read`.
 */
export async function readInvoices(ownerDid: string, sinceIsoDate?: string): Promise<QuickBooksInvoice[]> {
  const tokens = await requireGrantAndTokens(ownerDid, 'quickbooks:read');

  const where = sinceIsoDate ? ` WHERE TxnDate >= '${sinceIsoDate}'` : '';
  const query = `SELECT * FROM Invoice${where} ORDERBY TxnDate DESC MAXRESULTS 50`;
  const url = `${apiBase()}/v3/company/${tokens.realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`quickbooks_api: invoice query ${res.status} ${res.statusText}: ${text}`);
  }

  const data = (await res.json()) as { QueryResponse?: { Invoice?: RawInvoice[] } };
  const invoices = data.QueryResponse?.Invoice ?? [];
  return invoices.map((inv) => normalizeInvoice(inv));
}
