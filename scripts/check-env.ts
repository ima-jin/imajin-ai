#!/usr/bin/env tsx
/**
 * check-env.ts — validate .env.local files against .env.example templates
 *
 * Usage:
 *   npx tsx scripts/check-env.ts                     # check all services (dev)
 *   npx tsx scripts/check-env.ts --env prod           # check all services (prod)
 *   npx tsx scripts/check-env.ts www auth profile     # check specific services
 *   npx tsx scripts/check-env.ts --env prod www auth  # specific services on prod
 *
 * When the kernel is among the checked services, also asserts that a configured
 * VAULT_PATH points at a file that exists (#2412) — see checkVault().
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SERVICES, type ServiceDefinition } from "../packages/config/src/services.js";

// ── ANSI colours & symbols ───────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  white: "\x1b[97m",
};

const sym = {
  ok: `${c.green}✔${c.reset}`,
  warn: `${c.yellow}⚠${c.reset}`,
  err: `${c.red}✘${c.reset}`,
  info: `${c.cyan}ℹ${c.reset}`,
  arrow: `${c.dim}→${c.reset}`,
};

function bold(s: string) { return `${c.bold}${s}${c.reset}`; }
function dim(s: string)  { return `${c.dim}${s}${c.reset}`; }
function red(s: string)  { return `${c.red}${s}${c.reset}`; }
function yellow(s: string) { return `${c.yellow}${s}${c.reset}`; }
function green(s: string)  { return `${c.green}${s}${c.reset}`; }
function cyan(s: string)   { return `${c.cyan}${s}${c.reset}`; }

// ── Helpers ──────────────────────────────────────────────────────────────────

// Overridable for tests (scripts/__tests__/check-env.test.mjs) so they can
// point every apps/*/.env.{example,local} and deploy/ecosystem.*.config.js
// lookup at a throwaway temp directory instead of this real checkout.
const ROOT =
  process.env.CHECK_ENV_ROOT ??
  path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");

function parseEnvFile(filePath: string): Map<string, string> {
  const result = new Map<string, string>();
  if (!fs.existsSync(filePath)) return result;
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    result.set(key, val);
  }
  return result;
}

// ── .env.example annotations (#2246) ────────────────────────────────────────
//
// A recognized comment line placed directly above a `KEY=value` line in an
// .env.example changes how check-env treats that key when validating
// .env.local. See docs/ENVIRONMENTS.md for the user-facing writeup; this is
// the parser both that doc and every apps/*/.env.example header point back
// to as the source of truth:
//   # optional                 -> ok if unset locally; warned about once, grouped
//   # vault-sourced: <reason>  -> fetched at boot; ok if unset, WARNS if hand-set
//   # deprecated: <reason>     -> WARNS if set locally; fine if unset
// No annotation on a key = required, exactly like before this feature: a
// missing value is a hard error.

type AnnotationKind = "optional" | "vault-sourced" | "deprecated";

interface KeyAnnotation {
  kind: AnnotationKind;
  /** Free-text reason from `vault-sourced:`/`deprecated:` — absent for `# optional`. */
  reason?: string;
}

const OPTIONAL_ANNOTATION = /^#\s*optional\s*$/i;
const VAULT_SOURCED_ANNOTATION = /^#\s*vault-sourced:\s*(\S.*)$/i;
const DEPRECATED_ANNOTATION = /^#\s*deprecated:\s*(\S.*)$/i;

function parseAnnotationLine(rawLine: string): KeyAnnotation | null {
  const line = rawLine.trim();
  if (OPTIONAL_ANNOTATION.test(line)) return { kind: "optional" };
  const vaultMatch = VAULT_SOURCED_ANNOTATION.exec(line);
  if (vaultMatch) return { kind: "vault-sourced", reason: vaultMatch[1].trim() };
  const deprecatedMatch = DEPRECATED_ANNOTATION.exec(line);
  if (deprecatedMatch) return { kind: "deprecated", reason: deprecatedMatch[1].trim() };
  return null;
}

/**
 * Reads an .env.example's per-key annotations. Deliberately re-reads the
 * file with `parseEnvFile` rather than folding this into that function: the
 * annotation only ever applies to the *example* template, never to
 * .env.local, and keeping the two parses separate means a stray `# optional`
 * comment a user leaves in their own .env.local is inert instead of being
 * silently interpreted.
 */
function parseAnnotations(filePath: string): Map<string, KeyAnnotation> {
  const result = new Map<string, KeyAnnotation>();
  if (!fs.existsSync(filePath)) return result;
  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const annotation = i > 0 ? parseAnnotationLine(lines[i - 1]) : null;
    if (annotation) result.set(key, annotation);
  }
  return result;
}

// ── Per-env deploy targets (#2246) ───────────────────────────────────────────
//
// "Is this service actually deployed to this environment?" decides whether a
// missing .env.local is a hard error or just a warning (see checkService).
// Rather than inventing a new manifest, this reads the same source build.sh
// and the deploy workflows already treat as canonical for what pm2 runs per
// env: deploy/ecosystem.{dev,prod}.config.js's `cwd` entries (each one ends
// in `.../apps/<name>`). See deploy/README.md.

interface DeployTargets {
  /** False when the ecosystem file couldn't be read/parsed — callers fall back to the pre-#2246 heuristic. */
  known: boolean;
  names: Set<string>;
}

const deployTargetsCache = new Map<"dev" | "prod", DeployTargets>();

function loadDeployTargets(env: "dev" | "prod"): DeployTargets {
  const cached = deployTargetsCache.get(env);
  if (cached) return cached;

  const file = path.join(ROOT, "deploy", env === "prod" ? "ecosystem.prod.config.js" : "ecosystem.dev.config.js");
  const names = new Set<string>();
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf-8");
    const cwdPattern = /"cwd"\s*:\s*"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = cwdPattern.exec(text)) !== null) {
      const appMatch = /\/apps\/([^/"]+)\/?$/.exec(match[1]);
      if (appMatch) names.add(appMatch[1]);
    }
  }
  const result: DeployTargets = { known: names.size > 0, names };
  deployTargetsCache.set(env, result);
  return result;
}

/**
 * True when `svc` is actually meant to run in `env` — i.e. a missing
 * .env.local for it should be a hard error, not just a warning. Falls back
 * to the original devPort===0 heuristic (daemon services warn instead of
 * error) when the ecosystem manifest can't be read, so this never regresses
 * behaviour for an unrelated checkout shape.
 */
function isDeployTarget(svc: ServiceDefinition, env: "dev" | "prod"): boolean {
  const targets = loadDeployTargets(env);
  if (!targets.known) return svc.devPort !== 0;
  return targets.names.has(svc.name);
}

/** Extract port from a localhost URL like http://localhost:3001 */
function extractPort(url: string): number | null {
  const m = /localhost:(\d+)/.exec(url);
  return m ? Number.parseInt(m[1], 10) : null;
}

/** Return the expected port for a service name from the manifest */
function expectedPort(serviceName: string, env: "dev" | "prod"): number | null {
  const svc = SERVICES.find((s) => s.name === serviceName);
  if (!svc) return null;
  return env === "prod" ? svc.prodPort : svc.devPort;
}

/**
 * Given an env var key like AUTH_SERVICE_URL or DYKIL_SERVICE_URL,
 * extract the service name if it follows the {NAME}_SERVICE_URL pattern.
 */
function serviceNameFromKey(key: string): string | null {
  const m = /^([A-Z]+)_SERVICE_URL$/.exec(key);
  if (!m) return null;
  return m[1].toLowerCase();
}

/**
 * For NEXT_PUBLIC_*_URL keys, try to match against known service names.
 * e.g. NEXT_PUBLIC_AUTH_URL → auth, NEXT_PUBLIC_DYKIL_URL → dykil
 */
function serviceNameFromPublicKey(key: string): string | null {
  const m = /^NEXT_PUBLIC_([A-Z]+)_URL$/.exec(key);
  if (!m) return null;
  const candidate = m[1].toLowerCase();
  const svc = SERVICES.some((s) => s.name === candidate);
  return svc ? candidate : null;
}

// ── Main validation ──────────────────────────────────────────────────────────

interface ServiceResult {
  service: ServiceDefinition;
  hasEnvLocal: boolean;
  /** True when a missing .env.local for this service is an error, not just a warning (see isDeployTarget). */
  isDeployTarget: boolean;
  missing: string[];
  wrongPorts: { key: string; expected: number; actual: number }[];
  extra: string[];
  /** `# optional` keys absent from .env.local — fine, but surfaced as one grouped warning. */
  optionalMissing: string[];
  /** `# vault-sourced:` keys that ARE set in .env.local — the deprecated hand-provisioned path. */
  vaultSourcedPresent: { key: string; reason?: string }[];
  /** `# deprecated:` keys that ARE set in .env.local. */
  deprecatedPresent: { key: string; reason?: string }[];
  errors: number;
  warnings: number;
}

/** Keys present in .env.local but not declared in .env.example */
function findExtraKeys(example: Map<string, string>, local: Map<string, string>): string[] {
  const extra: string[] = [];
  for (const key of local.keys()) {
    if (!example.has(key)) {
      extra.push(key);
    }
  }
  return extra;
}

/**
 * Check a single .env.local key for a port mismatch — covers PORT=XXXX, *_SERVICE_URL,
 * and NEXT_PUBLIC_*_URL keys. Returns null when the key isn't port-related or matches.
 */
function findWrongPortForKey(
  key: string,
  val: string,
  svc: ServiceDefinition,
  env: "dev" | "prod"
): { key: string; expected: number; actual: number } | null {
  if (key === "PORT") {
    const expected = env === "prod" ? svc.prodPort : svc.devPort;
    const actual = Number.parseInt(val, 10);
    if (!Number.isNaN(actual) && actual !== expected) {
      return { key, expected, actual };
    }
    return null;
  }

  // Check *_SERVICE_URL first, then NEXT_PUBLIC_*_URL
  const svcName = serviceNameFromKey(key) ?? serviceNameFromPublicKey(key);
  if (!svcName) return null;

  const expected = expectedPort(svcName, env);
  if (expected === null) return null;

  const actual = extractPort(val);
  if (actual !== null && actual !== expected) {
    return { key, expected, actual };
  }
  return null;
}

/**
 * Splits `.env.example` keys absent from `.env.local` into hard-missing and
 * `# optional`-annotated ones. vault-sourced / deprecated missing keys are
 * fine and recorded nowhere.
 */
function classifyMissingKeys(
  example: Map<string, string>,
  local: Map<string, string>,
  annotations: Map<string, KeyAnnotation>,
): { missing: string[]; optionalMissing: string[] } {
  const missing: string[] = [];
  const optionalMissing: string[] = [];
  for (const key of example.keys()) {
    if (local.has(key)) continue;
    const annotation = annotations.get(key);
    if (!annotation) {
      missing.push(key);
    } else if (annotation.kind === "optional") {
      optionalMissing.push(key);
    }
  }
  return { missing, optionalMissing };
}

/**
 * vault-sourced/deprecated keys that ARE set locally get a warning each —
 * the former is exactly the "deprecated hand-provisioned value, remove
 * after rotation" signal a prod rotation sweep looks for.
 */
function findAnnotatedPresentKeys(
  annotations: Map<string, KeyAnnotation>,
  local: Map<string, string>,
): { vaultSourcedPresent: { key: string; reason?: string }[]; deprecatedPresent: { key: string; reason?: string }[] } {
  const vaultSourcedPresent: { key: string; reason?: string }[] = [];
  const deprecatedPresent: { key: string; reason?: string }[] = [];
  for (const [key, annotation] of annotations.entries()) {
    if (!local.has(key)) continue;
    if (annotation.kind === "vault-sourced") {
      vaultSourcedPresent.push({ key, reason: annotation.reason });
    } else if (annotation.kind === "deprecated") {
      deprecatedPresent.push({ key, reason: annotation.reason });
    }
  }
  return { vaultSourcedPresent, deprecatedPresent };
}

/** Validates port values in `.env.local` against the service's expected ports. */
function findWrongPorts(
  local: Map<string, string>,
  svc: ServiceDefinition,
  env: "dev" | "prod",
): { key: string; expected: number; actual: number }[] {
  const wrongPorts: { key: string; expected: number; actual: number }[] = [];
  for (const [key, val] of local.entries()) {
    const wrongPort = findWrongPortForKey(key, val, svc, env);
    if (wrongPort) {
      wrongPorts.push(wrongPort);
    }
  }
  return wrongPorts;
}

function checkService(svc: ServiceDefinition, env: "dev" | "prod"): ServiceResult {
  const appDir = path.join(ROOT, "apps", svc.name);
  const examplePath = path.join(appDir, ".env.example");
  const localPath = path.join(appDir, ".env.local");

  const example = parseEnvFile(examplePath);
  const annotations = parseAnnotations(examplePath);
  const local = parseEnvFile(localPath);
  const hasEnvLocal = fs.existsSync(localPath);

  if (!hasEnvLocal) {
    // Only a hard error when this service is actually deployed to `env`
    // (deploy/ecosystem.{env}.config.js) — otherwise it's a warning, e.g. a
    // daemon not yet provisioned on this host, or a service this env simply
    // doesn't run (#2246).
    const target = isDeployTarget(svc, env);
    return {
      service: svc,
      hasEnvLocal,
      isDeployTarget: target,
      missing: [],
      wrongPorts: [],
      extra: [],
      optionalMissing: [],
      vaultSourcedPresent: [],
      deprecatedPresent: [],
      errors: target ? 1 : 0,
      warnings: target ? 0 : 1,
    };
  }

  const { missing, optionalMissing } = classifyMissingKeys(example, local, annotations);
  const { vaultSourcedPresent, deprecatedPresent } = findAnnotatedPresentKeys(annotations, local);
  const wrongPorts = findWrongPorts(local, svc, env);

  // Warn about extra keys in .env.local not in .env.example
  const extra = findExtraKeys(example, local);

  const errors = missing.length + wrongPorts.length;
  const warnings =
    extra.length + (optionalMissing.length > 0 ? 1 : 0) + vaultSourcedPresent.length + deprecatedPresent.length;

  return {
    service: svc,
    hasEnvLocal,
    isDeployTarget: isDeployTarget(svc, env),
    missing,
    wrongPorts,
    extra,
    optionalMissing,
    vaultSourcedPresent,
    deprecatedPresent,
    errors,
    warnings,
  };
}

/** `<SVC>_VAULT_BOOTSTRAP_DID` / `_PRIVATE_KEY` — provisioned by the deploy, never by hand. */
const VAULT_BOOTSTRAP_KEY = /_VAULT_BOOTSTRAP_(DID|PRIVATE_KEY)$/;

function printResult(result: ServiceResult, env: "dev" | "prod"): void {
  const {
    service: svc,
    hasEnvLocal,
    isDeployTarget: target,
    missing,
    wrongPorts,
    extra,
    optionalMissing,
    vaultSourcedPresent,
    deprecatedPresent,
    errors,
    warnings,
  } = result;
  const icon = svc.icon;
  const label = bold(`${icon}  ${svc.name}`);
  const portLabel = dim(`(port ${env === "prod" ? svc.prodPort : svc.devPort})`);

  if (!hasEnvLocal) {
    const message = target
      ? red("no .env.local — required for this env's deploy target")
      : yellow("no .env.local — skipping (not a deploy target for this env)");
    console.log(`  ${target ? sym.err : sym.warn}  ${label} ${portLabel}  ${message}`);
    return;
  }

  if (errors === 0 && warnings === 0) {
    console.log(`  ${sym.ok}  ${label} ${portLabel}  ${green("all good")}`);
    return;
  }

  const errorSuffix = errors > 1 ? "s" : "";
  const warningSuffix = warnings > 1 ? "s" : "";
  const summary = [
    errors > 0 ? red(`${errors} error${errorSuffix}`) : null,
    warnings > 0 ? yellow(`${warnings} warning${warningSuffix}`) : null,
  ].filter(Boolean).join(", ");

  console.log(`  ${errors > 0 ? sym.err : sym.warn}  ${label} ${portLabel}  ${summary}`);

  printKeyIssues(missing, wrongPorts, optionalMissing);
  printAnnotatedIssues(vaultSourcedPresent, deprecatedPresent, extra);
}

function printKeyIssues(
  missing: string[],
  wrongPorts: { key: string; expected: number; actual: number }[],
  optionalMissing: string[],
): void {
  for (const key of missing) {
    console.log(`       ${sym.arrow}  ${red("missing")}  ${cyan(key)}`);
  }

  // A missing vault bootstrap identity is never fixed by editing .env.local: the
  // deploy's provisioning step mints the pair and the vault grants (#2442, #2550).
  if (missing.some((key) => VAULT_BOOTSTRAP_KEY.test(key))) {
    console.log(
      `       ${sym.arrow}  ${dim(
        "vault bootstrap identity: minted + granted in the vault by scripts/provision-service-bootstrap.mjs " +
          "(the deploy runs it before this check) — do not hand-set; look at that step's log"
      )}`
    );
  }

  for (const { key, expected, actual } of wrongPorts) {
    const portMismatch = `expected :${expected}, got :${actual}`;
    console.log(`       ${sym.arrow}  ${red("wrong port")}  ${cyan(key)}  ${dim(portMismatch)}`);
  }

  if (optionalMissing.length > 0) {
    const keys = optionalMissing.map((k) => cyan(k)).join(", ");
    console.log(`       ${sym.arrow}  ${yellow("optional, not set")}  ${keys}`);
  }
}

function printAnnotatedIssues(
  vaultSourcedPresent: { key: string; reason?: string }[],
  deprecatedPresent: { key: string; reason?: string }[],
  extra: string[],
): void {
  for (const { key, reason } of vaultSourcedPresent) {
    const detail = reason
      ? `deprecated hand-provisioned value present; remove after rotation (${reason})`
      : "deprecated hand-provisioned value present; remove after rotation";
    console.log(`       ${sym.arrow}  ${yellow("vault-sourced")}  ${cyan(key)}  ${dim(detail)}`);
  }

  for (const { key, reason } of deprecatedPresent) {
    console.log(`       ${sym.arrow}  ${yellow("deprecated")}  ${cyan(key)}  ${dim(reason ?? "")}`);
  }

  for (const key of extra) {
    console.log(`       ${sym.arrow}  ${yellow("extra")}  ${dim(key)}  ${dim("(not in .env.example)")}`);
  }
}

// ── Vault file check (#2412) ─────────────────────────────────────────────────
//
// v0.8.8 shipped VAULT_PATH=~/.imajin/vault.prod.json while that file did not
// exist; the kernel then ran ~9h with an empty vault and every sealed secret
// resolving to undefined. The kernel now refuses to boot in that state, and this
// check makes the deploy stop BEFORE pm2 is restarted.
//
// VAULT_PATH is not in any .env.local — pm2 sets it in deploy/ecosystem.*.config.js
// — so it is read from the process env first (operator override / tests), then
// from that ecosystem file. VAULT_ALLOW_BOOTSTRAP is the explicit first-run flag
// (same two sources) that turns a missing file from an error into a warning.

interface VaultCheckResult {
  /** No VAULT_PATH configured anywhere — nothing to assert. */
  skipped: boolean;
  path: string | null;
  exists: boolean;
  bootstrapAllowed: boolean;
  errors: number;
  warnings: number;
}

function readEcosystemEnvValue(env: "dev" | "prod", key: string): string | undefined {
  const file = path.join(ROOT, "deploy", env === "prod" ? "ecosystem.prod.config.js" : "ecosystem.dev.config.js");
  if (!fs.existsSync(file)) return undefined;
  const pattern = new RegExp(String.raw`"${key}"\s*:\s*"([^"]*)"`);
  return pattern.exec(fs.readFileSync(file, "utf-8"))?.[1];
}

function readVaultSetting(env: "dev" | "prod", key: string): string | undefined {
  const fromProcess = process.env[key]?.trim();
  if (fromProcess) return fromProcess;
  const fromEcosystem = readEcosystemEnvValue(env, key)?.trim();
  return fromEcosystem || undefined;
}

/** Mirrors apps/kernel/src/lib/vault/vault-path.ts: a leading `~` is the home directory. */
function expandTilde(rawPath: string): string {
  if (rawPath === "~") return os.homedir();
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\")) return path.join(os.homedir(), rawPath.slice(2));
  return rawPath;
}

function checkVault(env: "dev" | "prod"): VaultCheckResult {
  const raw = readVaultSetting(env, "VAULT_PATH");
  const flag = readVaultSetting(env, "VAULT_ALLOW_BOOTSTRAP")?.toLowerCase();
  const bootstrapAllowed = flag === "1" || flag === "true";

  if (!raw) {
    return { skipped: true, path: null, exists: false, bootstrapAllowed, errors: 0, warnings: 0 };
  }

  const vaultPath = expandTilde(raw);
  const exists = fs.existsSync(vaultPath);
  if (exists) {
    return { skipped: false, path: vaultPath, exists, bootstrapAllowed, errors: 0, warnings: 0 };
  }
  if (bootstrapAllowed) {
    return { skipped: false, path: vaultPath, exists, bootstrapAllowed, errors: 0, warnings: 1 };
  }
  return { skipped: false, path: vaultPath, exists, bootstrapAllowed, errors: 1, warnings: 0 };
}

function printVaultResult(result: VaultCheckResult): void {
  const label = bold("🔐  vault");
  if (result.skipped) {
    console.log(`  ${sym.info}  ${label}  ${dim("VAULT_PATH not set — nothing to check")}`);
    return;
  }
  if (result.exists) {
    console.log(`  ${sym.ok}  ${label}  ${green("vault file present")}  ${dim(result.path ?? "")}`);
    return;
  }
  if (result.bootstrapAllowed) {
    const detail = "vault file missing, but VAULT_ALLOW_BOOTSTRAP is set — kernel will bootstrap an empty vault";
    console.log(`  ${sym.warn}  ${label}  ${yellow(detail)}  ${dim(result.path ?? "")}`);
    return;
  }
  console.log(`  ${sym.err}  ${label}  ${red("VAULT_PATH file does not exist — kernel would refuse to boot")}`);
  console.log(`       ${sym.arrow}  ${red("missing")}  ${cyan(result.path ?? "")}`);
  console.log(
    `       ${sym.arrow}  ${dim("restore the file, fix VAULT_PATH, or set VAULT_ALLOW_BOOTSTRAP=1 for a deliberate first-run bootstrap")}`
  );
}

// ── CLI entry ────────────────────────────────────────────────────────────────

function parseArgs(args: string[]): { env: "dev" | "prod"; names: string[] } {
  let env: "dev" | "prod" = "dev";
  const names: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--env") {
      const val = args[++i];
      if (val === "prod") env = "prod";
    } else if (!args[i].startsWith("--")) {
      names.push(args[i]);
    }
  }

  return { env, names };
}

/** Print the names of any requested services that aren't in the manifest and exit(1) if any */
function exitIfUnknownServices(names: string[]): void {
  const unknown = names.filter((n) => !SERVICES.some((s) => s.name === n));
  if (unknown.length > 0) {
    console.error(`${sym.err} Unknown service(s): ${unknown.map(n => red(n)).join(", ")}`);
    console.error(`  Valid names: ${SERVICES.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }
}

function printHeader(env: "dev" | "prod", serviceCount: number): void {
  console.log();
  const envLabel = `env=${env}`;
  const checkingLabel = `checking ${serviceCount} service(s)`;
  console.log(`${bold("check-env")}  ${dim(envLabel)}  ${dim(checkingLabel)}`);
  console.log(dim("─".repeat(60)));
  console.log();
}

/** Print results grouped by tier (core platform services, then imajin apps) */
function printGroupedResults(results: ServiceResult[], env: "dev" | "prod"): void {
  const core = results.filter((r) => r.service.tier === "core");
  const imajin = results.filter((r) => r.service.tier === "imajin");

  if (core.length > 0) {
    console.log(`  ${bold(cyan("core"))}  ${dim("platform services")}`);
    for (const r of core) printResult(r, env);
    console.log();
  }

  if (imajin.length > 0) {
    console.log(`  ${bold(cyan("imajin"))}  ${dim("apps")}`);
    for (const r of imajin) printResult(r, env);
    console.log();
  }
}

/** Print the final summary line and exit the process with the appropriate status code */
function printSummaryAndExit(results: ServiceResult[], vault: VaultCheckResult | null): void {
  const totalErrors   = results.reduce((n, r) => n + r.errors, 0) + (vault?.errors ?? 0);
  const totalWarnings = results.reduce((n, r) => n + r.warnings, 0) + (vault?.warnings ?? 0);
  const noLocal       = results.filter((r) => !r.hasEnvLocal).length;

  console.log(dim("─".repeat(60)));

  if (totalErrors === 0 && totalWarnings === 0 && noLocal === 0) {
    console.log(`\n  ${sym.ok}  ${green(bold("All checks passed."))}\n`);
    process.exit(0);
  }

  const parts: string[] = [];
  if (totalErrors > 0)   parts.push(red(`${totalErrors} error${totalErrors > 1 ? "s" : ""}`));
  if (totalWarnings > 0) parts.push(yellow(`${totalWarnings} warning${totalWarnings > 1 ? "s" : ""}`));
  if (noLocal > 0)       parts.push(yellow(`${noLocal} service${noLocal > 1 ? "s" : ""} missing .env.local`));

  console.log(`\n  ${totalErrors > 0 ? sym.err : sym.warn}  ${parts.join("  ")}\n`);

  process.exit(totalErrors > 0 ? 1 : 0);
}

function main(): void {
  const { env, names } = parseArgs(process.argv.slice(2));

  const services = names.length > 0
    ? SERVICES.filter((s) => names.includes(s.name))
    : [...SERVICES];

  exitIfUnknownServices(names);

  printHeader(env, services.length);

  const results = services.map((svc) => checkService(svc, env));

  printGroupedResults(results, env);

  // Only the kernel process reads VAULT_PATH.
  const vault = services.some((s) => s.name === "kernel") ? checkVault(env) : null;
  if (vault) {
    printVaultResult(vault);
    console.log();
  }

  printSummaryAndExit(results, vault);
}

main();
