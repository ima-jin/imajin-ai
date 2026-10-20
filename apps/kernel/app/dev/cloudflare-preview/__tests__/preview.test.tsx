// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import { CloudflarePreview } from '../cloudflare-preview';
import CloudflarePreviewPage from '../page';
import { fixtureGroup, fixtureZoneId } from '../transport';

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('not found'); } }));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
describe('Cloudflare development preview', () => {
  it('refuses production server rendering', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => CloudflarePreviewPage()).toThrow('not found');
  });
  it('renders real panels with group ownership and non-executing proposal handoff', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect(CloudflarePreviewPage()).toBeDefined();
    render(<CloudflarePreview />);
    const importPanel = await screen.findByTestId('vault-import-panel');
    fireEvent.change(within(importPanel).getByLabelText('Owning identity'), { target: { value: fixtureGroup } });
    fireEvent.change(within(importPanel).getByLabelText('Purpose'), { target: { value: `dns.cloudflare:${fixtureZoneId}` } });
    fireEvent.change(within(importPanel).getByLabelText('Consumer agent or service DID'), { target: { value: 'did:imajin:fixture-node' } });
    const credential = within(importPanel).getByLabelText('Credential') as HTMLInputElement;
    fireEvent.change(credential, { target: { value: 'FAKE_FIXTURE_INPUT' } });
    fireEvent.click(within(importPanel).getByRole('button', { name: 'Seal and propose import' }));
    expect(credential.value).toBe('');
    await screen.findByRole('link', { name: 'Review import proposal' });
    expect(document.body.textContent).not.toContain('FAKE_FIXTURE_INPUT');
    const panel = within(screen.getByTestId('cloudflare-panel'));
    fireEvent.change(panel.getByLabelText('Verified zone domain'), { target: { value: 'imajin.ai' } });
    fireEvent.change(panel.getByLabelText('Cloudflare zone ID'), { target: { value: fixtureZoneId } });
    fireEvent.change(panel.getByLabelText('Initial zone view'), { target: { value: 'Edge classification' } });
    fireEvent.click(panel.getByRole('button', { name: 'Load zone' }));
    fireEvent.click(await panel.findByRole('button', { name: 'Preview all dry runs' }));
    const request = panel.getByRole('button', { name: 'Request approval' }) as HTMLButtonElement;
    await waitFor(() => expect(request.disabled).toBe(false));
    fireEvent.click(request);
    const link = await panel.findByRole('link', { name: /Review proposal 1:/ });
    const id = link.getAttribute('href')!.slice(1);
    expect(document.getElementById(id)?.textContent).toContain('cloudflare:bulk-proxy');
    await panel.findByRole('link', { name: /Review proposal 2:/ });
    expect(panel.queryByRole('button', { name: /execute/i })).toBeNull();
    expect(panel.getByRole('heading', { name: 'kernel.imajin.ai' })).toBeDefined();
    expect(panel.getByRole('heading', { name: '_verification.imajin.ai' })).toBeDefined();
    expect(screen.getByRole('heading', { name: 'Fixture pending proposals · no execution' })).toBeDefined();
  });
});
