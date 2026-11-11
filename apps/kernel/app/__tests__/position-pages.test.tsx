// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import HowItWorksPage, { metadata as howMetadata } from '../how-it-works/page';
import ComparePage, { metadata as compareMetadata } from '../compare/page';
import sitemap from '../sitemap';

const { getAllArticles } = vi.hoisted(() => ({ getAllArticles: vi.fn() }));
vi.mock('@/src/lib/www/articles', () => ({ getAllArticles }));

afterEach(cleanup);

describe('How it works', () => {
  it('leads with three ruled pillars and keeps their details collapsed', () => {
    render(<HowItWorksPage />);
    const pillars = screen.getByRole('region', { name: 'The three pillars' });
    expect(within(pillars).getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual([
      'Agent identity', 'Delegated authority', 'A signed record and settlement',
    ]);
    expect(pillars.compareDocumentPosition(screen.getByRole('figure')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pillars.textContent).toContain('Every agent holds its own key and proves it');
    expect(pillars.textContent).toContain('Several identities can run on one runtime, each for its own principal');
    expect(pillars.textContent).toContain('The agent never impersonates the person');
    expect(pillars.textContent).toContain('You grant authority explicitly and can revoke it');
    expect(pillars.textContent).toContain('the person authorised it, and the agent did it');
    expect(pillars.textContent).toContain('anyone can verify, including a third party’s own agent');
    expect(pillars.textContent).toContain('Cost and credit are recorded per identity');
    expect(pillars.textContent).toContain('.fair turns that into who gets paid');
  });

  it('has one HTML diagram with a complete visible, programmatically associated text alternative', () => {
    render(<HowItWorksPage />);
    const figure = screen.getByRole('figure');
    const alternative = document.getElementById(figure.getAttribute('aria-describedby')!);
    expect(figure.querySelector('img, canvas')).toBeNull();
    expect(figure.querySelector('[aria-hidden="true"]')?.textContent).toMatch(/Your agent runtime.*Imajin plugin.*Signed events.*Imajin kernel/);
    expect(alternative?.closest('[aria-hidden="true"], details')).toBeNull();
    expect(alternative?.textContent).toContain('Your agent runtime connects through the Imajin plugin to the kernel');
    expect(alternative?.textContent).toContain('Signed events flow in; risky actions wait for a named human approver');
    expect(alternative?.textContent).toContain('it never reaches into your runtime, holds session keys or reads transcripts');
    expect(figure.getAttribute('aria-labelledby')).toBe('flow-heading');
  });

  it('puts existing framework and deployment choices after the diagram, with alpha qualification', () => {
    render(<HowItWorksPage />);
    const fit = screen.getByRole('region', { name: 'How it fits' });
    expect(screen.getByRole('figure').compareDocumentPosition(fit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fit.textContent).toContain('Works with the framework you already run');
    expect(fit.textContent).toContain('OpenClaw today. Hosted or self-run. In alpha.');
    expect(fit.textContent).toContain('The harness is swappable');
    expect(fit.textContent).toContain('platforms and agencies running agents for many clients');
    expect(screen.getByRole('link', { name: 'Compare approaches →' }).getAttribute('href')).toBe('/compare');
  });
});

describe('Compare', () => {
  it('has exactly four rows with ruled focus and fit, and complementary frameworks', () => {
    render(<ComparePage />);
    const rows = within(screen.getByRole('region', { name: 'Four approaches compared' })).getAllByRole('article');
    expect(rows.map((row) => within(row).getByRole('heading').textContent)).toEqual([
      'Identity incumbents', 'Agent frameworks', 'Hosted assistants', 'Web3 agent projects',
    ]);
    for (const row of rows) {
      expect(row.textContent).toContain('Focus:');
      expect(row.textContent).toContain('Imajin in alpha:');
    }
    expect(rows[0].textContent).toContain('People logging into apps');
    expect(rows[0].textContent).toContain('agents acting for people');
    expect(rows[1].textContent).toContain('They orchestrate');
    expect(rows[1].textContent).toContain('the accountability layer under them. You use both.');
    expect(rows[2].textContent).toContain('Hosted identity, memory and logs');
    expect(rows[2].textContent).toContain('Rented; you don’t own the record');
    expect(rows[3].textContent).toContain('Imajin starts from working software');
    expect(screen.getByRole('link', { name: 'How it works →' }).getAttribute('href')).toBe('/how-it-works');
  });
});

describe.each([
  ['How it works', HowItWorksPage, howMetadata],
  ['Compare', ComparePage, compareMetadata],
] as const)('%s public page', (title, Page, metadata) => {
  it('is summary-first, explicitly alpha, and ends with both alpha CTAs and docs', () => {
    const { container } = render(<Page />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(title);
    expect(container.querySelector('header')?.textContent).toContain('Alpha · The trust layer for AI agents');
    const disclosures = container.querySelectorAll('details');
    expect(disclosures.length).toBeGreaterThan(0);
    for (const disclosure of disclosures) {
      expect(disclosure.open).toBe(false);
      expect(disclosure.querySelector('summary')?.textContent).toBeTruthy();
    }
    const footer = container.querySelector('main > div')?.lastElementChild;
    expect(footer?.tagName).toBe('FOOTER');
    const links = within(footer as HTMLElement);
    expect(links.getByRole('link', { name: 'Join the alpha' }).getAttribute('href')).toBe('/alpha');
    expect(links.getByRole('link', { name: 'Book a demo' }).getAttribute('href')).toBe('/alpha?intent=demo');
    expect(links.getByRole('link', { name: 'Read the docs' }).getAttribute('href')).toBe('/docs');
    expect(footer?.textContent).toContain('testers, integrators and partners');
    expect(footer?.textContent).toContain('Joining the alpha is the sign-up path today');
    expect(container.querySelector('nav')).toBeNull();
  });

  it('has page-specific metadata, including social descriptions rather than inherited manifesto copy', () => {
    expect(metadata.title).toBe(title);
    expect(metadata.description).toContain('alpha');
    expect(metadata.openGraph).toMatchObject({ title: `${title} | Imajin`, description: metadata.description });
    expect(metadata.twitter).toMatchObject({ title: `${title} | Imajin`, description: metadata.description });
    expect(howMetadata.description).not.toBe(compareMetadata.description);
  });

  it('does not advertise self-serve, beta verification, hardware, community apps or currency', () => {
    const { container } = render(<Page />);
    expect(container.textContent).not.toMatch(/\b(self-serve|verify a record|hardware|CPU|RAM|community apps|MJNx|token required|blockchain|wallet|Okta)\b/i);
    expect(container.querySelector('a[href="/register"]')).toBeNull();
  });
});

describe('public sitemap', () => {
  it('includes both pages and still filters articles without author handles', async () => {
    getAllArticles.mockResolvedValue([
      { authorHandle: 'jin', slug: 'signed', date: '2026-11-09' },
      { authorHandle: null, slug: 'hidden', date: '2026-11-09' },
    ]);
    const entries = await sitemap();
    const urls = entries.map((entry) => entry.url);
    expect(urls).toContain('https://imajin.ai/how-it-works');
    expect(urls).toContain('https://imajin.ai/compare');
    expect(urls).toContain('https://imajin.ai/articles/jin/signed');
    expect(urls.some((url) => url.includes('hidden'))).toBe(false);
  });

  it('keeps the public pages discoverable when the article database is unavailable', async () => {
    getAllArticles.mockRejectedValue(new Error('database unavailable'));
    expect((await sitemap()).map((entry) => entry.url)).toEqual([
      'https://imajin.ai', 'https://imajin.ai/alpha', 'https://imajin.ai/articles', 'https://imajin.ai/how-it-works', 'https://imajin.ai/compare', 'https://imajin.ai/project',
    ]);
  });
});
