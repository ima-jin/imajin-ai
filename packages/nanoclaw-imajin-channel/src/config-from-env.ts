/**
 * Env-based config loader shared by the channel adapter's registration glue
 * and the sidecars. Reads a keypair file whose PATH comes from env — never a
 * raw key value in an env var (imajin-ai#1932 quality bar: no secrets in
 * env-var VALUES that could leak via `docker inspect`/process listing;
 * secrets live in a 0600 file on disk instead).
 */
import { readFileSync } from 'node:fs';
import type { ImajinChatAdapterConfig } from './channel-adapter.js';

interface StoredKeypair {
  privateKey: string;
  publicKey: string;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required (see packages/nanoclaw-imajin-channel/README.md)`);
  }
  return value;
}

export function loadKeypair(path: string): StoredKeypair {
  const raw = readFileSync(path, 'utf-8');
  const parsed = JSON.parse(raw) as Partial<StoredKeypair>;
  if (!parsed.privateKey || !parsed.publicKey) {
    throw new Error(`Keypair file at ${path} is missing privateKey/publicKey`);
  }
  return { privateKey: parsed.privateKey, publicKey: parsed.publicKey };
}

/** Build the channel adapter's config from the standard env vars. */
export function adapterConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ImajinChatAdapterConfig {
  const kernelBaseUrl = requireEnv(env, 'KERNEL_BASE_URL');
  const agentDid = requireEnv(env, 'NANOCLAW_AGENT_DID');
  const keypairPath = requireEnv(env, 'NANOCLAW_AGENT_KEYPAIR_PATH');
  const { privateKey } = loadKeypair(keypairPath);
  return { kernelBaseUrl, agentDid, privateKeyHex: privateKey };
}
