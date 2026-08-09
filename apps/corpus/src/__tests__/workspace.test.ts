import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspacePath, validateSourcePath, workspaceRootForDid } from '../lib/workspace';

const did = 'did:example:alice';

describe('workspaceRootForDid', () => {
  it('derives a stable sha256-hashed workspace root under workspacesDir', () => {
    const workspacesDir = '/data/workspaces';
    const didHash = createHash('sha256').update(did).digest('hex');

    expect(workspaceRootForDid(did, { workspacesDir })).toBe(join(workspacesDir, didHash));
  });

  it('produces different roots for different DIDs', () => {
    const workspacesDir = '/data/workspaces';
    expect(workspaceRootForDid('did:example:alice', { workspacesDir })).not.toBe(
      workspaceRootForDid('did:example:bob', { workspacesDir }),
    );
  });
});

describe('resolveWorkspacePath', () => {
  let workspacesDir: string;

  beforeEach(() => {
    workspacesDir = mkdtempSync(join(tmpdir(), 'corpus-workspaces-'));
  });

  afterEach(() => {
    rmSync(workspacesDir, { recursive: true, force: true });
  });

  it('resolves "local:workspace" to the DID workspace root and creates it', () => {
    const resolved = resolveWorkspacePath(did, 'local:workspace', { workspacesDir });

    expect(resolved).toBe(workspaceRootForDid(did, { workspacesDir }));
  });

  it('resolves "local:workspace/docs" to a subdirectory of the workspace root', () => {
    const resolved = resolveWorkspacePath(did, 'local:workspace/docs', { workspacesDir });

    expect(resolved).toBe(join(workspaceRootForDid(did, { workspacesDir }), 'docs'));
  });

  it('resolves nested subdirectories', () => {
    const resolved = resolveWorkspacePath(did, 'local:workspace/docs/guides', { workspacesDir });

    expect(resolved).toBe(join(workspaceRootForDid(did, { workspacesDir }), 'docs', 'guides'));
  });

  it('scopes different DIDs to different workspace roots', () => {
    const aliceRoot = resolveWorkspacePath('did:example:alice', 'local:workspace', { workspacesDir });
    const bobRoot = resolveWorkspacePath('did:example:bob', 'local:workspace', { workspacesDir });

    expect(aliceRoot).not.toBe(bobRoot);
  });

  it('throws on a source string without a "local:workspace" prefix', () => {
    expect(() => resolveWorkspacePath(did, 'local:/etc/passwd', { workspacesDir })).toThrow(/Invalid workspace source/);
  });

  it('throws on path traversal via "../"', () => {
    expect(() => resolveWorkspacePath(did, 'local:workspace/../../etc', { workspacesDir })).toThrow(
      /outside the DID's workspace boundary/,
    );
  });

  it('throws on path traversal via "..\\\\"', () => {
    expect(() => resolveWorkspacePath(did, 'local:workspace/..\\..\\etc', { workspacesDir })).toThrow(
      /outside the DID's workspace boundary/,
    );
  });
});

describe('validateSourcePath', () => {
  let workspacesDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    workspacesDir = mkdtempSync(join(tmpdir(), 'corpus-workspaces-validate-'));
    workspaceRoot = join(workspacesDir, 'root');
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(workspacesDir, { recursive: true, force: true });
  });

  it('accepts the workspace root itself', () => {
    expect(() => validateSourcePath(workspaceRoot, workspaceRoot)).not.toThrow();
  });

  it('accepts a descendant of the workspace root', () => {
    expect(() => validateSourcePath(join(workspaceRoot, 'docs', 'guide.md'), workspaceRoot)).not.toThrow();
  });

  it('rejects an absolute path outside the workspace root', () => {
    expect(() => validateSourcePath('/etc/passwd', workspaceRoot)).toThrow(/outside the DID's workspace boundary/);
  });

  it('rejects a path that escapes the root via "../" traversal', () => {
    expect(() => validateSourcePath(join(workspaceRoot, '..', '..', 'etc', 'passwd'), workspaceRoot)).toThrow(
      /outside the DID's workspace boundary/,
    );
  });

  it('rejects a sibling directory that merely shares the root as a string prefix', () => {
    const sibling = `${workspaceRoot}-evil`;
    mkdirSync(sibling, { recursive: true });

    expect(() => validateSourcePath(sibling, workspaceRoot)).toThrow(/outside the DID's workspace boundary/);
  });

  it('rejects a symlink inside the workspace that points outside the boundary', () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'corpus-outside-'));
    const linkPath = join(workspaceRoot, 'escape-link');
    symlinkSync(outsideDir, linkPath);

    try {
      expect(() => validateSourcePath(linkPath, workspaceRoot)).toThrow(/outside the DID's workspace boundary/);
      expect(() => validateSourcePath(join(linkPath, 'secret.md'), workspaceRoot)).toThrow(
        /outside the DID's workspace boundary/,
      );
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('accepts a symlink inside the workspace that points to another location within the boundary', () => {
    const innerTarget = join(workspaceRoot, 'real-docs');
    mkdirSync(innerTarget, { recursive: true });
    const linkPath = join(workspaceRoot, 'docs-link');
    symlinkSync(innerTarget, linkPath);

    expect(() => validateSourcePath(linkPath, workspaceRoot)).not.toThrow();
  });
});
