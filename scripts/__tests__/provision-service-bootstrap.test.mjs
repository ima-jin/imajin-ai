import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createKernelDeps,
  discoverExternalService,
  discoverServices,
  dryRunServices,
  envLocalLabel,
  formatResult,
  grantKindFor,
  provisionServices,
} from '../lib/provision-service-bootstrap.ts';

// The DB / vault side effects (kernel identity insert, grantInternalSecretTo)
// are injected via `deps`, so no database is needed. `@imajin/auth`'s real
// keypair primitives are exercised through createKernelDeps().mintIdentity.

const roots = [];

/** A throwaway repo root with apps/<name>/.env.example (and an empty .env.local) for each service. */
function makeRoot(services = { market: 'MARKET', events: 'EVENTS' }) {
  const root = mkdtempSync(join(tmpdir(), 'provision-bootstrap-test-'));
  roots.push(root);
  for (const [name, prefix] of Object.entries(services)) {
    mkdirSync(join(root, 'apps', name), { recursive: true });
    writeFileSync(
      join(root, 'apps', name, '.env.example'),
      `# comment\nPORT=\n${prefix}_VAULT_BOOTSTRAP_DID=\n${prefix}_VAULT_BOOTSTRAP_PRIVATE_KEY=\n`,
    );
    writeFileSync(join(root, 'apps', name, '.env.local'), '');
  }
  return root;
}

const envLocal = (root, service) => join(root, 'apps', service, '.env.local');

function makeDeps(overrides = {}) {
  let minted = 0;
  return {
    mintIdentity: vi.fn(async () => {
      minted += 1;
      return {
        did: `did:imajin:minted${minted}`,
        publicKey: `pub${minted}`,
        privateKey: `SECRET-PRIVATE-KEY-${minted}`,
      };
    }),
    identityFromPrivateKey: vi.fn(async () => null),
    registerIdentity: vi.fn(async () => {}),
    ensureGrant: vi.fn(async (did) => ({ status: 'ok', grantId: `vdg_${did}` })),
    ensureCronSecretGrant: vi.fn(async (did) => ({ status: 'ok', grantId: `vdg_cron_${did}` })),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('discoverServices', () => {
  it('finds services from apps/*/.env.example, never from a hardcoded list', () => {
    const root = makeRoot({ market: 'MARKET', zeta: 'ZETA' });
    mkdirSync(join(root, 'apps', 'kernel'), { recursive: true });
    writeFileSync(join(root, 'apps', 'kernel', '.env.example'), 'PORT=\n');
    mkdirSync(join(root, 'apps', 'optional'), { recursive: true });
    writeFileSync(
      join(root, 'apps', 'optional', '.env.example'),
      '# transition (#2246): required together later\n# optional\nOPTIONAL_VAULT_BOOTSTRAP_DID=\n# optional\nOPTIONAL_VAULT_BOOTSTRAP_PRIVATE_KEY=\n',
    );
    mkdirSync(join(root, 'apps', 'commented'), { recursive: true });
    writeFileSync(join(root, 'apps', 'commented', '.env.example'), '# COMMENTED_VAULT_BOOTSTRAP_DID=\n');

    expect(discoverServices(root)).toEqual([
      { name: 'market', didKey: 'MARKET_VAULT_BOOTSTRAP_DID', privateKeyKey: 'MARKET_VAULT_BOOTSTRAP_PRIVATE_KEY' },
      { name: 'zeta', didKey: 'ZETA_VAULT_BOOTSTRAP_DID', privateKeyKey: 'ZETA_VAULT_BOOTSTRAP_PRIVATE_KEY' },
    ]);
  });

  it('discovers the real repo services declared in apps/*/.env.example', () => {
    const realRoot = join(import.meta.dirname, '..', '..');
    const names = discoverServices(realRoot).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['events']));
    // corpus annotates its pair `# optional` (hand-provisioned) — not ours to mint.
    expect(names).not.toContain('corpus');
  });

  it("discovers the kernel's cron scheduler identity (KERNEL_CRON_VAULT_BOOTSTRAP_*) from the real kernel .env.example", () => {
    const realRoot = join(import.meta.dirname, '..', '..');
    const kernel = discoverServices(realRoot).find((s) => s.name === 'kernel');
    expect(kernel).toEqual({
      name: 'kernel',
      didKey: 'KERNEL_CRON_VAULT_BOOTSTRAP_DID',
      privateKeyKey: 'KERNEL_CRON_VAULT_BOOTSTRAP_PRIVATE_KEY',
    });
  });
});

describe('cron-secret grant (#2550)', () => {
  it('grants the cron secret to the kernel identity and the attestation key to every other service', () => {
    expect(grantKindFor({ name: 'kernel' })).toBe('cron-secret');
    for (const name of ['events']) {
      expect(grantKindFor({ name })).toBe('attestation-internal-api-key');
    }
  });

  it('mints the kernel scheduler identity and grants ONLY the cron secret to it, with no hand-pasted value', async () => {
    const root = makeRoot({ kernel: 'KERNEL_CRON', market: 'MARKET' });
    const deps = makeDeps();

    const results = await provisionServices(root, discoverServices(root), deps);

    const kernel = results.find((r) => r.service === 'kernel');
    expect(kernel).toMatchObject({ status: 'minted', grantId: `vdg_cron_${kernel.did}` });
    expect(deps.ensureCronSecretGrant).toHaveBeenCalledTimes(1);
    expect(deps.ensureCronSecretGrant).toHaveBeenCalledWith(kernel.did);
    // The attestation key is only granted to the userspace service.
    const market = results.find((r) => r.service === 'market');
    expect(deps.ensureGrant).toHaveBeenCalledTimes(1);
    expect(deps.ensureGrant).toHaveBeenCalledWith(market.did);

    const local = readFileSync(envLocal(root, 'kernel'), 'utf8');
    expect(local).toContain(`KERNEL_CRON_VAULT_BOOTSTRAP_DID=${kernel.did}`);
    expect(local).toMatch(/^KERNEL_CRON_VAULT_BOOTSTRAP_PRIVATE_KEY=.+$/m);
    expect(local).not.toContain('CRON_SECRET=');
  });

  it('re-ensures the cron grant for an existing kernel identity without touching its keys', async () => {
    const root = makeRoot({ kernel: 'KERNEL_CRON' });
    const content = 'KERNEL_CRON_VAULT_BOOTSTRAP_DID=did:imajin:existing\nKERNEL_CRON_VAULT_BOOTSTRAP_PRIVATE_KEY=keep-me\n';
    writeFileSync(envLocal(root, 'kernel'), content);
    const deps = makeDeps();

    const results = await provisionServices(root, discoverServices(root), deps);

    expect(results[0]).toMatchObject({ service: 'kernel', status: 'existing', did: 'did:imajin:existing' });
    expect(deps.ensureCronSecretGrant).toHaveBeenCalledWith('did:imajin:existing');
    expect(deps.ensureGrant).not.toHaveBeenCalled();
    expect(readFileSync(envLocal(root, 'kernel'), 'utf8')).toBe(content);
  });

  it('fails the deploy with an error that names the cron secret and the vault when the grant cannot be made', async () => {
    const root = makeRoot({ kernel: 'KERNEL_CRON' });
    const failing = makeDeps({ ensureCronSecretGrant: vi.fn(async () => ({ status: 'no_reusable_grant' })) });

    const error = await provisionServices(root, discoverServices(root), failing).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/kernel: could not ensure the CRON_SECRET \(vault purpose 'kernel\.cron-secret'\) grant/);
    expect(error.message).not.toMatch(/\.env\.local/);
  });
});

describe('provisionServices', () => {
  it('mints, registers, writes and grants when both keys are missing', async () => {
    const root = makeRoot({ market: 'MARKET' });
    writeFileSync(envLocal(root, 'market'), 'PORT=3104\nNODE_ENV=production'); // no trailing newline
    const deps = makeDeps();

    const results = await provisionServices(root, discoverServices(root), deps);

    expect(results).toEqual([
      { service: 'market', did: 'did:imajin:minted1', status: 'minted', grantId: 'vdg_did:imajin:minted1' },
    ]);
    expect(deps.registerIdentity).toHaveBeenCalledWith({
      did: 'did:imajin:minted1',
      publicKey: 'pub1',
      name: 'market vault bootstrap',
    });
    expect(deps.ensureGrant).toHaveBeenCalledWith('did:imajin:minted1');
    // Existing content preserved, pair appended.
    expect(readFileSync(envLocal(root, 'market'), 'utf8')).toBe(
      'PORT=3104\nNODE_ENV=production\n' +
        'MARKET_VAULT_BOOTSTRAP_DID=did:imajin:minted1\n' +
        'MARKET_VAULT_BOOTSTRAP_PRIVATE_KEY=SECRET-PRIVATE-KEY-1\n',
    );
  });

  it('writes the pair to an empty .env.local', async () => {
    const root = makeRoot({ market: 'MARKET' });

    await provisionServices(root, discoverServices(root), makeDeps());

    expect(readFileSync(envLocal(root, 'market'), 'utf8')).toBe(
      'MARKET_VAULT_BOOTSTRAP_DID=did:imajin:minted1\nMARKET_VAULT_BOOTSTRAP_PRIVATE_KEY=SECRET-PRIVATE-KEY-1\n',
    );
  });

  it('skips a service with no .env.local rather than creating a stub (which would turn check-env warnings into errors)', async () => {
    const root = makeRoot();
    rmSync(envLocal(root, 'events'));
    const deps = makeDeps();
    const skipped = [];

    const results = await provisionServices(root, discoverServices(root), deps, () => {}, (service) => skipped.push(service.name));

    expect(results.map((r) => r.service)).toEqual(['market']);
    expect(skipped).toEqual(['events']);
    expect(deps.mintIdentity).toHaveBeenCalledTimes(1);
    expect(() => readFileSync(envLocal(root, 'events'))).toThrow();
  });

  it('skips and never overwrites a pair that is already present', async () => {
    const root = makeRoot({ market: 'MARKET' });
    const original =
      'MARKET_VAULT_BOOTSTRAP_DID="did:imajin:existing"\nMARKET_VAULT_BOOTSTRAP_PRIVATE_KEY=existing-secret\nPORT=3104\n';
    writeFileSync(envLocal(root, 'market'), original);
    const deps = makeDeps();

    const results = await provisionServices(root, discoverServices(root), deps);

    expect(results).toEqual([
      { service: 'market', did: 'did:imajin:existing', status: 'existing', grantId: 'vdg_did:imajin:existing' },
    ]);
    expect(deps.mintIdentity).not.toHaveBeenCalled();
    expect(readFileSync(envLocal(root, 'market'), 'utf8')).toBe(original);
  });

  it('ensures the grant for existing pairs (and re-registers a DID its key derives)', async () => {
    const root = makeRoot();
    for (const service of ['market', 'events']) {
      const prefix = service.toUpperCase();
      writeFileSync(
        envLocal(root, service),
        `${prefix}_VAULT_BOOTSTRAP_DID=did:imajin:${service}\n${prefix}_VAULT_BOOTSTRAP_PRIVATE_KEY=key-${service}\n`,
      );
    }
    const deps = makeDeps({
      // market's DID is the one its key derives; events' DID was minted some other way.
      identityFromPrivateKey: vi.fn(async (privateKey) =>
        privateKey === 'key-market' ? { did: 'did:imajin:market', publicKey: 'pub-market' } : null,
      ),
    });

    const results = await provisionServices(root, discoverServices(root), deps);

    expect(results.map((r) => [r.service, r.status])).toEqual([
      ['events', 'existing'],
      ['market', 'existing'],
    ]);
    expect(deps.ensureGrant.mock.calls.map(([did]) => did).sort()).toEqual(['did:imajin:events', 'did:imajin:market']);
    expect(deps.registerIdentity).toHaveBeenCalledTimes(1);
    expect(deps.registerIdentity).toHaveBeenCalledWith({
      did: 'did:imajin:market',
      publicKey: 'pub-market',
      name: 'market vault bootstrap',
    });
  });

  it.each([
    ['only the DID is present', 'MARKET_VAULT_BOOTSTRAP_DID=did:imajin:half\n'],
    ['only the private key is present', 'MARKET_VAULT_BOOTSTRAP_PRIVATE_KEY=half-secret-value\n'],
    ['the DID is present but the private key is empty', 'MARKET_VAULT_BOOTSTRAP_DID=did:imajin:half\nMARKET_VAULT_BOOTSTRAP_PRIVATE_KEY=\n'],
    ['both keys are present but empty', 'MARKET_VAULT_BOOTSTRAP_DID=\nMARKET_VAULT_BOOTSTRAP_PRIVATE_KEY=""\n'],
  ])('errors without touching anything when %s', async (_label, content) => {
    const root = makeRoot();
    writeFileSync(envLocal(root, 'market'), content);
    const deps = makeDeps();

    const error = await provisionServices(root, discoverServices(root), deps).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/market: apps\/market\/\.env\.local must define both/);
    expect(error.message).not.toContain('half-secret-value');
    // Validation happens up front: even the healthy "events" service is untouched.
    expect(deps.mintIdentity).not.toHaveBeenCalled();
    expect(deps.registerIdentity).not.toHaveBeenCalled();
    expect(deps.ensureGrant).not.toHaveBeenCalled();
    expect(readFileSync(envLocal(root, 'market'), 'utf8')).toBe(content);
    expect(readFileSync(envLocal(root, 'events'), 'utf8')).toBe('');
  });

  it('rejects an existing DID that is not a did:imajin identity', async () => {
    const root = makeRoot({ market: 'MARKET' });
    writeFileSync(envLocal(root, 'market'), 'MARKET_VAULT_BOOTSTRAP_DID=nope\nMARKET_VAULT_BOOTSTRAP_PRIVATE_KEY=k\n');

    await expect(provisionServices(root, discoverServices(root), makeDeps())).rejects.toThrow(/must start with 'did:imajin:'/);
  });

  it('writes .env.local with mode 0600 and leaves no temp file behind', async () => {
    const root = makeRoot({ market: 'MARKET' });
    writeFileSync(envLocal(root, 'market'), 'PORT=3104\n', { mode: 0o644 });

    await provisionServices(root, discoverServices(root), makeDeps());

    expect(statSync(envLocal(root, 'market')).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(root, 'apps', 'market')).sort()).toEqual(['.env.example', '.env.local']);
  });

  it('never prints or logs a private key, in output lines, results, console or stdout/stderr', async () => {
    const root = makeRoot();
    const sinks = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
    ];
    const lines = [];

    const results = await provisionServices(root, discoverServices(root), makeDeps(), (result) => lines.push(formatResult(result)));

    const everything = [
      ...lines,
      ...results.map((r) => JSON.stringify(r)),
      ...sinks.flatMap((spy) => spy.mock.calls.map((args) => args.join(' '))),
    ].join('\n');
    expect(everything).not.toContain('SECRET-PRIVATE-KEY');
    expect(lines).toEqual([
      'events · did:imajin:minted1 · minted · vdg_did:imajin:minted1',
      'market · did:imajin:minted2 · minted · vdg_did:imajin:minted2',
    ]);
    // ...while the key really is on disk for the service.
    expect(readFileSync(envLocal(root, 'events'), 'utf8')).toContain('SECRET-PRIVATE-KEY-1');
  });

  it('fails the run when the grant cannot be ensured, and self-heals on the next run', async () => {
    const root = makeRoot({ market: 'MARKET' });
    const failing = makeDeps({ ensureGrant: vi.fn(async () => ({ status: 'tier1_unsupported' })) });

    await expect(provisionServices(root, discoverServices(root), failing)).rejects.toThrow(/market: could not ensure the ATTESTATION_INTERNAL_API_KEY grant.*Tier 1/);
    // The pair was written before the grant failed...
    const written = readFileSync(envLocal(root, 'market'), 'utf8');
    expect(written).toContain('MARKET_VAULT_BOOTSTRAP_DID=did:imajin:minted1');

    // ...so the retry sees an existing pair (no rotation) and only ensures the grant.
    const healthy = makeDeps();
    const results = await provisionServices(root, discoverServices(root), healthy);
    expect(results).toEqual([
      { service: 'market', did: 'did:imajin:minted1', status: 'existing', grantId: 'vdg_did:imajin:minted1' },
    ]);
    expect(healthy.mintIdentity).not.toHaveBeenCalled();
    expect(readFileSync(envLocal(root, 'market'), 'utf8')).toBe(written);
  });
});

// #2712: a standalone app (links) lives in its own repo — targeted by checkout dir.
describe('standalone app checkout (#2712)', () => {
  /** A throwaway app checkout OUTSIDE the kernel root, with a links-style .env.example. */
  function makeCheckout({ name = 'links', prefix = 'LINKS', envLocal = '' } = {}) {
    const parent = mkdtempSync(join(tmpdir(), 'provision-external-test-'));
    roots.push(parent);
    const dir = join(parent, name);
    mkdirSync(dir);
    writeFileSync(
      join(dir, '.env.example'),
      `PORT=\n# comment\n${prefix}_VAULT_BOOTSTRAP_DID=\n${prefix}_VAULT_BOOTSTRAP_PRIVATE_KEY=\n`,
    );
    if (envLocal !== null) writeFileSync(join(dir, '.env.local'), envLocal);
    return dir;
  }

  it('discovers the bootstrap pair from the checkout .env.example, named after the directory', () => {
    const dir = makeCheckout();
    expect(discoverExternalService(dir)).toEqual({
      name: 'links',
      didKey: 'LINKS_VAULT_BOOTSTRAP_DID',
      privateKeyKey: 'LINKS_VAULT_BOOTSTRAP_PRIVATE_KEY',
      dir,
    });
    expect(discoverExternalService(dir, 'slug').name).toBe('slug');
  });

  it('rejects a checkout with no .env.example, no pair, or an optional pair', () => {
    const empty = mkdtempSync(join(tmpdir(), 'provision-external-test-'));
    roots.push(empty);
    expect(() => discoverExternalService(empty)).toThrow(/has no \.env\.example/);

    const noPair = makeCheckout();
    writeFileSync(join(noPair, '.env.example'), 'PORT=\n# LINKS_VAULT_BOOTSTRAP_DID=\n');
    expect(() => discoverExternalService(noPair)).toThrow(/declares no required <SVC>_VAULT_BOOTSTRAP_DID/);

    const optional = makeCheckout();
    writeFileSync(join(optional, '.env.example'), '# optional\nLINKS_VAULT_BOOTSTRAP_DID=\n');
    expect(() => discoverExternalService(optional)).toThrow(/declares no required/);
  });

  it('mints, registers, writes (0600, atomic) and grants into the checkout .env.local, never into the kernel apps/', async () => {
    const dir = makeCheckout({ envLocal: 'PORT=3102\n' });
    writeFileSync(join(dir, '.env.local'), 'PORT=3102\n', { mode: 0o644 });
    const kernelRoot = makeRoot({ market: 'MARKET' });
    const deps = makeDeps();

    const results = await provisionServices(kernelRoot, [discoverExternalService(dir)], deps);

    expect(results).toEqual([
      { service: 'links', did: 'did:imajin:minted1', status: 'minted', grantId: 'vdg_did:imajin:minted1' },
    ]);
    expect(deps.registerIdentity).toHaveBeenCalledWith({
      did: 'did:imajin:minted1',
      publicKey: 'pub1',
      name: 'links vault bootstrap',
    });
    expect(deps.ensureGrant).toHaveBeenCalledWith('did:imajin:minted1');
    expect(deps.ensureCronSecretGrant).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe(
      'PORT=3102\nLINKS_VAULT_BOOTSTRAP_DID=did:imajin:minted1\nLINKS_VAULT_BOOTSTRAP_PRIVATE_KEY=SECRET-PRIVATE-KEY-1\n',
    );
    expect(statSync(join(dir, '.env.local')).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir).sort()).toEqual(['.env.example', '.env.local']);
    expect(readdirSync(join(kernelRoot, 'apps'))).toEqual(['market']);
    expect(readFileSync(envLocal(kernelRoot, 'market'), 'utf8')).toBe('');
  });

  it('is idempotent: a re-run keeps the pair and only re-ensures the grant', async () => {
    const dir = makeCheckout();
    const kernelRoot = makeRoot({ market: 'MARKET' });
    await provisionServices(kernelRoot, [discoverExternalService(dir)], makeDeps());
    const written = readFileSync(join(dir, '.env.local'), 'utf8');

    const deps = makeDeps();
    const results = await provisionServices(kernelRoot, [discoverExternalService(dir)], deps);

    expect(results[0]).toMatchObject({ service: 'links', status: 'existing', did: 'did:imajin:minted1' });
    expect(deps.mintIdentity).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe(written);
  });

  it('prints and logs only the grant id, never the private key', async () => {
    const dir = makeCheckout();
    const sinks = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true),
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true),
    ];
    const lines = [];

    const results = await provisionServices(makeRoot(), [discoverExternalService(dir)], makeDeps(), (result) =>
      lines.push(formatResult(result)),
    );

    const everything = [
      ...lines,
      ...results.map((r) => JSON.stringify(r)),
      ...sinks.flatMap((spy) => spy.mock.calls.map((args) => args.join(' '))),
    ].join('\n');
    expect(everything).not.toContain('SECRET-PRIVATE-KEY');
    expect(lines).toEqual(['links · did:imajin:minted1 · minted · vdg_did:imajin:minted1']);
  });

  it('fails when .env.local is missing: nothing is minted, written or granted, and no stub is created', async () => {
    const dir = makeCheckout({ envLocal: null });
    const deps = makeDeps();
    const skipped = [];

    const error = await provisionServices(makeRoot(), [discoverExternalService(dir)], deps, () => {}, (s) => skipped.push(s)).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(`links: ${join(dir, '.env.local')} does not exist \u2014 create it first`);
    expect(skipped).toEqual([]);
    expect(deps.mintIdentity).not.toHaveBeenCalled();
    expect(deps.ensureGrant).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(['.env.example']);
  });

  it('fails non-zero on a half-written pair, naming the file but never the key', async () => {
    const content = 'LINKS_VAULT_BOOTSTRAP_PRIVATE_KEY=half-secret-value\n';
    const dir = makeCheckout({ envLocal: content });
    const deps = makeDeps();

    const error = await provisionServices(makeRoot(), [discoverExternalService(dir)], deps).catch((err) => err);

    expect(error.message).toContain(`links: ${join(dir, '.env.local')} must define both LINKS_VAULT_BOOTSTRAP_DID and`);
    expect(error.message).not.toContain('half-secret-value');
    expect(deps.mintIdentity).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe(content);
  });

  it('a failed grant after the write fails the run, then self-heals without rotating the key', async () => {
    const dir = makeCheckout();
    const failing = makeDeps({ ensureGrant: vi.fn(async () => ({ status: 'no_reusable_grant' })) });

    await expect(provisionServices(makeRoot(), [discoverExternalService(dir)], failing)).rejects.toThrow(
      /links: could not ensure the ATTESTATION_INTERNAL_API_KEY grant/,
    );
    const written = readFileSync(join(dir, '.env.local'), 'utf8');

    const healthy = makeDeps();
    const results = await provisionServices(makeRoot(), [discoverExternalService(dir)], healthy);
    expect(results[0]).toMatchObject({ status: 'existing' });
    expect(healthy.mintIdentity).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe(written);
  });

  it('never treats an external checkout named kernel as the cron scheduler', () => {
    const dir = makeCheckout({ name: 'kernel', prefix: 'KERNEL_CRON' });
    expect(grantKindFor(discoverExternalService(dir))).toBe('attestation-internal-api-key');
  });

  it('labels .env.local repo-relative for kernel apps and absolute for a checkout', () => {
    const dir = makeCheckout();
    expect(envLocalLabel({ name: 'market' })).toBe('apps/market/.env.local');
    expect(envLocalLabel(discoverExternalService(dir))).toBe(join(dir, '.env.local'));
  });
});

describe('dryRunServices (#2483)', () => {
  it('fails a half-written pair before loading anything, and leaves .env.local untouched', async () => {
    const root = makeRoot({ market: 'MARKET' });
    const content = 'MARKET_VAULT_BOOTSTRAP_DID=did:imajin:half\n';
    writeFileSync(envLocal(root, 'market'), content);

    const error = await dryRunServices(root, discoverServices(root)).catch((err) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/market: apps\/market\/\.env\.local must define both/);
    expect(readFileSync(envLocal(root, 'market'), 'utf8')).toBe(content);
  });
});

// The first mintIdentity() dynamically imports the real @imajin/auth keypair
// primitives. On a cold module cache (fresh CI runner / merge-group run) that
// import alone can take ~5s, which trips vitest's default 5000ms test timeout
// (#2755). Give this one test a generous explicit timeout rather than raising
// the timeout for the whole file.
const COLD_IMPORT_TIMEOUT_MS = 30_000;

describe('createKernelDeps (real @imajin/auth keypair primitives)', () => {
  it('mints a did:imajin identity whose DID is derived from the public key, and re-derives it from the private key', async () => {
    const deps = createKernelDeps('operator:test');

    const minted = await deps.mintIdentity();

    expect(minted.did).toBe(`did:imajin:${minted.publicKey.slice(0, 16)}`);
    expect(minted.privateKey).toMatch(/^[0-9a-f]{64}$/);
    expect(await deps.identityFromPrivateKey(minted.privateKey)).toEqual({ did: minted.did, publicKey: minted.publicKey });
    expect(await deps.identityFromPrivateKey('not-a-key')).toBeNull();
    expect((await deps.mintIdentity()).did).not.toBe(minted.did);
  }, COLD_IMPORT_TIMEOUT_MS);
});
