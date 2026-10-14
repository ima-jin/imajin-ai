import { serviceUrl } from './pledge-pay-url';
import { getPayAppToken, invalidatePayAppToken } from './pay-app-token';

/** No Stripe credential lives in events: these calls use its own app-service token. */
export interface PledgePaymentBinding {
  pledgeId: string;
  eventId: string;
  buyerDid: string;
  sellerDid: string;
  amount: number;
  currency: string;
}

export interface PledgePaymentVerification extends PledgePaymentBinding {
  setupIntentId: string;
  customerId: string;
}

export interface PaymentFailure {
  error: string;
  code: string;
  status: number;
}

const UNAVAILABLE: PaymentFailure = {
  error: 'Payment verification unavailable',
  code: 'payment_verification_unavailable',
  status: 503,
};

export const SETUP_INTENT_CONTRACT = 'seller-byo-v1';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function callPay(path: string, body: PledgePaymentBinding, retry = true):
Promise<{ data: Record<string, unknown> } | PaymentFailure> {
  const url = serviceUrl('pay');
  if (!url) return UNAVAILABLE;
  try {
    const token = await getPayAppToken();
    const res = await fetch(`${url}/api/setup-intent${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 401 && retry) {
      await invalidatePayAppToken();
      return callPay(path, body, false);
    }
    const data: unknown = await res.json();
    if (!isRecord(data)) return UNAVAILABLE;
    if (!res.ok) {
      // A missing route/permission/contract is NOT evidence the intent failed.
      const verificationFailure = path === '/verify'
        && [400, 403, 404, 409].includes(res.status)
        && typeof data.code === 'string' && data.code.startsWith('setup_intent_');
      if (verificationFailure && typeof data.error === 'string') {
        return { error: data.error, code: data.code as string, status: res.status };
      }
      return UNAVAILABLE;
    }
    return { data };
  } catch {
    // Token mint, network, timeout and invalid JSON all fail closed.
    return UNAVAILABLE;
  }
}

export async function createPledgePayment(binding: PledgePaymentBinding):
Promise<{ clientSecret: string; setupIntentId: string; customerId: string } | PaymentFailure> {
  const result = await callPay('', binding);
  if ('error' in result) return result;
  const { clientSecret, setupIntentId, customerId } = result.data;
  if (typeof clientSecret !== 'string' || !clientSecret
    || typeof setupIntentId !== 'string' || !setupIntentId.startsWith('seti_')
    || typeof customerId !== 'string' || !customerId.startsWith('cus_')) return UNAVAILABLE;
  return { clientSecret, setupIntentId, customerId };
}

/** Validate every binding echoed by the kernel before any pledge write, not just HTTP 200. */
export async function verifyPledgePayment(binding: PledgePaymentVerification):
Promise<{ paymentMethodId: string } | PaymentFailure> {
  const result = await callPay('/verify', binding);
  if ('error' in result) return result;
  const { data } = result;
  if (data.verified !== true
    || Object.entries(binding).some(([key, value]) => data[key] !== value)
    || typeof data.paymentMethodId !== 'string' || !data.paymentMethodId.startsWith('pm_')) return UNAVAILABLE;
  return { paymentMethodId: data.paymentMethodId };
}
