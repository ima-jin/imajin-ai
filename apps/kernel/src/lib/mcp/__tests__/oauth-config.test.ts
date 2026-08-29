// Open DCR (#1878): redirect_uri validation is spec-shaped, not a per-client
// allowlist. Any absolute https URI registers; loopback redirects (RFC 8252
// §7.3) are allowed on any port with no flag; fragments, wildcards, and
// custom schemes are rejected.
import { afterEach, describe, expect, it } from 'vitest';
import {
  MCP_SCOPES,
  areRedirectUrisAllowed,
  isLoopbackRedirectUri,
  isValidRedirectUri,
  redirectUriMatches,
  resolveGrantedScopes,
  resolveRefreshScopes,
  getMcpIssuer,
  getMcpResource,
  getAuthorizationEndpoint,
  getTokenEndpoint,
  getRegistrationEndpoint,
  getProtectedResourceMetadataUrl,
  withIssuerIdentification,
  ISSUER_IDENTIFICATION_SUPPORTED,
} from '../oauth-config.js';

const CLAUDE_URI = 'https://claude.ai/api/mcp/auth_callback';

describe('isValidRedirectUri (#1878)', () => {
  it('accepts any absolute https URI, not only known Anthropic callbacks', () => {
    expect(isValidRedirectUri(CLAUDE_URI)).toBe(true);
    expect(isValidRedirectUri('https://claude.com/api/mcp/auth_callback')).toBe(true);
    expect(isValidRedirectUri('https://typingmind.com/api/mcp/oauth/callback')).toBe(true);
    expect(isValidRedirectUri('https://random-third-party-client.example/cb')).toBe(true);
  });

  it('accepts RFC 8252 §7.3 loopback redirects on any port/path', () => {
    expect(isValidRedirectUri('http://127.0.0.1:6274/oauth/callback')).toBe(true);
    expect(isValidRedirectUri('http://localhost:8080/oauth/callback')).toBe(true);
    expect(isValidRedirectUri('http://[::1]:9999/oauth/callback')).toBe(true);
    expect(isValidRedirectUri('http://127.0.0.1:6274/oauth/callback/debug')).toBe(true);
  });

  it('rejects plain http on a non-loopback host', () => {
    expect(isValidRedirectUri('http://evil.example/cb')).toBe(false);
    expect(isValidRedirectUri('http://typingmind.com/cb')).toBe(false);
  });

  it('rejects a fragment component', () => {
    expect(isValidRedirectUri('https://example.com/cb#frag')).toBe(false);
    expect(isValidRedirectUri('http://localhost:6274/oauth/callback#frag')).toBe(false);
  });

  it('rejects a wildcard anywhere in the URI', () => {
    expect(isValidRedirectUri('https://*.evil.example/cb')).toBe(false);
    expect(isValidRedirectUri('https://evil.example/*')).toBe(false);
    expect(isValidRedirectUri('https://evil.example/cb*')).toBe(false);
  });

  it('rejects a custom/other scheme', () => {
    expect(isValidRedirectUri('myapp://callback')).toBe(false);
    expect(isValidRedirectUri('intent://callback#Intent')).toBe(false);
  });

  it('rejects empty or malformed values', () => {
    expect(isValidRedirectUri('')).toBe(false);
    expect(isValidRedirectUri('not-a-url')).toBe(false);
    expect(isValidRedirectUri('/relative/path')).toBe(false);
  });
});

describe('areRedirectUrisAllowed — every entry must be spec-valid (#1878)', () => {
  it('allows the known Anthropic callbacks (still spec-valid https)', () => {
    expect(areRedirectUrisAllowed([CLAUDE_URI])).toBe(true);
    expect(areRedirectUrisAllowed(['https://claude.com/api/mcp/auth_callback'])).toBe(true);
  });

  it('allows an arbitrary spec-valid https client with zero server config', () => {
    expect(areRedirectUrisAllowed(['https://typingmind.com/api/mcp/oauth/callback'])).toBe(true);
  });

  it('allows loopback redirect URIs on any port (RFC 8252 §7.3)', () => {
    expect(areRedirectUrisAllowed(['http://127.0.0.1:6274/oauth/callback'])).toBe(true);
    expect(areRedirectUrisAllowed(['http://127.0.0.1:54321/oauth/callback'])).toBe(true);
    expect(areRedirectUrisAllowed(['http://localhost:8080/oauth/callback'])).toBe(true);
    expect(areRedirectUrisAllowed(['http://[::1]:9999/oauth/callback'])).toBe(true);
  });

  it('accepts loopback redirect URIs with any path (RFC 8252 pins host, not path)', () => {
    expect(areRedirectUrisAllowed(['http://127.0.0.1:6274/evil'])).toBe(true);
    expect(areRedirectUrisAllowed(['http://localhost:8080/not-callback'])).toBe(true);
  });

  it('allows https on a loopback host too (https is always acceptable)', () => {
    expect(areRedirectUrisAllowed(['https://127.0.0.1/oauth/callback'])).toBe(true);
    expect(areRedirectUrisAllowed(['https://localhost:6274/oauth/callback'])).toBe(true);
  });

  it('rejects non-loopback plain-http URIs', () => {
    expect(areRedirectUrisAllowed(['http://evil.example:6274/oauth/callback'])).toBe(false);
  });

  it('rejects fragments, wildcards, and custom schemes', () => {
    expect(areRedirectUrisAllowed(['https://attacker.example/cb#frag'])).toBe(false);
    expect(areRedirectUrisAllowed(['https://*.attacker.example/cb'])).toBe(false);
    expect(areRedirectUrisAllowed(['myapp://callback'])).toBe(false);
  });

  it('rejects when any one of several URIs is invalid', () => {
    expect(areRedirectUrisAllowed([CLAUDE_URI, 'myapp://callback'])).toBe(false);
    expect(
      areRedirectUrisAllowed([
        'http://127.0.0.1:6274/oauth/callback',
        'http://evil.example:6274/oauth/callback',
      ]),
    ).toBe(false);
  });

  it('redirectUriMatches: exact match', () => {
    expect(redirectUriMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
  });

  it('redirectUriMatches: same-origin loopback with different path (Inspector /oauth/callback vs /debug)', () => {
    // registered = /oauth/callback (DCR stored first), authorize with /oauth/callback/debug
    expect(redirectUriMatches('http://localhost:6274/oauth/callback/debug', 'http://localhost:6274/oauth/callback')).toBe(true);
    expect(redirectUriMatches('http://127.0.0.1:6274/oauth/callback', 'http://127.0.0.1:6274/oauth/callback/debug')).toBe(true);
  });

  it('redirectUriMatches: rejects different loopback PORT', () => {
    expect(redirectUriMatches('http://localhost:9999/oauth/callback', 'http://localhost:6274/oauth/callback')).toBe(false);
  });

  it('redirectUriMatches: rejects cross-origin and non-loopback', () => {
    expect(redirectUriMatches('https://evil.example/cb', 'https://claude.ai/api/mcp/auth_callback')).toBe(false);
    expect(redirectUriMatches('http://evil.example:6274/x', 'http://localhost:6274/oauth/callback')).toBe(false);
    expect(redirectUriMatches(null, 'http://localhost:6274/oauth/callback')).toBe(false);
  });

  it('accepts the MCP Inspector two-URI loopback set (/oauth/callback + /oauth/callback/debug)', () => {
    expect(
      areRedirectUrisAllowed([
        'http://localhost:6274/oauth/callback',
        'http://localhost:6274/oauth/callback/debug',
      ]),
    ).toBe(true);
  });

  it('rejects an empty redirect-URI list', () => {
    expect(areRedirectUrisAllowed([])).toBe(false);
  });
});

describe('isLoopbackRedirectUri', () => {
  it('returns true for loopback hosts with any port', () => {
    expect(isLoopbackRedirectUri('http://127.0.0.1:6274/oauth/callback')).toBe(true);
    expect(isLoopbackRedirectUri('http://127.0.0.1:54321/oauth/callback')).toBe(true);
    expect(isLoopbackRedirectUri('http://localhost:8080/oauth/callback')).toBe(true);
    expect(isLoopbackRedirectUri('http://[::1]:9999/oauth/callback')).toBe(true);
  });

  it('returns true for loopback hosts with ANY path (RFC 8252 pins host, not path)', () => {
    // MCP Inspector registers both /oauth/callback and /oauth/callback/debug;
    // every entry must pass, so the extra path must be accepted. Security is
    // PKCE + loopback host, not the path.
    expect(isLoopbackRedirectUri('http://localhost:6274/oauth/callback/debug')).toBe(true);
    expect(isLoopbackRedirectUri('http://127.0.0.1:6274/callback')).toBe(true);
    expect(isLoopbackRedirectUri('http://127.0.0.1:6274/')).toBe(true);
  });

  it('returns false for https on loopback', () => {
    expect(isLoopbackRedirectUri('https://127.0.0.1/oauth/callback')).toBe(false);
  });

  it('returns false for non-loopback hosts', () => {
    expect(isLoopbackRedirectUri('http://evil.example:6274/oauth/callback')).toBe(false);
  });

  it('returns false for malformed URIs', () => {
    expect(isLoopbackRedirectUri('not-a-url')).toBe(false);
    expect(isLoopbackRedirectUri('')).toBe(false);
  });
});

describe('resolveGrantedScopes — RFC 6749 §3.3 default scope', () => {
  // Derive fixtures from the live vocabulary so these stay correct as the
  // MCP scope ceiling changes; hardcoded literals would silently rot.
  const [scopeA, scopeB] = MCP_SCOPES;
  const UNSUPPORTED = 'totally:not-a-real-scope';

  it('has at least two MCP scopes to exercise (fixture sanity)', () => {
    expect(MCP_SCOPES.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to the registered set when `scope` is ABSENT (the bug)', () => {
    // Regression: an omitted `scope` used to yield [] → error=invalid_scope,
    // dead-ending any MCP client that relies on the AS default.
    expect(resolveGrantedScopes(null, [scopeA, scopeB])).toEqual([scopeA, scopeB]);
    expect(resolveGrantedScopes(undefined, [scopeA])).toEqual([scopeA]);
  });

  it('falls back to the registered set when `scope` is empty or whitespace', () => {
    expect(resolveGrantedScopes('', [scopeA])).toEqual([scopeA]);
    expect(resolveGrantedScopes('   ', [scopeA])).toEqual([scopeA]);
    expect(resolveGrantedScopes('\t\n', [scopeA])).toEqual([scopeA]);
  });

  it('intersects an EXPLICIT scope with the registered set', () => {
    expect(resolveGrantedScopes(scopeA, [scopeA, scopeB])).toEqual([scopeA]);
    expect(resolveGrantedScopes(`${scopeA} ${scopeB}`, [scopeA, scopeB])).toEqual([scopeA, scopeB]);
  });

  it('never lets an explicit scope widen beyond what the client registered', () => {
    // Client registered only scopeA but asks for scopeB too → scopeB dropped.
    expect(resolveGrantedScopes(`${scopeA} ${scopeB}`, [scopeA])).toEqual([scopeA]);
  });

  it('applies the MCP ceiling to the fallback, so a stale registry row cannot widen', () => {
    // A registry row holding a scope no longer in the MCP vocabulary must not
    // leak through the absent-scope fallback.
    expect(resolveGrantedScopes(null, [scopeA, UNSUPPORTED])).toEqual([scopeA]);
  });

  it('applies the MCP ceiling to an explicit scope too', () => {
    expect(resolveGrantedScopes(UNSUPPORTED, [scopeA, UNSUPPORTED])).toEqual([]);
  });

  it('returns [] when the client has no registered scopes (invalid_scope preserved)', () => {
    expect(resolveGrantedScopes(null, [])).toEqual([]);
    expect(resolveGrantedScopes(null, null)).toEqual([]);
    expect(resolveGrantedScopes(null, undefined)).toEqual([]);
  });

  it('returns [] when an explicit scope shares nothing with the registered set', () => {
    expect(resolveGrantedScopes(scopeB, [scopeA])).toEqual([]);
  });

  it('tolerates irregular whitespace between explicit scopes', () => {
    expect(resolveGrantedScopes(`  ${scopeA}   ${scopeB}  `, [scopeA, scopeB])).toEqual([scopeA, scopeB]);
  });
});

describe('resolveRefreshScopes — re-resolution on refresh (#1630)', () => {
  const [scopeA, scopeB] = MCP_SCOPES;
  const UNSUPPORTED = 'totally:not-a-real-scope';

  it('returns the client\u2019s current registration ∩ the MCP ceiling', () => {
    expect(resolveRefreshScopes([scopeA, scopeB])).toEqual([scopeA, scopeB]);
    expect(resolveRefreshScopes([scopeA])).toEqual([scopeA]);
  });

  it('picks up a scope added to the registration after authorization (the bug)', () => {
    // The refresh lineage used to carry the original scope string forever, so a
    // scope toggled on later never reached the JWT.
    expect(resolveRefreshScopes([scopeA, scopeB])).toContain(scopeB);
  });

  it('drops a scope removed from the registration', () => {
    expect(resolveRefreshScopes([scopeA])).not.toContain(scopeB);
  });

  it('applies the MCP ceiling, so a stale registry row cannot widen', () => {
    expect(resolveRefreshScopes([scopeA, UNSUPPORTED])).toEqual([scopeA]);
    expect(resolveRefreshScopes([UNSUPPORTED])).toEqual([]);
  });

  it('de-duplicates repeated registry entries', () => {
    expect(resolveRefreshScopes([scopeA, scopeA, scopeB])).toEqual([scopeA, scopeB]);
  });

  it('returns [] for an empty / absent registration (callers must fail closed)', () => {
    expect(resolveRefreshScopes([])).toEqual([]);
    expect(resolveRefreshScopes(null)).toEqual([]);
    expect(resolveRefreshScopes(undefined)).toEqual([]);
  });
});

describe('lazy env getters (#1336)', () => {
  const originalUrl = process.env.MCP_PUBLIC_URL;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.MCP_PUBLIC_URL;
    else process.env.MCP_PUBLIC_URL = originalUrl;
  });

  it('getMcpIssuer reflects env at call time, not module-eval time', () => {
    delete process.env.MCP_PUBLIC_URL;
    expect(getMcpIssuer()).toBe('https://mcp.imajin.ai');
    process.env.MCP_PUBLIC_URL = 'https://custom.example.com';
    expect(getMcpIssuer()).toBe('https://custom.example.com');
  });

  it('getMcpResource reflects env at call time', () => {
    process.env.MCP_PUBLIC_URL = 'https://custom.example.com';
    expect(getMcpResource()).toBe('https://custom.example.com/mcp');
  });

  it('token aud and validator both call getter → always equal (#1336)', () => {
    // Simulates the bug: token minted with one value, validator checked against
    // a stale module-eval const. With getters both read env at call time.
    process.env.MCP_PUBLIC_URL = 'https://dynamic.example.com';
    const audAtMint = getMcpResource();
    const audAtValidate = getMcpResource();
    expect(audAtMint).toBe(audAtValidate);
    expect(audAtMint).toBe('https://dynamic.example.com/mcp');
  });

  it('endpoint getters also reflect env at call time', () => {
    process.env.MCP_PUBLIC_URL = 'https://ep.example.com';
    expect(getAuthorizationEndpoint()).toBe('https://ep.example.com/oauth/authorize');
    expect(getTokenEndpoint()).toBe('https://ep.example.com/oauth/token');
    expect(getRegistrationEndpoint()).toBe('https://ep.example.com/oauth/register');
    expect(getProtectedResourceMetadataUrl()).toBe('https://ep.example.com/.well-known/oauth-protected-resource');
  });
});

/**
 * RFC 9207 issuer identification (#1474) — added to the MCP authorization
 * standards list by the 2026-07-28 revision. Without `iss`, a client talking to
 * more than one authorization server cannot attribute a `code`/`state` pair to
 * the AS that produced it, which is the mechanic behind an OAuth mix-up attack.
 */
describe('RFC 9207 issuer identification', () => {
  const originalUrl = process.env.MCP_PUBLIC_URL;

  afterEach(() => {
    if (originalUrl === undefined) delete process.env.MCP_PUBLIC_URL;
    else process.env.MCP_PUBLIC_URL = originalUrl;
  });

  it('advertises support so clients may require `iss` from us', () => {
    expect(ISSUER_IDENTIFICATION_SUPPORTED).toBe(true);
  });

  it('stamps the issuer onto an authorization response URL', () => {
    delete process.env.MCP_PUBLIC_URL;
    const url = withIssuerIdentification(new URL('https://claude.ai/api/mcp/auth_callback'));
    expect(url.searchParams.get('iss')).toBe('https://mcp.imajin.ai');
  });

  it('reads the issuer at call time, not module-eval time', () => {
    process.env.MCP_PUBLIC_URL = 'https://iss.example.com';
    const url = withIssuerIdentification(new URL('http://localhost:6274/oauth/callback'));
    expect(url.searchParams.get('iss')).toBe('https://iss.example.com');
  });

  it('leaves the rest of the redirect untouched', () => {
    const url = withIssuerIdentification(
      new URL('http://localhost:6274/oauth/callback?state=abc&error=invalid_scope'),
    );
    expect(url.searchParams.get('state')).toBe('abc');
    expect(url.searchParams.get('error')).toBe('invalid_scope');
    expect(url.origin).toBe('http://localhost:6274');
    expect(url.pathname).toBe('/oauth/callback');
  });

  it('is idempotent — a second pass does not duplicate the parameter', () => {
    const url = withIssuerIdentification(
      withIssuerIdentification(new URL('https://claude.ai/api/mcp/auth_callback')),
    );
    expect(url.searchParams.getAll('iss')).toHaveLength(1);
  });
});
