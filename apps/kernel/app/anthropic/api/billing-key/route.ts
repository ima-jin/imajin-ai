/**
 * GET + POST /anthropic/api/billing-key (#1076 Stage 1)
 *
 * Pattern B credential ingestion for the Anthropic connector's ADMIN key —
 * distinct from `/anthropic/api/token`, which seals the inference key. Wired
 * through the same shared token-paste route factory used by every other
 * token-paste connector.
 *
 * Security invariants (enforced by the factory): the key is never logged,
 * never returned, never echoed, and per-DID isolation comes from
 * `anthropic-billing-api-key:${ownerDid}`. There is no raw-key release path.
 */
import { createConnectorTokenRoutes } from '@/src/lib/kernel/connector-token-route';
import { sealBillingKey, billingKeySealed } from '@/src/lib/anthropic/billing-connector';

export const { GET, POST, OPTIONS } = createConnectorTokenRoutes({
  name: 'Anthropic Billing',
  sealApiKey: sealBillingKey,
  keySealed: billingKeySealed,
});
