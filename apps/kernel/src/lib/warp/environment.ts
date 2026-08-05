/**
 * Per-DID Warp cloud-environment default (#1632).
 *
 * A Warp cloud agent with no environment gets a bare sandbox: no repo, no
 * dependencies, and a ~10-minute bootstrap tax on every dispatch. Naming a
 * persistent environment fixes that, but `environmentId` was only ever a
 * per-dispatch parameter — so every caller had to repeat it forever.
 *
 * This module makes the default a property of a **DID**, stored in the vault as
 * `warp-environment-id:{did}`. There is deliberately no env var: node-wide
 * configuration is expressed by storing a field against the *node* DID, which
 * keeps one mechanism instead of two and keeps the node's own default auditable
 * and rotatable like anyone else's.
 *
 * ## Why v1 node-sealed custody, not the delegation-grant path
 * The Warp Agent key is authority-bearing secret material, so it lives under
 * `custodyScheme: 'delegation-grant'` where revoking the grant kills dispatch
 * (see ./connector). An environment UID is neither secret nor authority-bearing:
 * it is an opaque routing preference that Warp itself will reject if the caller
 * has no access to that environment.
 *
 * Sealing it as a delegation grant would therefore buy no security and cost
 * correctness: under Tier 1 (#1603) a fresh grant is unreadable until the
 * external owner agent approves it, so the stored default would silently
 * evaporate for exactly as long as approval took — and dispatch would fall back
 * to a bare sandbox with no signal that anything was misconfigured. The value is
 * stored node-sealed so it is readable the moment it is written.
 *
 * The vault is still the right home: it gives per-DID isolation, a signed
 * tamper-evident history, and the same tombstone-on-delete semantics as every
 * other connector field, with no new table.
 */
import { createLogger } from '@imajin/logger';
import { deleteFromVault, loadAndUnseal, sealAndStore } from '@/src/lib/vault';

const log = createLogger('kernel');

/** Vault field prefix — the full field is `warp-environment-id:{did}`. */
export const WARP_ENVIRONMENT_PREFIX = 'warp-environment-id';

/**
 * Longest environment UID accepted.
 *
 * Warp's UIDs are 22-character base62 (`L2DO7swtN7Ku3G7gVPwziI`); the ceiling is
 * slack for a future format change, not a spec.
 */
const MAX_ENVIRONMENT_ID_LENGTH = 64;

/**
 * Characters an environment UID may contain.
 *
 * A conservative allowlist rather than a format assertion: Warp owns the real
 * schema and rejects an unknown UID with a problem document we already surface
 * verbatim. All this needs to guarantee is that a stored value is a single opaque
 * token — no whitespace, no path or URL punctuation — so it can never be
 * mistaken for anything else when it lands in `config.environment_id`.
 */
const ENVIRONMENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Vault field holding this DID's default Warp environment UID. */
export function warpEnvironmentField(did: string): string {
  return `${WARP_ENVIRONMENT_PREFIX}:${did}`;
}

/**
 * Whether `value` is storable as an environment UID.
 *
 * Rejects the empty string so "clear the default" is always the explicit delete
 * path rather than a write of nothing, which would leave a sealed blank that
 * every read then had to special-case.
 */
export function isValidEnvironmentId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_ENVIRONMENT_ID_LENGTH &&
    ENVIRONMENT_ID_PATTERN.test(value)
  );
}

/**
 * Read the environment UID stored for `did`, or `undefined` when none is set.
 *
 * Never throws. A configuration preference must not be able to take down
 * dispatch: an unreadable or corrupt field is reported as "no default set", which
 * degrades to Warp's own behaviour instead of failing a run that was otherwise
 * fully authorized. The failure is logged so it stays visible.
 */
export async function readEnvironmentId(did: string): Promise<string | undefined> {
  try {
    const stored = await loadAndUnseal(warpEnvironmentField(did));
    if (stored === undefined) return undefined;

    const trimmed = stored.trim();
    return isValidEnvironmentId(trimmed) ? trimmed : undefined;
  } catch (err) {
    log.warn(
      { err: String(err), did },
      'Warp environment default unreadable — dispatching with no stored environment',
    );
    return undefined;
  }
}

/**
 * Store `environmentId` as the default for `did`, replacing any previous value.
 *
 * Throws `warp_invalid_environment_id` on a value {@link isValidEnvironmentId}
 * rejects, so a bad write is refused at the edge rather than discovered later as
 * a silently-ignored default.
 */
export async function writeEnvironmentId(did: string, environmentId: string): Promise<void> {
  const trimmed = environmentId.trim();
  if (!isValidEnvironmentId(trimmed)) {
    throw new Error(
      'warp_invalid_environment_id: environmentId must be 1-' +
        `${MAX_ENVIRONMENT_ID_LENGTH} characters of [A-Za-z0-9_-]`,
    );
  }

  await sealAndStore(warpEnvironmentField(did), trimmed);
  log.info({ did }, 'Warp environment default stored');
}

/**
 * Clear the stored default for `did`. Returns whether a value was there to clear.
 *
 * Idempotent: clearing an unset default is a no-op rather than an error, so the
 * connector card's Clear action never has to reason about current state.
 */
export async function clearEnvironmentId(did: string): Promise<boolean> {
  const tombstoned = await deleteFromVault(warpEnvironmentField(did));
  const cleared = tombstoned !== undefined;
  if (cleared) {
    log.info({ did }, 'Warp environment default cleared');
  }
  return cleared;
}
