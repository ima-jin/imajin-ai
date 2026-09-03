/**
 * Small regex-free URL helpers. Trailing-slash stripping and http(s)->ws(s)
 * swapping are simple enough to do with plain string operations — avoiding
 * regex here sidesteps static-analysis concerns about anchored quantifiers
 * on untrusted input, even though the inputs here are operator-configured
 * base URLs, not request data.
 */

/** Strip any number of trailing `/` characters. */
export function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.codePointAt(end - 1) === 47 /* '/' */) end -= 1;
  return url.slice(0, end);
}

/** Swap a `http`/`https` base URL for its `ws`/`wss` equivalent. */
export function toWebSocketUrl(baseUrl: string): string {
  const trimmed = stripTrailingSlashes(baseUrl);
  if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`;
  if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`;
  return trimmed;
}
