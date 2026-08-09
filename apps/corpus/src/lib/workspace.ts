import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export interface WorkspaceOptions {
  workspacesDir?: string;
}

const WORKSPACE_SOURCE_PATTERN = /^local:workspace(\/.*)?$/;
const WORKSPACE_BOUNDARY_ERROR = "Source path is outside the DID's workspace boundary";

export function isWorkspaceSource(source: string): boolean {
  return WORKSPACE_SOURCE_PATTERN.test(source);
}

export function workspaceRootForDid(did: string, options: WorkspaceOptions = {}): string {
  const workspacesDir = options.workspacesDir ?? join(process.cwd(), 'data', 'workspaces');
  const didHash = createHash('sha256').update(did).digest('hex');
  return join(workspacesDir, didHash);
}

/**
 * Resolve a "local:workspace" or "local:workspace/subdir" source
 * to an actual filesystem path, scoped to the DID's workspace.
 */
export function resolveWorkspacePath(did: string, source: string, options: WorkspaceOptions = {}): string {
  const workspaceRoot = workspaceRootForDid(did, options);
  const subPath = parseWorkspaceSubPath(source);
  const resolvedPath = subPath ? join(workspaceRoot, subPath) : workspaceRoot;

  validateSourcePath(resolvedPath, workspaceRoot);
  mkdirSync(resolvedPath, { recursive: true });

  return resolvedPath;
}

export function validateSourcePath(resolvedPath: string, workspaceRoot: string): void {
  const normalizedRoot = resolve(workspaceRoot);
  const normalizedPath = resolve(resolvedPath);

  if (!isWithinRoot(normalizedPath, normalizedRoot)) {
    throw new Error(WORKSPACE_BOUNDARY_ERROR);
  }

  validateRealPathBoundary(normalizedPath, normalizedRoot);
}

function parseWorkspaceSubPath(source: string): string {
  const match = WORKSPACE_SOURCE_PATTERN.exec(source);
  if (!match) {
    throw new Error(`Invalid workspace source "${source}". Expected "local:workspace" or "local:workspace/<subdir>".`);
  }

  const subPath = match[1]?.slice(1) ?? '';
  if (subPath.includes('..') || subPath.includes('\\')) {
    throw new Error(WORKSPACE_BOUNDARY_ERROR);
  }

  return subPath;
}

function validateRealPathBoundary(normalizedPath: string, normalizedRoot: string): void {
  let existingAncestor = normalizedPath;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      return;
    }
    existingAncestor = parent;
  }

  let realRoot: string;
  try {
    realRoot = realpathSync(normalizedRoot);
  } catch {
    return;
  }

  const realAncestor = realpathSync(existingAncestor);
  if (!isWithinRoot(realAncestor, realRoot)) {
    throw new Error(WORKSPACE_BOUNDARY_ERROR);
  }
}

function isWithinRoot(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}
