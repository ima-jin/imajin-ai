// DCR redirect-URI allowlist: Anthropic callbacks are always allowed;
// loopback redirects (RFC 8252 §7.3) are allowed on any port with no flag.
import { afterEach, describe, expect, it } from 'vitest';
import {
  DCR_ALLOWED_REDIRECT_URIS,
  areRedirectUrisAllowed,
  isLoopbackRedirectUri,
  redirectUriMatches,
  getMcpIssuer,
  getMcpResource,
  getAuthorizationEndpoint,
  getTokenEndpoint,
  getRegistrationEndpoint,
  getProtectedResourceMetadataUrl,
} from '../oauth-config.js';

const CLAUDE_URI = 'https://claude.ai/api/mcp/auth_callback';

describe('DCR redirect-URI allowlist', () => {
  it('allows the exact Anthropic callbacks', () => {
    for (const uri of DCR_ALLOWED_REDIRECT_URIS) {
      expect(areRedirectUrisAllowed([uri])).toBe(true);
    }
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

  it('rejects https on loopback (RFC 8252 loopback is http-only)', () => {
    expect(areRedirectUrisAllowed(['https://127.0.0.1/oauth/callback'])).toBe(false);
    expect(areRedirectUrisAllowed(['https://localhost:6274/oauth/callback'])).toBe(false);
  });

  it('rejects non-loopback non-allowlisted URIs', () => {
    expect(areRedirectUrisAllowed(['http://evil.example:6274/oauth/callback'])).toBe(false);
    expect(areRedirectUrisAllowed(['https://attacker.example/cb'])).toBe(false);
  });

  it('rejects when any one of several URIs is not allowed', () => {
    expect(areRedirectUrisAllowed([CLAUDE_URI, 'https://attacker.example/cb'])).toBe(false);
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
