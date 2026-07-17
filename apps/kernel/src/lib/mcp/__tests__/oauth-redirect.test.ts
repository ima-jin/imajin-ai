// Regression for #1185: the login `next=` param must carry the PUBLIC issuer
// origin with NO stale internal port. Behind Caddy, request.url is
// http://localhost:3000|7000; anchoring must drop that port cleanly.
import { describe, expect, it } from 'vitest';
import { anchorToOrigin } from '../oauth-redirect.js';

const ISSUER = 'https://mcp.imajin.ai';

describe('anchorToOrigin (#1185 stale-port fix)', () => {
  it('drops the internal :3000 port and uses the issuer host', () => {
    const internal =
      'http://localhost:3000/oauth/authorize?response_type=code&client_id=abc&scope=github%3Aread';
    const out = anchorToOrigin(internal, ISSUER);
    expect(out.startsWith('https://mcp.imajin.ai/oauth/authorize')).toBe(true);
    expect(out).not.toContain(':3000');
    expect(out).not.toContain('localhost');
  });

  it('drops the internal :7000 (prod) port too', () => {
    const out = anchorToOrigin('http://localhost:7000/oauth/authorize?x=1', ISSUER);
    expect(out).not.toContain(':7000');
    expect(out.startsWith('https://mcp.imajin.ai/oauth/authorize')).toBe(true);
  });

  it('preserves path and query exactly', () => {
    const out = anchorToOrigin(
      'http://localhost:3000/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A6274%2Foauth%2Fcallback',
      ISSUER,
    );
    // the client's OWN localhost:6274 callback (in the query) must survive untouched
    expect(out).toContain('redirect_uri=http%3A%2F%2Flocalhost%3A6274%2Foauth%2Fcallback');
    expect(out).toContain('response_type=code');
  });

  it('is idempotent when the input already has the public origin', () => {
    const already = 'https://mcp.imajin.ai/oauth/authorize?x=1';
    expect(anchorToOrigin(already, ISSUER)).toBe(already);
  });
});
