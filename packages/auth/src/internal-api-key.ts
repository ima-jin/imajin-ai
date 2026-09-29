/**
 * Vault-sourced `ATTESTATION_INTERNAL_API_KEY` (#2353 — migrates the userspace
 * services off the deprecated env fallback that #2351 left in the kernel).
 *
 * Every packages/auth call into the kernel's internal-key-gated routes
 * (`postInternal`, act-as validation in `requireAuth`/`getSession`, app-token
 * validation in `requireAppAuth`) authenticates with this one shared secret.
 * It is no longer read from `process.env` anywhere in this package: a service
 * fetches it from the vault ONCE at boot via {@link bootstrapInternalApiKey}
 * (which wraps `loadFromVault` + `resolveGrantByPurpose`, the same pattern as
 * `apps/corpus/src/lib/attestation-key.ts`, #2245/#2351) and every consumer
 * here reads the resolved value back through {@link getInternalApiKey}.
 *
 * ## Bootstrap identity per service
 * Same shape as corpus's `CORPUS_VAULT_BOOTSTRAP_DID` / `_PRIVATE_KEY`: a
 * narrow-purpose, already-registered kernel identity whose only job is to
 * authenticate this one fetch. For service `<svc>` the env vars are
 * `<SVC>_VAULT_BOOTSTRAP_DID` and `<SVC>_VAULT_BOOTSTRAP_PRIVATE_KEY`. The
 * kernel operator grants the shared secret to that DID once, via
 * `scripts/grant-attestation-internal-api-key.ts <service-did>`.
 *
 * ## Fail closed
 * If the key cannot be resolved (identity not configured, vault refused, no
 * grant yet) {@link bootstrapInternalApiKey} logs ONE error naming the service
 * DID, the purpose, and the operator command — and leaves no key. From then
 * on `postInternal` throws {@link InternalApiKeyUnavailableError} rather than
 * ever sending an empty `Authorization` header.
 *
 * ## Process-global state
 * Next.js can bundle `instrumentation.ts` and route handlers as separate
 * module instances, so the state lives on `globalThis` (keyed by a registered
 * symbol) instead of a module-level `let`.
 *
 * ## Kernel
 * The kernel is its own vault: it registers a resolver
 * ({@link setInternalApiKeyResolver}) from its own `instrumentation.ts`
 * instead of bootstrapping through `loadFromVault`.
 */
import { createLogger } from '@imajin/logger';
import { loadFromVault, type GrantAckHandle } from './vault-client';

const log = createLogger('auth');

const VAULT_SOURCED_KEY = 'ATTESTATION_INTERNAL_API_KEY';

/**
 * Must match `ATTESTATION_INTERNAL_API_KEY_PURPOSE` in
 * apps/kernel/src/lib/auth/require-internal-api-key.ts and
 * scripts/grant-attestation-internal-api-key.ts — packages/auth must not
 * import apps/kernel internals, so this is duplicated (same rule as
 * `MINTED_KEY_FIELD_PREFIX` in vault-client.ts).
 */
export const ATTESTATION_INTERNAL_API_KEY_PURPOSE = 'kernel.attestation-internal-api-key';

/** Operator command that grants the shared secret to a service's bootstrap DID. */
export const GRANT_SCRIPT_COMMAND = 'npx tsx scripts/grant-attestation-internal-api-key.ts';

const SERVICE_DID_PLACEHOLDER = '<service-did>';

export type InternalApiKeyResolver = () => string | null | undefined | Promise<string | null | undefined>;

interface BootFailure {
  service: string;
  did: string | null;
  reason: string;
}

interface InternalApiKeyState {
  key: string | null;
  ack: GrantAckHandle | null;
  resolver: InternalApiKeyResolver | null;
  failure: BootFailure | null;
}

const STATE_SYMBOL = Symbol.for('@imajin/auth:internal-api-key-state');

function getState(): InternalApiKeyState {
  const holder = globalThis as unknown as Record<symbol, InternalApiKeyState | undefined>;
  let state = holder[STATE_SYMBOL];
  if (!state) {
    state = { key: null, ack: null, resolver: null, failure: null };
    holder[STATE_SYMBOL] = state;
  }
  return state;
}

/** Test-only: clears the process-global state so each test starts clean. */
export function _resetInternalApiKeyStateForTests(): void {
  const state = getState();
  state.key = null;
  state.ack = null;
  state.resolver = null;
  state.failure = null;
}

/** Env var names + vault `purpose` label a service's boot fetch uses. */
export function vaultBootstrapNames(service: string): { didEnv: string; privateKeyEnv: string; purpose: string } {
  const prefix = service.toUpperCase();
  return {
    didEnv: `${prefix}_VAULT_BOOTSTRAP_DID`,
    privateKeyEnv: `${prefix}_VAULT_BOOTSTRAP_PRIVATE_KEY`,
    purpose: `${service}.boot.attestation-key`,
  };
}

function operatorCommand(did: string | null): string {
  return `${GRANT_SCRIPT_COMMAND} ${did ?? SERVICE_DID_PLACEHOLDER}`;
}

/** Thrown by `postInternal` when no internal API key was resolved — never an empty header. */
export class InternalApiKeyUnavailableError extends Error {
  constructor(failure: BootFailure | null) {
    const cause = failure
      ? `${failure.service} could not resolve ${VAULT_SOURCED_KEY} from the vault at boot (${failure.reason}).`
      : `no vault-sourced ${VAULT_SOURCED_KEY} has been resolved — the service must call bootstrapInternalApiKey() at boot (instrumentation.ts).`;
    super(
      `Internal API key unavailable: ${cause} Purpose: ${ATTESTATION_INTERNAL_API_KEY_PURPOSE}. ` +
        `Operator: ${operatorCommand(failure?.did ?? null)}`,
    );
    this.name = 'InternalApiKeyUnavailableError';
  }
}

/** Builds the error `postInternal` throws when {@link getInternalApiKey} resolved nothing. */
export function internalApiKeyUnavailableError(): InternalApiKeyUnavailableError {
  return new InternalApiKeyUnavailableError(getState().failure);
}

/**
 * Registers a resolver consulted when no boot-fetched key is held. Used by
 * the kernel, which owns the secret itself. Pass `null` to clear.
 */
export function setInternalApiKeyResolver(resolver: InternalApiKeyResolver | null): void {
  getState().resolver = resolver;
}

/**
 * Returns the resolved internal API key, or `null` when none is available
 * (callers must treat `null` as "do not send" — never as an empty header).
 */
export async function getInternalApiKey(): Promise<string | null> {
  const state = getState();
  if (state.key) return state.key;
  if (!state.resolver) return null;
  try {
    return (await state.resolver()) || null;
  } catch (err) {
    log.error({ err: String(err) }, 'internal-api-key: resolver failed — treating the key as unavailable');
    return null;
  }
}

/**
 * Sends the deferred `used` ack (#2257: fetching is not itself an ack; the
 * first successful use is). Called by `postInternal` after its first
 * successful post. A no-op when nothing vault-sourced is held; idempotent.
 */
export function markInternalApiKeyUsed(): void {
  const state = getState();
  const ack = state.ack;
  if (!ack) return;
  state.ack = null;
  ack.used('first-internal-post');
}

export type InternalApiKeyBootResult = 'loaded' | 'unresolved';

function failBoot(service: string, did: string | null, reason: string): InternalApiKeyBootResult {
  const state = getState();
  state.key = null;
  state.ack = null;
  state.failure = { service, did, reason };
  const purpose = ATTESTATION_INTERNAL_API_KEY_PURPOSE;
  log.error(
    { service, did: did ?? undefined, purpose },
    `${service}: cannot resolve ${VAULT_SOURCED_KEY} from the vault (${reason}). ` +
      `Service DID: ${did ?? SERVICE_DID_PLACEHOLDER}. Purpose: ${purpose}. ` +
      `Internal posts to the kernel will FAIL until the operator runs: ${operatorCommand(did)}`,
  );
  return 'unresolved';
}

/**
 * Fetches `ATTESTATION_INTERNAL_API_KEY` from the vault for `service` and
 * holds it in memory for {@link getInternalApiKey}. Call once from the
 * service's `instrumentation.ts`. Never throws: any failure is logged (one
 * ERROR) and leaves the key unset, so internal posts fail closed.
 */
export async function bootstrapInternalApiKey(service: string): Promise<InternalApiKeyBootResult> {
  const names = vaultBootstrapNames(service);
  const did = process.env[names.didEnv] || null;
  const privateKey = process.env[names.privateKeyEnv];
  if (!did || !privateKey) {
    return failBoot(service, did, `${names.didEnv} / ${names.privateKeyEnv} not set`);
  }

  try {
    const credentials = await loadFromVault({
      resolveGrantByPurpose: ATTESTATION_INTERNAL_API_KEY_PURPOSE,
      purpose: names.purpose,
      keys: [{ key: VAULT_SOURCED_KEY, onMissing: 'degrade' }],
      identity: { did, privateKey },
    });

    const key = credentials.values[VAULT_SOURCED_KEY];
    if (!key) {
      return failBoot(service, did, 'no active grant for this purpose');
    }

    const state = getState();
    state.key = key;
    state.ack = credentials.acks[VAULT_SOURCED_KEY] ?? null;
    state.failure = null;
    log.info({ service, did }, `${service}: ${VAULT_SOURCED_KEY} fetched from vault at boot; ack deferred to first use`);
    return 'loaded';
  } catch (err) {
    return failBoot(service, did, `vault fetch failed: ${String(err)}`);
  }
}
