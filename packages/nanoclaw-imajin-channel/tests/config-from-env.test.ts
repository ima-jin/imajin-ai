import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { adapterConfigFromEnv, loadKeypair } from '../src/config-from-env.js';

describe('loadKeypair', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nanoclaw-channel-keypair-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a valid keypair file', () => {
    const path = join(dir, 'keypair.json');
    writeFileSync(path, JSON.stringify({ privateKey: 'priv', publicKey: 'pub' }));
    expect(loadKeypair(path)).toEqual({ privateKey: 'priv', publicKey: 'pub' });
  });

  it('throws when the file is missing required fields', () => {
    const path = join(dir, 'bad.json');
    writeFileSync(path, JSON.stringify({ publicKey: 'pub' }));
    expect(() => loadKeypair(path)).toThrow(/missing privateKey/);
  });
});

describe('adapterConfigFromEnv', () => {
  let dir: string;
  let keypairPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nanoclaw-channel-env-'));
    keypairPath = join(dir, 'keypair.json');
    writeFileSync(keypairPath, JSON.stringify({ privateKey: 'priv-hex', publicKey: 'pub-hex' }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('builds config from env vars', () => {
    const config = adapterConfigFromEnv({
      KERNEL_BASE_URL: 'https://kernel.example.com',
      NANOCLAW_AGENT_DID: 'did:imajin:agent-poc',
      NANOCLAW_AGENT_KEYPAIR_PATH: keypairPath,
    } as unknown as NodeJS.ProcessEnv);

    expect(config).toEqual({
      kernelBaseUrl: 'https://kernel.example.com',
      agentDid: 'did:imajin:agent-poc',
      privateKeyHex: 'priv-hex',
    });
  });

  it('throws when a required env var is missing', () => {
    expect(() =>
      adapterConfigFromEnv({ NANOCLAW_AGENT_DID: 'did:imajin:agent-poc' } as unknown as NodeJS.ProcessEnv),
    ).toThrow(/KERNEL_BASE_URL is required/);
  });
});
