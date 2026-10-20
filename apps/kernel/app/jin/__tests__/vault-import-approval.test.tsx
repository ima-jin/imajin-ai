// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { VaultImportApproval } from '../vault-import-approval';

afterEach(cleanup);

describe('VaultImportApproval', () => {
  it('makes the approved zone, grantee and capabilities visible without a token dump', () => {
    render(<VaultImportApproval detail={{
      cloudflare: { domain: 'example.com', zoneId: 'a'.repeat(32), granteeDid: 'did:web:external.example', capabilities: ['cloudflare:dns'] },
    }} />);
    expect(screen.getByText('Verified zone: example.com')).toBeDefined();
    expect(screen.getByText('Capability grantee: did:web:external.example')).toBeDefined();
    expect(screen.getByText('Capabilities: cloudflare:dns')).toBeDefined();
  });
  it('shows only explicit metadata and rotation semantics, never unknown fields', () => {
    const { container } = render(<VaultImportApproval detail={{
      ownerDid: 'did:imajin:test-org', consumerDid: 'did:imajin:test-agent', purpose: 'analysis',
      label: 'SonarCloud', fingerprint: 'test-fingerprint', expiresAt: '2027-01-01',
      replacesField: 'vault-imported-key:test', secret: 'OBVIOUSLY_FAKE_NOT_FOR_RENDER',
      stagingRef: 'INTERNAL_STAGING_REF',
    }} />);
    expect(screen.getByText('did:imajin:test-org')).toBeDefined();
    expect(screen.getByText('did:imajin:test-agent')).toBeDefined();
    expect(screen.getByText(/Re-import rotation/)).toBeDefined();
    expect(container.textContent).not.toContain('OBVIOUSLY_FAKE_NOT_FOR_RENDER');
    expect(container.textContent).not.toContain('INTERNAL_STAGING_REF');
  });

  it('handles absent metadata without a raw detail dump', () => {
    render(<VaultImportApproval detail={null} />);
    expect(screen.getAllByText('—')).toHaveLength(7);
    expect(screen.queryByText(/Re-import rotation/)).toBeNull();
  });
});
