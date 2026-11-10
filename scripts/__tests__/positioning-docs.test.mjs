import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const read = (file) => readFileSync(join(root, file), 'utf8');
const position = read('docs/POSITIONING.md');
const plain = position.replaceAll('**', '').replaceAll(/\s+/g, ' ');

describe('canonical positioning (#3366)', () => {
  it.each([
    ['category', 'Category: the trust layer for AI agents.'],
    ['one line', 'One line: identity and authority for AI agents.'],
    ['sub-line', 'Sub-line: your agents act as themselves, on your authority, and every action is signed.'],
    ['primary audience', "Who it's for: businesses putting AI agents in front of customers or staff, where the agent acts for a person: it pays, books, discloses data or signs."],
    ['secondary audience', 'Also: platforms and agencies running agents for many clients (multi-principal).'],
    ['problem', 'The problem: agent frameworks are good at doing things. None of them answer who did this, on whose authority, and who gets paid? Identity platforms (Okta and others) were built for people logging into apps, not for agents acting for people. Hosted assistants own the identity, the memory and the logs.'],
    ['agent identity', 'Agent identity. Every agent holds its own key and proves it, with no shared passwords or API tokens. Several identities can run on one runtime, each for its own principal. The agent never impersonates the person.'],
    ['delegated authority', 'Delegated authority. A person grants authority explicitly and can revoke it. Risky actions wait for a named human approver. The record shows both: the person authorised it, and the agent did it.'],
    ['signed record and settlement', "A signed record and settlement. Every action is a signed event that anyone can verify, including a third party's own agent. Cost and credit are recorded per identity, and .fair turns that into who gets paid."],
    ['how it fits', 'How it fits: a plugin for your agent runtime plus the Imajin kernel. It works with the framework you already run (OpenClaw today; the harness is swappable). The kernel only learns what an agent did through signed events: it never reaches into your runtime, holds session keys or reads transcripts. Hosted or self-run.'],
    ['identity comparison', 'Identity incumbents (built for people logging in).'],
    ['framework comparison', "Agent frameworks (they orchestrate; we're the accountability layer under them, and you use both)."],
    ['hosted comparison', "Hosted assistants (rented; you don't own the record)."],
    ['web3 comparison', 'Web3 agent projects (we start from working software; no token required).'],
    ['alpha calls to action', 'Alpha calls to action: book a demo, or join the alpha as a tester, integrator or partner. Joining the alpha is the sign-up path on this version of the site.'],
    ['off the front door', 'Hardware specs, the community apps, token talk. Sovereignty and the honest-record thesis live on /project as "why we built it this way".'],
    ['honesty', 'The site says alpha plainly. It claims only what works today, and nothing implies self-serve until #3364.'],
  ])('preserves the ruled %s', (_element, wording) => {
    expect(plain).toContain(wording);
  });

  it('keeps proof exactly as ruled, with only the anonymized partner names', () => {
    const proof = position.split('<summary>Proof</summary>')[1].split('</details>')[0];
    expect(proof.trim().replaceAll(/\s+/g, ' ')).toBe(
      '"Imajin on Imajin": our own operations agent works under its own identity every day, with signed events, approvals and cost recorded per identity. Plus Agentic Travel Co and Agricultural Supply Chain Co, anonymized until agreements are signed.',
    );
  });

  it('distinguishes alpha now from the CTA/proof-only 1.0-beta follow-on', () => {
    const phase = position.split('## Phase')[1].split('## Honesty rule')[0];
    expect(phase).toContain('[#3284](https://github.com/ima-jin/imajin-ai/issues/3284)');
    expect(phase).toContain('[#3364](https://github.com/ima-jin/imajin-ai/issues/3364)');
    expect(phase.replaceAll(/\s+/g, ' ')).toContain(
      'The 1.0-beta site follows ([#3364](https://github.com/ima-jin/imajin-ai/issues/3364)) and changes only the calls to action and the proof:',
    );
    expect(phase.replaceAll(/\s+/g, ' ')).toContain(
      'self-serve sign-up, "Verify a record", proof counters and developer quickstart belong to that follow-on, not the alpha front door.',
    );
  });

  it('makes this file the change-first source for every public surface', () => {
    expect(plain).toContain(
      'Every public surface copies from here: the site, app, docs, llms files, repos and sales material. Change it here first.',
    );
    expect(position).toContain('https://github.com/ima-jin/imajin-ai/issues/3284#issuecomment-6753880988');
    expect(position).toContain('This file is the canonical position.');
  });

  it('keeps a one-line historical pointer instead of the retired audit', () => {
    expect(read('docs/MESSAGING-AUDIT.md').trim()).toBe(
      'Historical audit retired; current guidance: [POSITIONING.md](POSITIONING.md).',
    );
  });

  it('has no repository links to the audit as current guidance', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
      .split('\0').filter((file) => /\.(?:md|mdx|txt|html)$/i.test(file));
    for (const file of files) {
      if (file === 'docs/MESSAGING-AUDIT.md') continue;
      expect(read(file), file).not.toMatch(/MESSAGING-AUDIT\.md/i);
    }
  });

  it('links positioning from the developer entry point and any docs index', () => {
    expect(read('docs/DEVELOPER.md')).toContain('[positioning](POSITIONING.md)');
    expect(read('docs/developer-guide.md')).toContain('[positioning](POSITIONING.md)');
    for (const file of ['docs/README.md', 'docs/index.md', 'docs/INDEX.md', 'docs/index.mdx']) {
      if (existsSync(join(root, file))) expect(read(file), file).toContain('](POSITIONING.md)');
    }
  });

  it.each([
    ['DIDs', /\bdid:[a-z]+:/i],
    ['IPv4 addresses', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
    ['IPv6 addresses', /\b[\da-f]{1,4}(?::[\da-f]{0,4}){2,7}\b|::1\b/i],
    ['ports', /:\d{2,5}\b/],
    ['deal details', /\b(?:contract value|deal value|deal size|revenue|ARR|MRR)\b|\$\d/i],
  ])('does not publish %s', (_kind, pattern) => {
    expect(position).not.toMatch(pattern);
  });

  it('is summary-first with the detailed positioning collapsed', () => {
    const summary = position.split('<details>')[0];
    expect(summary).toContain('**Category:**');
    expect(summary).toContain('**One line:**');
    expect(summary).toContain('**Sub-line:**');
    expect(summary).toContain('**Alpha calls to action:**');
    expect(position.match(/<details>/g)).toHaveLength(5);
    expect(position.match(/<\/details>/g)).toHaveLength(5);
  });
});
