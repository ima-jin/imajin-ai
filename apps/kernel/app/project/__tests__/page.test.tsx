// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@imajin/ui', () => ({ ImajinFooter: () => <span>Imajin</span> }));

import ProjectPage, { metadata } from '../page';

function renderPage() {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(<ProjectPage />);
  return container;
}

describe('/project rationale and alpha state', () => {
  it('leads with the reasons for the design rather than the old product pitch', () => {
    const page = renderPage();
    const header = page.querySelector('header')!;
    expect(header.querySelector('h1')?.textContent).toBe('Why we built it this way');
    expect(header.textContent).toContain('An agent should carry its own identity.');
    expect(header.textContent).toContain('Trust should live in signatures, not a vendor.');
    expect(header.textContent).toContain('own the record and run it on hardware you own.');
    expect(header.textContent).toContain('the trust layer for AI agents');
    expect(header.textContent).toContain('not a promise that the alpha is finished');
    expect(page.textContent).not.toContain('Imajin runs your community');
  });

  it('dates the state and gives only the specified hardware and model division of work', () => {
    const state = renderPage().querySelector('details')!;
    expect(state.querySelector('summary')?.textContent).toContain('State of Imajin, November 2026');
    expect(state.textContent).toContain('We run on our own hardware');
    const hardware = Array.from(state.querySelectorAll('li'), item => item.textContent);
    expect(hardware).toEqual([
      'One GPU box with an RTX 5090 for local models.',
      'One Grace Blackwell workstation with 128 GB unified memory for a 120B model plus embeddings and retrieval.',
      'One platform server.',
    ]);
    expect(state.textContent).toMatch(/Frontier models do judgment work\.\s+Local models do coding, research, embeddings\s+and transcription\./);
  });

  it('names all six additions to the harness without pitching a replacement harness', () => {
    const harness = renderPage().querySelectorAll('details').item(1);
    expect(harness.textContent).toContain('you use both');
    const additions = Array.from(harness.querySelectorAll('li'), item => item.textContent);
    expect(additions).toEqual([
      'Its own identity per agent: the agent acts as itself, not as the person.',
      'A signed record of what the agent did and on whose authority.',
      'Approval by a person: risky actions wait for a named human approver.',
      'Several identities on one runtime, each for its own principal.',
      'Events pushed to the agent.',
      'Cost and credit recorded per identity (.fair).',
    ]);
  });

  it('states every current limit plainly', () => {
    const limits = renderPage().querySelectorAll('details').item(2);
    expect(limits.querySelector('summary')?.textContent).toContain('Honest limits');
    expect(Array.from(limits.querySelectorAll('li'), item => item.textContent)).toEqual([
      'The plugin is early (v0.1).',
      'We depend on upstream for some harness paths.',
      'Frontier models still do the judgment work.',
      'A person is still in the dispatch loop.',
      'One server, no redundancy yet.',
      'Few outside users so far.',
    ]);
  });

  it('ends with the invitation and both alpha intake paths, not self-serve registration', () => {
    const page = renderPage();
    const ending = page.querySelector('article')!.lastElementChild!;
    expect(ending.querySelector('h2')?.textContent).toBe("Don't trust us; point your agent at it");
    expect(ending.textContent).toContain('This is an alpha.');
    expect(ending.textContent).toContain('tester, integrator or partner');
    expect(ending.textContent).toContain('Joining the alpha is the sign-up path for now.');
    expect(ending.querySelector('a[href="/alpha?intent=demo"]')?.textContent).toBe('Book a demo');
    expect(ending.querySelector('a[href="/alpha"]')?.textContent).toBe('Join the alpha');
    expect(page.querySelector('a[href="/register"]')).toBeNull();
  });

  it('is summary-first with concise, closed disclosures and a whitepaper link', () => {
    const page = renderPage();
    const disclosures = Array.from(page.querySelectorAll('details'));
    expect(disclosures).toHaveLength(3);
    for (const disclosure of disclosures) {
      expect(disclosure.open).toBe(false);
      expect(disclosure.firstElementChild?.tagName).toBe('SUMMARY');
      expect(disclosure.querySelector('summary')?.firstChild?.textContent).toMatch(/\s$/);
      expect(disclosure.querySelector('summary span')?.textContent?.trim()).toBeTruthy();
    }
    expect(page.querySelector('header a')?.getAttribute('href')).toBe('/whitepaper');
    expect(page.querySelectorAll('h1')).toHaveLength(1);
    expect(page.querySelector('header')?.textContent?.trim().split(/\s+/).length).toBeLessThan(100);
  });

  it('updates search and social metadata without inheriting the old community pitch', () => {
    expect(metadata.title).toBe('Why we built it this way');
    expect(metadata.description).toContain('November 2026');
    expect(metadata.description).toContain('alpha');
    expect(metadata.alternates).toEqual({ canonical: '/project' });
    expect(metadata.openGraph).toMatchObject({
      title: metadata.title, description: metadata.description, url: '/project', images: [],
    });
    expect(metadata.twitter).toMatchObject({
      title: metadata.title, description: metadata.description, images: [],
    });
    expect(JSON.stringify(metadata)).not.toMatch(/community|sovereign|token/i);
  });

  it('keeps internal identifiers, addresses and partner references out of public copy', () => {
    const page = renderPage();
    const content = `${page.textContent} ${JSON.stringify(metadata)}`;
    expect(content).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(content).not.toMatch(/\bdid:[a-z]+:|#\d+|\b(?:localhost|https?:\/\/|\w+\.(?:local|internal|lan))\b/i);
    expect(content).not.toMatch(/\b(?:port|hostname|service name|Agentic Travel Co|Agricultural Supply Chain Co)\b/i);
    const hrefs = Array.from(page.querySelectorAll('a'), link => link.getAttribute('href'));
    expect(hrefs).toEqual(['/whitepaper', '/alpha?intent=demo', '/alpha']);
  });
});
