/**
 * Anthropic BILLING connector backend library (#1076 Stage 1).
 *
 * Anthropic's Usage & Cost Admin API (`GET /v1/organizations/usage_report/messages`,
 * `GET /v1/organizations/cost_report`) requires an ADMIN API key
 * (`sk-ant-admin...`) — a different credential from the inference key sealed
 * by `./connector.ts` (`sk-ant-api03-...`). Custody is the same shape (a
 * second `createConnectorTokenPaste` instance, gated by its own scope), just
 * a different vault field and a different scope: `anthropic:billing` rather
 * than `anthropic:infer`.
 *
 * Deliberately reuses the SAME `connectorDid`/`channel` as the inference
 * connector (`./connector.ts`): this is still the Anthropic connector card,
 * just a second credential slot on it, so a single active `channel_links`
 * row for (channel: 'anthropic', appDid: ANTHROPIC_CONNECTOR_DID) can carry
 * both `anthropic:infer` and `anthropic:billing` in its `scopes` array. Only
 * the `id` passed to `createConnectorTokenPaste` differs, which is what
 * namespaces the sealed vault field (`anthropic-billing-api-key:{did}`,
 * distinct from `anthropic-api-key:{did}`).
 *
 * The sealed key never leaves the kernel: it is resolved server-side for the
 * duration of one ingestion pull and there is no route that returns it to a
 * caller (mirrors the inference connector's anti-goal).
 */
import { CONNECTOR_DIDS, CONNECTOR_CHANNELS } from '@imajin/auth/scope-vocabulary';
import {
  createConnectorTokenPaste,
  type TokenPasteCredentials,
} from '@/src/lib/kernel/connector-token-paste';

/** Connector app DID — the same Anthropic connector card the inference key lives on. */
export const ANTHROPIC_CONNECTOR_DID = CONNECTOR_DIDS.anthropic;

/** Channel label in `auth.channel_links`. */
export const ANTHROPIC_CHANNEL = CONNECTOR_CHANNELS.anthropic;

/** Scope the owner grants to let their Admin key be used for billing reconciliation. */
export const ANTHROPIC_BILLING_SCOPE = 'anthropic:billing';

const anthropicBilling = createConnectorTokenPaste({
  id: 'anthropic-billing',
  displayName: 'Anthropic Billing',
  connectorDid: ANTHROPIC_CONNECTOR_DID,
  channel: ANTHROPIC_CHANNEL,
});

/** Per-DID vault field for the Anthropic Admin API key: `anthropic-billing-api-key:{ownerDid}`. */
export const vaultField = anthropicBilling.vaultField;

/** Seal an Admin API key for this DID. Re-sealing replaces the previous value (rotate semantics). */
export const sealBillingKey = anthropicBilling.sealApiKey;

/** True when an active `channel_links` row for this DID carries `anthropic:billing`. */
export const resolveActiveGrant = anthropicBilling.resolveActiveGrant;

/** Fail-closed gate: active grant + sealed key, or throw `anthropic-billing_*`. */
export const requireGrantAndKey = anthropicBilling.requireGrantAndKey;

/** Whether an Anthropic Admin API key is sealed AND readable for this DID. */
export const billingKeySealed = anthropicBilling.keySealed;

/** Whether a key is sealed but awaiting owner grant approval (#1603). */
export const billingKeyPending = anthropicBilling.keyPending;

/** Revoke the sealed Admin API key's delegation grant for this DID. */
export const revokeBillingKey = anthropicBilling.revokeApiKey;

/**
 * List every owner DID with an active `anthropic:billing` grant — what the
 * daily ingestion job (#1076 Stage 1) iterates.
 */
export function listBillingGrantOwners(): Promise<string[]> {
  return anthropicBilling.listActiveGrantOwners(ANTHROPIC_BILLING_SCOPE);
}

export type AnthropicBillingCredentials = TokenPasteCredentials;

/**
 * Resolve sealed Anthropic Admin credentials for a DID, or `undefined` when
 * this DID has no billing connection sealed (or the grant is missing).
 *
 * Returns `undefined` rather than throwing so the ingestion job can skip this
 * principal's Anthropic pull and continue with the next principal/provider
 * (fail-open, #1076 Stage 1) instead of aborting the whole sweep.
 */
export function loadAnthropicBillingCredentials(ownerDid: string): Promise<AnthropicBillingCredentials | undefined> {
  return anthropicBilling.loadCredentials(ownerDid, ANTHROPIC_BILLING_SCOPE);
}
