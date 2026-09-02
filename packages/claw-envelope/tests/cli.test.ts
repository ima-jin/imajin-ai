import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs, render, writeTree } from '../src/cli.js';

describe('parseArgs', () => {
  it('requires agent-did, owner-did, handle, and out', () => {
    expect(() => parseArgs([])).toThrow(/--agent-did/);
    expect(() => parseArgs(['--agent-did', 'did:x'])).toThrow(/--owner-did/);
    expect(() => parseArgs(['--agent-did', 'did:x', '--owner-did', 'did:y'])).toThrow(/--handle/);
  });

  it('defaults harness to nanoclaw and scopes to messages read/write', () => {
    const args = parseArgs(['--agent-did', 'did:a', '--owner-did', 'did:o', '--handle', 'h', '--out', '/tmp/x']);
    expect(args.harness).toBe('nanoclaw');
    expect(args.scopes).toEqual(['messages:read', 'messages:write']);
  });

  it('parses a custom comma-separated scopes list', () => {
    const args = parseArgs([
      '--agent-did', 'did:a', '--owner-did', 'did:o', '--handle', 'h', '--out', '/tmp/x',
      '--scopes', 'messages:read, discovery:read',
    ]);
    expect(args.scopes).toEqual(['messages:read', 'discovery:read']);
  });
});

describe('render + writeTree', () => {
  let outDir: string;

  afterEach(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  it('renders and writes a full tree to disk for the nanoclaw harness', () => {
    outDir = mkdtempSync(join(tmpdir(), 'claw-envelope-'));
    const args = parseArgs(['--agent-did', 'did:imajin:a', '--owner-did', 'did:imajin:o', '--handle', 'poc', '--out', outDir]);
    const tree = render(args);
    writeTree(tree, outDir);

    const containerJsonPath = join(outDir, 'nanoclaw', 'groups', 'poc', 'container.json');
    const written = JSON.parse(readFileSync(containerJsonPath, 'utf-8')) as { provider: string };
    expect(written.provider).toBe('claude');
  });

  it('rejects an unknown harness', () => {
    const args = parseArgs(['--agent-did', 'did:a', '--owner-did', 'did:o', '--handle', 'h', '--out', '/tmp/x', '--harness', 'openclaw']);
    expect(() => render(args)).toThrow(/Unknown harness/);
  });
});
