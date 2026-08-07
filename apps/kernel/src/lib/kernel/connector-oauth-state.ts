/**
 * Shared factory for signed, stateless OAuth `state` tokens used by
 * connector authorization-code flows (GitHub #1333, QuickBooks #1210, …).
 *
 * The callback arrives from the provider without an imajin session, so `state`
 * must itself carry the owner DID — HMAC-signed with a server secret + short
 * TTL so it can't be forged or replayed. No DB/state table needed.
 *
 * Usage:
 *   const { signState, verifyState } = createOAuthStateHelpers('github_state');
 */
import { createSignedPayloadCodec } from './connector-signed-payload';

const STATE_TTL_MS = 10 * 60 * 1000;

interface StatePayload {
  did: string;
  /**
   * Same-origin app path to send the browser back to after the callback
   * completes (#1529). Lives *inside* the signed payload so it inherits the
   * HMAC — a tampered `returnTo` fails signature verification, which is what
   * keeps this from becoming an open redirect.
   */
  returnTo?: string;
}

/** Result of a successful {@link OAuthStateHelpers.verifyState}. */
export interface VerifiedState {
  /** The owner DID the state token was minted for. */
  did: string;
  /** The signed return path, when the connect route supplied one. */
  returnTo?: string;
}

export interface OAuthStateHelpers {
  /**
   * Mint a signed state token binding the owner DID, and optionally the
   * same-origin path to return the browser to after the callback.
   */
  signState(ownerDid: string, returnTo?: string): string;
  /**
   * Verify a state token and return the bound DID (plus `returnTo` when one was
   * signed in). Throws on tamper/expiry.
   */
  verifyState(state: string): VerifiedState;
}

/**
 * Create a pair of `signState` / `verifyState` helpers scoped to the given
 * error prefix (e.g. `'github_state'`, `'quickbooks_state'`). Both functions
 * use `AUTH_PRIVATE_KEY` from the environment as the HMAC secret.
 */
export function createOAuthStateHelpers(errorPrefix: string): OAuthStateHelpers {
  const codec = createSignedPayloadCodec<StatePayload>(errorPrefix, STATE_TTL_MS);

  function signState(ownerDid: string, returnTo?: string): string {
    // Only set the key when present so tokens minted without a returnTo keep
    // their original shape (and their original length).
    return codec.sign(returnTo ? { did: ownerDid, returnTo } : { did: ownerDid });
  }

  function verifyState(state: string): VerifiedState {
    const payload = codec.verify(state);
    return { did: payload.did, returnTo: payload.returnTo };
  }

  return { signState, verifyState };
}
