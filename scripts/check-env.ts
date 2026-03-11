#!/usr/bin/env tsx
/**
 * check-env.ts — validate .env.local files against .env.example templates
 *
 * Usage:
 *   npx tsx scripts/check-env.ts                     # check all services (dev)
 *   npx tsx scripts/check-env.ts --env prod           # check all services (prod)
 *   npx tsx scripts/check-env.ts www auth profile     # check specific services
 *   npx tsx scripts/check-env.ts --env prod www auth  # specific services on prod
 */

import fs from "node:fs";
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

const ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "..");

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

/** Extract port from a localhost URL like http://localhost:3001 */
function extractPort(url: string): number | null {
  const m = url.match(/localhost:(\d+)/);
  return m ? parseInt(m[1], 10) : null;
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
  const m = key.match(/^([A-Z]+)_SERVICE_URL$/);
  if (!m) return null;
  return m[1].toLowerCase();
}

/**
 * For NEXT_PUBLIC_*_URL keys, try to match against known service names.
 * e.g. NEXT_PUBLIC_AUTH_URL → auth, NEXT_PUBLIC_DYKIL_URL → dykil
 */
function serviceNameFromPublicKey(key: string): string | null {
  const m = key.match(/^NEXT_PUBLIC_([A-Z]+)_URL$/);
  if (!m) return null;
  const candidate = m[1].toLowerCase();
  const svc = SERVICES.find((s) => s.name === candidate);
  return svc ? candidate : null;
}

// ── Main validation ──────────────────────────────────────────────────────────

interface ServiceResult {
  service: ServiceDefinition;
  hasEnvLocal: boolean;
  missing: string[];
  wrongPorts: { key: string; expected: number; actual: number }[];
  extra: string[];
  errors: number;
  warnings: number;
}

function checkService(svc: ServiceDefinition, env: "dev" | "prod"): ServiceResult {
  const appDir = path.join(ROOT, "apps", svc.name);
  const examplePath = path.join(appDir, ".env.example");
  const localPath = path.join(appDir, ".env.local");

  const example = parseEnvFile(examplePath);
  const local = parseEnvFile(localPath);
  const hasEnvLocal = fs.existsSync(localPath);

  const missing: string[] = [];
  const wrongPorts: { key: string; expected: number; actual: number }[] = [];
  const extra: string[] = [];

  if (!hasEnvLocal) {
    return { service: svc, hasEnvLocal, missing: [], wrongPorts: [], extra: [], errors: 1, warnings: 0 };
  }

  // Check all keys from .env.example are present in .env.local
  for (const key of example.keys()) {
    if (!local.has(key)) {
      missing.push(key);
    }
  }

  // Validate port values in .env.local
  for (const [key, val] of local.entries()) {
    // Check PORT=XXXX
    if (key === "PORT") {
      const expected = env === "prod" ? svc.prodPort : svc.devPort;
      const actual = parseInt(val, 10);
      if (!isNaN(actual) && actual !== expected) {
        wrongPorts.push({ key, expected, actual });
      }
      continue;
    }

    // Check *_SERVICE_URL
    const svcName = serviceNameFromKey(key);
    if (svcName) {
      const expected = expectedPort(svcName, env);
      if (expected !== null) {
        const actual = extractPort(val);
        if (actual !== null && actual !== expected) {
          wrongPorts.push({ key, expected, actual });
        }
      }
      continue;
    }

    // Check NEXT_PUBLIC_*_URL
    const pubSvcName = serviceNameFromPublicKey(key);
    if (pubSvcName) {
      const expected = expectedPort(pubSvcName, env);
      if (expected !== null) {
        const actual = extractPort(val);
        if (actual !== null && actual !== expected) {
          wrongPorts.push({ key, expected, actual });
        }
      }
      continue;
    }
  }

  // Warn about extra keys in .env.local not in .env.example
  for (const key of local.keys()) {
    if (!example.has(key)) {
      extra.push(key);
    }
  }

  const errors = missing.length + wrongPorts.length;
  const warnings = extra.length;

  return { service: svc, hasEnvLocal, missing, wrongPorts, extra, errors, warnings };
}

function printResult(result: ServiceResult, env: "dev" | "prod"): void {
  const { service: svc, hasEnvLocal, missing, wrongPorts, extra, errors, warnings } = result;
  const icon = svc.icon;
  const label = bold(`${icon}  ${svc.name}`);
  const portLabel = dim(`(port ${env === "prod" ? svc.prodPort : svc.devPort})`);

  if (!hasEnvLocal) {
    console.log(`  ${sym.warn}  ${label} ${portLabel}  ${yellow("no .env.local — skipping")}`);
    return;
  }

  if (errors === 0 && warnings === 0) {
    console.log(`  ${sym.ok}  ${label} ${portLabel}  ${green("all good")}`);
    return;
  }

  const summary = [
    errors > 0 ? red(`${errors} error${errors > 1 ? "s" : ""}`) : null,
    warnings > 0 ? yellow(`${warnings} warning${warnings > 1 ? "s" : ""}`) : null,
  ].filter(Boolean).join(", ");

  console.log(`  ${errors > 0 ? sym.err : sym.warn}  ${label} ${portLabel}  ${summary}`);

  for (const key of missing) {
    console.log(`       ${sym.arrow}  ${red("missing")}  ${cyan(key)}`);
  }

  for (const { key, expected, actual } of wrongPorts) {
    console.log(`       ${sym.arrow}  ${red("wrong port")}  ${cyan(key)}  ${dim(`expected :${expected}, got :${actual}`)}`);
  }

  for (const key of extra) {
    console.log(`       ${sym.arrow}  ${yellow("extra")}  ${dim(key)}  ${dim("(not in .env.example)")}`);
  }
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

function main(): void {
  const { env, names } = parseArgs(process.argv.slice(2));

  const services = names.length > 0
    ? SERVICES.filter((s) => names.includes(s.name))
    : [...SERVICES];

  const unknown = names.filter((n) => !SERVICES.find((s) => s.name === n));
  if (unknown.length > 0) {
    console.error(`${sym.err} Unknown service(s): ${unknown.map(n => red(n)).join(", ")}`);
    console.error(`  Valid names: ${SERVICES.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }

  console.log();
  console.log(`${bold("check-env")}  ${dim(`env=${env}`)}  ${dim(`checking ${services.length} service(s)`)}`);
  console.log(dim("─".repeat(60)));
  console.log();

  const results = services.map((svc) => checkService(svc, env));

  // Group by tier for readability
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

  // Summary
  const totalErrors   = results.reduce((n, r) => n + r.errors, 0);
  const totalWarnings = results.reduce((n, r) => n + r.warnings, 0);
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

main();
