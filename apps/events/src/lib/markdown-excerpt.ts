export interface MarkdownSpanMatch {
  /** Text to keep in the output in place of the matched span (empty for images). */
  text: string;
  /** Index to resume scanning from after the matched span. */
  nextIndex: number;
}

/** Matches image syntax at position `i`: `![alt](url)` => drop entirely. */
export function matchMarkdownImage(input: string, i: number): MarkdownSpanMatch | null {
  if (input[i] !== '!' || input[i + 1] !== '[') return null;
  const closeBracket = input.indexOf(']', i + 2);
  if (closeBracket < 0 || input[closeBracket + 1] !== '(') return null;
  const closeParen = input.indexOf(')', closeBracket + 2);
  if (closeParen < 0) return null;
  return { text: '', nextIndex: closeParen + 1 };
}

/** Matches link syntax at position `i`: `[label](url)` => keep the label. */
export function matchMarkdownLink(input: string, i: number): MarkdownSpanMatch | null {
  if (input[i] !== '[') return null;
  const closeBracket = input.indexOf(']', i + 1);
  if (closeBracket < 0 || input[closeBracket + 1] !== '(') return null;
  const closeParen = input.indexOf(')', closeBracket + 2);
  if (closeParen < 0) return null;
  return { text: input.slice(i + 1, closeBracket), nextIndex: closeParen + 1 };
}

/** Strips markdown link/image syntax, keeping link labels but dropping images entirely. */
export function stripMarkdownLinksAndImages(input: string): string {
  let out = '';
  let i = 0;

  while (i < input.length) {
    const imageMatch = matchMarkdownImage(input, i);
    if (imageMatch) {
      i = imageMatch.nextIndex;
      continue;
    }

    const linkMatch = matchMarkdownLink(input, i);
    if (linkMatch) {
      out += linkMatch.text;
      i = linkMatch.nextIndex;
      continue;
    }

    out += input[i];
    i += 1;
  }

  return out;
}

/** Strip markdown syntax to get clean plaintext for excerpts. */
export function stripMarkdown(text: string): string {
  const withoutLinksAndImages = stripMarkdownLinksAndImages(text);
  let out = withoutLinksAndImages;
  for (const marker of ['*', '_', '~', '`', '#', '>']) out = out.split(marker).join('');
  return out
    .replaceAll('\r\n', '\n')
    .replace(/\n{2,}/g, ' · ')
    .replaceAll('\n', ' ')
    .replaceAll('\t', ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}
