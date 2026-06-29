/**
 * Pure helpers for promoting an authorized app into a first-class actor identity
 * row (#1170 Stage 0), generalizing the Claude one-off in migration 0053 (#1178).
 *
 * Kept import-free (no db / Next / @imajin imports) so the row shape + key policy
 * are unit-testable without the `@/*` path alias, which vitest does not resolve.
 */

/** Input describing the app being promoted (sourced from a registry.apps row). */
export interface PromoteActorInput {
  /** registry.apps.id — the OAuth client_id / adapter-binding id. */
  appId: string;
  /** registry.apps.app_did — becomes the actor identity DID (auth.identities.id). */
  appDid: string;
  /** Display name (registry.apps.name). */
  name?: string | null;
  /** Optional avatar (registry.apps.logo_url). */
  avatarUrl?: string | null;
  /** Adapter type recorded in metadata (e.g. 'oauth'). Defaults to 'oauth'. */
  adapter?: string;
}

/** Metadata stamped on a promoted agent actor (mirrors migration 0053). */
export interface AgentActorMetadata {
  agent: true;
  client: true;
  adapter: string;
  adapterAppId: string;
}

/** A row ready to insert into auth.identities (camelCase Drizzle fields). */
export interface AgentActorRow {
  id: string;
  scope: 'actor';
  subtype: 'agent';
  publicKey: string;
  handle: null;
  name: string | null;
  avatarUrl: string | null;
  metadata: AgentActorMetadata;
}

/**
 * Non-signing sentinel public key for a promoted agent actor.
 *
 * auth.identities.public_key is NOT NULL + UNIQUE and is otherwise a real
 * Ed25519 signing key. Agent actors are non-signing (#1171 Correction 3), so we
 * store a deterministic, non-curve `agent_<appId>` sentinel: unique per app and
 * impossible to confuse with a real curve key. The app's real key (if any) stays
 * on the registry.apps adapter binding — promotion never copies it here, so an
 * authorized integration can never become a signing identity in v1.
 */
export function agentSentinelKey(appId: string): string {
  return `agent_${appId}`;
}

/**
 * Shape the auth.identities row for a promoted agent actor. Mirrors migration
 * 0053 exactly: scope='actor', subtype='agent', sentinel key, NULL handle (so an
 * agent can never collide with or impersonate a human handle), agent metadata.
 */
export function buildAgentActorRow(input: PromoteActorInput): AgentActorRow {
  return {
    id: input.appDid,
    scope: 'actor',
    subtype: 'agent',
    publicKey: agentSentinelKey(input.appId),
    handle: null,
    name: input.name ?? null,
    avatarUrl: input.avatarUrl ?? null,
    metadata: {
      agent: true,
      client: true,
      adapter: input.adapter ?? 'oauth',
      adapterAppId: input.appId,
    },
  };
}
