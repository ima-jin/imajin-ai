/**
 * OpenAI BILLING connector backend library (#1076 Stage 1).
 *
 * OpenAI's org usage/cost surface (`GET /v1/organization/usage/completions`,
 * `GET /v1/organization/costs`) requires an org ADMIN API key — a different
 * credential from the inference key sealed by `./connector.ts`. See
 * `@/src/lib/anthropic/billing-connector` for the full rationale; this is the
 * OpenAI instance of the identical shape.
 */
import { CONNECTOR_DIDS, CONNECTOR_CHANNELS } from '@imajin/auth/scope-vocabulary';
import {
  createConnectorTokenPaste,
  type TokenPasteCredentials,
} from '@/src/lib/kernel/connector-token-paste';

/** Connector app DID — the same OpenAI connector card the inference key lives on. */
export const OPENAI_CONNECTOR_DID = CONNECTOR_DIDS.openai;

/** Channel label in `auth.channel_links`. */
export const OPENAI_CHANNEL = CONNECTOR_CHANNELS.openai;

/** Scope the owner grants to let their org admin key be used for billing reconciliation. */
export const OPENAI_BILLING_SCOPE = 'openai:billing';

const openaiBilling = createConnectorTokenPaste({
  id: 'openai-billing',
  displayName: 'OpenAI Billing',
  connectorDid: OPENAI_CONNECTOR_DID,
  channel: OPENAI_CHANNEL,
});

/** Per-DID vault field for the OpenAI org admin API key: `openai-billing-api-key:{ownerDid}`. */
export const vaultField = openaiBilling.vaultField;

/** Seal an org admin API key for this DID. Re-sealing replaces the previous value (rotate semantics). */
export const sealBillingKey = openaiBilling.sealApiKey;

/** True when an active `channel_links` row for this DID carries `openai:billing`. */
export const resolveActiveGrant = openaiBilling.resolveActiveGrant;

/** Fail-closed gate: active grant + sealed key, or throw `openai-billing_*`. */
export const requireGrantAndKey = openaiBilling.requireGrantAndKey;

/** Whether an OpenAI org admin API key is sealed AND readable for this DID. */
export const billingKeySealed = openaiBilling.keySealed;

/** Whether a key is sealed but awaiting owner grant approval (#1603). */
export const billingKeyPending = openaiBilling.keyPending;

/** Revoke the sealed org admin API key's delegation grant for this DID. */
export const revokeBillingKey = openaiBilling.revokeApiKey;

/**
 * List every owner DID with an active `openai:billing` grant — what the
 * daily ingestion job (#1076 Stage 1) iterates.
 */
export function listBillingGrantOwners(): Promise<string[]> {
  return openaiBilling.listActiveGrantOwners(OPENAI_BILLING_SCOPE);
}

export type OpenAIBillingCredentials = TokenPasteCredentials;

/**
 * Resolve sealed OpenAI org admin credentials for a DID, or `undefined` when
 * this DID has no billing connection sealed (or the grant is missing).
 *
 * Returns `undefined` rather than throwing so the ingestion job can skip this
 * principal's OpenAI pull and continue with the next principal/provider
 * (fail-open, #1076 Stage 1) instead of aborting the whole sweep.
 */
export function loadOpenaiBillingCredentials(ownerDid: string): Promise<OpenAIBillingCredentials | undefined> {
  return openaiBilling.loadCredentials(ownerDid, OPENAI_BILLING_SCOPE);
}
