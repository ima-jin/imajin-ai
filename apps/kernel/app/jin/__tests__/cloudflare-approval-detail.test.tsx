// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CloudflareApprovalDetail } from '../cloudflare-approval-detail';

afterEach(cleanup);
const context = { actor: { did: 'did:imajin:actor' }, ownerDid: 'did:imajin:group', domain: 'example.com', zoneId: 'a'.repeat(32), expiresAt: '2026-10-20T10:00:00Z' };
describe('Cloudflare approval details', () => {
  it('shows the exact actor, owner and proxy before-after without arbitrary payload fields', () => {
    const record = { id: 'r', name: 'www.example.com', type: 'A', content: '192.0.2.1', ttl: 1, proxied: false };
    render(<CloudflareApprovalDetail detail={{ ...context, operation: 'bulk-proxy',
      unexpected: 'FAKE_PRIVATE_VALUE', changes: [{ recordId: 'r', before: record, after: { ...record, proxied: true, token: 'FAKE_PRIVATE_VALUE' } }] }} />);
    expect(screen.getByText('Actor: did:imajin:actor')).toBeDefined();
    expect(screen.getByText('On behalf of: did:imajin:group')).toBeDefined();
    expect(screen.getByText(/www.example.com/).textContent).toContain('"proxied": true');
    expect(document.body.textContent).not.toContain('FAKE_PRIVATE_VALUE');
  });
  it('shows cache rules in order with fixed before-after fields', () => {
    const rule = { description: 'Static assets', expression: 'true', enabled: true,
      action_parameters: { cache: true, edge_ttl: { mode: 'override_origin', default: 3600 } } };
    render(<CloudflareApprovalDetail detail={{ ...context, operation: 'cache-set', before: [], rules: [rule] }} />);
    expect(screen.getByText(/Static assets/).textContent).toContain('3600');
  });
  it('fails safely on malformed or absent plan fields', () => {
    const { rerender } = render(<CloudflareApprovalDetail detail={null} />);
    expect(screen.getByText(/do not approve/)).toBeDefined();
    rerender(<CloudflareApprovalDetail detail={{ operation: 'cache-set', before: [null], rules: 'bad' }} />);
    expect(screen.getByText('Actor: Unavailable')).toBeDefined();
    rerender(<CloudflareApprovalDetail detail={{ operation: 'bulk-proxy', changes: [null] }} />);
    expect(screen.getByText(/Record 1/)).toBeDefined();
  });
});
