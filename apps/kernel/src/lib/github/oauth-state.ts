/**
 * Signed, stateless OAuth `state` helpers for the GitHub connect flow (#1333).
 * Thin wrapper around the shared connector-oauth-state factory.
 */
import { createOAuthStateHelpers } from '../kernel/connector-oauth-state';

export const { signState, verifyState } = createOAuthStateHelpers('github_state');
