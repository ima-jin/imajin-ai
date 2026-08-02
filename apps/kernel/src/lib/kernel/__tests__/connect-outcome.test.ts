import { describe, it, expect } from 'vitest';
import {
  buildConnectHref,
  connectorDetailPath,
  readConnectOutcome,
} from '../connect-outcome';

// ─── connect-outcome.ts — client side of the OAuth round-trip (#1529) ────────
//
// The interesting behaviour is the connector-id tagging: the connectors page
// renders one card per connector against a single shared URL, so a result must
// only ever light up the card it belongs to.

/** Terser than constructing URLSearchParams from an object literal each time. */
function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe('connectorDetailPath', () => {
  it('points at the per-connector detail route', () => {
    expect(connectorDetailPath('quickbooks')).toBe('/auth/connectors/quickbooks');
  });
});

describe('buildConnectHref', () => {
  it('threads the connector detail page through as an encoded returnTo', () => {
    expect(buildConnectHref('/quickbooks/api/connect', 'quickbooks')).toBe(
      '/quickbooks/api/connect?returnTo=%2Fauth%2Fconnectors%2Fquickbooks',
    );
  });

  it('produces a returnTo the server will accept as same-origin', () => {
    const href = buildConnectHref('/github/api/connect', 'github');
    const returnTo = new URLSearchParams(href.split('?')[1]).get('returnTo');
    expect(returnTo).toBe('/auth/connectors/github');
  });
});

describe('readConnectOutcome — success', () => {
  it('reports connected when the id matches', () => {
    expect(readConnectOutcome(params('connected=github'), 'github')).toEqual({
      connected: true,
      errorMessage: null,
    });
  });

  it('ignores a success tagged for a different connector', () => {
    expect(readConnectOutcome(params('connected=github'), 'quickbooks')).toEqual({
      connected: false,
      errorMessage: null,
    });
  });

  it('prefers success over a stale error param', () => {
    const outcome = readConnectOutcome(
      params('connected=github&error=exchange_failed&connector=github'),
      'github',
    );
    expect(outcome.connected).toBe(true);
    expect(outcome.errorMessage).toBeNull();
  });
});

describe('readConnectOutcome — failure', () => {
  it.each([
    'missing_params',
    'invalid_state',
    'missing_param',
    'credential_pending',
    'exchange_failed',
  ])('maps the %s code to human copy', (code) => {
    const outcome = readConnectOutcome(params(`error=${code}&connector=github`), 'github');
    expect(outcome.connected).toBe(false);
    expect(outcome.errorMessage).toBeTruthy();
    // The raw code is an implementation detail — it must not reach the user.
    expect(outcome.errorMessage).not.toContain(code);
  });

  it('gives every code distinct copy', () => {
    const codes = ['missing_params', 'invalid_state', 'missing_param', 'credential_pending', 'exchange_failed'];
    const messages = codes.map((c) => readConnectOutcome(params(`error=${c}&connector=github`), 'github').errorMessage);
    expect(new Set(messages).size).toBe(codes.length);
  });

  it('falls back to generic copy for an unrecognised code', () => {
    const outcome = readConnectOutcome(params('error=who_knows&connector=github'), 'github');
    expect(outcome.errorMessage).toBe("That connection attempt didn't complete. Please try again.");
  });

  it('ignores an error tagged for a different connector', () => {
    expect(readConnectOutcome(params('error=exchange_failed&connector=github'), 'quickbooks')).toEqual({
      connected: false,
      errorMessage: null,
    });
  });

  it('ignores an untagged error param', () => {
    // Without a `connector` tag we cannot know whose failure this was.
    expect(readConnectOutcome(params('error=exchange_failed'), 'github').errorMessage).toBeNull();
  });

  it('ignores a connector tag with no error code', () => {
    expect(readConnectOutcome(params('connector=github'), 'github').errorMessage).toBeNull();
  });
});

describe('readConnectOutcome — no outcome', () => {
  it('reports nothing for an empty query string', () => {
    expect(readConnectOutcome(params(''), 'github')).toEqual({
      connected: false,
      errorMessage: null,
    });
  });

  it('ignores unrelated query params', () => {
    expect(readConnectOutcome(params('tab=scopes&page=2'), 'github')).toEqual({
      connected: false,
      errorMessage: null,
    });
  });
});
