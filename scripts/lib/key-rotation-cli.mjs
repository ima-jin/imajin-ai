/**
 * scripts/lib/key-rotation-cli.mjs (#2081)
 *
 * The logic behind `scripts/key-rotation.mjs` — the machine checks for the
 * AUTH_PRIVATE_KEY rotation runbook (docs/security/node-key-roles-and-rotation.md).
 * Kept dependency-injected (the pure crypto module, env, fetch, file reads and
 * output streams are all passed in) so every branch is unit-testable without a
 * built package, a network or a kernel. No kernel code is imported: a script
 * that pulled in the kernel's modules would hit the ESM-only-dependency
 * failure class of #2483/#2485.
 *
 * Subcommands, one per gate of the ceremony:
 *   preflight  pure check of the old/new key pair; prints the grace-window env
 *   sign       offline: dual-sign the rotation, print the PUBLIC payload as JSON
 *   submit     POST that payload to the kernel's admin endpoint
 *   verify     GET the kernel's key-history verdict; exit 1 when it fails
 *
 * Private keys are only ever read from the environment, handed to the crypto
 * module, and never printed. `sign` writes public material and signatures only.
 */

const USAGE = [
  'Usage: node scripts/key-rotation.mjs <preflight|sign|submit|verify> [options]',
  '  preflight  [--grace-hours N]            needs OLD_AUTH_PRIVATE_KEY, NEW_AUTH_PRIVATE_KEY',
  '  sign       [--effective-at ISO-8601]    needs OLD_AUTH_PRIVATE_KEY, NEW_AUTH_PRIVATE_KEY; payload JSON on stdout',
  '  submit     --payload <file>             needs KERNEL_ADMIN_COOKIE; KERNEL_BASE_URL (default http://localhost:3000)',
  '  verify     [--anchor PUBLIC_KEY_HEX]    needs KERNEL_ADMIN_COOKIE; exits 1 if the history check fails',
].join('\n');

const DEFAULT_BASE_URL = 'http://localhost:3000';
const ROTATION_PATH = '/api/admin/keys/rotation';
const FLAGS_BY_COMMAND = {
  preflight: ['grace-hours'],
  sign: ['effective-at'],
  submit: ['payload'],
  verify: ['anchor'],
};

/** Strip control characters before logging response-derived values (log injection, S5145). */
function sanitizeForLog(value) {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ');
}

/** Parse `--flag value` / `--flag=value` for the flags a command allows. Returns `{ flags }` or `{ error }`. */
function parseFlags(command, args) {
  const allowed = FLAGS_BY_COMMAND[command];
  const flags = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    i += 1;
    const equals = arg.indexOf('=');
    const name = (equals === -1 ? arg : arg.slice(0, equals)).replace(/^--/, '');
    if (!arg.startsWith('--') || !allowed.includes(name)) return { error: `Unexpected argument '${sanitizeForLog(arg)}'` };
    let value = arg.slice(equals + 1);
    if (equals === -1) {
      value = args[i];
      i += 1;
    }
    if (value === undefined || value === '') return { error: `--${name} needs a value` };
    flags[name] = value;
  }
  return { flags };
}

function adminRequestInit(env, method, body) {
  const cookie = env.KERNEL_ADMIN_COOKIE;
  if (!cookie) return { error: 'KERNEL_ADMIN_COOKIE is required (the full Cookie header from a logged-in admin session)' };
  const headers = { Cookie: cookie };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return { init: { method, headers, ...(body === undefined ? {} : { body }) } };
}

function rotationUrl(env, query = '') {
  const base = (env.KERNEL_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return `${base}${ROTATION_PATH}${query}`;
}

function preflight({ keyRotation, env, out }, flags) {
  const graceHours = flags['grace-hours'] === undefined ? keyRotation.DEFAULT_GRACE_HOURS : Number(flags['grace-hours']);
  const result = keyRotation.evaluateKeyRotationPreflight({
    oldPrivateKey: env.OLD_AUTH_PRIVATE_KEY,
    newPrivateKey: env.NEW_AUTH_PRIVATE_KEY,
    graceHours,
  });

  if (result.oldKey) out.log(`old key: ${result.oldKey.kid}  public ${result.oldKey.publicKey}`);
  if (result.newKey) out.log(`new key: ${result.newKey.kid}  public ${result.newKey.publicKey}`);
  for (const warning of result.warnings) out.log(`WARNING: ${warning}`);
  for (const error of result.errors) out.error(`ERROR: ${error}`);

  if (!result.ok) {
    out.error('FAIL: not a usable rotation — do not swap AUTH_PRIVATE_KEY');
    return 1;
  }

  out.log('\nSet on the kernel together with the new AUTH_PRIVATE_KEY (grace window, #2244):');
  for (const [name, value] of Object.entries(result.previousKeyEnv ?? {})) out.log(`  ${name}=${value}`);
  out.log('\nOK: rotation pair is usable');
  return 0;
}

function sign({ keyRotation, env, out }, flags) {
  const check = keyRotation.evaluateKeyRotationPreflight({
    oldPrivateKey: env.OLD_AUTH_PRIVATE_KEY,
    newPrivateKey: env.NEW_AUTH_PRIVATE_KEY,
  });
  if (!check.ok) {
    for (const error of check.errors) out.error(`ERROR: ${error}`);
    out.error('FAIL: refusing to sign — fix the key pair first (run `preflight`)');
    return 1;
  }

  const effectiveAt = flags['effective-at'] === undefined ? undefined : new Date(flags['effective-at']);
  if (effectiveAt && Number.isNaN(effectiveAt.getTime())) {
    out.error(`--effective-at must be an ISO-8601 instant\n${USAGE}`);
    return 2;
  }

  const payload = keyRotation.createKeyRotatedPayload({
    oldPrivateKey: env.OLD_AUTH_PRIVATE_KEY,
    newPrivateKey: env.NEW_AUTH_PRIVATE_KEY,
    effectiveAt,
  });
  // The payload (public keys + two signatures) goes to stdout so it can be redirected to a file;
  // everything human-readable goes to stderr.
  out.log(JSON.stringify(payload, null, 2));
  out.error(`signed ${payload.oldKid} -> ${payload.newKid} effective ${payload.effectiveAt}`);
  out.error('Next: swap AUTH_PRIVATE_KEY + restart, then `submit` this payload, then destroy the old private key.');
  return 0;
}

async function submit({ env, fetchImpl, readFile, out }, flags) {
  if (!flags.payload) {
    out.error(`--payload <file> is required\n${USAGE}`);
    return 2;
  }
  let body;
  try {
    body = JSON.stringify(JSON.parse(await readFile(flags.payload, 'utf8')));
  } catch (err) {
    out.error(`FAIL: could not read a JSON payload from ${sanitizeForLog(flags.payload)}: ${sanitizeForLog(err.message)}`);
    return 1;
  }

  const request = adminRequestInit(env, 'POST', body);
  if (request.error) {
    out.error(request.error);
    return 2;
  }

  const res = await fetchImpl(rotationUrl(env), request.init);
  const json = await res.json().catch(() => ({}));
  if (res.status !== 201) {
    out.error(`FAIL: kernel answered ${res.status}: ${sanitizeForLog(json.error ?? 'no error message')}`);
    return 1;
  }
  out.log(`key.rotated recorded: ${sanitizeForLog(json.attestationId)}`);
  out.log(`  ${sanitizeForLog(json.oldKid)} -> ${sanitizeForLog(json.newKid)}  effective ${sanitizeForLog(json.effectiveAt)}`);
  out.log('Next: run `verify`, then destroy the old private key.');
  return 0;
}

async function verify({ env, fetchImpl, out }, flags) {
  const request = adminRequestInit(env, 'GET');
  if (request.error) {
    out.error(request.error);
    return 2;
  }
  const query = flags.anchor ? `?anchor=${encodeURIComponent(flags.anchor)}` : '';

  const res = await fetchImpl(rotationUrl(env, query), request.init);
  const report = await res.json().catch(() => ({}));
  if (res.status !== 200 || typeof report.ok !== 'boolean') {
    out.error(`FAIL: kernel answered ${res.status}: ${sanitizeForLog(report.error ?? 'unexpected response')}`);
    return 1;
  }

  out.log(`node DID:    ${sanitizeForLog(report.nodeDid ?? '(none)')}`);
  out.log(`current kid: ${sanitizeForLog(report.currentKid ?? '(none)')}`);
  out.log(`rotations:   ${sanitizeForLog(report.rotations)}`);
  for (const entry of report.history ?? []) {
    out.log(`  ${sanitizeForLog(entry.kid)}  ${sanitizeForLog(entry.validFrom ?? '(genesis)')} -> ${sanitizeForLog(entry.validUntil ?? '(current)')}`);
  }
  for (const warning of report.warnings ?? []) out.log(`WARNING: ${sanitizeForLog(warning)}`);
  for (const error of report.errors ?? []) out.error(`ERROR: ${sanitizeForLog(error)}`);

  out.log(report.ok ? 'OK: key history is verifiable and ends at the loaded key' : 'FAIL: key history check failed');
  return report.ok ? 0 : 1;
}

const COMMANDS = { preflight, sign, submit, verify };

/**
 * Run the CLI. Returns the process exit code: 0 ok, 1 a check failed, 2 bad usage.
 *
 * @param {string[]} argv      arguments after the script name
 * @param {object}   deps
 * @param {object}   deps.keyRotation  the `@imajin/auth/key-rotation` module
 * @param {Record<string,string|undefined>} deps.env
 * @param {typeof fetch} deps.fetchImpl
 * @param {(path: string, encoding: string) => Promise<string>} deps.readFile
 * @param {{ log: (line: string) => void, error: (line: string) => void }} deps.out
 */
export async function runKeyRotationCli(argv, deps) {
  const [command, ...args] = argv;
  if (!Object.hasOwn(COMMANDS, command ?? '')) {
    deps.out.error(`Unknown or missing subcommand '${sanitizeForLog(command ?? '')}'\n${USAGE}`);
    return 2;
  }

  const parsed = parseFlags(command, args);
  if (parsed.error) {
    deps.out.error(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  return COMMANDS[command](deps, parsed.flags);
}
