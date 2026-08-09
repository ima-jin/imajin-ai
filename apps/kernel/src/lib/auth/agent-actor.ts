/**
 * Pure helpers for promoting an authorized app into a first-class actor identity
 * row (#1170 Stage 0), generalizing the Claude one-off in migration 0053 (#1178).
 *
 * Kept import-free (no db / Next / @imajin imports) so the row shape + key policy
 * are unit-testable without the `@/*` path alias, which vitest does not resolve.
 *
 * #1735: the promoted actor now stores the app's REAL Ed25519 public key (the
 * same key that was used to derive its DID) instead of a non-signing `agent_`
 * sentinel. Developer apps hold a real keypair and mint proof-of-possession
 * tokens against it (`/auth/api/apps/token`) — verifying that signature against
 * a sentinel string always failed with a 401. Promotion also now creates the
 * bidirectional `identity_members` rows linking the actor to the DID that
 * granted the authorization, so the promoted actor is never an orphan.
 */

/** Input describing the app being promoted (sourced from a registry.apps row). */
export interface PromoteActorInput {
  /** registry.apps.id — the OAuth client_id / adapter-binding id. */
  appId: string;
  /** registry.apps.app_did — becomes the actor identity DID (auth.identities.id). */
  appDid: string;
  /**
   * registry.apps.public_key — the app's real Ed25519 public key (hex). This is
   * the exact key that `appDid` was derived from, so it always matches
   * `publicKeyFromDid(appDid)` (#1735).
   */
  publicKey: string;
  /**
   * The acting/business DID that granted this authorization (#1735). Becomes
   * the 'owner' member of the promoted actor, and the promoted actor becomes
   * an 'agent' member of this DID, so the actor is never an orphaned identity.
   */
  ownerDid: string;
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

/** A row ready to insert into auth.identity_members (camelCase Drizzle fields). */
export interface AgentMembershipRow {
  identityDid: string;
  memberDid: string;
  role: 'owner' | 'agent';
  addedBy: string;
  addedVia: 'direct' | 'agent';
}

/**
 * Shape the auth.identities row for a promoted agent actor. Mirrors migration
 * 0053's shape (scope='actor', subtype='agent', NULL handle so an agent can
 * never collide with or impersonate a human handle, agent metadata) but stores
 * the app's real Ed25519 public key rather than the historical `agent_`
 * sentinel (#1735).
 */
export function buildAgentActorRow(input: PromoteActorInput): AgentActorRow {
  return {
    id: input.appDid,
    scope: 'actor',
    subtype: 'agent',
    publicKey: input.publicKey,
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

/**
 * Shape the two auth.identity_members rows linking a promoted agent actor to
 * the DID that granted its authorization (#1735). Without these, the promoted
 * actor is an orphan: it exists in auth.identities but belongs to nobody, and
 * can never be listed under (or delegated to act for) its owner.
 */
export function buildAgentMembershipRows(input: PromoteActorInput): AgentMembershipRow[] {
  return [
    // The promoted actor is owned by the DID that granted the authorization.
    {
      identityDid: input.appDid,
      memberDid: input.ownerDid,
      role: 'owner',
      addedBy: input.ownerDid,
      addedVia: 'direct',
    },
    // Reverse: the owner DID gains the promoted actor as a delegated agent.
    {
      identityDid: input.ownerDid,
      memberDid: input.appDid,
      role: 'agent',
      addedBy: input.ownerDid,
      addedVia: 'agent',
    },
  ];
}
