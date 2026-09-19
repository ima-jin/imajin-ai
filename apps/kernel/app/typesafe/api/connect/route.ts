/**
 * GET + POST /typesafe/api/connect (#2197)
 *
 * Pattern B credential ingestion for the TypeSafe.ai connector, wired
 * through the shared token-paste route factory (the same one Discord,
 * Stripe, and every brain connector use — see `connector-token-route.ts`).
 * Named `connect` rather than `token` per the issue's route list; the
 * underlying factory and its contract (GET → `{ keySealed }`, POST seals
 * `{ token }`) are unchanged.
 *
 * Security invariants (enforced by the factory): the key is never logged,
 * never returned, never echoed, and per-DID isolation comes from
 * `typesafe-api-key:${ownerDid}`.
 */
import { createConnectorTokenRoutes } from '@/src/lib/kernel/connector-token-route';
import { sealApiKey, typesafeKeySealed } from '@/src/lib/typesafe/connector';

export const { GET, POST, OPTIONS } = createConnectorTokenRoutes({
  name: 'TypeSafe.ai',
  sealApiKey,
  keySealed: typesafeKeySealed,
});
