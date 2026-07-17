// DCR redirect-URI allowlist: Anthropic callbacks are always allowed; the MCP
// Inspector localhost callbacks are allowed ONLY when MCP_ALLOW_LOCAL_DCR=1.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DCR_ALLOWED_REDIRECT_URIS,
  DCR_LOCAL_DEV_REDIRECT_URIS,
  activeRedirectAllowlist,
  areRedirectUrisAllowed,
  isLocalDcrEnabled,
  getMcpIssuer,
  getMcpResource,
  getAuthorizationEndpoint,
  getTokenEndpoint,
  getRegistrationEndpoint,
  getProtectedResourceMetadataUrl,
} from '../oauth-config.js';

const CLAUDE_URI = 'https://claude.ai/api/mcp/auth_callback';
const INSPECTOR_URI = 'http://localhost:6274/oauth/callback';

describe('DCR redirect-URI allowlist', () => {
  const original = process.env.MCP_ALLOW_LOCAL_DCR;

  beforeEach(() => {
    delete process.env.MCP_ALLOW_LOCAL_DCR;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.MCP_ALLOW_LOCAL_DCR;
    else process.env.MCP_ALLOW_LOCAL_DCR = original;
  });

  it('allows the exact Anthropic callbacks by default', () => {
    for (const uri of DCR_ALLOWED_REDIRECT_URIS) {
      expect(areRedirectUrisAllowed([uri])).toBe(true);
    }
  });

  it('rejects the Inspector localhost callback when the flag is off', () => {
    expect(isLocalDcrEnabled()).toBe(false);
    expect(areRedirectUrisAllowed([INSPECTOR_URI])).toBe(false);
    expect(activeRedirectAllowlist()).toEqual(DCR_ALLOWED_REDIRECT_URIS);
  });

  it('allows the Inspector localhost callbacks when the flag is on', () => {
    process.env.MCP_ALLOW_LOCAL_DCR = '1';
    expect(isLocalDcrEnabled()).toBe(true);
    for (const uri of DCR_LOCAL_DEV_REDIRECT_URIS) {
      expect(areRedirectUrisAllowed([uri])).toBe(true);
    }
    expect(areRedirectUrisAllowed([CLAUDE_URI])).toBe(true);
  });

  it('still rejects an unknown redirect URI even with the flag on', () => {
    process.env.MCP_ALLOW_LOCAL_DCR = '1';
    expect(areRedirectUrisAllowed(['http://localhost:6274/evil'])).toBe(false);
    expect(areRedirectUrisAllowed(['https://attacker.example/cb'])).toBe(false);
  });

  it('rejects when any one of several URIs is not allowed', () => {
    process.env.MCP_ALLOW_LOCAL_DCR = '1';
    expect(areRedirectUrisAllowed([CLAUDE_URI, 'https://attacker.example/cb'])).toBe(false);
  });

  it('rejects an empty redirect-URI list', () => {
    expect(areRedirectUrisAllowed([])).toBe(false);
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
