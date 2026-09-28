/**
 * Local bootstrap-keystore file (#2411, restart-authentication ruling).
 *
 * On first boot, `loadAppSigningKey` mints an Ed25519 "bootstrap" keypair
 * and persists it here — NEVER the app's actual vault signing key, only
 * this narrow-purpose keypair whose only job is authenticating later
 * `POST /api/apps/signing-key/fetch` calls (see `../src/ed25519.ts` and
 * `load-app-signing-key.ts`). Every later boot reads it back instead of
 * spending a fresh operator-approved claim code.
 *
 * File mode `0600` (owner read/write only) — the private key never leaves
 * this file, never touches a log line, and is never sent anywhere except
 * as a signature (never the key bytes themselves) on each fetch request.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BootstrapKeypair } from './ed25519';

/** Default keystore path, relative to the process's own working directory. */
const DEFAULT_KEYSTORE_PATH = './.imajin/keystore.json';

/** Resolves the keystore path: explicit option, then `IMAJIN_APP_KEYSTORE`, then the default. */
export function resolveKeystorePath(explicit?: string): string {
  return explicit ?? process.env.IMAJIN_APP_KEYSTORE ?? DEFAULT_KEYSTORE_PATH;
}

interface KeystoreFileShape {
  bootstrapPublicKey?: unknown;
  bootstrapPrivateKey?: unknown;
}

/** Reads and parses the keystore file at `path`. Returns `null` when absent or malformed — never throws. */
export function readKeystore(path: string): BootstrapKeypair | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as KeystoreFileShape;
    if (typeof parsed.bootstrapPublicKey !== 'string' || typeof parsed.bootstrapPrivateKey !== 'string') {
      return null;
    }
    return { publicKey: parsed.bootstrapPublicKey, privateKey: parsed.bootstrapPrivateKey };
  } catch {
    return null;
  }
}

/** Writes `keypair` to `path` as `0600`, creating parent directories as needed. */
export function writeKeystore(path: string, keypair: BootstrapKeypair): void {
  const dir = dirname(path);
  if (dir && dir !== '.') {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const body = JSON.stringify({ bootstrapPublicKey: keypair.publicKey, bootstrapPrivateKey: keypair.privateKey }, null, 2);
  writeFileSync(path, body, { mode: 0o600 });
  // `mode` above only applies at file CREATION time — explicitly chmod so a
  // rebind (overwriting an existing keystore) is never left more permissive
  // than 0600.
  chmodSync(path, 0o600);
}
