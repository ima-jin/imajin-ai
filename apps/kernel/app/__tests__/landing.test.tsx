// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Home from '../page';

const routing = vi.hoisted(() => ({
  domainFromHost: vi.fn(),
  domainLanding: vi.fn(),
  redirect: vi.fn(),
  getHeader: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: async () => ({ get: routing.getHeader }) }));
vi.mock('next/navigation', () => ({ redirect: routing.redirect }));
vi.mock('@/src/lib/domains/routing', () => routing);

beforeEach(() => {
  vi.resetAllMocks();
  routing.getHeader.mockReturnValue('imajin.ai');
  routing.domainFromHost.mockReturnValue('imajin.ai');
  routing.domainLanding.mockResolvedValue(null);
});
afterEach(cleanup);

describe('public landing acceptance', () => {
  it('leads with the canonical one line, sub-line, alpha and both alpha CTAs', async () => {
    render(await Home());
    const hero = within(screen.getByRole('heading', { level: 1 }).closest('header')!);
    expect(hero.getByRole('heading', { level: 1 }).textContent).toBe('Identity and authority for AI agents.');
    expect(hero.getByText('Your agents act as themselves, on your authority, and every action is signed.')).toBeDefined();
    expect(hero.getByText('Imajin · Alpha · The trust layer for AI agents')).toBeDefined();
    expect(hero.getByRole('link', { name: 'Book a demo' }).getAttribute('href')).toBe('/alpha?intent=demo');
    expect(hero.getByRole('link', { name: 'Join the alpha' }).getAttribute('href')).toBe('/alpha');
  });

  it('puts the three scannable pillars first, with supporting details collapsed', async () => {
    const { container } = render(await Home());
    const product = screen.getByRole('region', { name: 'The three pillars' });
    expect(product.id).toBe('product');
    expect(product).toBe(container.querySelector('section'));
    expect(within(product).getAllByRole('heading').map(heading => heading.textContent)).toEqual([
      'Agent identity', 'Delegated authority', 'A signed record and settlement',
    ]);
    expect(product.querySelectorAll('article')).toHaveLength(3);
    expect(product.querySelectorAll('details')).toHaveLength(3);
    for (const details of container.querySelectorAll('details')) expect(details.open).toBe(false);
    expect(within(product).getByText('The agent never impersonates the person.')).toBeDefined();
    expect(within(product).getByText('A person grants authority explicitly and can revoke it.')).toBeDefined();
    expect(within(product).getByText('Cost and credit are recorded per identity.')).toBeDefined();
  });

  it('links how it fits, gives only the canonical proof, and provides docs and SDK', async () => {
    render(await Home());
    expect(screen.getByRole('link', { name: 'How it works →' }).getAttribute('href')).toBe('/how-it-works');
    expect(screen.getByRole('heading', { name: 'Imajin on Imajin' })).toBeDefined();
    expect(screen.getByText('Our own operations agent works under its own identity every day, with signed events, approvals and cost recorded per identity.')).toBeDefined();
    expect(screen.getByText('Plus Agentic Travel Co and Agricultural Supply Chain Co, anonymized until agreements are signed.')).toBeDefined();
    expect(screen.getByRole('link', { name: 'docs' }).getAttribute('href')).toBe('/docs');
    expect(screen.getByRole('link', { name: 'SDK' }).getAttribute('href')).toBe('https://github.com/ima-jin/imajin-ai/tree/main/packages/auth-client');
    expect(screen.getByText(/Developers:/).textContent).toBe('Developers: docs and SDK');
    expect(screen.getByText('Platforms and agencies running agents for many clients (multi-principal).').closest('details')?.open).toBe(false);
  });

  it('takes every product claim from the canonical positioning rather than introducing claims', async () => {
    const { container } = render(await Home());
    const canonical = readFileSync(resolve('docs/POSITIONING.md'), 'utf8').replaceAll(/\s+/g, ' ').replaceAll(/[.,]/g, '').toLowerCase();
    // The doc wraps prose across lines and uses Markdown emphasis only on labels.
    for (const element of container.querySelectorAll('h1, article h2, article p, section p')) {
      expect(canonical).toContain(element.textContent!.replaceAll(/[.,]/g, '').toLowerCase());
    }
  });

  it('removes legacy messaging, metrics, matrix, community launcher and subscription form', async () => {
    const { container } = render(await Home());
    for (const phrase of ['programmable trust', 'the speed of thought', 'protocol matrix', '24% complete', 'sovereign network', 'community', 'self-serve', 'Verify a record']) {
      expect(container.textContent?.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
    expect(container.querySelector('progress, video, form')).toBeNull();
    for (const file of ['PrimitiveMatrix.tsx', 'matrix.ts', 'LandingGrid.tsx', 'PromoVideo.tsx']) {
      expect(existsSync(resolve('apps/kernel/src/components/www', file))).toBe(false);
    }
    expect(existsSync(resolve('docs/matrix-status.json'))).toBe(false);
  });

  it('preserves verified custom-domain landing routing', async () => {
    routing.domainLanding.mockResolvedValue('/auth?scope=did%3Aimajin%3Aorg');
    routing.redirect.mockImplementation(() => { throw new Error('redirect'); });
    await expect(Home()).rejects.toThrow('redirect');
    expect(routing.getHeader).toHaveBeenCalledWith('host');
    expect(routing.domainFromHost).toHaveBeenCalledWith('imajin.ai');
    expect(routing.domainLanding).toHaveBeenCalledWith('imajin.ai');
    expect(routing.redirect).toHaveBeenCalledWith('/auth?scope=did%3Aimajin%3Aorg');
  });

  it('renders safely without a routable host and does not look up a destination', async () => {
    routing.domainFromHost.mockReturnValue(null);
    render(await Home());
    expect(routing.domainLanding).not.toHaveBeenCalled();
    expect(routing.redirect).not.toHaveBeenCalled();
    expect(screen.getByRole('heading', { level: 1 })).toBeDefined();
  });
});
