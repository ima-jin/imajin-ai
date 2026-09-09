import { describe, it, expect } from 'vitest';
import { stripTrailingSlashes } from '../src/url-utils.js';

/** The regex this package used before the S8786 fix — kept only to pin equivalence. */
function stripTrailingSlashesOld(value: string): string {
  return value.replace(/\/+$/, '');
}

// Every one of these is a real base URL shape passed into `stripTrailingSlashes`
// call sites in this package (kernelBaseUrl / route.directBaseUrl in
// token-provider.ts and upstream.ts), plus the trailing-slash edge cases those
// call sites are meant to normalize.
const REAL_INPUTS = [
  'https://kernel.test',
  'https://kernel.test/',
  'https://kernel.test//',
  'https://kernel.test///',
  'https://api.openai.com/v1',
  'https://api.openai.com/v1/',
  'https://api.anthropic.com',
  'https://api.anthropic.com/',
  'http://127.0.0.1:8787',
  'http://127.0.0.1:8787/',
  '',
  '/',
  '///',
  'no-scheme-host.example',
];

describe('stripTrailingSlashes', () => {
  it.each(REAL_INPUTS)('matches the old /\\/+$/ regex for %j', (input) => {
    expect(stripTrailingSlashes(input)).toBe(stripTrailingSlashesOld(input));
  });

  it('removes one or more trailing slashes', () => {
    expect(stripTrailingSlashes('https://kernel.test///')).toBe('https://kernel.test');
  });

  it('leaves a string with no trailing slash unchanged', () => {
    expect(stripTrailingSlashes('https://kernel.test')).toBe('https://kernel.test');
  });

  it('does not strip slashes that are not at the end of the string', () => {
    expect(stripTrailingSlashes('https://kernel.test/v1/chat')).toBe('https://kernel.test/v1/chat');
  });
});
