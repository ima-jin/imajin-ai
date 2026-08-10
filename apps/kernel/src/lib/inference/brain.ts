/**
 * Brain resolution (#1621) — "I brought A brain."
 *
 * The kernel is the engine, not the brain. It runs the inference pipeline
 * (capture → context → policy → consent) but brings no model credential of its
 * own: the acting DID's sealed connector cards ARE the model selection. Sealing
 * a key IS choosing your brain, so each user can seal N brains and each of their
 * invoked agents can run on whichever one they have sealed.
 *
 * There is deliberately NO env-var fallback. `ANTHROPIC_API_KEY` /
 * `OPENAI_API_KEY` are being removed from the kernel environment, and a silent
 * env fallback would reintroduce exactly the shared-brain coupling this module
 * exists to delete — it would also mask a missing connection until the upstream
 * provider answered 401. No sealed connection is a fail-closed condition with an
 * actionable error instead.
 *
 * Resolution walks two axes, DID-major:
 *   1. WHOSE card — the acting owner DID, then the invoking app DID, then the
 *      app's registrant org DID (the identity that registered the app and where
 *      org-level keys are sealed). Owner-first is deliberate: a human's own
 *      brain outranks the app's, and an app can never quietly displace it.
 *   2. WHICH provider — that DID's sealed connectors, in BRAIN_CONNECTORS order.
 *
 * Consent and attribution stay attached to the owner DID regardless of which DID
 * supplied the credential; only the bill moves.
 *
 * Adding a provider is one entry in BRAIN_CONNECTORS. The resolution order,
 * the connectors named in the fail-closed error, and the scopes the caller is
 * told to grant are all projections of that table.
 */
import { createLogger } from '@imajin/logger';
import type { ProviderName } from '@imajin/llm';
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { loadGeminiCredentials } from '@/src/lib/gemini/connector';
import { loadAnthropicCredentials } from '@/src/lib/anthropic/connector';

const log = createLogger('kernel:inference:brain');

/** Connector ids that can supply a brain, in resolution order. */
export type BrainConnectorId = 'gemini' | 'anthropic';

/**
 * Whose sealed card may supply the model (#1624).
 *
 * A bare DID string is accepted anywhere this is, and means "owner only".
 */
export interface BrainCredentialContext {
  /** Acting supplier/user DID. Consent and attribution stay attached here. */
  ownerDid?: string;
  /** Invoking app/org DID that may provide the credential and pay for compute. */
  appDid?: string;
}

/**
 * A resolved brain: whose card supplied it, which connector it was, and
 * everything the model factory needs to make the call.
 *
 * `apiKey` is non-optional by construction — a brain without a credential is
 * not a brain. It must never be logged or returned to a caller.
 */
export interface ResolvedBrain {
  /** Connector card the credential came from — safe to log and surface. */
  connector: BrainConnectorId;
  /**
   * DID whose card supplied the credential: the owner's own, or the app/org
   * subsidising it. Safe to log, and worth logging — it is the only signal of
   * who is paying for a given call.
   */
  credentialDid: string;
  /** Provider adapter for `getModel()`. */
  provider: ProviderName;
  /** Model the credential owner sealed, or this connector's default. */
  modelId: string;
  /** The sealed key. Never log this. */
  apiKey: string;
  /** Endpoint override — set for OpenAI-compatible providers such as Gemini. */
  baseURL?: string;
}

/** Credentials as returned by a connector's `load*Credentials` helper. */
interface SealedCredentials {
  apiKey: string;
  baseUrl?: string;
  modelId?: string;
}

interface BrainConnector {
  id: BrainConnectorId;
  /** Display name used in the fail-closed error. */
  name: string;
  /** Provider adapter this connector's credential drives. */
  provider: ProviderName;
  /** Scope the owner must grant on the connector card. */
  scope: string;
  /** Route the owner pastes their key into. */
  tokenRoute: string;
  /** Model used when the owner sealed no explicit `modelId`. */
  defaultModelId: string;
  /** Endpoint used when the owner sealed no explicit `baseUrl`. */
  defaultBaseUrl?: string;
  load: (ownerDid: string) => Promise<SealedCredentials | undefined>;
}

/**
 * Gemini speaks the OpenAI-compatible surface, so its provider adapter is
 * `openai` pointed at Google's endpoint — not a separate provider.
 */
const GEMINI_OPENAI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';

/**
 * The brain table. Order is resolution priority: the first connector with a
 * sealed, granted credential wins.
 *
 * A per-DID preferred default is a deliberate non-goal for now (#1621 calls it
 * a future refinement); until then "first sealed wins" is the whole policy.
 */
const BRAIN_CONNECTORS: readonly BrainConnector[] = [
  {
    id: 'gemini',
    name: 'Google Gemini',
    provider: 'openai',
    scope: 'gemini:infer',
    tokenRoute: '/gemini/api/token',
    defaultModelId: 'gemini-2.0-flash',
    defaultBaseUrl: GEMINI_OPENAI_BASE_URL,
    load: loadGeminiCredentials,
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    provider: 'anthropic',
    scope: 'anthropic:infer',
    tokenRoute: '/anthropic/api/token',
    defaultModelId: 'claude-sonnet-4-20250514',
    load: loadAnthropicCredentials,
  },
];

/**
 * A connector that threw while being probed, rather than answering "nothing
 * sealed" (#1637).
 *
 * `cause` is a stringified error kept for server-side diagnosis only. It is
 * deliberately NOT folded into {@link NoBrainSealedError}'s message, which
 * reaches HTTP surfaces: an upstream message can embed the value being read.
 */
export interface BrainConnectorFailure {
  connector: BrainConnectorId;
  credentialDid: string;
  cause: string;
}

/**
 * Thrown when none of the candidate DIDs has sealed a brain.
 *
 * Carries the connectors that are actually available to seal, derived from the
 * same table the resolver walks, so the message can never drift out of sync
 * with what the platform supports.
 */
export class NoBrainSealedError extends Error {
  /** DIDs that were checked, in the order they were tried. */
  readonly triedDids: readonly string[];
  readonly availableConnectors: readonly BrainConnectorId[];
  /**
   * Connectors that errored during the walk instead of reporting "not sealed".
   *
   * Empty in the ordinary "user has connected nothing" case. Non-empty means the
   * resolution was degraded, and this is the only place that survives to say so
   * — without it, skipping a throwing connector would turn a vault fault into an
   * indistinguishable "you have no brain".
   */
  readonly failures: readonly BrainConnectorFailure[];

  constructor(
    triedDids: readonly string[],
    connectors: readonly BrainConnector[],
    failures: readonly BrainConnectorFailure[] = [],
  ) {
    const options = connectors
      .map((c) => `${c.name} (grant '${c.scope}', seal a key at ${c.tokenRoute})`)
      .join(' or ');
    const subject = triedDids.length > 0 ? triedDids.join(', ') : '(no DID supplied)';
    const degraded = failures.length > 0
      ? ` ${failures.length} connector probe(s) failed and were skipped — see kernel logs.`
      : '';
    super(
      `inference_no_brain: no model credential sealed for ${subject} — ` +
      `connect ${options}. The kernel brings no brain of its own.${degraded}`,
    );
    this.name = 'NoBrainSealedError';
    this.triedDids = triedDids;
    this.availableConnectors = connectors.map((c) => c.id);
    this.failures = failures;
  }
}

/** The connector ids that can currently supply a brain, in resolution order. */
export function listBrainConnectors(): readonly BrainConnectorId[] {
  return BRAIN_CONNECTORS.map((c) => c.id);
}

/**
 * Look up the DID that registered an app — the org/business/person whose
 * profile owns the app and where org-level connector keys are sealed.
 *
 * Returns undefined when the app is not found (graceful — the walk just skips
 * this hop rather than failing the entire resolution).
 */
async function lookupAppRegistrantDid(appDid: string): Promise<string | undefined> {
  try {
    const [row] = await db
      .select({ ownerDid: registryApps.ownerDid })
      .from(registryApps)
      .where(eq(registryApps.appDid, appDid))
      .limit(1);
    return row?.ownerDid;
  } catch (err) {
    log.warn({ appDid, err: String(err) }, 'app registrant lookup failed — skipping');
    return undefined;
  }
}

/**
 * Candidate DIDs in resolution order: owner first, then the app/org.
 *
 * Deduped, because an app invoking on its own behalf would otherwise have its
 * connectors probed twice for every call.
 */
function credentialDids(context: string | BrainCredentialContext): string[] {
  const normalized: BrainCredentialContext =
    typeof context === 'string' ? { ownerDid: context } : context;

  const seen = new Set<string>();
  const dids: string[] = [];
  for (const did of [normalized.ownerDid, normalized.appDid]) {
    if (!did || seen.has(did)) continue;
    seen.add(did);
    dids.push(did);
  }
  return dids;
}

/**
 * Resolve a brain from the candidate DIDs' sealed connector cards.
 *
 * Walks DIDs owner-first, and each DID's connectors in BRAIN_CONNECTORS order,
 * returning the first connection that is both granted and sealed. Throws
 * `NoBrainSealedError` when none is — there is no env-var fallback and no
 * node-level default credential.
 *
 * A connector that THROWS is skipped rather than aborting the walk (#1637). One
 * card's custody problem is not the other cards' problem: before this, a Gemini
 * key awaiting Tier 1 owner approval escaped as a raw `VaultDelegationError`,
 * which meant a healthy Anthropic key later in the table was never tried and the
 * caller lost the actionable `NoBrainSealedError` as well. Skipping still fails
 * closed — with nothing resolvable the walk ends in `NoBrainSealedError`, whose
 * `failures` records what was skipped — and each failure is logged.
 *
 * The returned `apiKey` is for the immediate call only: never log it, persist
 * it, or include it in a response body.
 */
export async function resolveBrain(
  context: string | BrainCredentialContext,
): Promise<ResolvedBrain> {
  const dids = credentialDids(context);

  // Walk up to the app's registrant org DID — the identity where org-level
  // keys (e.g. Gemini) are sealed. The UI seals keys to org/business/person
  // identities, not to app DIDs directly; this hop bridges the gap.
  const ctx = typeof context === 'string' ? { ownerDid: context } : context;
  if (ctx.appDid) {
    const registrantDid = await lookupAppRegistrantDid(ctx.appDid);
    if (registrantDid && !dids.includes(registrantDid)) {
      dids.push(registrantDid);
    }
  }

  const failures: BrainConnectorFailure[] = [];

  for (const did of dids) {
    for (const connector of BRAIN_CONNECTORS) {
      let creds: SealedCredentials | undefined;
      try {
        creds = await connector.load(did);
      } catch (err) {
        // Never log `err` alongside anything unsealed, and never surface it to a
        // caller: a vault/provider message can carry the value being read.
        log.warn(
          { credentialDid: did, connector: connector.id, err: String(err) },
          'brain connector probe failed — skipping this connector',
        );
        failures.push({ connector: connector.id, credentialDid: did, cause: String(err) });
        continue;
      }
      if (!creds) {
        continue;
      }

      // The sealed endpoint wins; the connector default covers the common case
      // (Gemini's OpenAI-compatible URL). Anthropic has no default, so it stays
      // absent and the SDK uses its own.
      const baseURL = creds.baseUrl ?? connector.defaultBaseUrl;

      const brain: ResolvedBrain = {
        connector: connector.id,
        credentialDid: did,
        provider: connector.provider,
        modelId: creds.modelId ?? connector.defaultModelId,
        apiKey: creds.apiKey,
        ...(baseURL === undefined ? {} : { baseURL }),
      };

      log.info(
        {
          credentialDid: did,
          connector: brain.connector,
          provider: brain.provider,
          model: brain.modelId,
        },
        'resolved brain from sealed connection',
      );
      return brain;
    }
  }

  throw new NoBrainSealedError(dids, BRAIN_CONNECTORS, failures);
}
