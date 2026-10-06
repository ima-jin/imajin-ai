/**
 * Interac e-Transfer pay-in rail (#2665).
 *
 * The ONE kernel EMT pay-in rail: payment requests use it today, and the
 * re-architected events app (#1988) is meant to use it in place of its own
 * `etransfer-helpers.ts` / `confirm-payment.ts` — which is why it knows
 * nothing about payment requests. It is a pure adapter: given an amount, a
 * reference and the receiver's email it returns the instructions a payer
 * needs. Confirming that the money arrived is a human act (the receiver
 * checks their bank), so the rail is `confirmation: 'manual'` and there is
 * no webhook, feed or SDK here.
 *
 * The same `'emt'` name is what #2014 will register as the withdraw
 * direction (`WithdrawRail`) — see `./types.ts`.
 */
import type { PayInFeeEntry, PayInInstructions, PayInRail, PayInRequest } from './types';

export const EMT_RAIL_NAME = 'emt';

/** Interac e-Transfer moves Canadian dollars only. */
const EMT_CURRENCIES: readonly string[] = ['CAD'];

/** An e-Transfer carries no processor fee: the money moves bank to bank. */
const EMT_PROCESSOR_FEE: PayInFeeEntry = { role: 'processor', rateBps: 0, fixedCents: 0 };

export class EmtPayInRail implements PayInRail {
  readonly name = EMT_RAIL_NAME;
  readonly currencies = EMT_CURRENCIES;
  readonly confirmation = 'manual' as const;

  supportsCurrency(currency: string): boolean {
    return EMT_CURRENCIES.includes(currency.toUpperCase());
  }

  instructionsFor(request: PayInRequest, destination: string): PayInInstructions {
    if (!destination.trim()) {
      throw new Error('EMT pay-in requires a receiving email');
    }
    if (!Number.isInteger(request.amountMinor) || request.amountMinor <= 0) {
      throw new Error('EMT pay-in requires a positive integer amount in minor units');
    }
    if (!this.supportsCurrency(request.currency)) {
      throw new Error(`EMT pay-in does not support currency '${request.currency}'`);
    }
    if (!request.reference.trim()) {
      throw new Error('EMT pay-in requires a reference');
    }
    return {
      rail: this.name,
      destination: destination.trim(),
      amountMinor: request.amountMinor,
      currency: request.currency.toUpperCase(),
      reference: request.reference,
    };
  }

  settlementFees(manifestFees: readonly PayInFeeEntry[] | undefined): PayInFeeEntry[] {
    const withoutProcessor = (manifestFees ?? []).filter((fee) => fee.role !== 'processor');
    return [...withoutProcessor, EMT_PROCESSOR_FEE];
  }
}
