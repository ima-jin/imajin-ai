import { createLogger } from '@imajin/logger';
import type { BusEvent, ReactorHandler } from '../types';
import { EMISSION_SCHEDULE, resolveAmount, resolveTarget } from '../emissions';

const log = createLogger('bus:mjn');

const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL;
const PAY_SERVICE_API_KEY = process.env.PAY_SERVICE_API_KEY;

export const mjnReactor: ReactorHandler = async (event, config) => {
  if (!PAY_SERVICE_URL || !PAY_SERVICE_API_KEY) {
    log.warn({}, 'MJN reactor: PAY_SERVICE_URL or PAY_SERVICE_API_KEY not set');
    return;
  }

  const attestationType = (config.attestationType as string) || event.type;
  const spec = EMISSION_SCHEDULE[attestationType];
  if (!spec || spec.emit.length === 0) return;

  // Settlement value for percentage-based emissions
  const settlementCents = typeof event.payload?.amount === 'number' ? event.payload.amount : undefined;

  const context = {
    issuerDid: event.issuer,
    subjectDid: event.subject,
    scopeDid: (event.payload?.scope_did as string) || null,
    nodeDid: null as string | null, // TODO: resolve from config
  };

  for (const rule of spec.emit) {
    const targetDid = resolveTarget(rule, context);
    if (!targetDid) {
      log.warn({ rule: rule.to, type: attestationType }, '[mjn] No target DID — skipping');
      continue;
    }

    const amount = resolveAmount(rule, settlementCents);
    if (amount <= 0) continue;

    try {
      const response = await fetch(`${PAY_SERVICE_URL}/api/emission`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${PAY_SERVICE_API_KEY}`,
        },
        body: JSON.stringify({
          to_did: targetDid,
          amount,
          currency: 'MJN',
          reason: rule.reason,
          metadata: {
            attestation_type: attestationType,
            to_role: rule.to,
            event_type: event.type,
            issuer: event.issuer,
            subject: event.subject,
          },
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        log.error({ status: response.status, text, targetDid, attestationType }, '[mjn] Emission credit failed');
      } else {
        log.info({ amount, targetDid: targetDid.slice(0, 24), attestationType, reason: rule.reason }, '[mjn] MJN credited');
      }
    } catch (err) {
      log.error({ err: String(err), targetDid, attestationType }, '[mjn] Emission request error');
    }
  }
};
