/**
 * Public node availability is a metadata-only readiness probe, not a payment
 * or a provider API call. Never unseal credentials or cache this result:
 * revocation must be visible on the next request.
 */
export async function isNodeCardRailConfigured(): Promise<boolean> {
  try {
    const { getNodeDidFromConfig } = await import('@/src/lib/kernel/node-identity');
    const nodeDid = await getNodeDidFromConfig();
    if (!nodeDid) return false;

    const { resolveCardRail } = await import('../payment-requests/card-rail');
    if ((await resolveCardRail(nodeDid)).kind !== 'connector') return false;

    const { stripePublishableKeyField, stripeWebhookSecretField } = await import('@/src/lib/stripe/connector-core');
    const { vaultFieldStatus } = await import('@/src/lib/vault');
    const statuses = await Promise.all([
      vaultFieldStatus(stripePublishableKeyField(nodeDid)),
      vaultFieldStatus(stripeWebhookSecretField(nodeDid)),
    ]);
    return statuses.every(status => status === 'ready');
  } catch {
    // A failed readiness lookup must never advertise a card rail or disclose
    // vault/provider diagnostics to an unauthenticated caller.
    return false;
  }
}
