import { signState, verifyState } from '../oauth-state';
import { describeOAuthStateContract } from '../../kernel/__tests__/oauth-state-contract';

// google/oauth-state.ts is a one-line createOAuthStateHelpers('google_state')
// wrapper (#2144) — see the shared contract for what is actually exercised.
describeOAuthStateContract('google', { signState, verifyState }, '/auth/connectors/google');
