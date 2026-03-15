/**
 * settleTip
 *
 * Calls POST /api/settle on the pay service after a tip payment completes.
 * Settlement failure is non-fatal — the tip has already been recorded.
 */

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL!;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY!;
const PLATFORM_DID = process.env.PLATFORM_DID || 'did:imajin:platform';
const PLATFORM_FEE_PERCENT = parseFloat(process.env.PLATFORM_FEE_PERCENT || '1.5');

interface SettleTipParams {
  tipId: string;
  recipientDid: string;
  fromDid: string | null;
  amount: number;      // cents
  currency: string;
  stripeSessionId?: string;
}

export async function settleTip(params: SettleTipParams): Promise<void> {
  const { tipId, recipientDid, fromDid, amount, currency, stripeSessionId } = params;

  const totalDollars = amount / 100;
  const platformAmount = parseFloat((totalDollars * (PLATFORM_FEE_PERCENT / 100)).toFixed(2));
  const creatorAmount = parseFloat((totalDollars - platformAmount).toFixed(2));

  const chain = [
    { did: recipientDid, amount: creatorAmount, role: 'creator' },
    { did: PLATFORM_DID, amount: platformAmount, role: 'platform' },
  ];

  const body = {
    from_did: fromDid || 'anonymous',
    total_amount: totalDollars,
    service: 'coffee',
    type: 'tip',
    funded: true,
    funded_provider: 'stripe',
    fair_manifest: { chain },
    metadata: {
      tipId,
      ...(stripeSessionId && { stripeSessionId }),
    },
  };

  try {
    const response = await fetch(`${PAY_SERVICE_URL}/api/settle`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PAY_SERVICE_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[settle] pay /api/settle returned ${response.status}: ${text}`);
      return;
    }

    const result = await response.json();
    console.log(`[settle] Tip settlement complete for ${tipId}:`, result);
  } catch (error) {
    console.error('[settle] Tip settlement request failed (non-fatal):', error);
  }
}
