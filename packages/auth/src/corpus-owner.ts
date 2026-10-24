/** Source names are identifiers, never caller-selected DIDs or URLs. */
export function githubCorpusOwner(source: string): string | null {
  if (!source.startsWith('github:')) return null;
  const match = /^github:([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-z\d_.-]+)$/i.exec(source);
  if (!match || match[2] === '.' || match[2] === '..') throw new Error('Invalid GitHub corpus source');
  return match[1].toLowerCase();
}

/** Workspace belongs to its principal; GitHub belongs to its source group. */
export async function resolveCorpusDid(
  source: string,
  principalDid: string,
  resolveGroup: (owner: string) => Promise<string>,
): Promise<string> {
  if (!principalDid) throw new Error('principal DID is required');
  const owner = githubCorpusOwner(source);
  return owner === null ? principalDid : resolveGroup(owner);
}
