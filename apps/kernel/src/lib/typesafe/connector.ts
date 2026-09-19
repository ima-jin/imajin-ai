/**
 * TypeSafe.ai (Jev) connector backend library (#2197).
 *
 * Design revision (see the issue's superseding comment): TypeSafe is a
 * SERVICE connector, not an inference connector. A sealed TypeSafe API key
 * buys the `/v1/systemone` calibrated decision primitive — a typed answer
 * (noul/choice/score) with a probability distribution attached — which is
 * not a chat completion and cannot be forwarded through `/infer/*`. It is
 * therefore custodied exactly like every other token-paste SERVICE
 * connector (OpenRouter, #2189) but owns its own route namespace
 * (`/typesafe/api/*`) and its own scope family (`typesafe:decide`), and is
 * never registered in `BRAIN_CONNECTORS` (`src/lib/inference/brain.ts`).
 *
 * Custody mechanics — per-DID vault fields, the fail-closed grant gate, the
 * pending-grant distinction — all live in `createConnectorTokenPaste`
 * (#1621). Only TypeSafe's identity is declared here, the same shape every
 * other token-paste connector (Discord, Stripe, OpenRouter, the brain
 * connectors) already uses.
 *
 * The sealed key never leaves the kernel: it is resolved server-side for the
 * duration of one call and there is no route, and no exported function here,
 * that returns it to a caller (#1922 anti-goal, load-bearing).
 */
import { CONNECTOR_DIDS, CONNECTOR_CHANNELS } from '@imajin/auth/scope-vocabulary';
import {
  createConnectorTokenPaste,
  type TokenPasteCredentials,
} from '@/src/lib/kernel/connector-token-paste';

/** Connector app DID — matches the scope-manifest for the typesafe connector. */
export const TYPESAFE_CONNECTOR_DID = CONNECTOR_DIDS.typesafe;

/** Channel label in `auth.channel_links`. */
export const TYPESAFE_CHANNEL = CONNECTOR_CHANNELS.typesafe;

/** Scope the owner grants to let their key be used for `/typesafe/api/decide` calls. */
export const TYPESAFE_DECIDE_SCOPE = 'typesafe:decide';

/**
 * TypeSafe.ai's public API base (docs.typesafe.ai/api) — owned by `./client`
 * (which must stay free of this module's vault/DB dependency) and
 * re-exported here so callers of the connector identity have it too.
 */
export { TYPESAFE_BASE_URL } from './client';

const typesafe = createConnectorTokenPaste({
  id: 'typesafe',
  displayName: 'TypeSafe.ai',
  connectorDid: TYPESAFE_CONNECTOR_DID,
  channel: TYPESAFE_CHANNEL,
});

/** Per-DID vault field for the TypeSafe API key: `typesafe-api-key:{ownerDid}`. */
export const vaultField = typesafe.vaultField;

/** Seal an API key for this DID. TypeSafe has no per-call baseUrl/model override to seal alongside it. */
export const sealApiKey = typesafe.sealApiKey;

/** True when an active `channel_links` row for this DID carries the scope. */
export const resolveActiveGrant = typesafe.resolveActiveGrant;

/** Fail-closed gate: active `typesafe:decide` grant + sealed key, or throw `typesafe_*`. */
export const requireGrantAndKey = typesafe.requireGrantAndKey;

/** Whether a TypeSafe API key is sealed AND readable for this DID (#1724). */
export const typesafeKeySealed = typesafe.keySealed;

/** Whether a key is sealed but awaiting owner grant approval (#1603). */
export const typesafeKeyPending = typesafe.keyPending;

/**
 * Revoke the sealed TypeSafe API key's delegation grant for this DID,
 * cutting off access immediately without deleting the sealed key (#1720).
 */
export const revokeApiKey = typesafe.revokeApiKey;

export type TypesafeCredentials = TokenPasteCredentials;

/**
 * Resolve sealed TypeSafe credentials for a DID, or `undefined` when this DID
 * has no active `typesafe:decide` grant or no key sealed. The resolved key is
 * for the immediate call only: never log it or return it to a caller.
 */
export function loadTypesafeCredentials(ownerDid: string): Promise<TypesafeCredentials | undefined> {
  return typesafe.loadCredentials(ownerDid, TYPESAFE_DECIDE_SCOPE);
}

/**
 * Resolve the sealed TypeSafe key for a DID WITHOUT requiring an active
 * `typesafe:decide` grant (#1773 precedent). Used by `GET /typesafe/api/models`,
 * which doubles as connect-time key validation (probe) and card status —
 * the owner is asking "is my key valid?" before reaching the "grant scopes"
 * step, not spending the credential on anyone's behalf.
 */
export function loadTypesafeSealedCredentials(ownerDid: string): Promise<TypesafeCredentials | undefined> {
  return typesafe.loadSealedCredentials(ownerDid);
}
