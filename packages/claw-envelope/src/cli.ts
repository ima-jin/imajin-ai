#!/usr/bin/env node
/**
 * `claw-envelope render --harness nanoclaw --agent-did <did> --owner-did <did> --handle <name> --out <dir>`
 *
 * Renders a context envelope for the given harness and writes it to `--out`.
 * Only `nanoclaw` is implemented; the harness registry is a plain map so a
 * future harness renderer is one entry, not a rewrite (imajin-ai#1758 Phase 6).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateEnvelope } from './generate';
import { renderNanoClaw } from './renderers/nanoclaw';
import type { ContextEnvelopeInput, RenderedTree } from './types';

type HarnessRenderer = (input: ContextEnvelopeInput) => RenderedTree;

const HARNESS_RENDERERS: Record<string, HarnessRenderer> = {
  nanoclaw: (input) => renderNanoClaw(generateEnvelope(input)),
};

interface ParsedArgs {
  harness: string;
  agentDid: string;
  ownerDid: string;
  handle: string;
  purpose: string;
  scopes: string[];
  out: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx === -1 ? undefined : argv[idx + 1];
  };
  const harness = get('--harness') ?? 'nanoclaw';
  const agentDid = get('--agent-did');
  const ownerDid = get('--owner-did');
  const handle = get('--handle');
  const out = get('--out');
  const purpose = get('--purpose') ?? 'First hand-built NanoClaw instance inside an Imajin context (imajin-ai#1932).';
  const scopesRaw = get('--scopes');
  const scopes = scopesRaw ? scopesRaw.split(',').map((s) => s.trim()).filter(Boolean) : ['messages:read', 'messages:write'];

  if (!agentDid) throw new Error('--agent-did is required');
  if (!ownerDid) throw new Error('--owner-did is required');
  if (!handle) throw new Error('--handle is required');
  if (!out) throw new Error('--out is required');

  return { harness, agentDid, ownerDid, handle, purpose, scopes, out };
}

export function render(args: ParsedArgs): RenderedTree {
  const renderer = HARNESS_RENDERERS[args.harness];
  if (!renderer) {
    throw new Error(`Unknown harness '${args.harness}'. Known harnesses: ${Object.keys(HARNESS_RENDERERS).join(', ')}`);
  }
  const input: ContextEnvelopeInput = {
    agentDid: args.agentDid,
    ownerDid: args.ownerDid,
    handle: args.handle,
    intent: {
      scopes: args.scopes,
      busRoutes: [{ eventType: 'chat.message.received', description: 'Inbound DM dispatch to the NanoClaw runtime.' }],
      brain: {
        placement: 'hosted',
        provider: 'anthropic:claude',
        via: 'kernel-passthrough',
      },
      purpose: args.purpose,
    },
  };
  return renderer(input);
}

export function writeTree(tree: RenderedTree, outDir: string): void {
  for (const file of tree.files) {
    const fullPath = join(outDir, file.relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, file.content, 'utf-8');
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const tree = render(args);
  writeTree(tree, args.out);
  console.log(`Rendered ${tree.files.length} file(s) for harness '${tree.harness}' into ${args.out}`);
  if (tree.manualSteps.length > 0) {
    console.log('\nManual steps still required:');
    for (const step of tree.manualSteps) {
      console.log(`  - ${step}`);
    }
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
