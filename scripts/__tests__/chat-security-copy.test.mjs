import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

describe('current chat security documentation', () => {
  it.each([
    'SECURITY.md',
    'apps/kernel/public/llms-full.txt',
    'docs/mjn-whitepaper.md',
    'docs/canon/rfcs/RFC-06-identity-portability.md',
  ])('%s describes transport protection, storage, notifications and planned encryption', (path) => {
    const copy = read(path);

    expect(copy).toContain('TLS in transit');
    expect(copy).toContain('plaintext at rest on the hosting node');
    expect(copy).toContain('chat.messages_v2.content');
    expect(copy).toMatch(/push notifications carry the first 200 characters of the\s+message preview/i);
    expect(copy).toMatch(/planned(?: under[^\n]*)?[, ]+(?:but )?not implemented/i);
    expect(copy).not.toMatch(/end.to.end encrypted|key.epoch/i);
  });

  it('keeps the concise agent entry point to a single pointer to the full security disclosure', () => {
    const copy = read('apps/kernel/public/llms.txt');
    const security = copy.split(/\r?\n/).filter(line => line.includes('communication and security limits'));
    expect(security).toHaveLength(1);
    expect(security[0]).toContain('https://imajin.ai/llms-full.txt#communication-and-security-limits');
    expect(copy).not.toContain('plaintext at rest');
    expect(copy).not.toContain('first 200 characters');
  });

  it.each([
    'apps/kernel/api-spec/chat.yaml',
    'scripts/generate-api-specs.ts',
  ])('%s does not present key bundles as current message encryption', (path) => {
    const copy = read(path);

    expect(copy).toContain('public key bundles');
    expect(copy).toContain('key bundles do not provide current message encryption');
    expect(copy).not.toMatch(/e2ee key bundles?/i);
  });
});
