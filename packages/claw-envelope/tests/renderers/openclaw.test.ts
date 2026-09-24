import { describe, expect, it } from 'vitest';
import { generateEnvelope } from '../../src/generate.js';
import { renderOpenClaw } from '../../src/renderers/openclaw.js';
import type { ContextEnvelopeInput } from '../../src/types.js';

const input: ContextEnvelopeInput = {
  agentDid: 'did:imajin:agent-openclaw-poc',
  ownerDid: 'did:imajin:owner-ryan',
  handle: 'OpenClaw POC',
  intent: {
    scopes: ['messages:read', 'messages:write'],
    busRoutes: [{ eventType: 'chat.message.received', description: 'Inbound DM dispatch.' }],
    brain: { placement: 'hosted', provider: 'anthropic:claude' },
    purpose: 'First OpenClaw instance inside an Imajin context.',
  },
};

describe('renderOpenClaw', () => {
  const envelope = generateEnvelope(input);
  const tree = renderOpenClaw(envelope);

  it('renders exactly the expected file list (snapshot of the output tree shape)', () => {
    expect(tree.harness).toBe('openclaw');
    expect(tree.files.map((f) => f.relativePath)).toEqual([
      'envelope/SOUL.md',
      'envelope/AGENTS.md',
      'envelope/MEMORY.md',
      'openclaw/AGENTS.md',
      'openclaw/SOUL.md',
      'openclaw/MEMORY.md',
      'openclaw/USER.md',
      'openclaw/memory/README.md',
      'openclaw/memory/context/README.md',
      'openclaw/openclaw.json',
      'openclaw/SETUP.md',
    ]);
  });

  it('maps the envelope workspace files onto openclaw/*.md unmodified — no persona-squash step needed', () => {
    const soul = tree.files.find((f) => f.relativePath === 'openclaw/SOUL.md');
    const agents = tree.files.find((f) => f.relativePath === 'openclaw/AGENTS.md');
    const memory = tree.files.find((f) => f.relativePath === 'openclaw/MEMORY.md');
    expect(soul?.content).toBe(envelope.workspace['SOUL.md']);
    expect(agents?.content).toBe(envelope.workspace['AGENTS.md']);
    expect(memory?.content).toBe(envelope.workspace['MEMORY.md']);
  });

  it('renders USER.md with the real principal DID and grants, not placeholders', () => {
    const userMd = tree.files.find((f) => f.relativePath === 'openclaw/USER.md');
    expect(userMd?.content).toContain(input.ownerDid);
    expect(userMd?.content).toContain(input.agentDid);
    expect(userMd?.content).toContain('messages:read');
    expect(userMd?.content).toContain('messages:write');
    expect(userMd?.content).toContain('chat.message.received');
  });

  it('renders a valid openclaw.json with the imajin plugin configured against the agent DID + kernel URL, no static keys', () => {
    const openclawJson = tree.files.find((f) => f.relativePath === 'openclaw/openclaw.json');
    const parsed = JSON.parse(openclawJson!.content) as {
      plugins: { entries: { imajin: { enabled: boolean; config: { nodeUrl: string; did: string; keypairPath: string } } } };
    };
    const config = parsed.plugins.entries.imajin.config;
    expect(parsed.plugins.entries.imajin.enabled).toBe(true);
    expect(config.did).toBe(input.agentDid);
    expect(config.nodeUrl).toBe('https://jin.imajin.ai');
    // keypairPath is a placeholder path, never a raw key or an API-key-shaped string (NOT-PAT).
    expect(config.keypairPath).toMatch(/^\/path\/to\/.*\.json$/);
    expect(JSON.stringify(parsed)).not.toMatch(/sk-[A-Za-z0-9]{10,}/);
  });

  it('honors a custom kernelBaseUrl option', () => {
    const customTree = renderOpenClaw(envelope, { kernelBaseUrl: 'https://custom.example' });
    const openclawJson = customTree.files.find((f) => f.relativePath === 'openclaw/openclaw.json');
    const parsed = JSON.parse(openclawJson!.content) as { plugins: { entries: { imajin: { config: { nodeUrl: string } } } } };
    expect(parsed.plugins.entries.imajin.config.nodeUrl).toBe('https://custom.example');
  });

  it('renders the memory/context/ position stub when no operator context bundle is supplied', () => {
    const contextReadme = tree.files.find((f) => f.relativePath === 'openclaw/memory/context/README.md');
    expect(contextReadme?.content).toContain('position stub');
  });

  it('merges an operator-supplied context bundle under memory/context/ without changing the envelope schema', () => {
    const bundleTree = renderOpenClaw(envelope, { contextBundle: { 'project-notes.md': 'Some real operator context.' } });
    const bundled = bundleTree.files.find((f) => f.relativePath === 'openclaw/memory/context/project-notes.md');
    expect(bundled?.content).toBe('Some real operator context.');
    const contextReadme = bundleTree.files.find((f) => f.relativePath === 'openclaw/memory/context/README.md');
    expect(contextReadme?.content).not.toContain('Empty at first boot');
  });

  it('documents the plugin-install step as manual rather than scripting an OpenClaw install blind', () => {
    expect(tree.manualSteps.some((s) => s.toLowerCase().includes('openclaw-imajin-plugin'))).toBe(true);
    expect(tree.manualSteps.some((s) => s.includes('keypairPath'))).toBe(true);
  });

  it("documents that model provider selection is left to the operator, unlike NanoClaw's kernel-passthrough shim", () => {
    expect(tree.manualSteps.some((s) => s.toLowerCase().includes('model provider'))).toBe(true);
  });

  it("surfaces a brain deviation note in manualSteps when brain.via is 'direct'", () => {
    const directInput: ContextEnvelopeInput = {
      ...input,
      intent: {
        ...input.intent,
        brain: { placement: 'hosted', provider: 'anthropic:claude', via: 'direct', deviation: 'operator-run local model' },
      },
    };
    const directEnvelope = generateEnvelope(directInput);
    const directTree = renderOpenClaw(directEnvelope);
    expect(directTree.manualSteps.some((s) => s.includes('operator-run local model'))).toBe(true);
  });
});
