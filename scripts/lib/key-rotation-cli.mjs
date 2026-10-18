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
 *   sign       offline, AFTER the restart: dual-sign the rotation at --effective-at, print the PUBLIC payload as JSON
 *   submit     POST that payload to the kernel's admin endpoint
 *   verify     GET the kernel's key-history verdict; exit 1 when it fails
 *
 * `generate` mints a seed in-process and installs it without shell/env transport.
 * Private keys and filesystem/crypto exception text are never printed by it.
 * `sign` writes public material and signatures only.
 */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual, parseEnv } from 'node:util';

const USAGE = [
  'Usage: node scripts/key-rotation.mjs <generate|destroy|preflight|sign|submit|verify> [options]',
  '  generate   --env-file <file> [--grace-hours N]  mint and install; exclusive <file>.key-rotation.bak rollback backup',
  '  destroy    --env-file <file>            remove the rotation backup after verification',
  '  preflight  [--grace-hours N]            needs OLD_AUTH_PRIVATE_KEY, NEW_AUTH_PRIVATE_KEY',
  '  sign       --effective-at ISO-8601      the instant the new key began signing; needs OLD_AUTH_PRIVATE_KEY, NEW_AUTH_PRIVATE_KEY; payload JSON on stdout',
  '  submit     --payload <file>             needs KERNEL_ADMIN_COOKIE; KERNEL_BASE_URL (default http://localhost:3000)',
  '  verify     [--anchor PUBLIC_KEY_HEX]    needs KERNEL_ADMIN_COOKIE; exits 1 if the history check fails',
].join('\n');

const DEFAULT_BASE_URL = 'http://localhost:3000';
const ROTATION_PATH = '/api/admin/keys/rotation';
const FLAGS_BY_COMMAND = {
  generate: ['env-file', 'grace-hours'],
  destroy: ['env-file'],
  preflight: ['grace-hours'],
  sign: ['effective-at'],
  submit: ['payload'],
  verify: ['anchor'],
};
const PRIVATE_KEY_NAME = 'AUTH_PRIVATE_KEY';
const ROTATION_ENV_NAMES = new Set([
  PRIVATE_KEY_NAME,
  'AUTH_PREVIOUS_PUBLIC_KEY',
  'AUTH_PREVIOUS_PUBLIC_KEY_VALID_FROM',
  'AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL',
]);
const BACKUP_SUFFIX = '.key-rotation.bak';
function assignmentEnd(lines, start, value) {
  const quote = value.trimStart()[0];
  if (!['"', "'", '`'].includes(quote) || value.trimStart().slice(1).includes(quote)) return start;
  let end = start + 1;
  while (end < lines.length && !lines[end].includes(quote)) end += 1;
  if (end === lines.length) throw new Error('Unterminated env value');
  return end;
}

/** Identify whole assignments, not apparent assignments inside multiline values. */
function envAssignments(text) {
  const lines = text.split(/(?<=\n)/);
  const assignments = new Map();
  let cursor = 0;
  while (cursor < lines.length) {
    const start = cursor;
    const match = /^[ \t]*(?:export[ \t]+)?([A-Za-z_]\w*)[ \t]*=[ \t]*(.*)/.exec(lines[cursor]);
    cursor += 1;
    if (!match) continue;
    const end = assignmentEnd(lines, start, match[2]);
    cursor = end + 1;
    const name = match[1];
    if (!ROTATION_ENV_NAMES.has(name)) continue;
    if (assignments.has(name)) throw new Error('Duplicate rotation assignment');
    assignments.set(name, { start, end });
  }
  return { lines, assignments };
}

function replaceAssignments(lines, assignments, values, newline) {
  for (const [name, value] of Object.entries(values)) {
    const entry = assignments.get(name);
    if (entry) {
      const ending = lines[entry.end].endsWith('\n') ? newline : '';
      lines[entry.start] = `${name}=${value}${ending}`;
      for (let i = entry.start + 1; i <= entry.end; i += 1) lines[i] = '';
    }
  }
}

function rewriteRotationEnv(text, values) {
  const { lines, assignments } = envAssignments(text);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  replaceAssignments(lines, assignments, values, newline);
  let rewritten = lines.join('');
  for (const [name, value] of Object.entries(values)) {
    if (assignments.has(name)) continue;
    if (rewritten && !rewritten.endsWith('\n')) rewritten += newline;
    rewritten += `${name}=${value}${newline}`;
  }
  // Node's parser is the authority. Refuse unusual syntax rather than silently
  // changing an unrelated multiline value or installing an ineffective key.
  const before = parseEnv(text);
  const after = parseEnv(rewritten);
  const expected = { ...before, ...values };
  if (!isDeepStrictEqual(after, expected)) {
    throw new Error('Env rewrite changed assignment semantics');
  }
  return rewritten;
}

/** No symlink following, devices, directories or unreadable files, even as root. */
async function readRegularEnv(fileSystem, filename) {
  const handle = await fileSystem.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o444) === 0) throw new Error('Not a readable regular env file');
    const bytes = await handle.readFile();
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw new Error('Env file is not UTF-8');
    return { text, stat };
  } finally {
    await handle.close();
  }
}

async function writePrivateFile(handle, text) {
  try {
    // chmod also defeats a restrictive umask: both files must be exactly 0600.
    await handle.chmod(0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function installRotationEnv(fileSystem, filename, original, rewritten) {
  const backup = `${filename}${BACKUP_SUFFIX}`;
  // Exclusive creation is the rotation lock: never overwrite an earlier rollback.
  const backupHandle = await fileSystem.open(backup, 'wx', 0o600);
  try {
    await writePrivateFile(backupHandle, original.text);
  } catch {
    // We own this exclusive pathname and have not touched the env. Do not
    // leave a partial write masquerading as a usable rollback backup.
    await fileSystem.unlink(backup);
    throw new Error('Could not complete rollback backup');
  }
  const temporary = path.join(path.dirname(filename), `.key-rotation-${randomUUID()}.tmp`);
  const temporaryHandle = await fileSystem.open(temporary, 'wx', 0o600);
  try {
    await writePrivateFile(temporaryHandle, rewritten);
    const current = await readRegularEnv(fileSystem, filename);
    if (current.stat.ino !== original.stat.ino || current.stat.dev !== original.stat.dev || current.text !== original.text) {
      throw new Error('Env changed during rotation');
    }
    await fileSystem.rename(temporary, filename);
  } catch {
    // No cleanup after a successful commit: a cleanup error must not report
    // installation failure after the env was already replaced.
    await fileSystem.rm(temporary, { force: true });
    throw new Error('Atomic env installation failed');
  }
}

async function generate({ keyRotation, out, fileSystem = fs, generatePrivateKey = () => randomBytes(32).toString('hex') }, flags) {
  if (!flags['env-file']) {
    out.error('--env-file <file> is required');
    return 2;
  }
  try {
    const filename = path.resolve(flags['env-file']);
    const original = await readRegularEnv(fileSystem, filename);
    const { assignments } = envAssignments(original.text);
    if (!assignments.has(PRIVATE_KEY_NAME)) throw new Error('Missing current key assignment');
    const newPrivateKey = generatePrivateKey();
    const check = keyRotation.evaluateKeyRotationPreflight({
      oldPrivateKey: parseEnv(original.text)[PRIVATE_KEY_NAME],
      newPrivateKey,
      graceHours: flags['grace-hours'] === undefined ? keyRotation.DEFAULT_GRACE_HOURS : Number(flags['grace-hours']),
    });
    if (!check.ok) {
      out.error('FAIL: rotation preflight rejected the current key or grace window; env unchanged');
      return 1;
    }
    const rewritten = rewriteRotationEnv(original.text, { [PRIVATE_KEY_NAME]: newPrivateKey, ...check.previousKeyEnv });
    await installRotationEnv(fileSystem, filename, original, rewritten);
    out.log(`old key: ${check.oldKey.kid}  public ${check.oldKey.publicKey}`);
    out.log(`new key: ${check.newKey.kid}  public ${check.newKey.publicKey}`);
    for (const warning of check.warnings) out.log(`WARNING: ${warning}`);
    out.log('OK: env installed atomically; rollback backup retained with suffix .key-rotation.bak (0600)');
    return 0;
  } catch {
    // Never interpolate input, env content, or exceptions: even a filesystem
    // error may contain secret-bearing input. A backup is retained on failure.
    out.error('FAIL: could not generate/install rotation; check env access, format and existing .key-rotation.bak backup before retrying');
    return 1;
  }
}

async function destroy({ out, fileSystem = fs }, flags) {
  if (!flags['env-file']) {
    out.error('--env-file <file> is required');
    return 2;
  }
  try {
    const backup = `${path.resolve(flags['env-file'])}${BACKUP_SUFFIX}`;
    const stat = await fileSystem.lstat(backup);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Not a regular backup');
    await fileSystem.unlink(backup);
    out.log('OK: rotation backup removed; storage snapshots and external copies require separate retirement');
    return 0;
  } catch {
    out.error('FAIL: could not destroy rotation backup; check that a regular .key-rotation.bak file exists and is removable');
    return 1;
  }
}

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
    if (!arg.startsWith('--') || !allowed.includes(name)) {
      return { error: ['generate', 'destroy'].includes(command) ? 'Unexpected argument' : `Unexpected argument '${sanitizeForLog(arg)}'` };
    }
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
  let base = env.KERNEL_BASE_URL || DEFAULT_BASE_URL;
  // Trim trailing slashes without a regex (a `/+$` pattern backtracks super-linearly, S8786).
  while (base.endsWith('/')) base = base.slice(0, -1);
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
  // `effectiveAt` is the instant the NEW key began signing, i.e. when the restarted kernel came
  // up. There is deliberately no default: "now" at signing time is wrong whenever signing and
  // the swap are not the same moment, and anything the old key signed after `effectiveAt` would
  // later verify as invalid (#2081).
  if (flags['effective-at'] === undefined) {
    out.error(`--effective-at is required: the UTC instant the restarted kernel began signing with the new key\n${USAGE}`);
    return 2;
  }
  const effectiveAt = new Date(flags['effective-at']);
  if (Number.isNaN(effectiveAt.getTime())) {
    out.error(`--effective-at must be an ISO-8601 instant\n${USAGE}`);
    return 2;
  }

  const check = keyRotation.evaluateKeyRotationPreflight({
    oldPrivateKey: env.OLD_AUTH_PRIVATE_KEY,
    newPrivateKey: env.NEW_AUTH_PRIVATE_KEY,
  });
  if (!check.ok) {
    for (const error of check.errors) out.error(`ERROR: ${error}`);
    out.error('FAIL: refusing to sign — fix the key pair first (run `preflight`)');
    return 1;
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
  out.error('Next: `submit` this payload (after the Phase 2 sweep and the identity-row update), then destroy the old private key.');
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

  out.log(`node DID:    ${sanitizeForLog(report.nodeDid ?? '(none)')} (source: ${sanitizeForLog(report.nodeDidSource ?? 'unknown')})`);
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

const COMMANDS = { generate, destroy, preflight, sign, submit, verify };

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
