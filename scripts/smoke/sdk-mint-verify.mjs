#!/usr/bin/env node
/**
 * Mint + verify a DID-signed, scope-carrying message using only what
 * `@ima-jin/auth` exports (#1982's smoke-app acceptance check).
 *
 * ## Why this, not a real round trip against `dev`
 *
 * #1982 asks to "mint/verify a scoped token against dev". The kernel's real
 * app-token mint endpoint (`POST /auth/api/tokens/app`, see
 * `apps/kernel/app/auth/api/tokens/app/route.ts`) requires a real,
 * authenticated first-party session cookie — there is no anonymous or
 * service-account path to it by design, so an unattended CI job or agent
 * cannot obtain one without a new secret (which is out of scope here). What
 * *is* reachable, and genuinely proves the published package works
 * out-of-repo, is exercising `@ima-jin/auth`'s own sign/verify primitives —
 * the same DID-signing building block the kernel's session/app-token flow is
 * built on (`sign`/`verify`/`SignedMessage`, see `packages/auth/src/sign.ts`
 * and `verify.ts`) — end to end, from a real registry install.
 *
 * This module is dependency-injected on the auth module (rather than
 * hardcoding an import) so the same logic can be unit-tested against the
 * in-repo source (`scripts/smoke/__tests__/sdk-mint-verify.test.mjs`) and
 * exercised for real against a package installed from GitHub Packages (see
 * `scripts/smoke-test-sdk-install.sh`), with no duplication between the two.
 *
 * ## Usage
 *
 * `node scripts/smoke/sdk-mint-verify.mjs [package-specifier]`
 *
 * `package-specifier` defaults to `@ima-jin/auth` and is resolved via normal
 * Node module resolution from the current working directory — run this from
 * inside the scratch install directory `scripts/smoke-test-sdk-install.sh`
 * creates, where that specifier resolves to a real, registry-installed copy.
 */

const DEFAULT_SCOPES = ['profile:read'];

/**
 * Mints a signed, scope-carrying message (identity + payload + Ed25519
 * signature) using `authModule`'s own `generateKeypair`/`createDID`/`sign`,
 * then verifies it with `authModule.verify`. Throws if minting or
 * verification fails for any reason — a thrown error is the signal a caller
 * (CLI or test) should treat as smoke-test failure.
 *
 * @param {Pick<typeof import('@ima-jin/auth'), 'generateKeypair' | 'createDID' | 'sign' | 'verify'>} authModule
 * @param {{ scopes?: string[] }} [options]
 */
export async function mintAndVerifyScopedToken(authModule, options = {}) {
  const { generateKeypair, createDID, sign, verify } = authModule;
  const scopes = options.scopes ?? DEFAULT_SCOPES;

  const keypair = generateKeypair();
  const did = createDID(keypair.publicKey);
  const signed = await sign({ scopes }, keypair.privateKey, { id: did, type: 'agent' });
  const result = await verify(signed, keypair.publicKey);

  if (!result.valid) {
    throw new Error(`minted scoped message failed verification: ${result.error ?? 'unknown error'}`);
  }

  return { did, scopes, signed };
}

async function main() {
  const packageSpecifier = process.argv[2] ?? '@ima-jin/auth';
  const authModule = await import(packageSpecifier);
  const { did, scopes } = await mintAndVerifyScopedToken(authModule);
  console.log(`OK: minted + verified a [${scopes.join(', ')}]-scoped message for ${did} via ${packageSpecifier}`);
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  await main().catch((err) => {
    console.error(`FAIL: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
