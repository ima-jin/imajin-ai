/**
 * Signed, stateless OAuth `state` helpers for the QuickBooks connect flow (#1210).
 * Thin wrapper around the shared connector-oauth-state factory.
 */
import { createOAuthStateHelpers } from '../kernel/connector-oauth-state';

export const { signState, verifyState } = createOAuthStateHelpers('quickbooks_state');
