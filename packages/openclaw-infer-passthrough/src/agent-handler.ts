import type { IncomingHttpHeaders } from 'node:http';
import { jsonError, toProxyResponse, type ProxyResponse } from './dispatch.js';
import { translateOpenAiParams } from './param-translation.js';
import {
  forwardAnthropicToKernel, forwardMcpToKernel, forwardModelsToKernel, forwardToKernel,
  type ForwardHeaders, type AnthropicPath,
} from './upstream.js';

const DID = /^did:[a-z0-9]+:[^\s]+$/;
const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface AgentCredential {
  token: string;
  actingAs?: string;
}

/** Shape checks only. Signature, audience, scopes and acting authority belong to the kernel. */
function isAgentJwt(token: string): boolean {
  if (!COMPACT_JWT.test(token)) return false;
  try {
    const [headerPart, claimsPart] = token.split('.');
    const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    const claims = JSON.parse(Buffer.from(claimsPart, 'base64url').toString('utf8'));
    return header?.typ === 'app+jwt' && header.alg === 'EdDSA' &&
      typeof claims?.azp === 'string' && DID.test(claims.azp) &&
      typeof claims.sub === 'string' && DID.test(claims.sub) &&
      typeof claims.exp === 'number' && Number.isFinite(claims.exp) && claims.exp > Date.now() / 1000;
  } catch {
    return false;
  }
}

/** Never reads a route principal or a configured host key. Authorization, if present, wins. */
export function readAgentCredential(headers: IncomingHttpHeaders, allowApiKey: boolean): AgentCredential | ProxyResponse {
  const authorization = headers.authorization;
  const token = authorization === undefined && allowApiKey
    ? headers['x-api-key']
    : typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7) : undefined;
  if (typeof token !== 'string' || !isAgentJwt(token)) {
    return jsonError(401, 'invalid_agent_credential', 'Missing or invalid calling agent credential: expected the agent’s own app+jwt');
  }
  const actingAs = headers['x-acting-as'];
  if (actingAs !== undefined && (typeof actingAs !== 'string' || !DID.test(actingAs))) {
    return jsonError(401, 'invalid_agent_credential', 'Invalid calling agent x-acting-as credential selector: expected a DID');
  }
  return { token, actingAs };
}

export type AgentEndpoint = 'completions' | 'models' | AnthropicPath | 'mcp';

export interface AgentRequest extends ForwardHeaders {
  endpoint: AgentEndpoint;
  credential: AgentCredential;
  bodyText: string;
  anthropicVersion?: string;
  anthropicBeta?: string;
  mcpProtocolVersion?: string;
  mcpSessionId?: string;
}

/** No mint, identity cache, token retry or direct-provider fallback on the agent lane. */
export async function handleAgentRequest(
  kernelBaseUrl: string, timeoutMs: number, req: AgentRequest,
): Promise<ProxyResponse> {
  const { token, actingAs } = req.credential;
  const headers = { ...req, actingAs };
  let response: Response;
  switch (req.endpoint) {
    case 'models':
      response = await forwardModelsToKernel(kernelBaseUrl, token, timeoutMs, actingAs);
      break;
    case 'completions': {
      let model: string | undefined;
      try {
        const parsed = JSON.parse(req.bodyText);
        if (typeof parsed?.model === 'string') model = parsed.model;
      } catch {
        // The kernel owns request validation, including invalid JSON.
      }
      response = await forwardToKernel(kernelBaseUrl, token, translateOpenAiParams(model, req.bodyText), timeoutMs, headers);
      break;
    }
    case 'mcp':
      response = await forwardMcpToKernel(kernelBaseUrl, token, req.bodyText, timeoutMs, headers);
      break;
    default:
      response = await forwardAnthropicToKernel(kernelBaseUrl, req.endpoint, token, req.bodyText, timeoutMs, headers);
  }
  if (response.status === 401) {
    await response.body?.cancel();
    return jsonError(401, 'invalid_agent_credential', 'Kernel rejected the calling agent credential; refresh the agent’s own app+jwt');
  }
  return toProxyResponse(response, req.endpoint === 'mcp' ? ['Mcp-Session-Id', 'Mcp-Protocol-Version'] : []);
}
