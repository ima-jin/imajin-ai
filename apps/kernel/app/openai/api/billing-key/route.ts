/**
 * GET + POST /openai/api/billing-key (#1076 Stage 1)
 *
 * Pattern B credential ingestion for the OpenAI connector's org ADMIN key —
 * distinct from `/openai/api/token`, which seals the inference key. Wired
 * through the same shared token-paste route factory used by every other
 * token-paste connector.
 *
 * Security invariants (enforced by the factory): the key is never logged,
 * never returned, never echoed, and per-DID isolation comes from
 * `openai-billing-api-key:${ownerDid}`. There is no raw-key release path.
 */
import { createConnectorTokenRoutes } from '@/src/lib/kernel/connector-token-route';
import { sealBillingKey, billingKeySealed } from '@/src/lib/openai/billing-connector';

export const { GET, POST, OPTIONS } = createConnectorTokenRoutes({
  name: 'OpenAI Billing',
  sealApiKey: sealBillingKey,
  keySealed: billingKeySealed,
});
