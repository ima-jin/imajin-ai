/**
 * Moonshot documents a USD balance snapshot, NOT period-billed spend:
 * https://platform.kimi.ai/docs/api/balance (#2972).
 * Cash, vouchers, top-ups and expiry make balance deltas unsuitable as billed
 * usage. Read balances under moonshot:billing; record receipts via the existing
 * POST /usage/api/billed with vendor=moonshot. Never write snapshots to billed.
 */
import { MOONSHOT_BASE_URL } from '@/src/lib/moonshot/connector';
import { BillingApiError } from './types';
import { fetchBillingJson } from './http';

export interface MoonshotBalance {
  currency: 'USD';
  available: number;
  voucher: number;
  cash: number;
}

interface BalanceEnvelope {
  code: number;
  status: boolean;
  data: {
    available_balance: number;
    voucher_balance: number;
    cash_balance: number;
  };
}

export function createMoonshotBalanceReader(options: { apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
  return {
    provider: 'moonshot' as const,
    billedMode: 'manual-only' as const,
    async fetch(): Promise<MoonshotBalance> {
      let response: BalanceEnvelope;
      try {
        response = await fetchBillingJson<BalanceEnvelope>({
          providerId: 'moonshot',
          providerLabel: 'Moonshot',
          baseUrl: MOONSHOT_BASE_URL,
          path: '/users/me/balance',
          params: {},
          headers: { Authorization: `Bearer ${options.apiKey}` },
          fetchImpl: options.fetchImpl ?? fetch,
          timeoutMs: options.timeoutMs ?? 10_000,
        });
      } catch (error) {
        // Transport/parser errors can include headers or provider bodies.
        const status = error instanceof BillingApiError ? error.status : 502;
        throw new BillingApiError('moonshot', status, 'Moonshot balance unavailable');
      }
      const data = response?.data;
      if (response?.code !== 0 || response.status !== true || !data ||
          ![data.available_balance, data.voucher_balance, data.cash_balance]
            .every((value) => typeof value === 'number' && Number.isFinite(value)) ||
          data.voucher_balance < 0) {
        throw new BillingApiError('moonshot', 502, 'Invalid Moonshot balance response');
      }
      return { currency: 'USD', available: data.available_balance, voucher: data.voucher_balance, cash: data.cash_balance };
    },
  };
}
