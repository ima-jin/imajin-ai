import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { forwardToMcp, type McpProxyDeps } from '../../src/mcp-proxy/server.js';
import type { TokenSource } from '../../src/mcp-proxy/token-provider.js';

function startUpstream(handler: (authHeader: string | undefined, res: Parameters<Parameters<typeof createServer>[0]>[1]) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => handler(req.headers.authorization, res));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

class StubTokenSource implements TokenSource {
  tokens: string[];
  invalidated = 0;
  private index = 0;

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  async getToken(): Promise<string> {
    return this.tokens[Math.min(this.index, this.tokens.length - 1)];
  }

  invalidate(): void {
    this.invalidated++;
    this.index++;
  }
}

describe('forwardToMcp', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) await new Promise((resolve) => server!.close(resolve));
    server = undefined;
  });

  it('forwards the request with a bearer token and proxies the response back', async () => {
    const { server: upstream, port } = await startUpstream((authHeader, res) => {
      expect(authHeader).toBe('Bearer jwt-1');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    server = upstream;

    const deps: McpProxyDeps = {
      config: {
        host: '127.0.0.1',
        port: 0,
        kernelBaseUrl: 'https://kernel.example.com',
        mcpServerUrl: `http://127.0.0.1:${port}`,
        agentDid: 'did:x',
        keypairPath: '/tmp/keypair.json',
        attestationId: 'att-1',
        timeoutMs: 5_000,
      },
      tokenProvider: new StubTokenSource(['jwt-1']),
    };

    const result = await forwardToMcp(deps, 'POST', '/mcp', { 'content-type': 'application/json' }, Buffer.from('{}'));
    expect(result.status).toBe(200);
    expect(JSON.parse(result.body.toString())).toEqual({ ok: true });
  });

  it('invalidates the token and retries once on a 401 from upstream', async () => {
    let callCount = 0;
    const { server: upstream, port } = await startUpstream((authHeader, res) => {
      callCount++;
      if (authHeader === 'Bearer jwt-stale') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'expired' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    server = upstream;

    const tokenSource = new StubTokenSource(['jwt-stale', 'jwt-fresh']);
    const deps: McpProxyDeps = {
      config: {
        host: '127.0.0.1',
        port: 0,
        kernelBaseUrl: 'https://kernel.example.com',
        mcpServerUrl: `http://127.0.0.1:${port}`,
        agentDid: 'did:x',
        keypairPath: '/tmp/keypair.json',
        attestationId: 'att-1',
        timeoutMs: 5_000,
      },
      tokenProvider: tokenSource,
    };

    const result = await forwardToMcp(deps, 'GET', '/mcp', {}, Buffer.alloc(0));
    expect(result.status).toBe(200);
    expect(callCount).toBe(2);
    expect(tokenSource.invalidated).toBe(1);
  });

  it('refuses to forward a path that resolves outside the configured MCP server origin (SSRF guard)', async () => {
    const deps: McpProxyDeps = {
      config: {
        host: '127.0.0.1',
        port: 0,
        kernelBaseUrl: 'https://kernel.example.com',
        mcpServerUrl: 'https://mcp.imajin.ai',
        agentDid: 'did:x',
        keypairPath: '/tmp/keypair.json',
        attestationId: 'att-1',
        timeoutMs: 5_000,
      },
      tokenProvider: new StubTokenSource(['jwt-1']),
    };

    await expect(
      forwardToMcp(deps, 'GET', 'https://evil.example.com/steal', {}, Buffer.alloc(0)),
    ).rejects.toThrow(/refusing to forward outside the configured MCP server origin/);
    await expect(forwardToMcp(deps, 'GET', '//evil.example.com/steal', {}, Buffer.alloc(0))).rejects.toThrow(
      /refusing to forward outside the configured MCP server origin/,
    );
  });
});
