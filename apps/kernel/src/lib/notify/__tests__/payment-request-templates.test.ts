/**
 * The `pay:payment_request-*` notify templates (#2212, child of #2206).
 */
import { describe, it, expect } from 'vitest';
import { getTemplate } from '../templates';

describe('pay:payment_request-issued template', () => {
  it('is registered with an email leg', () => {
    const template = getTemplate('pay:payment_request-issued');
    expect(template).toBeDefined();
    expect(template!.email).toBeDefined();
  });

  it('names the issuer in title/body/subject and includes the amount in body only', () => {
    const template = getTemplate('pay:payment_request-issued')!;
    const data = { issuerName: 'Acme Co', totalFormatted: '$19.99' };

    expect(template.title(data)).toBe('Acme Co sent you a payment request');
    expect(template.email!.subject(data)).toBe('Acme Co sent you a payment request');
    expect(template.body(data)).toContain('$19.99');
  });

  it('falls back to a generic issuer label when the display name is missing', () => {
    const template = getTemplate('pay:payment_request-issued')!;
    expect(template.title({})).toBe('Someone sent you a payment request');
  });
});

describe('pay:payment_request-paid template', () => {
  it('renders issuer vs recipient copy from data.role', () => {
    const template = getTemplate('pay:payment_request-paid')!;
    const amount = '$19.99';

    expect(template.title({ role: 'issuer' })).toBe('Payment received');
    expect(template.body({ role: 'issuer', totalFormatted: amount })).toContain('You received');

    expect(template.title({ role: 'recipient' })).toBe('Payment sent');
    expect(template.body({ role: 'recipient', totalFormatted: amount })).toContain('was received');
  });
});

describe('pay:payment_request-settled template', () => {
  it('phrases the recipient copy differently for manual vs automatic settlement', () => {
    const template = getTemplate('pay:payment_request-settled')!;

    const manual = template.body({ role: 'recipient', totalFormatted: '$5.00', method: 'manual' });
    const stripe = template.body({ role: 'recipient', totalFormatted: '$5.00', method: 'stripe' });

    expect(manual).toContain('the issuer marked this settled');
    expect(stripe).toContain('confirmed automatically');
    expect(manual).not.toBe(stripe);
  });

  it.each([
    ['manual', 'issuer', 'You marked', 'settled.'],
    ['manual', 'recipient', 'the issuer marked this settled', 'was settled'],
    ['stripe', 'issuer', 'confirmed by the platform', 'was settled automatically'],
    ['stripe', 'recipient', 'confirmed automatically (Stripe)', 'was settled'],
  ])('renders the email html for method=%s role=%s with the amount emphasised', (method, role, ...fragments) => {
    const template = getTemplate('pay:payment_request-settled')!;

    const html = template.email!.html({ role, method, totalFormatted: '$5.00' });

    expect(html).toContain('<strong style="color:#ffffff;">$5.00</strong>');
    for (const fragment of fragments) {
      expect(html).toContain(fragment);
    }
  });

  it('escapes the amount in the email html and falls back when it is missing', () => {
    const template = getTemplate('pay:payment_request-settled')!;

    expect(template.email!.html({ role: 'issuer', method: 'manual', totalFormatted: '<b>$1</b>' })).toContain('&lt;b&gt;$1&lt;/b&gt;');
    expect(template.email!.html({ role: 'issuer', method: 'manual' })).toContain('This payment request');
  });
});

describe('pay:payment_request-voided template', () => {
  it('is registered with an email leg', () => {
    const template = getTemplate('pay:payment_request-voided');
    expect(template).toBeDefined();
    expect(template!.email).toBeDefined();
  });
});

describe('pay:payment_request-claimed template', () => {
  it('is registered and mentions the recipient claiming their identity', () => {
    const template = getTemplate('pay:payment_request-claimed');
    expect(template).toBeDefined();
    expect(template!.body({})).toContain('claimed their identity');
  });
});
