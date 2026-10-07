/**
 * Front door — reach-gate authoring for `/jin` (#2598, parent epics #2587 /
 * #2288).
 *
 * UI-only slice: ZERO new tables, ZERO migrations, ZERO schema changes. It
 * reads and writes primitives that already exist:
 *
 *   - `identities.metadata.agentReachTopics` — the raw, never-disclosed gate
 *     value `reachPrincipal()` evaluates (src/lib/auth/agent-reach.ts). This
 *     module is now the non-test writer of it: it is always re-derived from
 *     the OPEN topics, so a change takes effect on the very next reach call
 *     (the gate reads the row on every call — nothing is cached).
 *   - `identities.metadata.agentReachGate` — one more key in the same jsonb
 *     blob (tiers, per-topic published/mode, daily cap). Authoring state for
 *     the consumers that read it: the agent card (published topic labels)
 *     and the delivery path (mode + cap — enforcement deferred to the #2587 delivery
 *     child, Ryan's ruling on #2598) and `reachPrincipal()` (tiers).
 *   - `kernel.consent_grants` — the `agent.reach` / `contact_topics`
 *     `strangers` grant that opens the broker gate. Replace-semantics, the
 *     same shape as `PUT /profile/api/profile/:id/contact-visibility`: every
 *     save revokes the active grant and (if any non-anonymous tier is
 *     admitted) inserts a fresh one, publishing the existing registered
 *     `broker.consent.revoked` / `broker.consent.created` events — the same
 *     signed bus trail `POST/DELETE /api/broker/consent` produce.
 *
 * Rulings applied (Ryan, 2026-10-05):
 *   - topic menu disclosure: only the topic labels the operator opts to
 *     publish go on the card; gate rules stay private; unpublished topics
 *     answer boolean-only.
 *   - default mode for an admitted topic: `deliver` (full message to the
 *     Inbox, rate-limited, one-tap block).
 *   - anonymous tier: reach_card only — ask/send need a credential, so the
 *     anonymous tier is locked and can never be switched on for the gate.
 */
import { and, eq } from 'drizzle-orm';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { brokerTermVocabulary, normalizeBrokerTerm } from '@imajin/auth/broker-consent-vocabulary';
import { db, identities, consentGrants } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';

const log = createLogger('kernel');

export const FRONT_DOOR_PURPOSE = 'agent.reach';
export const FRONT_DOOR_FIELD = 'contact_topics';
export const FRONT_DOOR_GRANT_CLASS = 'strangers';

/**
 * Tiers a requester can present, weakest first. `anonymous` is reach_card
 * only and can never be admitted; the other three are the identity tiers in
 * `auth.identities.tier` that can hold a credential (`soft` / `preliminary` /
 * `established` — Ryan's ruling on #2598; `verified` / `attested` were retired
 * user levels). `steward` / `operator` identities rank as `established`.
 */
export const FRONT_DOOR_TIERS = ['anonymous', 'soft', 'preliminary', 'established'] as const;
export type FrontDoorTier = (typeof FRONT_DOOR_TIERS)[number];

/** The tiers the operator can switch on — everything except the locked `anonymous`. */
export type FrontDoorGateTier = Exclude<FrontDoorTier, 'anonymous'>;

const GATE_TIER_BY_IDENTITY_TIER: Readonly<Record<string, FrontDoorGateTier>> = {
  soft: 'soft',
  preliminary: 'preliminary',
  hard: 'preliminary', // legacy value, see `normalizeTier` in @imajin/auth
  established: 'established',
  steward: 'established',
  operator: 'established',
};

/**
 * Map a raw `auth.identities.tier` value onto the gate tier it is judged as,
 * or `null` for a missing / non-string / unknown value — which the gate
 * treats as "admitted nowhere" (fail closed, same posture as
 * `requireEstablishedDid`).
 */
export function gateTierForIdentityTier(tier: unknown): FrontDoorGateTier | null {
  if (typeof tier !== 'string') return null;
  return Object.hasOwn(GATE_TIER_BY_IDENTITY_TIER, tier) ? GATE_TIER_BY_IDENTITY_TIER[tier] : null;
}

export const FRONT_DOOR_MODES = ['deliver', 'decline'] as const;
export type FrontDoorMode = (typeof FRONT_DOOR_MODES)[number];

export const MIN_DAILY_CAP = 1;
export const MAX_DAILY_CAP = 1000;
export const DEFAULT_DAILY_CAP = 25;

export interface FrontDoorTopicConfig {
  /** The gate answers `true` for this topic. */
  open: boolean;
  /** The topic's label is listed on the operator's agent card. */
  published: boolean;
  /** What happens to an admitted message: deliver to the Inbox, or decline. */
  mode: FrontDoorMode;
}

export interface FrontDoorConfig {
  tiers: Record<FrontDoorTier, boolean>;
  topics: Record<string, FrontDoorTopicConfig>;
  /** Max delivered messages per day, or `null` for no cap. */
  dailyCap: number | null;
}

export interface FrontDoorTopicOption {
  term: string;
  label: string;
}

/** Topics the operator can choose from — the canonical `contact_topic` vocabulary. */
export function frontDoorTopicOptions(): FrontDoorTopicOption[] {
  const vocabulary = brokerTermVocabulary('contact_topic');
  return (vocabulary?.terms ?? []).map((entry: { term: string; label: string }) => ({ term: entry.term, label: entry.label }));
}

function closedTopic(): FrontDoorTopicConfig {
  return { open: false, published: false, mode: 'deliver' };
}

/** Every vocabulary topic, closed and unpublished, default mode `deliver`. */
export function defaultFrontDoorConfig(): FrontDoorConfig {
  const topics: Record<string, FrontDoorTopicConfig> = {};
  for (const { term } of frontDoorTopicOptions()) topics[term] = closedTopic();
  return {
    tiers: { anonymous: false, soft: false, preliminary: false, established: false },
    topics,
    dailyCap: DEFAULT_DAILY_CAP,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ValidationResult = { ok: true; config: FrontDoorConfig } | { ok: false; error: string };

function validateTiers(raw: unknown): { ok: true; tiers: FrontDoorConfig['tiers'] } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'tiers must be an object' };
  const tiers: FrontDoorConfig['tiers'] = { anonymous: false, soft: false, preliminary: false, established: false };
  for (const tier of FRONT_DOOR_TIERS) {
    const value = raw[tier];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return { ok: false, error: `tiers.${tier} must be a boolean` };
    tiers[tier] = value;
  }
  for (const key of Object.keys(raw)) {
    if (!(FRONT_DOOR_TIERS as readonly string[]).includes(key)) return { ok: false, error: `unknown tier: ${key}` };
  }
  // Ruling (2026-10-05): anonymous is reach_card only — ask/send need a credential.
  if (tiers.anonymous) return { ok: false, error: 'the anonymous tier is reach_card only and cannot be admitted' };
  return { ok: true, tiers };
}

function validateTopics(raw: unknown): { ok: true; topics: FrontDoorConfig['topics'] } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'topics must be an object' };
  const topics: FrontDoorConfig['topics'] = {};
  for (const [key, value] of Object.entries(raw)) {
    const term = normalizeBrokerTerm('contact_topic', key);
    if (!term) return { ok: false, error: `unknown topic: ${key}` };
    if (!isRecord(value)) return { ok: false, error: `topics.${key} must be an object` };
    const { open, published, mode } = value;
    if (typeof open !== 'boolean') return { ok: false, error: `topics.${key}.open must be a boolean` };
    if (typeof published !== 'boolean') return { ok: false, error: `topics.${key}.published must be a boolean` };
    if (typeof mode !== 'string' || !(FRONT_DOOR_MODES as readonly string[]).includes(mode)) {
      return { ok: false, error: `topics.${key}.mode must be one of: ${FRONT_DOOR_MODES.join(', ')}` };
    }
    // An unpublished-by-default invariant: a closed topic is never advertised.
    topics[term] = { open, published: open && published, mode: mode as FrontDoorMode };
  }
  return { ok: true, topics };
}

function validateDailyCap(raw: unknown): { ok: true; dailyCap: number | null } | { ok: false; error: string } {
  if (raw === null) return { ok: true, dailyCap: null };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < MIN_DAILY_CAP || raw > MAX_DAILY_CAP) {
    return { ok: false, error: `dailyCap must be null or an integer between ${MIN_DAILY_CAP} and ${MAX_DAILY_CAP}` };
  }
  return { ok: true, dailyCap: raw };
}

/** Validate an untrusted PUT body into a complete config; topics absent from the body are closed. */
export function validateFrontDoorConfig(body: unknown): ValidationResult {
  if (!isRecord(body)) return { ok: false, error: 'body must be an object' };

  const tiers = validateTiers(body.tiers);
  if (!tiers.ok) return tiers;
  const topics = validateTopics(body.topics);
  if (!topics.ok) return topics;
  const cap = validateDailyCap(body.dailyCap);
  if (!cap.ok) return cap;

  const config = defaultFrontDoorConfig();
  config.tiers = tiers.tiers;
  config.topics = { ...config.topics, ...topics.topics };
  config.dailyCap = cap.dailyCap;
  return { ok: true, config };
}

/** True when at least one non-anonymous tier is admitted — the gate is "on". */
export function isGateOpen(config: FrontDoorConfig): boolean {
  return config.tiers.soft || config.tiers.preliminary || config.tiers.established;
}

/**
 * Whether a requester of identity tier `identityTier` is admitted by the
 * principal's gate, given the principal's raw `identities.metadata`.
 *
 * - No `agentReachGate` key (a gate only ever seeded via `seedAgentReachGate`,
 *   or never authored): no tier restriction — the pre-#2598 behaviour, where
 *   any requester holding an `agent:reach` grant is admitted.
 * - An authored gate: the requester's tier must be one the operator enabled.
 *   An unparsable stored gate, or a missing / unknown requester tier, is
 *   refused (fail closed). Membership is exact, not "or higher": the operator
 *   chose which tiers may reach them.
 */
export function isTierAdmitted(metadata: unknown, identityTier: unknown): boolean {
  if (!isRecord(metadata) || !('agentReachGate' in metadata)) return true;
  const stored = readStoredConfig(metadata);
  if (!stored) return false;
  const gateTier = gateTierForIdentityTier(identityTier);
  return gateTier !== null && stored.tiers[gateTier];
}

/** The raw gate value `reachPrincipal()` evaluates: open topics, in vocabulary order. */
export function deriveGateTopics(config: FrontDoorConfig): string[] {
  return frontDoorTopicOptions()
    .map(({ term }) => term)
    .filter((term) => config.topics[term]?.open === true);
}

/** Labels of the topics the operator opted to publish on the agent card (never the gate rules). */
export function publishedTopicLabels(metadata: unknown): string[] {
  const stored = readStoredConfig(metadata);
  if (!stored) return [];
  return frontDoorTopicOptions()
    .filter(({ term }) => stored.topics[term]?.open === true && stored.topics[term]?.published === true)
    .map(({ label }) => label);
}

/** Parse `metadata.agentReachGate` leniently (it is our own write, but jsonb is untrusted at rest). */
function readStoredConfig(metadata: unknown): FrontDoorConfig | null {
  if (!isRecord(metadata) || !isRecord(metadata.agentReachGate)) return null;
  const result = validateFrontDoorConfig(metadata.agentReachGate);
  return result.ok ? result.config : null;
}

/**
 * The config to show: the stored `agentReachGate` if present; otherwise one
 * seeded from the legacy `agentReachTopics` array (as written by the
 * test-only `seedAgentReachGate`) so a previously seeded gate shows up as it
 * actually behaves — those topics open, deliver, unpublished.
 */
export function resolveFrontDoorConfig(metadata: unknown, hasActiveGrant: boolean): FrontDoorConfig {
  const stored = readStoredConfig(metadata);
  if (stored) return stored;

  const config = defaultFrontDoorConfig();
  const legacy = isRecord(metadata) && Array.isArray(metadata.agentReachTopics) ? metadata.agentReachTopics : [];
  for (const entry of legacy) {
    const term = typeof entry === 'string' ? normalizeBrokerTerm('contact_topic', entry) : undefined;
    if (term) config.topics[term] = { open: true, published: false, mode: 'deliver' };
  }
  // The legacy seed admits any requester holding an `agent:reach` grant
  // (grantedToClass 'strangers'), whatever their tier — all three gate tiers.
  config.tiers.soft = hasActiveGrant;
  config.tiers.preliminary = hasActiveGrant;
  config.tiers.established = hasActiveGrant;
  return config;
}

async function hasActiveGateGrant(principalDid: string): Promise<boolean> {
  const rows = await db
    .select({ id: consentGrants.id })
    .from(consentGrants)
    .where(activeGateGrantWhere(principalDid))
    .limit(1);
  return rows.length > 0;
}

function activeGateGrantWhere(principalDid: string) {
  return and(
    eq(consentGrants.subject, principalDid),
    eq(consentGrants.purpose, FRONT_DOOR_PURPOSE),
    eq(consentGrants.grantedToClass, FRONT_DOOR_GRANT_CLASS),
    eq(consentGrants.status, 'active'),
  );
}

export async function readFrontDoorConfig(principalDid: string): Promise<FrontDoorConfig | null> {
  const [principal] = await db
    .select({ metadata: identities.metadata })
    .from(identities)
    .where(eq(identities.id, principalDid))
    .limit(1);
  if (!principal) return null;
  return resolveFrontDoorConfig(principal.metadata, await hasActiveGateGrant(principalDid));
}

function publishConsentEvent(
  type: 'broker.consent.created' | 'broker.consent.revoked',
  principalDid: string,
  consentId: string,
): void {
  publish(type, {
    issuer: principalDid,
    subject: principalDid,
    scope: 'broker',
    payload: {
      consentId,
      subject: principalDid,
      grantedTo: null,
      purpose: FRONT_DOOR_PURPOSE,
      context_id: consentId,
      context_type: 'consent',
    },
  }).catch((err: unknown) => log.error({ err: String(err) }, `[front-door] ${type} publish failed`));
}

/**
 * Persist `config` for `principalDid`. Returns false when the principal row
 * does not exist. Order matters for fail-closed behaviour: the metadata is
 * written first, then the grant is swapped — a reach call can never see an
 * open grant over a stale, wider topic list.
 */
export async function writeFrontDoorConfig(principalDid: string, config: FrontDoorConfig): Promise<boolean> {
  const [principal] = await db
    .select({ id: identities.id, metadata: identities.metadata })
    .from(identities)
    .where(eq(identities.id, principalDid))
    .limit(1);
  if (!principal) return false;

  const metadata = isRecord(principal.metadata) ? principal.metadata : {};
  await db
    .update(identities)
    .set({ metadata: { ...metadata, agentReachGate: config, agentReachTopics: deriveGateTopics(config) } })
    .where(eq(identities.id, principalDid));

  const existing = await db
    .select({ id: consentGrants.id })
    .from(consentGrants)
    .where(activeGateGrantWhere(principalDid));

  // Replace-semantics (same as contact-visibility): revoke, then re-create when the gate is on.
  if (existing.length > 0) {
    await db
      .update(consentGrants)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(activeGateGrantWhere(principalDid));
    for (const row of existing) publishConsentEvent('broker.consent.revoked', principalDid, row.id);
  }

  if (isGateOpen(config)) {
    const id = generateId('cgrant');
    await db.insert(consentGrants).values({
      id,
      subject: principalDid,
      grantedTo: null,
      grantedToClass: FRONT_DOOR_GRANT_CLASS,
      purpose: FRONT_DOOR_PURPOSE,
      allowedFields: [FRONT_DOOR_FIELD],
      mode: 'attestation',
      status: 'active',
      consentRef: generateId('consent'),
    });
    publishConsentEvent('broker.consent.created', principalDid, id);
  }

  return true;
}
