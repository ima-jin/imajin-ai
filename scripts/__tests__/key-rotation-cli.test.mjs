import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as keyRotation from '../../packages/auth/src/key-rotation.ts';
import * as authCrypto from '../../packages/auth/src/crypto.ts';
import { runKeyRotationCli } from '../lib/key-rotation-cli.mjs';

// #2081: the machine checks behind the AUTH_PRIVATE_KEY rotation runbook. The
// crypto is exercised for real (source, so no build is needed); only env,
// fetch, file reads and the output streams are faked.

const newKeypair = () => authCrypto.generateKeypair();

function makeDeps({ env = {}, fetchImpl, readFile } = {}) {
  const logs = [];
  const errors = [];
  return {
    deps: {
      keyRotation,
      env,
      fetchImpl: fetchImpl ?? vi.fn(),
      readFile: readFile ?? vi.fn(),
      out: { log: (line) => logs.push(line), error: (line) => errors.push(line) },
    },
    stdout: () => logs.join('\n'),
    stderr: () => errors.join('\n'),
  };
}

function jsonResponse(status, body) {
  return { status, json: async () => body };
}

describe('usage', () => {
  it.each([
    [[], /Unknown or missing subcommand ''/],
    [['bogus'], /Unknown or missing subcommand 'bogus'/],
    [['preflight', '--bogus', 'x'], /Unexpected argument '--bogus'/],
    [['preflight', 'stray'], /Unexpected argument 'stray'/],
    [['preflight', '--grace-hours'], /--grace-hours needs a value/],
    [['verify', '--effective-at', 'x'], /Unexpected argument '--effective-at'/],
    [['sign'], /--effective-at is required/],
  ])('rejects %j with exit 2', async (argv, message) => {
    const { deps, stderr } = makeDeps();
    expect(await runKeyRotationCli(argv, deps)).toBe(2);
    expect(stderr()).toMatch(message);
    expect(stderr()).toMatch(/Usage: node scripts\/key-rotation\.mjs/);
  });

  it('does not allow constructor-style subcommands through the lookup', async () => {
    const { deps, stderr } = makeDeps();
    expect(await runKeyRotationCli(['constructor'], deps)).toBe(2);
    expect(stderr()).toMatch(/Unknown or missing subcommand/);
  });

  it('accepts --flag=value as well as --flag value', async () => {
    const oldKey = newKeypair();
    const newKey = newKeypair();
    const env = { OLD_AUTH_PRIVATE_KEY: oldKey.privateKey, NEW_AUTH_PRIVATE_KEY: newKey.privateKey };
    const spaced = makeDeps({ env });
    const joined = makeDeps({ env });

    expect(await runKeyRotationCli(['preflight', '--grace-hours', '72'], spaced.deps)).toBe(0);
    expect(await runKeyRotationCli(['preflight', '--grace-hours=72'], joined.deps)).toBe(0);
    const until = (text) => /VALID_UNTIL=(\S+)/.exec(text)[1];
    const from = (text) => /VALID_FROM=(\S+)/.exec(text)[1];
    // Same 72h window in both forms (compare span, not wall-clock).
    expect(Date.parse(until(spaced.stdout())) - Date.parse(from(spaced.stdout()))).toBe(72 * 3_600_000);
    expect(Date.parse(until(joined.stdout())) - Date.parse(from(joined.stdout()))).toBe(72 * 3_600_000);
  });
});

describe('preflight', () => {
  it('passes a real pair, prints kids/public keys and the grace-window env, never a private key', async () => {
    const oldKey = newKeypair();
    const newKey = newKeypair();
    const { deps, stdout, stderr } = makeDeps({
      env: { OLD_AUTH_PRIVATE_KEY: oldKey.privateKey, NEW_AUTH_PRIVATE_KEY: newKey.privateKey },
    });

    expect(await runKeyRotationCli(['preflight'], deps)).toBe(0);

    expect(stdout()).toContain(`old key: ${keyRotation.computeKeyKid(oldKey.publicKey)}`);
    expect(stdout()).toContain(`new key: ${keyRotation.computeKeyKid(newKey.publicKey)}`);
    expect(stdout()).toContain(`AUTH_PREVIOUS_PUBLIC_KEY=${oldKey.publicKey}`);
    expect(stdout()).toMatch(/AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL=\d{4}-\d{2}-\d{2}T/);
    expect(stdout()).toContain('OK: rotation pair is usable');
    for (const secret of [oldKey.privateKey, newKey.privateKey]) {
      expect(stdout()).not.toContain(secret);
      expect(stderr()).not.toContain(secret);
    }
  });

  it('fails (exit 1) on missing keys, an identical pair and a bad grace window', async () => {
    const key = newKeypair();
    const missing = makeDeps({ env: {} });
    expect(await runKeyRotationCli(['preflight'], missing.deps)).toBe(1);
    expect(missing.stderr()).toMatch(/old key is not set/);
    expect(missing.stderr()).toMatch(/do not swap AUTH_PRIVATE_KEY/);

    const same = makeDeps({ env: { OLD_AUTH_PRIVATE_KEY: key.privateKey, NEW_AUTH_PRIVATE_KEY: key.privateKey } });
    expect(await runKeyRotationCli(['preflight'], same.deps)).toBe(1);
    expect(same.stderr()).toMatch(/identical/);

    const grace = makeDeps({
      env: { OLD_AUTH_PRIVATE_KEY: newKeypair().privateKey, NEW_AUTH_PRIVATE_KEY: newKeypair().privateKey },
    });
    expect(await runKeyRotationCli(['preflight', '--grace-hours', 'soon'], grace.deps)).toBe(1);
    expect(grace.stderr()).toMatch(/graceHours must be a positive number/);
  });
});

describe('sign', () => {
  it('prints a public, dual-signed payload on stdout that the kernel-side verifier accepts', async () => {
    const oldKey = newKeypair();
    const newKey = newKeypair();
    const { deps, stdout, stderr } = makeDeps({
      env: { OLD_AUTH_PRIVATE_KEY: oldKey.privateKey, NEW_AUTH_PRIVATE_KEY: newKey.privateKey },
    });

    expect(await runKeyRotationCli(['sign', '--effective-at', '2026-10-06T12:00:00.000Z'], deps)).toBe(0);

    const payload = JSON.parse(stdout());
    expect(payload.effectiveAt).toBe('2026-10-06T12:00:00.000Z');
    expect(payload.oldPublicKey).toBe(oldKey.publicKey);
    expect(payload.newPublicKey).toBe(newKey.publicKey);
    expect(keyRotation.verifyKeyRotatedPayload(payload).ok).toBe(true);
    for (const secret of [oldKey.privateKey, newKey.privateKey]) {
      expect(stdout()).not.toContain(secret);
      expect(stderr()).not.toContain(secret);
    }
  });

  it('refuses to sign an unusable pair', async () => {
    const key = newKeypair();
    const { deps, stdout, stderr } = makeDeps({
      env: { OLD_AUTH_PRIVATE_KEY: key.privateKey, NEW_AUTH_PRIVATE_KEY: key.privateKey },
    });

    expect(await runKeyRotationCli(['sign', '--effective-at', '2026-10-06T12:00:00.000Z'], deps)).toBe(1);
    expect(stdout()).toBe('');
    expect(stderr()).toMatch(/refusing to sign/);
  });

  it('requires --effective-at (no "now" default) and signs nothing without it', async () => {
    const { deps, stdout, stderr } = makeDeps({
      env: { OLD_AUTH_PRIVATE_KEY: newKeypair().privateKey, NEW_AUTH_PRIVATE_KEY: newKeypair().privateKey },
    });

    expect(await runKeyRotationCli(['sign'], deps)).toBe(2);
    expect(stdout()).toBe('');
    expect(stderr()).toMatch(/--effective-at is required: the UTC instant the restarted kernel began signing/);
  });

  it('rejects an unparseable --effective-at as bad usage', async () => {
    const { deps, stdout, stderr } = makeDeps({
      env: { OLD_AUTH_PRIVATE_KEY: newKeypair().privateKey, NEW_AUTH_PRIVATE_KEY: newKeypair().privateKey },
    });

    expect(await runKeyRotationCli(['sign', '--effective-at', 'yesterday-ish'], deps)).toBe(2);
    expect(stdout()).toBe('');
    expect(stderr()).toMatch(/--effective-at must be an ISO-8601 instant/);
  });
});

describe('submit', () => {
  const payload = { oldKid: 'a', newKid: 'b' };

  it('POSTs the payload with the admin cookie and reports the minted attestation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(201, { attestationId: 'att_1', oldKid: 'a', newKid: 'b', effectiveAt: '2026-10-06T12:00:00.000Z' }),
    );
    const readFile = vi.fn().mockResolvedValue(JSON.stringify(payload));
    const { deps, stdout } = makeDeps({
      env: { KERNEL_ADMIN_COOKIE: 'imajin_session=abc', KERNEL_BASE_URL: 'https://node.example/' },
      fetchImpl,
      readFile,
    });

    expect(await runKeyRotationCli(['submit', '--payload', 'p.json'], deps)).toBe(0);

    expect(readFile).toHaveBeenCalledWith('p.json', 'utf8');
    expect(fetchImpl).toHaveBeenCalledWith('https://node.example/api/admin/keys/rotation', {
      method: 'POST',
      headers: { Cookie: 'imajin_session=abc', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(stdout()).toContain('key.rotated recorded: att_1');
  });

  it('defaults the base URL to localhost', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, {}));
    const { deps } = makeDeps({
      env: { KERNEL_ADMIN_COOKIE: 'c' },
      fetchImpl,
      readFile: vi.fn().mockResolvedValue('{}'),
    });

    await runKeyRotationCli(['submit', '--payload', 'p.json'], deps);

    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:3000/api/admin/keys/rotation');
  });

  it('exits 1 and surfaces the kernel error when the kernel refuses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(409, { error: 'key auth-x is already part of the recorded key history' }));
    const { deps, stderr } = makeDeps({
      env: { KERNEL_ADMIN_COOKIE: 'c' },
      fetchImpl,
      readFile: vi.fn().mockResolvedValue('{}'),
    });

    expect(await runKeyRotationCli(['submit', '--payload', 'p.json'], deps)).toBe(1);
    expect(stderr()).toMatch(/kernel answered 409: key auth-x is already part of the recorded key history/);
  });

  it('tolerates a non-JSON error body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 502,
      json: async () => {
        throw new Error('not json');
      },
    });
    const { deps, stderr } = makeDeps({
      env: { KERNEL_ADMIN_COOKIE: 'c' },
      fetchImpl,
      readFile: vi.fn().mockResolvedValue('{}'),
    });

    expect(await runKeyRotationCli(['submit', '--payload', 'p.json'], deps)).toBe(1);
    expect(stderr()).toMatch(/kernel answered 502: no error message/);
  });

  it('requires --payload and an admin cookie, and never calls the network without them', async () => {
    const fetchImpl = vi.fn();
    const noPayload = makeDeps({ env: { KERNEL_ADMIN_COOKIE: 'c' }, fetchImpl });
    expect(await runKeyRotationCli(['submit'], noPayload.deps)).toBe(2);
    expect(noPayload.stderr()).toMatch(/--payload <file> is required/);

    const noCookie = makeDeps({ env: {}, fetchImpl, readFile: vi.fn().mockResolvedValue('{}') });
    expect(await runKeyRotationCli(['submit', '--payload', 'p.json'], noCookie.deps)).toBe(2);
    expect(noCookie.stderr()).toMatch(/KERNEL_ADMIN_COOKIE is required/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exits 1 when the payload file is unreadable or not JSON', async () => {
    const unreadable = makeDeps({
      env: { KERNEL_ADMIN_COOKIE: 'c' },
      readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
    });
    expect(await runKeyRotationCli(['submit', '--payload', 'missing.json'], unreadable.deps)).toBe(1);
    expect(unreadable.stderr()).toMatch(/could not read a JSON payload from missing\.json: ENOENT/);

    const garbage = makeDeps({ env: { KERNEL_ADMIN_COOKIE: 'c' }, readFile: vi.fn().mockResolvedValue('{nope') });
    expect(await runKeyRotationCli(['submit', '--payload', 'bad.json'], garbage.deps)).toBe(1);
  });
});

describe('verify', () => {
  const report = {
    ok: true,
    errors: [],
    warnings: [],
    nodeDid: 'did:imajin:node',
    nodeDidSource: 'relay_config',
    currentKid: 'auth-2',
    rotations: 1,
    history: [
      { kid: 'auth-1', validFrom: null, validUntil: '2026-10-06T12:00:00.000Z' },
      { kid: 'auth-2', validFrom: '2026-10-06T12:00:00.000Z', validUntil: null },
    ],
  };

  it('exits 0 and prints the chain when the kernel reports ok', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, report));
    const { deps, stdout } = makeDeps({ env: { KERNEL_ADMIN_COOKIE: 'c' }, fetchImpl });

    expect(await runKeyRotationCli(['verify'], deps)).toBe(0);

    expect(fetchImpl).toHaveBeenCalledWith('http://localhost:3000/api/admin/keys/rotation', {
      method: 'GET',
      headers: { Cookie: 'c' },
    });
    expect(stdout()).toContain('node DID:    did:imajin:node (source: relay_config)');
    expect(stdout()).toContain('current kid: auth-2');
    expect(stdout()).toContain('auth-1  (genesis) -> 2026-10-06T12:00:00.000Z');
    expect(stdout()).toContain('auth-2  2026-10-06T12:00:00.000Z -> (current)');
    expect(stdout()).toContain('OK: key history is verifiable');
  });

  it('passes --anchor through, URL-encoded', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, report));
    const { deps } = makeDeps({ env: { KERNEL_ADMIN_COOKIE: 'c' }, fetchImpl });

    await runKeyRotationCli(['verify', '--anchor', 'ab/cd'], deps);

    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:3000/api/admin/keys/rotation?anchor=ab%2Fcd');
  });

  it('exits 1 and prints errors when the kernel reports a failed check', async () => {
    const failed = { ...report, ok: false, errors: ['key history ends at auth-1 but AUTH_PRIVATE_KEY is auth-2'], warnings: ['careful'] };
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, failed));
    const { deps, stdout, stderr } = makeDeps({ env: { KERNEL_ADMIN_COOKIE: 'c' }, fetchImpl });

    expect(await runKeyRotationCli(['verify'], deps)).toBe(1);
    expect(stderr()).toMatch(/ERROR: key history ends at auth-1/);
    expect(stdout()).toMatch(/WARNING: careful/);
    expect(stdout()).toMatch(/FAIL: key history check failed/);
  });

  it('exits 1 on a transport-level failure or an unexpected body', async () => {
    const unauthorized = makeDeps({
      env: { KERNEL_ADMIN_COOKIE: 'c' },
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(401, { error: 'Unauthorized' })),
    });
    expect(await runKeyRotationCli(['verify'], unauthorized.deps)).toBe(1);
    expect(unauthorized.stderr()).toMatch(/kernel answered 401: Unauthorized/);

    const weird = makeDeps({
      env: { KERNEL_ADMIN_COOKIE: 'c' },
      fetchImpl: vi.fn().mockResolvedValue({
        status: 200,
        json: async () => {
          throw new Error('html');
        },
      }),
    });
    expect(await runKeyRotationCli(['verify'], weird.deps)).toBe(1);
    expect(weird.stderr()).toMatch(/unexpected response/);
  });

  it('requires an admin cookie', async () => {
    const fetchImpl = vi.fn();
    const { deps, stderr } = makeDeps({ env: {}, fetchImpl });

    expect(await runKeyRotationCli(['verify'], deps)).toBe(2);
    expect(stderr()).toMatch(/KERNEL_ADMIN_COOKIE is required/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('strips control characters from response-derived log lines (log injection)', async () => {
    const hostile = { ...report, ok: false, errors: ['bad\nFAKE: forged line'] };
    const { deps, stderr } = makeDeps({
      env: { KERNEL_ADMIN_COOKIE: 'c' },
      fetchImpl: vi.fn().mockResolvedValue(jsonResponse(200, hostile)),
    });

    await runKeyRotationCli(['verify'], deps);

    expect(stderr()).toBe('ERROR: bad FAKE: forged line');
  });
});

// The real entrypoint needs @imajin/auth built (deploy builds packages first).
// Locally this runs once `pnpm --filter "@imajin/auth..." build` has.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entrypoint = join(repoRoot, 'scripts', 'key-rotation.mjs');
const built = existsSync(join(repoRoot, 'packages', 'auth', 'dist', 'key-rotation.js'));

describe.skipIf(!built)('key-rotation.mjs entrypoint', () => {
  it('runs the full offline sign -> payload round trip as a real process', () => {
    const oldKey = newKeypair();
    const newKey = newKeypair();
    const result = spawnSync(process.execPath, [entrypoint, 'sign', '--effective-at', '2026-10-06T12:00:00Z'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, OLD_AUTH_PRIVATE_KEY: oldKey.privateKey, NEW_AUTH_PRIVATE_KEY: newKey.privateKey },
    });

    expect(result.status).toBe(0);
    expect(keyRotation.verifyKeyRotatedPayload(JSON.parse(result.stdout)).ok).toBe(true);
    expect(result.stdout + result.stderr).not.toContain(oldKey.privateKey);
    expect(result.stdout + result.stderr).not.toContain(newKey.privateKey);
  });

  it('exits 2 with usage for an unknown subcommand', () => {
    const result = spawnSync(process.execPath, [entrypoint, 'nope'], { cwd: repoRoot, encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Usage: node scripts\/key-rotation\.mjs/);
  });
});
