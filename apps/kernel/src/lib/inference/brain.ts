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
 *   1. WHOSE card — the acting owner DID, then an invoking app/org DID that may
 *      subsidise the compute (#1624). Owner-first is deliberate: a human's own
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

  constructor(triedDids: readonly string[], connectors: readonly BrainConnector[]) {
    const options = connectors
      .map((c) => `${c.name} (grant '${c.scope}', seal a key at ${c.tokenRoute})`)
      .join(' or ');
    const subject = triedDids.length > 0 ? triedDids.join(', ') : '(no DID supplied)';
    super(
      `inference_no_brain: no model credential sealed for ${subject} — ` +
      `connect ${options}. The kernel brings no brain of its own.`,
    );
    this.name = 'NoBrainSealedError';
    this.triedDids = triedDids;
    this.availableConnectors = connectors.map((c) => c.id);
  }
}

/** The connector ids that can currently supply a brain, in resolution order. */
export function listBrainConnectors(): readonly BrainConnectorId[] {
  return BRAIN_CONNECTORS.map((c) => c.id);
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
 * The returned `apiKey` is for the immediate call only: never log it, persist
 * it, or include it in a response body.
 */
export async function resolveBrain(
  context: string | BrainCredentialContext,
): Promise<ResolvedBrain> {
  const dids = credentialDids(context);

  for (const did of dids) {
    for (const connector of BRAIN_CONNECTORS) {
      const creds = await connector.load(did);
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

  throw new NoBrainSealedError(dids, BRAIN_CONNECTORS);
}
