/**
 * MCP proxy config (imajin-ai#1932). Env vars only — no secrets in JSON
 * config files. `NANOCLAW_AGENT_KEYPAIR_PATH` points at a 0600 file, never
 * an inline key value.
 */
export interface McpProxyConfig {
  host: string;
  port: number;
  kernelBaseUrl: string;
  mcpServerUrl: string;
  agentDid: string;
  keypairPath: string;
  /**
   * The `app.authorized` attestation granting this agent's app DID the MCP
   * scope it needs (imajin-ai#1932 harvested checklist: owner consent step,
   * minted once, cannot be automated away).
   */
  attestationId: string;
  timeoutMs: number;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
const DEFAULT_TIMEOUT_MS = 20_000;

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required (see packages/nanoclaw-imajin-channel/README.md)`);
  }
  return value;
}

function parsePositiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

export function loadMcpProxyConfig(env: NodeJS.ProcessEnv = process.env): McpProxyConfig {
  return {
    host: env.MCP_PROXY_HOST || DEFAULT_HOST,
    port: parsePositiveInt(env, 'MCP_PROXY_PORT', DEFAULT_PORT),
    kernelBaseUrl: requireEnv(env, 'KERNEL_BASE_URL'),
    mcpServerUrl: env.MCP_SERVER_URL || 'https://mcp.imajin.ai',
    agentDid: requireEnv(env, 'NANOCLAW_AGENT_DID'),
    keypairPath: requireEnv(env, 'NANOCLAW_AGENT_KEYPAIR_PATH'),
    attestationId: requireEnv(env, 'MCP_PROXY_ATTESTATION_ID'),
    timeoutMs: parsePositiveInt(env, 'MCP_PROXY_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
  };
}
