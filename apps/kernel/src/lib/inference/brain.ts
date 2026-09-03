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
import { loadXaiCredentials, XAI_BASE_URL } from '@/src/lib/xai/connector';
import { loadOpenaiCredentials, OPENAI_BASE_URL } from '@/src/lib/openai/connector';
import { loadMoonshotCredentials, MOONSHOT_BASE_URL } from '@/src/lib/moonshot/connector';
import { loadZaiCredentials, ZAI_BASE_URL } from '@/src/lib/zai/connector';
import { loadLocalCredentials } from '@/src/lib/local/connector';
import { lookupAppRegistrantDid } from '@/src/lib/kernel/app-registrant';

const log = createLogger('kernel:inference:brain');

/** Connector ids that can supply a brain, in resolution order. */
export type BrainConnectorId = 'gemini' | 'anthropic' | 'xai' | 'openai' | 'moonshot' | 'zai' | 'local';

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
  /** The sealed key. Never log this. Empty string for `local` (#1957) — an optional bearer, not a required credential. */
  apiKey: string;
  /** Endpoint override — set for OpenAI-compatible providers such as Gemini. */
  baseURL?: string;
  /**
   * The address `local`'s `baseURL` was resolved and pinned to at save time
   * (#1957) — undefined for every other connector. The completions
   * passthrough uses this to connect via the egress-safe fetch without a
   * fresh (and reboundable) DNS resolution on every call.
   */
  pinnedIp?: string;
}

/** Credentials as returned by a connector's `load*Credentials` helper. */
interface SealedCredentials {
  apiKey: string;
  baseUrl?: string;
  modelId?: string;
  pinnedIp?: string;
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
    // #1953, following the #1769 precedent: no hardcoded default. Anthropic
    // was the last inference connector still carrying one
    // (`claude-sonnet-4-20250514`) — a dated snapshot that goes stale the
    // same way gemini-2.0-flash did (#1764), and a retired model can come
    // back as something other than a clean 404. The owner picks a live
    // model from GET /anthropic/api/models and it is sealed as `modelId` —
    // see `NoModelSelectedError` for the fail-closed path when none is
    // chosen yet.
    load: loadAnthropicCredentials,
  },
  {
    // #1924. Appended rather than slotted in: this table's order IS resolution
    // priority, so inserting xAI above Anthropic would silently move existing
    // dual-sealed DIDs onto a different brain. The #1922 migration-order call
    // (2026-09-01) is about which provider the passthrough is validated on
    // first, not about which sealed card wins here.
    id: 'xai',
    name: 'xAI Grok',
    // xAI speaks the OpenAI-compatible surface, so its provider adapter is
    // `openai` pointed at api.x.ai — the same move Gemini makes above, not a
    // separate provider.
    provider: 'openai',
    scope: 'xai:infer',
    tokenRoute: '/xai/api/token',
    // No hardcoded default, matching the Gemini precedent set by #1769: a
    // baked-in Grok id goes stale the way gemini-2.0-flash did (#1764), and a
    // retired model can answer 429 rather than 404, which is indistinguishable
    // from a rate limit. The owner picks a live model from GET /xai/api/models
    // and it is sealed as `modelId` — see `NoModelSelectedError` for the
    // fail-closed path when none is chosen yet.
    defaultBaseUrl: XAI_BASE_URL,
    load: loadXaiCredentials,
  },
  {
    // #1927. Appended rather than slotted in, same reasoning as xAI above:
    // this table's order IS resolution priority, so inserting OpenAI earlier
    // would silently move existing dual-sealed DIDs onto a different brain.
    // The #1922 migration-order call (2026-09-01) validates the passthrough on
    // OpenAI second (Grok → OpenAI → Gemini, Anthropic last) — that is about
    // passthrough validation order, not about which sealed card wins here.
    id: 'openai',
    name: 'OpenAI',
    provider: 'openai',
    scope: 'openai:infer',
    tokenRoute: '/openai/api/token',
    // No hardcoded default, matching the Gemini/xAI precedent set by #1769: a
    // baked-in OpenAI model id goes stale the way gemini-2.0-flash did
    // (#1764). The owner picks a live model from GET /openai/api/models and
    // it is sealed as `modelId` — see `NoModelSelectedError` for the
    // fail-closed path when none is chosen yet.
    defaultBaseUrl: OPENAI_BASE_URL,
    load: loadOpenaiCredentials,
  },
  {
    // #1930. Appended rather than slotted in, same reasoning as xAI/OpenAI
    // above: this table's order IS resolution priority, so inserting
    // Moonshot earlier would silently move existing dual-sealed DIDs onto a
    // different brain. Kimi (kimi-k2.x) is the live coding-agent workhorse in
    // OpenClaw today, joining the pre-Anthropic validation set in the #1922
    // migration order (Grok → OpenAI → Gemini → +Kimi, Anthropic last) — that
    // is about passthrough validation order, not about which sealed card
    // wins here.
    id: 'moonshot',
    name: 'Moonshot AI',
    // Moonshot speaks the OpenAI-compatible surface, so its provider adapter
    // is `openai` pointed at api.moonshot.ai — the same move xAI/OpenAI make
    // above, not a separate provider.
    provider: 'openai',
    scope: 'moonshot:infer',
    tokenRoute: '/moonshot/api/token',
    // No hardcoded default, matching the Gemini/xAI/OpenAI precedent set by
    // #1769: a baked-in Kimi model id goes stale the way gemini-2.0-flash did
    // (#1764), and a retired model can answer 429 rather than 404, which is
    // indistinguishable from a rate limit. The owner picks a live model from
    // GET /moonshot/api/models and it is sealed as `modelId` — see
    // `NoModelSelectedError` for the fail-closed path when none is chosen yet.
    defaultBaseUrl: MOONSHOT_BASE_URL,
    load: loadMoonshotCredentials,
  },
  {
    // #1931. Appended rather than slotted in, same reasoning as xAI/OpenAI/
    // Moonshot above: this table's order IS resolution priority, so inserting
    // Z.ai earlier would silently move existing dual-sealed DIDs onto a
    // different brain. Z.ai (Zhipu AI's GLM-4.x family) is capability-
    // completion with no current spend (#1922 priority note) — lowest
    // priority of the provider entries, appended last for that reason too.
    id: 'zai',
    name: 'Z.ai',
    // Z.ai speaks the OpenAI-compatible surface, so its provider adapter is
    // `openai` pointed at api.z.ai — the same move xAI/OpenAI/Moonshot make
    // above, not a separate provider.
    provider: 'openai',
    scope: 'zai:infer',
    tokenRoute: '/zai/api/token',
    // No hardcoded default, matching the Gemini/xAI/OpenAI/Moonshot precedent
    // set by #1769: a baked-in GLM model id goes stale the way
    // gemini-2.0-flash did (#1764), and a retired model can answer 429 rather
    // than 404, which is indistinguishable from a rate limit. The owner picks
    // a live model from GET /zai/api/models and it is sealed as `modelId` —
    // see `NoModelSelectedError` for the fail-closed path when none is chosen
    // yet.
    defaultBaseUrl: ZAI_BASE_URL,
    load: loadZaiCredentials,
  },
  {
    // #1957. Appended rather than slotted in, same reasoning as every other
    // brain connector above. This is the ONE entry in this table with no
    // sealed key required at all — `load` resolves whenever the owner has
    // configured a `baseUrl` and granted `local:infer`, with or without a
    // bearer token. No `defaultBaseUrl`: unlike a hosted provider, there is
    // no platform-wide default endpoint to fall back to — the owner's
    // sealed `baseUrl` IS the connector, and `buildResolvedBrain` already
    // fails closed (`NoModelSelectedError`) when no model is chosen, the
    // same #1769 precedent covers the missing endpoint case: an owner with
    // a granted scope but no saved `baseUrl` never resolves via this
    // connector at all (`loadLocalCredentials` returns `undefined`).
    id: 'local',
    name: 'Local Inference',
    // Ollama and vLLM both speak the OpenAI-compatible surface.
    provider: 'openai',
    scope: 'local:infer',
    tokenRoute: '/local/api/token',
    load: loadLocalCredentials,
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
 * Thrown when the provider rejects the sealed model id as not found (#1818).
 *
 * A connector card can be fully resolved — grant, key, and model id all
 * present — and still die at call time: Google (and other providers) retire
 * model ids out from under a standing selection, and Google's own
 * `ListModels` API keeps listing retired models, so pick-time validation
 * (`PUT /gemini/api/models`, #1818 item 2) narrows this window but cannot
 * close it. `resolveBrain` never throws this itself — it has no way to know
 * the model is dead until the provider is actually called — so the policy
 * layer (`infer`) raises it once a chat-completions call comes back
 * 404/NotFound, with the connector/model that was actually in use.
 *
 * Distinct from `NoModelSelectedError`: a model IS selected, it just no
 * longer exists upstream — the remedy is to pick a *different* model, not to
 * pick one for the first time.
 */
export class ModelDeprecatedError extends Error {
  /** Connector whose sealed model id the provider rejected. */
  readonly connector: BrainConnectorId;
  /** The model id that was sealed and is no longer servable upstream. */
  readonly modelId: string;

  constructor(connector: BrainConnectorId, modelId: string) {
    super(
      `model_deprecated: ${connector} model '${modelId}' was not found upstream — it has ` +
      'likely been retired. Choose a different model on the connector card.',
    );
    this.name = 'ModelDeprecatedError';
    this.connector = connector;
    this.modelId = modelId;
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
    ...(creds.pinnedIp === undefined ? {} : { pinnedIp: creds.pinnedIp }),
  };
}

/**
 * Restricts which brains a caller may resolve into (#1959).
 *
 * A bare `resolveBrain(context)` call walks every table entry, because the
 * OpenAI-compatible passthrough (#1925) is provider-agnostic — whichever
 * brain resolves is fine, since its own two adapters cover the whole table.
 * A route that speaks exactly one provider's wire format (the Anthropic
 * Messages raw passthrough, #1959) is not provider-agnostic: resolving, say,
 * xAI there would forward Anthropic-shaped bytes to an OpenAI-compatible
 * upstream that cannot parse them. `connectors` narrows the walk to the ids
 * a caller can actually forward to, so a principal whose only sealed brain
 * is the wrong shape fails closed with `NoBrainSealedError` naming just the
 * connector(s) that would have worked, rather than silently resolving one
 * that can't serve the request.
 */
export interface ResolveBrainOptions {
  /** When set, only these connector ids are walked — in BRAIN_CONNECTORS order, not the order given here. */
  connectors?: readonly BrainConnectorId[];
}

/**
 * Resolve a brain from the candidate DIDs' sealed connector cards.
 *
 * Walks DIDs owner-first, and each DID's connectors in BRAIN_CONNECTORS order
 * (optionally narrowed by {@link ResolveBrainOptions.connectors}), returning
 * the first connection that is both granted and sealed. Throws
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
  options?: ResolveBrainOptions,
): Promise<ResolvedBrain> {
  const dids = credentialDids(context);
  const candidateConnectors = options?.connectors
    ? BRAIN_CONNECTORS.filter((c) => options.connectors!.includes(c.id))
    : BRAIN_CONNECTORS;

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
    for (const connector of candidateConnectors) {
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

  throw new NoBrainSealedError(dids, candidateConnectors, failures);
}
