import { describe, expect, it } from 'vitest';
import { loadMcpProxyConfig } from '../../src/mcp-proxy/config.js';

const validEnv = {
  KERNEL_BASE_URL: 'https://kernel.example.com',
  NANOCLAW_AGENT_DID: 'did:imajin:agent-poc',
  NANOCLAW_AGENT_KEYPAIR_PATH: '/secure/keypair.json',
  MCP_PROXY_ATTESTATION_ID: 'att-1',
} as unknown as NodeJS.ProcessEnv;

describe('loadMcpProxyConfig', () => {
  it('applies defaults for host/port/timeout/mcp server url', () => {
    const config = loadMcpProxyConfig(validEnv);
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8788);
    expect(config.mcpServerUrl).toBe('https://mcp.imajin.ai');
    expect(config.timeoutMs).toBe(20_000);
  });

  it('honors overrides', () => {
    const config = loadMcpProxyConfig({
      ...validEnv,
      MCP_PROXY_PORT: '9000',
      MCP_SERVER_URL: 'https://mcp.staging.example.com',
    } as unknown as NodeJS.ProcessEnv);
    expect(config.port).toBe(9000);
    expect(config.mcpServerUrl).toBe('https://mcp.staging.example.com');
  });

  it('throws when a required var is missing', () => {
    expect(() => loadMcpProxyConfig({} as NodeJS.ProcessEnv)).toThrow(/KERNEL_BASE_URL is required/);
  });

  it('throws on a non-numeric port override', () => {
    expect(() => loadMcpProxyConfig({ ...validEnv, MCP_PROXY_PORT: 'not-a-number' } as unknown as NodeJS.ProcessEnv)).toThrow(
      /must be a positive integer/,
    );
  });
});
