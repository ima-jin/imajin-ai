// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ReachPage } from '../reach-page';
import { card } from './fixture';

afterEach(cleanup);

describe('ReachPage public presentation', () => {
  it('shows the public identity, share URL, card URL, and opted-in labels', () => {
    const withPrivateExtras = { ...card, metadata: { privateRule: 'PRIVATE_GATE_SENTINEL' }, token: 'PRIVATE_TOKEN_SENTINEL' };
    render(<ReachPage card={withPrivateExtras} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Reach Alex');
    expect(screen.getByText(card.principalDid).textContent).toBe(card.principalDid);
    expect(screen.getByText(card.instructionsUrl).textContent).toBe(card.instructionsUrl);
    expect(screen.getByRole('link', { name: 'Unified JSON card' }).getAttribute('href')).toBe(card.url);
    expect(screen.getByText('community').tagName).toBe('LI');
    expect(document.querySelector('input, textarea, form')).toBeNull();
    expect(document.body.textContent).not.toContain('PRIVATE_GATE_SENTINEL');
    expect(document.body.textContent).not.toContain('PRIVATE_TOKEN_SENTINEL');
  });

  it('provides each supported platform with card-derived URLs, never an invented transport', () => {
    render(<ReachPage card={card} />);
    for (const name of ['Muse MCP setup', 'Claude MCP instructions', 'ChatGPT OpenAPI instructions', 'Gemini OpenAPI instructions', 'Signed agent instructions']) {
      expect(screen.getByRole('button', { name: `Copy ${name}` })).toBeTruthy();
    }
    const snippets = [...document.querySelectorAll('pre')].map(element => element.textContent);
    expect(snippets.find(text => text?.includes('Transport: remote HTTP MCP'))).toContain(card.transports[0].endpoint);
    expect(snippets.find(text => text?.includes('Connect your OpenAPI-capable ChatGPT'))).toContain(card.transports[1].endpoint);
    expect(snippets.find(text => text?.includes('Connect your Gemini'))).toContain(card.transports[1].endpoint);
    expect(snippets.find(text => text?.includes('Signed Reach endpoint'))).toContain(card.reach.endpoint);
    expect(snippets.find(text => text?.startsWith('curl'))).toContain(card.onboarding.endpoint);
    expect(screen.getByRole('link', { name: 'MCP protected resource metadata' }).getAttribute('href')).toBe(card.transports[0].discovery);
    expect(screen.getByRole('link', { name: 'Read the knock flow document' }).getAttribute('href')).toBe(card.onboarding.flowDocument);
  });

  it('explains narrow authority and client limitations without promising OAuth or A2A', () => {
    render(<ReachPage card={card} />);
    expect(screen.getByText(/No owner token or owner approval is needed/).textContent).toContain('UNVERIFIED');
    expect(screen.getByText(/Anonymous access is discovery only/)).toBeTruthy();
    expect(screen.getByText(/A credential is not consent to every topic/)).toBeTruthy();
    expect(screen.getByText(/Tool and connector access may vary/).textContent).toContain('OAuth sign-in and A2A are not live');
    expect(screen.getByText(/The signed path supports did:imajin and verified did:web/)).toBeTruthy();
    expect(screen.getByText(/Knock requires a gate that admits soft-tier/)).toBeTruthy();
  });

  it('handles absent labels, name, handle, and transports without inventing setup options', () => {
    render(<ReachPage card={{ ...card, name: null, handle: null, reach: { ...card.reach, topics: undefined }, transports: [] }} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Reach this person');
    expect(screen.getByText('No topic labels have been published.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy Muse MCP setup' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Copy ChatGPT OpenAPI instructions' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Agents with signing keys' })).toBeNull();
  });

  it('falls back to the handle and wraps all code for narrow viewports', () => {
    render(<ReachPage card={{ ...card, name: null }} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Reach @alex');
    for (const snippet of document.querySelectorAll('pre')) {
      expect(snippet.className).toContain('whitespace-pre-wrap');
      expect(snippet.className).toContain('[overflow-wrap:anywhere]');
    }
  });
});
