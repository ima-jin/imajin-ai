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
import { loadGeminiCredentials } from '@/src/lib/gemini/connector';
import { loadAnthropicCredentials } from '@/src/lib/anthropic/connector';
import { lookupAppRegistrantDid } from '@/src/lib/kernel/app-registrant';

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
  /**
   * Model used when the owner sealed no explicit `modelId`. Omitted (#1769)
   * when the provider retires/renames models often enough that a hardcoded
   * fallback goes stale silently — see {@link NoModelSelectedError}.
   */
  defaultModelId?: string;
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
    name: 'Gemini',
    provider: 'openai',
    scope: 'gemini:infer',
    tokenRoute: '/gemini/api/token',
    // #1769: no hardcoded default. gemini-2.0-flash was shut down 2026-06-01
    // (Google's Gemini deprecation schedule) while still hardcoded here, and a
    // decommissioned model can come back as a 429 rather than a clean 404/410
    // — indistinguishable from a real rate limit unless you already know the
    // model is dead (#1764). Rather than swap in the next string that will go
    // stale the same way, the owner picks a live model from GET
    // /gemini/api/models and it is sealed as `modelId` — see
    // `NoModelSelectedError` for the fail-closed path when none is chosen yet.
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
 * Thrown when a connector's credential resolves (grant + key both present)
 * but no model is selected — neither a sealed `modelId` nor a connector
 * `defaultModelId` (#1769).
 *
 * Distinct from `NoBrainSealedError`: the DID in question IS connected, so
 * falling through to the next connector/DID would be wrong — the fix is to
 * pick a model on this connector's card, not to try a different credential.
 */
export class NoModelSelectedError extends Error {
  constructor(connectorName: string, tokenRoute: string) {
    super(
      `${connectorName} is connected but no model is selected — choose a model on the ` +
      `${connectorName} connector card (${tokenRoute}).`,
    );
    this.name = 'NoModelSelectedError';
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
 * Build the {@link ResolvedBrain} for a connector that just resolved usable
 * credentials — the sealed endpoint/model win over the connector's defaults.
 *
 * Throws `NoModelSelectedError` (#1769) when neither a sealed `modelId` nor a
 * connector `defaultModelId` is available: this DID IS connected (grant + key
 * both resolved), so a resolver must not silently fall through to the next
 * DID/connector over a fixable "pick a model" problem.
 */
function buildResolvedBrain(
  connector: BrainConnector,
  did: string,
  creds: SealedCredentials,
): ResolvedBrain {
  const baseURL = creds.baseUrl ?? connector.defaultBaseUrl;
  const modelId = creds.modelId ?? connector.defaultModelId;
  if (!modelId) {
    throw new NoModelSelectedError(connector.name, connector.tokenRoute);
  }
  return {
    connector: connector.id,
    credentialDid: did,
    provider: connector.provider,
    modelId,
    apiKey: creds.apiKey,
    ...(baseURL === undefined ? {} : { baseURL }),
  };
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

  // Diagnostic for #1762: the full candidate list, in walk order, before any
  // connector is probed, plus whether an appDid was supplied at all — a
  // missing appDid means the registrant org-DID walk above never ran, which
  // is otherwise indistinguishable from "no brain" once resolution fails.
  log.info({ appDid: ctx.appDid ?? null, dids }, 'resolveBrain: walking candidate DIDs');

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
        // Not an error — this DID simply has no usable connection for this
        // connector (unsealed, or sealed with no active grant). Logged at
        // debug-adjacent info level because "which DID/connector combos were
        // empty" is exactly what #1762 needed and could not see before.
        log.info(
          { credentialDid: did, connector: connector.id },
          'brain connector probe: nothing sealed/granted for this DID',
        );
        continue;
      }

      // The sealed endpoint/model win over the connector defaults; a missing
      // model with no default throws NoModelSelectedError (#1769) rather than
      // continuing the walk — see buildResolvedBrain.
      const brain = buildResolvedBrain(connector, did, creds);

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
