/**
 * The `attest.pending_signature` notify template (#1820).
 *
 * Verifies the in-app title/body render, and that the email includes a CTA
 * deep-linking back to the origin app only when `originUrl` was derivable.
 */
import { describe, it, expect } from 'vitest';
import { getTemplate } from '../templates';

describe('attest.pending_signature template', () => {
  it('is registered and resolvable via getTemplate', () => {
    expect(getTemplate('attest.pending_signature')).toBeDefined();
  });

  it('renders an urgent in-app title/body naming the attestation type', () => {
    const template = getTemplate('attest.pending_signature')!;
    const data = { attestationId: 'att_001', type: 'delivery.receipt' };

    expect(template.urgency).toBe('urgent');
    expect(template.title(data)).toBe('New delivery.receipt attestation awaiting your signature');
    expect(template.body(data)).toContain('delivery.receipt');
  });

  it('falls back to a generic label when type is missing', () => {
    const template = getTemplate('attest.pending_signature')!;

    expect(template.title({})).toBe('New attestation attestation awaiting your signature');
  });

  it('includes a CTA link to originUrl in the email body when present', () => {
    const template = getTemplate('attest.pending_signature')!;
    const html = template.email!.html({ type: 'delivery.receipt', originUrl: 'https://xprize.example.com' });

    expect(html).toContain('https://xprize.example.com');
    expect(html).toContain('Review pending signatures');
  });

  it('omits the CTA link when originUrl was not derivable', () => {
    const template = getTemplate('attest.pending_signature')!;
    const html = template.email!.html({ type: 'delivery.receipt' });

    expect(html).not.toContain('Review pending signatures');
  });

  it('escapes the attestation type in the email body', () => {
    const template = getTemplate('attest.pending_signature')!;
    const html = template.email!.html({ type: '<script>alert(1)</script>' });

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
