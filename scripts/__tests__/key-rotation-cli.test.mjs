import { afterEach, describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createPrivateKey } from 'node:crypto';
import { tmpdir } from 'node:os';
import { parseEnv } from 'node:util';
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
const temporaryDirectories = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function rotationFixture() {
  const directory = await fs.mkdtemp(join(tmpdir(), 'rotation-test-'));
  temporaryDirectories.push(directory);
  const filename = join(directory, '.env.local');
  const oldKey = newKeypair();
  const newKey = newKeypair();
  const original = `# retain this comment\nOTHER="keep # spaces"\nAUTH_PRIVATE_KEY=${oldKey.privateKey}\nTAIL=untouched\n`;
  await fs.writeFile(filename, original, { mode: 0o600 });
  const capture = makeDeps();
  capture.deps.generatePrivateKey = () => newKey.privateKey;
  return {
    ...capture, directory, filename, oldKey, newKey, original,
    backup: `${filename}.key-rotation.bak`,
    argv: ['generate', '--env-file', filename],
  };
}

/** Boolean assertions ensure even a failing security test cannot print its secrets. */
function expectNoPrivateMaterial(output, ...keys) {
  for (const key of keys) {
    const seed = Buffer.from(authCrypto.extractPrivateKeySeed(key), 'hex');
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    const privateObject = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    const pem = privateObject.export({ format: 'pem', type: 'pkcs8' }).toString();
    const jwk = privateObject.export({ format: 'jwk' });
    const forms = [key, pem, ...pem.trim().split('\n').slice(1, -1), jwk.d];
    for (const bytes of [seed, der, Buffer.from(key)]) {
      forms.push(bytes.toString('hex'), bytes.toString('hex').toUpperCase(), bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('latin1'));
    }
    for (const secret of forms) expect(output.includes(secret)).toBe(false);
  }
  expect(output.includes('PRIVATE KEY-----')).toBe(false);
  expect(output.includes('"d":')).toBe(false);
}

function expectSafeCapture(fixture) {
  expectNoPrivateMaterial(fixture.stdout() + fixture.stderr(), fixture.oldKey.privateKey, fixture.newKey.privateKey);
}

function overrideHandle(handle, overrides) {
  return new Proxy(handle, {
    get(target, name) {
      if (Object.hasOwn(overrides, name)) return overrides[name];
      const value = Reflect.get(target, name);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('generate', () => {
  it('mints a fresh Ed25519 seed in-process with the production random source', async () => {
    const f = await rotationFixture();
    delete f.deps.generatePrivateKey;
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(0);
    const generated = parseEnv(await fs.readFile(f.filename, 'utf8')).AUTH_PRIVATE_KEY;
    expect(authCrypto.isValidPrivateKey(generated)).toBe(true);
    expect(generated === f.oldKey.privateKey).toBe(false);
    expect(f.stdout()).toContain(authCrypto.getPublicKey(generated));
    expectNoPrivateMaterial(f.stdout() + f.stderr(), f.oldKey.privateKey, generated);
  });
  it('uses the shared preflight, installs atomically and preserves the private rollback file byte-for-byte', async () => {
    const f = await rotationFixture();
    await fs.chmod(f.filename, 0o644);
    const now = new Date('2026-10-17T12:00:00Z');
    const evaluate = vi.fn((input) => keyRotation.evaluateKeyRotationPreflight({ ...input, now }));
    f.deps.keyRotation = { ...keyRotation, evaluateKeyRotationPreflight: evaluate };
    let observedRename = false;
    f.deps.fileSystem = {
      ...fs,
      rename: async (source, target) => {
        observedRename = true;
        expect(dirname(source)).toBe(dirname(target));
        expect(target).toBe(f.filename);
        expect((await fs.readFile(target, 'utf8')) === f.original).toBe(true);
        expect((await fs.readFile(f.backup, 'utf8')) === f.original).toBe(true);
        expect((await fs.stat(source)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(f.backup)).mode & 0o777).toBe(0o600);
        expect(parseEnv(await fs.readFile(source, 'utf8')).AUTH_PRIVATE_KEY === f.newKey.privateKey).toBe(true);
        await fs.rename(source, target);
      },
    };

    expect(await runKeyRotationCli([...f.argv, '--grace-hours', '72'], f.deps)).toBe(0);
    expect(observedRename).toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(1);
    const text = await fs.readFile(f.filename, 'utf8');
    const env = parseEnv(text);
    expect(env.AUTH_PRIVATE_KEY === f.newKey.privateKey).toBe(true);
    expect(env.AUTH_PREVIOUS_PUBLIC_KEY).toBe(f.oldKey.publicKey);
    expect(env.AUTH_PREVIOUS_PUBLIC_KEY_VALID_FROM).toBe(now.toISOString());
    expect(env.AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL).toBe('2026-10-20T12:00:00.000Z');
    expect(text.includes('# retain this comment\nOTHER="keep # spaces"\n')).toBe(true);
    expect(text.includes('TAIL=untouched\n')).toBe(true);
    expect(text.includes(f.oldKey.privateKey)).toBe(false);
    expect((await fs.stat(f.filename)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(f.backup)).mode & 0o777).toBe(0o600);
    expect((await fs.readFile(f.backup, 'utf8')) === f.original).toBe(true);
    expect((await fs.readdir(f.directory)).length).toBe(2);
    expect(f.stdout()).toContain(`old key: ${keyRotation.computeKeyKid(f.oldKey.publicKey)}  public ${f.oldKey.publicKey}`);
    expect(f.stdout()).toContain(`new key: ${keyRotation.computeKeyKid(f.newKey.publicKey)}  public ${f.newKey.publicKey}`);
    expect(f.stderr()).toBe('');
    expectSafeCapture(f);
  });
  it.each([false, true])('handles a partial backup write, including cleanup failure=%s, without touching the env', async (cleanupFails) => {
    const f = await rotationFixture();
    f.deps.fileSystem = {
      ...fs,
      unlink: cleanupFails ? async () => { throw new Error('backup cleanup unavailable'); } : fs.unlink,
      open: async (filename, flags, mode) => {
        const handle = await fs.open(filename, flags, mode);
        if (filename !== f.backup) return handle;
        return overrideHandle(handle, {
          writeFile: async (text) => {
            await handle.writeFile(text.slice(0, 30), 'utf8');
            throw new Error('partial backup write');
          },
        });
      },
    };
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(1);
    expect((await fs.readFile(f.filename, 'utf8')) === f.original).toBe(true);
    expect(existsSync(f.backup)).toBe(cleanupFails);
    expectSafeCapture(f);
  });

  it.each(['\n', '\r\n'])('preserves unrelated multiline values, comments and %j endings; replaces prior window values', async (newline) => {
    const f = await rotationFixture();
    const prefix = ['# comment', 'MULTI="first', 'AUTH_PRIVATE_KEY=not-an-assignment', 'last"', '', 'BLANK=', 'UNCHANGED=one # comment'].join(newline) + newline;
    const key = `  export AUTH_PRIVATE_KEY = '${f.oldKey.privateKey}' # private`;
    const window = ['AUTH_PREVIOUS_PUBLIC_KEY="old"', "AUTH_PREVIOUS_PUBLIC_KEY_VALID_FROM='", "stale'", 'AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL=stale'];
    const original = prefix + [key, ...window].join(newline);
    await fs.writeFile(f.filename, original);
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(0);
    const result = await fs.readFile(f.filename, 'utf8');
    expect(result.startsWith(prefix)).toBe(true);
    expect(result.endsWith('\n')).toBe(false);
    expect((await fs.readFile(f.backup, 'utf8')) === original).toBe(true);
    expect(parseEnv(result).AUTH_PRIVATE_KEY === f.newKey.privateKey).toBe(true);
    expect(parseEnv(result).AUTH_PREVIOUS_PUBLIC_KEY).toBe(f.oldKey.publicKey);
    const env = parseEnv(result);
    expect(Date.parse(env.AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL) - Date.parse(env.AUTH_PREVIOUS_PUBLIC_KEY_VALID_FROM)).toBe(48 * 3_600_000);
    expectSafeCapture(f);
  });

  it('accepts PKCS#8 old keys and refuses noncanonical multiline keys without printing either encoding', async () => {
    const f = await rotationFixture();
    const pkcs8 = '302e020100300506032b657004220420' + f.oldKey.privateKey;
    await fs.writeFile(f.filename, `AUTH_PRIVATE_KEY="\n${pkcs8}\n"\nOTHER=keep`);
    // The auth primitive accepts canonical hex, not embedded newlines: refuse
    // rather than reinterpret the old key or overwrite it.
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(1);
    await fs.writeFile(f.filename, `AUTH_PRIVATE_KEY='${pkcs8}'\nOTHER=keep`);
    expect(await runKeyRotationCli([...f.argv, '--grace-hours=12'], f.deps)).toBe(0);
    expect(f.stdout()).toContain('WARNING: grace window of 12h');
    expect((await fs.readFile(f.filename, 'utf8')).includes('OTHER=keep\n')).toBe(true);
    expectSafeCapture(f);
  });

  it.each([
    ['missing', async (f) => fs.unlink(f.filename)],
    ['unreadable', async (f) => fs.chmod(f.filename, 0o000)],
    ['directory', async (f) => { await fs.unlink(f.filename); await fs.mkdir(f.filename); }],
    ['symlink', async (f) => { await fs.rename(f.filename, join(f.directory, 'real')); await fs.symlink(join(f.directory, 'real'), f.filename); }],
    ['hardlink', async (f) => fs.link(f.filename, join(f.directory, 'alias'))],
    ['invalid UTF-8', async (f) => fs.writeFile(f.filename, Buffer.from([0xff]))],
    ['missing key', async (f) => fs.writeFile(f.filename, 'OTHER=keep\n')],
    ['invalid key', async (f) => fs.writeFile(f.filename, `AUTH_PRIVATE_KEY=bad-${f.oldKey.privateKey}\n`)],
    ['unterminated quote', async (f) => fs.writeFile(f.filename, `OTHER="never closes\nAUTH_PRIVATE_KEY=${f.oldKey.privateKey}\n`)],
    ['duplicate private key', async (f) => fs.appendFile(f.filename, `export AUTH_PRIVATE_KEY=${f.oldKey.privateKey}\n`)],
    ['duplicate window', async (f) => fs.appendFile(f.filename, 'AUTH_PREVIOUS_PUBLIC_KEY=a\nAUTH_PREVIOUS_PUBLIC_KEY=b\n')],
    ['existing backup', async (f) => fs.writeFile(f.backup, f.original, { mode: 0o600 })],
    ['symlink backup', async (f) => fs.symlink(f.filename, f.backup)],
    ['directory backup', async (f) => fs.mkdir(f.backup)],
  ])('fails safely for %s', async (_name, prepare) => {
    const f = await rotationFixture();
    await prepare(f);
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(1);
    expect(f.stdout()).toBe('');
    expect(f.stderr()).toMatch(/^FAIL: /);
    expectSafeCapture(f);
  });

  it.each(['0', '-1', 'NaN', 'Infinity', '1e300'])('rejects grace-hours %s without installing anything', async (grace) => {
    const f = await rotationFixture();
    expect(await runKeyRotationCli([...f.argv, '--grace-hours', grace], f.deps)).toBe(1);
    expect((await fs.readFile(f.filename, 'utf8')) === f.original).toBe(true);
    expect(existsSync(f.backup)).toBe(false);
    expectSafeCapture(f);
  });

  it('refuses identical generated keys and catches generation/crypto exceptions', async () => {
    const f = await rotationFixture();
    f.deps.generatePrivateKey = () => f.oldKey.privateKey;
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(1);
    f.deps.generatePrivateKey = () => { throw new Error('random source failed'); };
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(1);
    f.deps.generatePrivateKey = () => f.newKey.privateKey;
    f.deps.keyRotation = { ...keyRotation, evaluateKeyRotationPreflight: () => { throw new Error('crypto failed'); } };
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(1);
    expect((await fs.readFile(f.filename, 'utf8')) === f.original).toBe(true);
    expect(existsSync(f.backup)).toBe(false);
    expectSafeCapture(f);
  });

  it.each(['backup-open', 'backup-chmod', 'backup-write', 'backup-sync', 'backup-close', 'temp-open', 'temp-chmod', 'temp-write', 'temp-sync', 'temp-close', 'rename'])('keeps the env unchanged on %s failure and never prints secrets', async (failure) => {
    const f = await rotationFixture();
    const fail = () => { throw new Error('simulated filesystem failure'); };
    f.deps.fileSystem = {
      ...fs,
      rename: failure === 'rename' ? fail : fs.rename,
      open: async (filename, flags, mode) => {
        const kind = filename === f.backup ? 'backup' : 'temp';
        if (flags !== 'wx') return fs.open(filename, flags, mode);
        if (failure === `${kind}-open`) return fail();
        const handle = await fs.open(filename, flags, mode);
        const overrides = {};
        for (const method of ['chmod', 'writeFile', 'sync', 'close']) {
          const label = method === 'writeFile' ? 'write' : method;
          if (failure === `${kind}-${label}`) {
            overrides[method] = async () => {
              if (method === 'close') await handle.close();
              return fail();
            };
          }
        }
        return overrideHandle(handle, overrides);
      },
    };
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(1);
    expect((await fs.readFile(f.filename, 'utf8')) === f.original).toBe(true);
    expect((await fs.readdir(f.directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
    if (failure.startsWith('backup-')) {
      expect(existsSync(f.backup)).toBe(false);
    } else {
      expect((await fs.readFile(f.backup, 'utf8')) === f.original).toBe(true);
      expect((await fs.stat(f.backup)).mode & 0o777).toBe(0o600);
    }
    expectSafeCapture(f);
  });

  it('fails closed when unusual dotenv grammar would change unrelated assignment semantics', async () => {
    const f = await rotationFixture();
    const original = `ODD-NAME="first\nAUTH_PREVIOUS_PUBLIC_KEY=inside the multiline value\nlast"\nAUTH_PRIVATE_KEY=${f.oldKey.privateKey}\n`;
    await fs.writeFile(f.filename, original);
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(1);
    expect((await fs.readFile(f.filename, 'utf8')) === original).toBe(true);
    expect(existsSync(f.backup)).toBe(false);
    expectSafeCapture(f);
  });

  it('refuses replacement of the env inode, even with identical contents', async () => {
    const f = await rotationFixture();
    f.deps.fileSystem = {
      ...fs,
      open: async (filename, flags, mode) => {
        if (flags === 'wx' && filename !== f.backup) {
          await fs.rename(f.filename, join(f.directory, 'concurrent-original'));
          await fs.writeFile(f.filename, f.original, { mode: 0o600 });
        }
        return fs.open(filename, flags, mode);
      },
    };
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(1);
    expect((await fs.readFile(f.filename, 'utf8')) === f.original).toBe(true);
    expectSafeCapture(f);
  });

  it('does not perform fallible cleanup after the rename has committed', async () => {
    const f = await rotationFixture();
    f.deps.fileSystem = { ...fs, rm: vi.fn().mockRejectedValue(new Error('cleanup unavailable')) };
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(0);
    expect(f.deps.fileSystem.rm).not.toHaveBeenCalled();
    expectSafeCapture(f);
  });

  it('refuses a concurrent env change without overwriting it', async () => {
    const f = await rotationFixture();
    f.deps.fileSystem = {
      ...fs,
      open: async (filename, flags, mode) => {
        if (flags === 'wx' && filename !== f.backup) await fs.appendFile(f.filename, '# concurrent edit\n');
        return fs.open(filename, flags, mode);
      },
    };
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(1);
    expect((await fs.readFile(f.filename, 'utf8')) === f.original + '# concurrent edit\n').toBe(true);
    expect((await fs.readFile(f.backup, 'utf8')) === f.original).toBe(true);
    expectSafeCapture(f);
  });

  it('does not overwrite an existing backup, including on a second generation', async () => {
    const f = await rotationFixture();
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(0);
    const installed = await fs.readFile(f.filename, 'utf8');
    f.deps.generatePrivateKey = () => newKeypair().privateKey;
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(1);
    expect((await fs.readFile(f.filename, 'utf8')) === installed).toBe(true);
    expect((await fs.readFile(f.backup, 'utf8')) === f.original).toBe(true);
    expectSafeCapture(f);
  });

  it('catches read and cleanup failures without propagating exception text', async () => {
    const f = await rotationFixture();
    f.deps.fileSystem = { ...fs, open: async () => { throw new Error('read unavailable'); } };
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(1);
    f.deps.fileSystem = {
      ...fs,
      rename: async () => { throw new Error('rename unavailable'); },
      rm: async () => { throw new Error('cleanup unavailable'); },
    };
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(1);
    expect(f.stderr()).not.toMatch(/unavailable/);
    expectSafeCapture(f);
  });

  it.each(['generate', 'destroy'])('rejects missing paths and unexpected arguments for %s without reflecting input', async (command) => {
    const f = await rotationFixture();
    for (const argv of [[command], [command, '--env-file'], [command, f.oldKey.privateKey], [command, '--bogus=' + f.newKey.privateKey]]) {
      expect(await runKeyRotationCli(argv, f.deps)).toBe(2);
    }
    expectSafeCapture(f);
  });
});

describe('destroy', () => {
  it('unlinks only the regular backup without reading it or changing the current env', async () => {
    const f = await rotationFixture();
    expect(await runKeyRotationCli(f.argv, f.deps)).toBe(0);
    const installed = await fs.readFile(f.filename, 'utf8');
    f.deps.fileSystem = { ...fs, readFile: vi.fn(), open: vi.fn() };
    expect(await runKeyRotationCli(['destroy', '--env-file', f.filename], f.deps)).toBe(0);
    expect(f.deps.fileSystem.readFile).not.toHaveBeenCalled();
    expect(f.deps.fileSystem.open).not.toHaveBeenCalled();
    expect(existsSync(f.backup)).toBe(false);
    expect((await fs.readFile(f.filename, 'utf8')) === installed).toBe(true);
    expectSafeCapture(f);
  });

  it.each(['missing', 'symlink', 'directory', 'hardlink', 'unlink failure'])('refuses %s backups safely', async (kind) => {
    const f = await rotationFixture();
    if (kind === 'symlink') await fs.symlink(f.filename, f.backup);
    if (kind === 'directory') await fs.mkdir(f.backup);
    if (kind === 'hardlink') await fs.link(f.filename, f.backup);
    if (kind === 'unlink failure') {
      await fs.writeFile(f.backup, f.original, { mode: 0o600 });
      f.deps.fileSystem = { ...fs, unlink: async () => { throw new Error('unlink unavailable'); } };
    }
    expect(await runKeyRotationCli(['destroy', '--env-file', f.filename], f.deps)).toBe(1);
    expect((await fs.readFile(f.filename, 'utf8')) === f.original).toBe(true);
    expectSafeCapture(f);
  });
});

describe('usage', () => {
  it.each([
    [[], /Unknown or missing subcommand/],
    [['bogus'], /Unknown or missing subcommand/],
    [['preflight', '--bogus', 'x'], /Unexpected argument/],
    [['preflight', 'stray'], /Unexpected argument/],
    [['preflight', '--grace-hours'], /--grace-hours needs a value/],
    [['verify', '--effective-at', 'x'], /Unexpected argument/],
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

describe('file-backed signing and preflight (#2987)', () => {
  const instant = '2026-10-06T12:00:00.000Z';
  const args = (f, command = 'sign') => [
    command, '--env-file', f.filename,
    ...(command === 'sign' ? ['--effective-at', instant] : []),
  ];

  async function installedFixture() {
    const f = await rotationFixture();
    await fs.writeFile(f.backup, f.original, { mode: 0o600 });
    await fs.writeFile(f.filename, `AUTH_PRIVATE_KEY=${f.newKey.privateKey}\n`);
    // Contradictory legacy keys must never override file mode.
    f.deps.env = { OLD_AUTH_PRIVATE_KEY: f.newKey.privateKey, NEW_AUTH_PRIVATE_KEY: f.oldKey.privateKey };
    return f;
  }

  it('reads NEW from the file and OLD from its backup, emitting only a public dual-signed JSON payload', async () => {
    const f = await installedFixture();
    const before = await fs.readFile(f.filename, 'utf8');
    expect(await runKeyRotationCli(args(f), f.deps)).toBe(0);
    const payload = JSON.parse(f.stdout());
    expect(keyRotation.verifyKeyRotatedPayload(payload).ok).toBe(true);
    expect(payload.oldPublicKey).toBe(f.oldKey.publicKey);
    expect(payload.newPublicKey).toBe(f.newKey.publicKey);
    expect(payload.effectiveAt).toBe(instant);
    expect(Object.keys(payload).sort()).toEqual([
      'effectiveAt', 'newKeySignature', 'newKid', 'newPublicKey',
      'oldKeySignature', 'oldKid', 'oldPublicKey',
    ]);
    expect((await fs.readFile(f.filename, 'utf8')) === before).toBe(true);
    expect((await fs.readFile(f.backup, 'utf8')) === f.original).toBe(true);
    expect(f.deps.fetchImpl).not.toHaveBeenCalled();
    expectSafeCapture(f);
  });

  it('supports offline file-mode preflight without reading legacy shell keys', async () => {
    const f = await installedFixture();
    f.deps.env = {};
    expect(await runKeyRotationCli(args(f, 'preflight'), f.deps)).toBe(0);
    expect(f.stdout()).toContain(f.oldKey.publicKey);
    expect(f.stdout()).toContain(f.newKey.publicKey);
    expectSafeCapture(f);
  });

  it.each(['sign', 'preflight'])('accepts quoted PKCS#8 file keys for %s', async (command) => {
    const f = await installedFixture();
    const prefix = '302e020100300506032b657004220420';
    await fs.writeFile(f.filename, `export AUTH_PRIVATE_KEY='${prefix}${f.newKey.privateKey}'\n`);
    await fs.writeFile(f.backup, `AUTH_PRIVATE_KEY="${prefix}${f.oldKey.privateKey}"\n`);
    expect(await runKeyRotationCli(args(f, command), f.deps)).toBe(0);
    expectSafeCapture(f);
  });

  it('requires an explicit restart instant before file access', async () => {
    const f = await installedFixture();
    f.deps.fileSystem = { open: vi.fn() };
    expect(await runKeyRotationCli(['sign', '--env-file', f.filename], f.deps)).toBe(2);
    expect(await runKeyRotationCli([...args(f).slice(0, -1), 'not-an-instant'], f.deps)).toBe(2);
    expect(f.deps.fileSystem.open).not.toHaveBeenCalled();
    expectSafeCapture(f);
  });

  for (const command of ['sign', 'preflight']) {
    for (const target of ['current', 'backup']) {
      it.each(['missing', 'directory', 'symlink', 'hardlink', 'unreadable', 'invalid UTF-8', 'missing key', 'duplicate key', 'malformed key', 'unterminated quote'])(
        `${command} refuses unsafe ${target} file: %s without falling back or exposing inputs`,
        async (kind) => {
          const f = await installedFixture();
          const filename = target === 'current' ? f.filename : f.backup;
          if (kind === 'missing') await fs.unlink(filename);
          if (kind === 'directory') { await fs.unlink(filename); await fs.mkdir(filename); }
          if (kind === 'symlink') { await fs.rename(filename, join(f.directory, 'real')); await fs.symlink(join(f.directory, 'real'), filename); }
          if (kind === 'hardlink') await fs.link(filename, join(f.directory, 'alias'));
          if (kind === 'unreadable') await fs.chmod(filename, 0o000);
          if (kind === 'invalid UTF-8') await fs.writeFile(filename, Buffer.from([0xff]));
          if (kind === 'missing key') await fs.writeFile(filename, 'OTHER=keep\n');
          if (kind === 'duplicate key') await fs.appendFile(filename, `AUTH_PRIVATE_KEY=${f.newKey.privateKey}\n`);
          if (kind === 'malformed key') await fs.writeFile(filename, `AUTH_PRIVATE_KEY=invalid-${f.newKey.privateKey}\n`);
          if (kind === 'unterminated quote') await fs.writeFile(filename, `OTHER="never closes\nAUTH_PRIVATE_KEY=${f.newKey.privateKey}\n`);
          expect(await runKeyRotationCli(args(f, command), f.deps)).toBe(1);
          if (command === 'sign') expect(f.stdout()).toBe('');
          expectSafeCapture(f);
        },
      );
    }
  }

  it.each(['read', 'stat', 'close', 'preflight', 'sign'])('sanitizes %s exceptions that contain random private material', async (failure) => {
    const f = await installedFixture();
    const fail = () => { throw new Error(f.oldKey.privateKey + f.newKey.privateKey); };
    if (failure === 'read') f.deps.fileSystem = { ...fs, open: fail };
    if (failure === 'stat' || failure === 'close') {
      f.deps.fileSystem = {
        ...fs,
        open: async (...params) => {
          const handle = await fs.open(...params);
          return overrideHandle(handle, {
            [failure]: failure === 'close' ? async () => { await handle.close(); fail(); } : fail,
          });
        },
      };
    }
    if (failure === 'preflight') f.deps.keyRotation = { ...keyRotation, evaluateKeyRotationPreflight: fail };
    if (failure === 'sign') f.deps.keyRotation = { ...keyRotation, createKeyRotatedPayload: fail };
    expect(await runKeyRotationCli(args(f), f.deps)).toBe(1);
    expect(f.stdout()).toBe('');
    expectSafeCapture(f);
  });

  it('never reflects unknown subcommands, flags, values or secret-bearing paths', async () => {
    const f = await installedFixture();
    for (const argv of [
      [f.oldKey.privateKey],
      ['sign', '--bogus=' + f.oldKey.privateKey],
      ['preflight', f.newKey.privateKey],
      ['verify', '--bogus', f.oldKey.privateKey],
      ['submit', '--payload', join(f.directory, f.oldKey.privateKey)],
      ['sign', '--env-file', f.oldKey.privateKey, '--effective-at', instant],
    ]) {
      expect(await runKeyRotationCli(argv, f.deps)).not.toBe(0);
    }
    expectSafeCapture(f);
  });

  it('rejects duplicate flags and missing flag values without reading a file', async () => {
    const f = await installedFixture();
    f.deps.fileSystem = { open: vi.fn() };
    for (const argv of [
      ['sign', '--env-file', '--effective-at', instant],
      ['sign', '--env-file', f.filename, '--env-file', f.backup],
    ]) expect(await runKeyRotationCli(argv, f.deps)).toBe(2);
    expect(f.deps.fileSystem.open).not.toHaveBeenCalled();
    expectSafeCapture(f);
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
    expect(unreadable.stderr()).toMatch(/could not read a JSON payload; check file access and format/);

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

describe('rotation operator runbook synchronization (#2987)', () => {
  const docFile = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/security/node-key-roles-and-rotation.md');

  it('executes documented offline commands with generated temporary material, never a real env', async () => {
    const doc = await fs.readFile(docFile, 'utf8');
    const runbook = doc.split('## 4. Rotation runbook')[1].split('## 5.')[0];
    const blocks = [...runbook.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]);
    const commands = blocks.filter((block) => block.includes('scripts/key-rotation.mjs'));
    expect(commands.length).toBe(4);
    const f = await rotationFixture();
    for (const text of commands) {
      const command = text.replace(/\\\n\s*/g, ' ').trim();
      expect(command.startsWith('node -- scripts/key-rotation.mjs ')).toBe(true);
      const argv = command
        .replace('node -- scripts/key-rotation.mjs ', '')
        .replace('apps/kernel/.env.local', f.filename)
        .replace('"$RESTART_AT"', '2026-10-06T12:00:00.000Z')
        .replace(' > key-rotated.json', '')
        .split(/\s+/);
      const capture = makeDeps();
      expect(await runKeyRotationCli(argv, capture.deps)).toBe(0);
      const current = parseEnv(await fs.readFile(f.filename, 'utf8')).AUTH_PRIVATE_KEY;
      expectNoPrivateMaterial(capture.stdout() + capture.stderr(), f.oldKey.privateKey, current);
      if (argv[0] === 'sign') {
        expect(keyRotation.verifyKeyRotatedPayload(JSON.parse(capture.stdout())).ok).toBe(true);
      }
    }
    expect(existsSync(f.backup)).toBe(false);
  });

  it('orders browser baseline, generation, sealed export, restart, file sign, reimport and upload/anchored verify', async () => {
    const doc = await fs.readFile(docFile, 'utf8');
    const headings = [
      '### Step 1. Browser baseline before generation',
      '### Step 2. Generate and install the new env key',
      '### Step 3. Phase 1 sweep: seal export to the NEW public key',
      '### Step 4. Restart',
      '### Step 5. Sign the handover offline',
      '### Step 6. Phase 2 sweep: reimport',
      '### Step 9. Record the handover',
      '### Step 10. Verify the whole chain',
    ];
    let previous = -1;
    for (const heading of headings) {
      const index = doc.indexOf(heading);
      expect(index).toBeGreaterThan(previous);
      previous = index;
    }
    for (const contract of [
      "{phase:'export',newPublicKey:<64 hex Ed25519 pub>}",
      '{exported:number,newPublicKey:string}',
      "{phase:'reimport'}",
      '{resealed:number}',
      '{pending:boolean,exported?:number,newPublicKey?:string}',
      'GET /api/vault/rotation-sweep',
      'normal same-origin browser',
      'upload the public `key-rotated.json`',
      'pinned **public** anchor',
      'apps/kernel/src/lib/vault/rotation-handoff.ts',
    ]) expect(doc).toContain(contract);
  });

  it('contains no shell key/cookie/plaintext transport or full process dumps', async () => {
    const doc = await fs.readFile(docFile, 'utf8');
    expect(doc).not.toMatch(/OLD_AUTH_PRIVATE_KEY=|NEW_AUTH_PRIVATE_KEY=|KERNEL_ADMIN_COOKIE|\$EXPORT|pm2 jlist|curl /);
    const runbook = doc.split('## 4. Rotation runbook')[1].split('## 5.')[0];
    expect(runbook).toContain('pm2 pid prod-jin');
    expect(runbook).toContain('ps -p <PID> -o lstart=');
    expect(runbook).toContain('legacy compatibility, not this operator runbook');
  });
});

// The real entrypoint needs @imajin/auth built (deploy builds packages first).
// Locally this runs once `pnpm --filter "@imajin/auth..." build` has.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entrypoint = join(repoRoot, 'scripts', 'key-rotation.mjs');
const built = existsSync(join(repoRoot, 'packages', 'auth', 'dist', 'key-rotation.js'));

describe.skipIf(!built)('key-rotation.mjs entrypoint', () => {
  it('generates in a real process with only paths in argv, no keys in child env, and captures both streams', async () => {
    const f = await rotationFixture();
    const run = (command, filename = f.filename) => spawnSync(process.execPath, [entrypoint, command, '--env-file', filename], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {},
    });
    const result = run('generate');

    expect(result.status).toBe(0);
    const generated = parseEnv(await fs.readFile(f.filename, 'utf8')).AUTH_PRIVATE_KEY;
    const generatedPublic = authCrypto.getPublicKey(generated);
    expect(result.stdout).toContain(generatedPublic);
    expectNoPrivateMaterial(result.stdout + result.stderr, f.oldKey.privateKey, generated);
    const signed = spawnSync(process.execPath, [
      '--', entrypoint, 'sign', '--env-file', f.filename, '--effective-at', '2026-10-06T12:00:00.000Z',
    ], { cwd: repoRoot, encoding: 'utf8', env: {} });
    expect(signed.status).toBe(0);
    expectNoPrivateMaterial(signed.stdout + signed.stderr, f.oldKey.privateKey, generated);
    const payload = JSON.parse(signed.stdout);
    expect(keyRotation.verifyKeyRotatedPayload(payload).ok).toBe(true);
    expect(payload.oldPublicKey).toBe(f.oldKey.publicKey);
    expect(payload.newPublicKey).toBe(generatedPublic);
    const preflight = run('preflight');
    expect(preflight.status).toBe(0);
    expectNoPrivateMaterial(preflight.stdout + preflight.stderr, f.oldKey.privateKey, generated);
    for (const filename of [f.filename, join(f.directory, 'missing')]) {
      const failure = run('generate', filename);
      // Some Node versions consume --env-file before the script, returning 9
      // for a missing file. Either path must remain free of private material.
      expect(failure.status).not.toBe(0);
      expectNoPrivateMaterial(failure.stdout + failure.stderr, f.oldKey.privateKey, generated);
    }
    const guarded = spawnSync(process.execPath, ['--', entrypoint, 'generate', '--env-file', join(f.directory, 'missing')], {
      cwd: repoRoot, encoding: 'utf8', env: {},
    });
    expect(guarded.status).toBe(1);
    expectNoPrivateMaterial(guarded.stdout + guarded.stderr, f.oldKey.privateKey, generated);
    await fs.chmod(f.filename, 0o000);
    const unreadable = spawnSync(process.execPath, ['--', entrypoint, 'generate', '--env-file', f.filename], {
      cwd: repoRoot, encoding: 'utf8', env: {},
    });
    expect(unreadable.status).toBe(1);
    expectNoPrivateMaterial(unreadable.stdout + unreadable.stderr, f.oldKey.privateKey, generated);
    await fs.chmod(f.filename, 0o600);
    const destroyed = run('destroy');
    expect(destroyed.status).toBe(0);
    expectNoPrivateMaterial(destroyed.stdout + destroyed.stderr, f.oldKey.privateKey, generated);
  });

  it('exits 2 with usage for an unknown subcommand', () => {
    const result = spawnSync(process.execPath, [entrypoint, 'nope'], { cwd: repoRoot, encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Usage: node scripts\/key-rotation\.mjs/);
  });
});
