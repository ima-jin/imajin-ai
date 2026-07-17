/**
 * QuickBooks Online connector backend (#1210, Phase 1 — read-mostly).
 *
 * Connects a human DID's QuickBooks Online account (OAuth2), sealing the token
 * bundle in imajin-vault, gated by an active `auth.channel_links` row for the
 * quickbooks connector app DID + `quickbooks:read`. Reads the supplier's
 * invoices as settlement signals.
 *
 * The OAuth2 plumbing (config sealing, token sealing, authorize URL, code
 * exchange, refresh, grant resolution) is provided by `createConnectorOAuth`
 * (#1333). Only QuickBooks-specific details live here: the Intuit endpoints,
 * the HTTP-Basic token auth method, the `realmId`-carrying token bundle, and
 * the invoice/settlement API.
 */
import { createConnectorOAuth, type BaseOAuthConfig, type OAuthTokenResponse } from '../kernel/connector-oauth';

/** Connector app DID — the selectable "QuickBooks" connector identity. */
export const QUICKBOOKS_CONNECTOR_DID = 'did:imajin:quickbooks-connector';

/** Intuit OAuth2 + Accounting API scope. */
export const QUICKBOOKS_OAUTH_SCOPE = 'com.intuit.quickbooks.accounting';

/** PrivateNote marker that stamps the lot correlationId onto an invoice (deterministic read-back). */
export const LOT_NOTE_PREFIX = 'imajin-lot:';

// ── QuickBooks-specific types ─────────────────────────────────────────────────────────

export interface QuickBooksConfig extends BaseOAuthConfig {
  environment: 'sandbox' | 'production';
}

export interface QuickBooksTokens {
  accessToken: string;
  refreshToken: string;
  realmId: string;
  /** epoch ms at which the access token expires. */
  expiresAt: number;
}

// ── Factory ───────────────────────────────────────────────────────────────────────────

const qb = createConnectorOAuth<QuickBooksConfig, QuickBooksTokens>({
  name: 'quickbooks',
  configPrefix: 'quickbooks-config',
  tokenPrefix: 'quickbooks-oauth',
  connectorDid: QUICKBOOKS_CONNECTOR_DID,
  channel: 'quickbooks',
  authorizeUrl: 'https://appcenter.intuit.com/connect/oauth2',
  tokenUrl: 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',
  oauthScope: QUICKBOOKS_OAUTH_SCOPE,
  // Intuit uses HTTP Basic auth for client credentials (not body params).
  tokenAuth: 'basic',
  parseConfig: (raw) => raw as QuickBooksConfig,
  buildTokens: (data: OAuthTokenResponse, extra, previous) => ({
    accessToken: data.access_token as string,
    // Intuit rotates refresh tokens periodically; keep the newest.
    refreshToken: (data.refresh_token ?? previous?.refreshToken) as string,
    // realmId comes from the callback param (extra) on initial connect, then
    // carried forward from the previous bundle on refresh.
    realmId: (extra['realmId'] as string | undefined) ?? previous?.realmId ?? '',
    expiresAt: Date.now() + ((data.expires_in as number) * 1000),
  }),
  // QB tokens always expire; refresh 60s ahead.
  shouldRefresh: (tokens) => Date.now() >= tokens.expiresAt - 60_000,
});

// ── Public exports (shared interface unchanged) ─────────────────────────────────

export const configField = qb.configField;
/** Alias kept for backward compatibility — use `configField` for the config vault key. */
export const vaultField = qb.tokenField;
export const storeConfig = qb.storeConfig;
export const buildAuthorizeUrl = qb.buildAuthorizeUrl;
export const resolveActiveGrant = qb.resolveActiveGrant;

/**
 * Exchange an authorization code for tokens and seal them under ownerDid.
 * `realmId` is supplied by Intuit as a callback query param (not in the token body).
 */
export async function exchangeCodeAndStore(
  ownerDid: string,
  code: string,
  realmId: string,
): Promise<void> {
  await qb.exchangeCodeAndStore(ownerDid, code, { realmId });
}

// ── QuickBooks-specific: grant gate ─────────────────────────────────────────────

/** Accounting API base differs by the DID's configured environment. */
function apiBase(config: QuickBooksConfig): string {
  return config.environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

/**
 * Resolve the grant + a valid (refreshed if needed) token bundle. Fail-closed.
 * QB actions need both the access token (for Authorization) and the full bundle
 * (for realmId + config for apiBase), so we return both.
 *
 * Throws:
 *   - `quickbooks_no_grant`  — no active channel_links row for ownerDid + scope.
 *   - `quickbooks_no_tokens` — no sealed tokens for ownerDid.
 */
async function requireGrantAndTokens(
  ownerDid: string,
  scope: string,
): Promise<{ tokens: QuickBooksTokens; config: QuickBooksConfig }> {
  const hasGrant = await qb.resolveActiveGrant(ownerDid, scope);
  if (!hasGrant) {
    throw new Error(
      `quickbooks_no_grant: DID ${ownerDid} has no active '${scope}' grant — ` +
      `enable the connector scope in the scope-manifest`,
    );
  }
  const [config, tokens] = await Promise.all([qb.loadConfig(ownerDid), qb.loadAndRefreshTokens(ownerDid)]);
  if (tokens === undefined) {
    throw new Error(
      `quickbooks_no_tokens: no QuickBooks tokens sealed for DID ${ownerDid} — connect the account first`,
    );
  }
  return { tokens, config };
}

// ── Read: invoices as settlement signals ──────────────────────────────────────

export interface QuickBooksInvoice {
  id: string;
  docNumber: string | null;
  customerName: string | null;
  totalAmount: number;
  /** Outstanding balance; 0 means paid (the settlement trigger). */
  balance: number | null;
  currency: string | null;
  txnDate: string | null;
  /** Lot correlationId recovered from the PrivateNote stamp, if present. */
  correlationId: string | null;
}

interface RawInvoice {
  Id: string;
  DocNumber?: string;
  TotalAmt?: number;
  Balance?: number;
  CurrencyRef?: { value?: string };
  TxnDate?: string;
  CustomerRef?: { name?: string };
  PrivateNote?: string;
}

function parseLotCorrelationId(privateNote: string | undefined): string | null {
  if (privateNote === undefined) {
    return null;
  }
  const marker = privateNote.split('\n').find((line) => line.startsWith(LOT_NOTE_PREFIX));
  return marker ? marker.slice(LOT_NOTE_PREFIX.length).trim() : null;
}

function normalizeInvoice(raw: Readonly<RawInvoice>): QuickBooksInvoice {
  return {
    id: raw.Id,
    docNumber: raw.DocNumber ?? null,
    customerName: raw.CustomerRef?.name ?? null,
    totalAmount: typeof raw.TotalAmt === 'number' ? raw.TotalAmt : 0,
    balance: typeof raw.Balance === 'number' ? raw.Balance : null,
    currency: raw.CurrencyRef?.value ?? null,
    txnDate: raw.TxnDate ?? null,
    correlationId: parseLotCorrelationId(raw.PrivateNote),
  };
}

/**
 * Read the owner's recent QuickBooks invoices (read-only). `sinceIsoDate`
 * (YYYY-MM-DD) optionally bounds the query. Gated by `quickbooks:read`.
 */
export async function readInvoices(ownerDid: string, sinceIsoDate?: string): Promise<QuickBooksInvoice[]> {
  const { tokens, config } = await requireGrantAndTokens(ownerDid, 'quickbooks:read');

  const where = sinceIsoDate ? ` WHERE TxnDate >= '${sinceIsoDate}'` : '';
  const query = `SELECT * FROM Invoice${where} ORDERBY TxnDate DESC MAXRESULTS 50`;
  const url = `${apiBase(config)}/v3/company/${tokens.realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`;

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

// ── Write: create an invoice stamped with the lot correlationId ───────────────

export interface CreateInvoiceLine {
  amount: number;
  itemRef: string;
  description?: string;
  quantity?: number;
  unitPrice?: number;
}

export interface CreateInvoiceParams {
  /** Delivery lot's correlationId — stamped onto the invoice for deterministic read-back. */
  correlationId: string;
  customerRef: string;
  lines: CreateInvoiceLine[];
}

/**
 * Create a QuickBooks invoice on behalf of ownerDid, stamping the lot
 * `correlationId` into PrivateNote so the paid read-back matches deterministically
 * (AgriFortress authors the invoice, so no fuzzy matching). Gated by `quickbooks:write`.
 */
export async function createInvoice(ownerDid: string, params: CreateInvoiceParams): Promise<QuickBooksInvoice> {
  const { tokens, config } = await requireGrantAndTokens(ownerDid, 'quickbooks:write');

  const body = {
    CustomerRef: { value: params.customerRef },
    PrivateNote: `${LOT_NOTE_PREFIX}${params.correlationId}`,
    Line: params.lines.map((line) => ({
      Amount: line.amount,
      DetailType: 'SalesItemLineDetail',
      Description: line.description,
      SalesItemLineDetail: {
        ItemRef: { value: line.itemRef },
        ...(line.quantity === undefined ? {} : { Qty: line.quantity }),
        ...(line.unitPrice === undefined ? {} : { UnitPrice: line.unitPrice }),
      },
    })),
  };

  const url = `${apiBase(config)}/v3/company/${tokens.realmId}/invoice?minorversion=65`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`quickbooks_api: invoice create ${res.status} ${res.statusText}: ${text}`);
  }

  const data = (await res.json()) as { Invoice?: RawInvoice };
  if (!data.Invoice) {
    throw new Error('quickbooks_api: invoice create returned no Invoice');
  }
  return normalizeInvoice(data.Invoice);
}
