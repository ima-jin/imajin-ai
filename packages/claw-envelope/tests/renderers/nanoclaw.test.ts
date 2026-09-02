import { describe, expect, it } from 'vitest';
import { generateEnvelope } from '../../src/generate.js';
import { groupFolderFor, renderNanoClaw } from '../../src/renderers/nanoclaw.js';
import type { ContextEnvelopeInput } from '../../src/types.js';

const input: ContextEnvelopeInput = {
  agentDid: 'did:imajin:agent-nanoclaw-poc',
  ownerDid: 'did:imajin:owner-ryan',
  handle: 'NanoClaw POC',
  intent: {
    scopes: ['messages:read', 'messages:write'],
    busRoutes: [{ eventType: 'chat.message.received', description: 'Inbound DM dispatch.' }],
    brain: { placement: 'hosted', provider: 'anthropic:claude', deviation: 'direct key POC' },
    purpose: 'First hand-built NanoClaw instance inside an Imajin context.',
  },
};

describe('groupFolderFor', () => {
  it('slugifies a handle into a directory-safe folder name', () => {
    expect(groupFolderFor('NanoClaw POC')).toBe('nanoclaw-poc');
    expect(groupFolderFor('  --weird--  ')).toBe('weird');
    expect(groupFolderFor('')).toBe('imajin-agent');
  });
});

describe('renderNanoClaw', () => {
  const envelope = generateEnvelope(input);
  const tree = renderNanoClaw(envelope, { mcpProxyPort: 8788 });

  it('renders exactly the expected file list (snapshot of the output tree shape)', () => {
    expect(tree.harness).toBe('nanoclaw');
    expect(tree.files.map((f) => f.relativePath)).toEqual([
      'envelope/SOUL.md',
      'envelope/AGENTS.md',
      'envelope/MEMORY.md',
      'nanoclaw/groups/nanoclaw-poc/instructions.prepend.md',
      'nanoclaw/groups/nanoclaw-poc/memory/README.md',
      'nanoclaw/groups/nanoclaw-poc/container.json',
      'nanoclaw/.env.example',
      'nanoclaw/APPLY.md',
    ]);
  });

  it('maps SOUL.md + AGENTS.md content onto instructions.prepend.md, NanoClaw\'s real persona surface', () => {
    const persona = tree.files.find((f) => f.relativePath.endsWith('instructions.prepend.md'));
    expect(persona?.content).toContain('First hand-built NanoClaw instance');
    expect(persona?.content).toContain(input.agentDid);
  });

  it('renders a valid container.json pointing MCP at the loopback proxy, never at mcp.imajin.ai directly', () => {
    const containerJson = tree.files.find((f) => f.relativePath.endsWith('container.json'));
    const parsed = JSON.parse(containerJson!.content) as {
      provider: string;
      assistantName: string;
      mcpServers: Record<string, { type: string; url: string }>;
    };
    expect(parsed.provider).toBe('claude');
    expect(parsed.assistantName).toBe('NanoClaw POC');
    expect(parsed.mcpServers.imajin.type).toBe('http');
    expect(parsed.mcpServers.imajin.url).toBe('http://127.0.0.1:8788/mcp');
    expect(parsed.mcpServers.imajin.url).not.toContain('mcp.imajin.ai');
  });

  it('never renders a raw secret value in .env.example — only variable names', () => {
    const envFile = tree.files.find((f) => f.relativePath.endsWith('.env.example'));
    const lines = envFile!.content.split('\n').filter((l) => l.includes('='));
    for (const line of lines) {
      const [, value] = line.split('=');
      expect(value ?? '').not.toMatch(/^[A-Za-z0-9+/]{20,}={0,2}$/); // not base64-secret-shaped
    }
    expect(envFile!.content).toContain('NANOCLAW_AGENT_KEYPAIR_PATH=');
    expect(envFile!.content).toContain('DIRECT_BRAIN_API_KEY=');
  });

  it('documents the channel-copy step as a manual/apply step rather than duplicating adapter source', () => {
    const applyDoc = tree.files.find((f) => f.relativePath === 'nanoclaw/APPLY.md');
    expect(applyDoc?.content).toContain('nanoclaw-imajin-channel');
    expect(applyDoc?.content).toContain("import './imajin-chat.js';");
    expect(tree.manualSteps.some((s) => s.toLowerCase().includes('channel'))).toBe(true);
  });

  it('surfaces the brain deviation as a manual step', () => {
    expect(tree.manualSteps.some((s) => s.includes('DIRECT_BRAIN_API_KEY'))).toBe(true);
  });
});
