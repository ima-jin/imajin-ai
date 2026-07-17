// DCR redirect-URI allowlist: Anthropic callbacks are always allowed; the MCP
// Inspector localhost callbacks are allowed ONLY when MCP_ALLOW_LOCAL_DCR=1.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DCR_ALLOWED_REDIRECT_URIS,
  DCR_LOCAL_DEV_REDIRECT_URIS,
  activeRedirectAllowlist,
  areRedirectUrisAllowed,
  isLocalDcrEnabled,
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
