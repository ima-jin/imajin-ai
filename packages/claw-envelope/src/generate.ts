/**
 * Pure envelope generator (imajin-ai#1758/#1932/#1933): `ContextEnvelopeInput`
 * in, harness-agnostic `ContextEnvelope` out. No filesystem access, no
 * network calls — a renderer (see `renderers/`) is what turns this into a
 * particular harness's on-disk layout.
 */
import { isKnownGrantScope, type GrantScope } from '@imajin/auth';
import type {
  ContextEnvelope,
  ContextEnvelopeInput,
  DelegationGrantRef,
  SecretRef,
} from './types';

const MCP_SERVER_URL = 'https://mcp.imajin.ai';

/**
 * Validate the requested scopes against the closed grant-capability registry
 * (`@imajin/auth`'s `GRANT_SCOPE_REGISTRY`) up front — a typo here should
 * fail loudly at generation time, not silently produce a grant request the
 * kernel will reject at bootstrap time.
 */
export function validateIntentScopes(scopes: readonly string[]): { valid: GrantScope[]; invalid: string[] } {
  const valid: GrantScope[] = [];
  const invalid: string[] = [];
  for (const scope of scopes) {
    if (isKnownGrantScope(scope)) valid.push(scope);
    else invalid.push(scope);
  }
  return { valid, invalid };
}

function soulMd(handle: string, purpose: string): string {
  return `# SOUL.md — ${handle}

${purpose}

This instance is a second first-class agent inside its owner's Imajin
context (imajin-ai#1932) — not a fork or a copy of any other agent. Its
identity, tools, grants, and attribution all live inside this context.
`;
}

function agentsMd(input: ContextEnvelopeInput): string {
  const scopeList = input.intent.scopes.map((s) => `- \`${s}\``).join('\n') || '- (none requested)';
  const routeList =
    input.intent.busRoutes.map((r) => `- \`${r.eventType}\` — ${r.description}`).join('\n') || '- (none)';
  return `# AGENTS.md — ${input.handle}

## Identity
- Agent DID: \`${input.agentDid}\`
- Owner DID: \`${input.ownerDid}\`

## Grants (minimal-by-default; expand deliberately)
${scopeList}

## Bus routes
${routeList}

## Brain
- Placement: \`${input.intent.brain.placement}\`
- Provider: \`${input.intent.brain.provider}\`
- Via: \`${input.intent.brain.via ?? 'kernel-passthrough'}\`
${input.intent.brain.via === 'direct' && input.intent.brain.deviation ? `- **Deviation**: ${input.intent.brain.deviation}\n` : ''}
## Tools
MCP tools are reached through \`${MCP_SERVER_URL}\` under the grants above.
Tool access is enforced kernel-side — this file is documentation, not policy.
`;
}

function memoryMd(handle: string): string {
  return `# MEMORY.md — ${handle}

(empty at first boot — this file is where continuity accumulates)
`;
}

/**
 * Generate a harness-agnostic `ContextEnvelope` from an input. Throws if any
 * requested scope is not in the closed grant-capability registry — callers
 * should call `validateIntentScopes` first if they want to report bad scopes
 * without an exception.
 */
export function generateEnvelope(input: ContextEnvelopeInput): ContextEnvelope {
  const { valid, invalid } = validateIntentScopes(input.intent.scopes);
  if (invalid.length > 0) {
    throw new Error(
      `Unknown grant capabilities requested (not in @imajin/auth's GRANT_SCOPE_REGISTRY): ${invalid.join(', ')}`,
    );
  }

  const delegationGrants: DelegationGrantRef[] = valid.map((capability) => ({
    capability,
    note: 'Issued via POST /auth/api/grants at bootstrap time — grantId is filled in after issuance.',
  }));

  const via = input.intent.brain.via ?? 'kernel-passthrough';

  const secrets: SecretRef[] = [
    { kind: 'env-var', name: 'NANOCLAW_AGENT_KEYPAIR_PATH', purpose: "Path to this agent's Ed25519 keypair file (never the key material itself)." },
  ];
  // 'kernel-passthrough' (the default) never puts a provider key on the
  // harness container at all — only 'direct' (an explicit, non-default
  // break-glass choice) does, and only then is it a deviation worth a secret
  // entry and a loud note.
  if (via === 'direct') {
    secrets.push({
      kind: 'env-var',
      name: 'DIRECT_BRAIN_API_KEY',
      purpose: input.intent.brain.deviation
        ? `Documented deviation: ${input.intent.brain.deviation}`
        : "brain.via: 'direct' break-glass — bypasses the kernel's sealed connector entirely.",
    });
  }

  return {
    agentDid: input.agentDid,
    ownerDid: input.ownerDid,
    handle: input.handle,
    workspace: {
      'SOUL.md': soulMd(input.handle, input.intent.purpose),
      'AGENTS.md': agentsMd(input),
      'MEMORY.md': memoryMd(input.handle),
    },
    config: {
      model: {
        placement: input.intent.brain.placement,
        provider: input.intent.brain.provider,
        via,
        deviation: input.intent.brain.deviation,
      },
      execPolicy: { allowWrite: false },
      mcp: { serverUrl: MCP_SERVER_URL, scopes: valid },
    },
    delegationGrants,
    secrets,
    busRoutes: input.intent.busRoutes,
  };
}
