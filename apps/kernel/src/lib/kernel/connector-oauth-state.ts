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
  /**
   * The app DID that owns the OAuth client credentials used for this flow
   * (#1704), when the connect route resolved one from app-auth context.
   * Absent for BYO-app connections, where `did` owns its own config. The
   * callback — which arrives sessionless — has no other way to learn this, so
   * it must ride along inside the signed state.
   */
  appDid?: string;
}

/** Result of a successful {@link OAuthStateHelpers.verifyState}. */
export interface VerifiedState {
  /** The owner DID the state token was minted for. */
  did: string;
  /** The signed return path, when the connect route supplied one. */
  returnTo?: string;
  /** The app DID owning the OAuth client credentials (#1704), when one was signed in. */
  appDid?: string;
}

export interface OAuthStateHelpers {
  /**
   * Mint a signed state token binding the owner DID, and optionally the
   * same-origin path to return the browser to after the callback, and
   * optionally the app DID that owns the OAuth client credentials (#1704).
   */
  signState(ownerDid: string, returnTo?: string, appDid?: string): string;
  /**
   * Verify a state token and return the bound DID (plus `returnTo` / `appDid`
   * when they were signed in). Throws on tamper/expiry.
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

  function signState(ownerDid: string, returnTo?: string, appDid?: string): string {
    // Only set each key when present so tokens minted without returnTo/appDid
    // keep their original shape (and their original length).
    const payload: StatePayload = { did: ownerDid };
    if (returnTo) payload.returnTo = returnTo;
    if (appDid) payload.appDid = appDid;
    return codec.sign(payload);
  }

  function verifyState(state: string): VerifiedState {
    const payload = codec.verify(state);
    return { did: payload.did, returnTo: payload.returnTo, appDid: payload.appDid };
  }

  return { signState, verifyState };
}
