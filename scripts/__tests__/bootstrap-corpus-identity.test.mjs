import { describe, it, expect, vi, afterEach } from 'vitest';

// Imported in-process (not spawned as a `tsx` subprocess like
// check-env.test.mjs): vitest's own `@imajin/auth` resolve.alias
// (vitest.config.ts) points the dynamic `import('@imajin/auth')` inside
// main() at packages/auth/src/index.ts directly, so this test exercises the
// real ESM-resolution code path (#1711) without depending on
// packages/auth/dist/ having been built first — the CI "test" job runs
// before the "build" job and never builds workspace packages.
const SCRIPT = '../bootstrap-corpus-identity.ts';

describe('bootstrap-corpus-identity.ts', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('dynamically imports generateKeypair/createDID from @imajin/auth and prints a corpus DID + private key', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mod = await import(SCRIPT);
    await mod.__mainPromise;

    const output = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    logSpy.mockRestore();

    expect(output).toContain('Corpus Service Identity Bootstrap (#1751)');

    // createDID's output shape: did:imajin:<16 hex chars>
    const didMatch = /Generated corpus DID: (did:imajin:[0-9a-f]{16})/.exec(output);
    expect(didMatch).not.toBeNull();
    const did = didMatch[1];

    expect(output).toContain(`CORPUS_DID=${did}`);
    // generateKeypair's privateKey is a 64-char hex string.
    expect(output).toMatch(/CORPUS_DID_PRIVATE_KEY=[0-9a-f]{64}/);
  });

  it('mints a fresh, non-idempotent DID/keypair on every run', async () => {
    const extractDid = (output) => /Generated corpus DID: (did:imajin:[0-9a-f]{16})/.exec(output)[1];

    const runOnce = async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.resetModules();
      const mod = await import(SCRIPT);
      await mod.__mainPromise;
      const output = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
      logSpy.mockRestore();
      return extractDid(output);
    };

    const first = await runOnce();
    const second = await runOnce();
    expect(first).not.toBe(second);
  });
});
