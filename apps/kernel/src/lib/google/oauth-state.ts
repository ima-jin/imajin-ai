/**
 * Signed, stateless OAuth `state` helpers for the Google connect flow (#2144).
 * Thin wrapper around the shared connector-oauth-state factory.
 */
import { createOAuthStateHelpers } from '../kernel/connector-oauth-state';

export const { signState, verifyState } = createOAuthStateHelpers('google_state');
