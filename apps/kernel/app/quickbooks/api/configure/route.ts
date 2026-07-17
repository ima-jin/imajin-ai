import { storeConfig, type QuickBooksConfig } from '@/src/lib/quickbooks/connector';
import { createConfigureHandler } from '@/src/lib/kernel/connector-oauth-routes';

/** OPTIONS + POST /quickbooks/api/configure — seal per-DID QuickBooks OAuth app config. */
export const { OPTIONS, POST } = createConfigureHandler<QuickBooksConfig>({
  // QuickBooks config adds `environment` beyond the base three fields.
  buildConfig: (base, body) => ({
    ...base,
    environment: body.environment === 'production' ? 'production' : 'sandbox' as const,
  }),
  storeConfig,
});
