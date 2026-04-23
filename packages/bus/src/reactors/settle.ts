import { createLogger } from '@imajin/logger';
import type { BusEvent, ReactorHandler } from '../types';

const log = createLogger('bus:settle');

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY;

export const settleReactor: ReactorHandler = async (event, _config) => {
  if (!PAY_SERVICE_URL || !PAY_SERVICE_API_KEY) {
    log.warn({}, 'Settlement skipped: PAY_SERVICE_URL or PAY_SERVICE_API_KEY not set');
    return;
  }

  const payload = event.payload || {};

  // Extract settlement params from event payload
  const from_did = payload.from_did as string | undefined || event.issuer;
  const total_amount = payload.total_amount as number | undefined;
  const currency = payload.currency as string | undefined;
  const fairManifest = payload.fairManifest as Record<string, unknown> | null | undefined;
  const funded = payload.funded as boolean | undefined;
  const funded_provider = payload.funded_provider as string | undefined;
  const metadata = payload.metadata as Record<string, unknown> | undefined;
  const service = payload.settle_service as string | undefined || event.scope;
  const type = payload.settle_type as string | undefined || event.type;

  if (!total_amount || typeof total_amount !== 'number') {
    log.warn({ event: event.type }, 'Settlement skipped: total_amount missing or invalid');
    return;
  }

  const body: Record<string, unknown> = {
    from_did,
    total_amount,
    service,
    type,
  };

  if (funded !== undefined) body.funded = funded;
  if (funded_provider) body.funded_provider = funded_provider;
  if (currency) body.currency = currency;
  if (fairManifest) body.fair_manifest = fairManifest;
  if (metadata) body.metadata = metadata;

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
      log.error({ status: response.status, text }, 'Settlement request failed');
      return;
    }

    log.info({ event: event.type, from_did, total_amount }, 'Settlement complete');
  } catch (err) {
    log.error({ err: String(err) }, 'Settlement request error');
  }
};
