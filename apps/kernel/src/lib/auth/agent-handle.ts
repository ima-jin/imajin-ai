/** Client-safe handle rules shared by the create form and identity minting. */
const HANDLE_REGEX = /^[a-z0-9_-]+$/;

function suffixOnlyError(prefix: string): string {
  return `Enter only the optional suffix, not @${prefix}. Leave it blank for @${prefix}.`;
}

export function agentHandlePrefix(ownerHandle: string | null | undefined): string {
  return ownerHandle ? `${ownerHandle}-jin` : '';
}

export function agentHandleError(handle: unknown, ownerHandle?: string | null): string | null {
  if (!handle || typeof handle !== 'string') return 'handle is required';
  if (handle.length < 3 || handle.length > 64) return 'Handle must be 3-64 characters';
  if (!HANDLE_REGEX.test(handle)) return 'Handle must be lowercase letters, numbers, underscores, or hyphens';
  const prefix = agentHandlePrefix(ownerHandle);
  if (prefix && handle !== prefix && !(handle.startsWith(`${prefix}-`) && handle.length > prefix.length + 1)) {
    return `Handle must be @${prefix} or @${prefix}-<suffix> for the acting owner`;
  }
  if (prefix && handle.slice(prefix.length + 1).startsWith(prefix)) return suffixOnlyError(prefix);
  return null;
}

export function composeAgentHandle(ownerHandle: string | null | undefined, suffix: string): string {
  const prefix = agentHandlePrefix(ownerHandle);
  if (!prefix) return suffix;
  return suffix ? `${prefix}-${suffix}` : prefix;
}

export function agentSuffixError(ownerHandle: string | null | undefined, suffix: string): string | null {
  const prefix = agentHandlePrefix(ownerHandle);
  if (prefix && suffix.startsWith(prefix)) {
    return suffixOnlyError(prefix);
  }
  return agentHandleError(composeAgentHandle(ownerHandle, suffix), ownerHandle);
}
