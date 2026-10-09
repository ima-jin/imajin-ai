/** The two ways an issuer can be paid online (`GET /pay/api/payment-requests/rails`, #2754). */
export interface PayRails {
  card: boolean;
  emt: boolean;
}

/**
 * Read which rails the issuer can be paid through. `null` when it can't be read
 * (network/auth/shape) — callers stay quiet rather than guess: a false alarm on
 * every page would be worse than no warning.
 */
export async function loadPayRails(issuerDid: string): Promise<PayRails | null> {
  try {
    const res = await fetch(`/pay/api/payment-requests/rails?issuer_did=${encodeURIComponent(issuerDid)}`, {
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data?.card === 'boolean' && typeof data?.emt === 'boolean' ? { card: data.card, emt: data.emt } : null;
  } catch {
    return null;
  }
}
