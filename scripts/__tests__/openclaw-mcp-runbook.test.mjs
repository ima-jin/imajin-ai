import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MCP_SCOPE_SET } from '../../apps/kernel/src/lib/mcp/oauth-config';

const text = readFileSync(new URL('../../docs/ops/openclaw-mcp.md', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const blocks = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
describe('operator runbook acceptance contract', () => {
  it('keeps screenshot evidence in PR comments rather than documentation image embeds', () => {
    expect(text).toContain('see the screenshots in the PR #3235 comments');
    expect(text).not.toMatch(/!\[[^\]]*\]\([^)]*\.(?:png|jpe?g|gif|webp)/i);
  });
  it('provides only discovery-based OAuth transport configuration, never credentials or shared headers', () => {
    expect(blocks[0]).toEqual({ mcp: { servers: { imajin: {
      enabled: true, transport: 'streamable-http', url: 'https://mcp.imajin.ai/mcp',
    } } } });
    expect(text).toContain('PKCE S256');
    expect(text).toContain('separate OAuth registration');
    expect(text).toContain('Never let `main` and `artifact` share a token');
  });
  it('requests only actual MCP scopes and preserves direct identity and attestation flows', () => {
    expect(blocks[1].every(scope => MCP_SCOPE_SET.has(scope))).toBe(true);
    expect(blocks[1]).toEqual(expect.arrayContaining(['media:read', 'discovery:read', 'warp:dispatch', 'inference:write']));
    expect(text).toContain('`identity:read` is a platform scope');
    expect(text).toContain('`attestations:write` is not an MCP scope');
    expect(text).toContain('inbound-message listener');
  });
  it('documents both explicit consent profiles, revocation controls and the deferred operator window', () => {
    for (const required of ['Jin → Ryan', 'Artifact-Jin → Artifact', '#3237',
      'seven complete days', 'MCP_EXPECTED_DID', 'MCP_EXPECTED_PRINCIPAL', '/auth/agents', '/auth/connectors', '/jin']) {
      expect(text).toContain(required);
    }
    expect(text).toContain('Even one available principal is not selected automatically.');
    expect(text).toContain('ordinary membership cannot approve');
    expect(text).toContain('Assigned bots need no member-key grant');
    expect(text).toContain('wrong-account');
  });
});
