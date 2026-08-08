import { storeConfig, type QuickBooksConfig } from '@/src/lib/quickbooks/connector';
import { createConfigureHandler } from '@/src/lib/kernel/connector-oauth-routes';

/** A non-empty, trimmed `webhookVerifierToken` from the request body, or undefined. */
function readWebhookVerifierToken(body: Record<string, unknown>): string | undefined {
  const value = body.webhookVerifierToken;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** OPTIONS + POST /quickbooks/api/configure — seal per-DID QuickBooks OAuth app config. */
export const { OPTIONS, POST } = createConfigureHandler<QuickBooksConfig>({
  // QuickBooks config adds `environment` plus the optional webhook verifier
  // token (xprize #35) beyond the base three fields.
  buildConfig: (base, body) => {
    const webhookVerifierToken = readWebhookVerifierToken(body);
    return {
      ...base,
      environment: body.environment === 'production' ? 'production' : 'sandbox' as const,
      ...(webhookVerifierToken === undefined ? {} : { webhookVerifierToken }),
    };
  },
  storeConfig,
});
