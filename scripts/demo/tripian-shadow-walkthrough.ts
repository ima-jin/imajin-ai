#!/usr/bin/env tsx
/**
 * Tripian shadow-mode restaurant walkthrough (#1232).
 *
 * End-to-end proof of the SHITSUJI/Tripian PoC: a traveler with dietary prefs,
 * a restaurant that requests those prefs through the broker, and consent logic
 * that decides what is released and in what form — all in SHADOW MODE, where
 * everything runs and is audited but nothing gates the flow.
 *
 * Wires the merged primitives into one demonstrable sequence:
 *   #1230  POST /registry/api/identity   (lazy get-or-create soft DIDs)
 *   #1227  vault seal/unseal             (via scripts/demo/vault-client.ts seam)
 *   #1049  consent grants                (kernel.consent_grants)
 *   #1231  POST /api/broker/request      (shadow mode, enforced:false)
 *   #1050  GET  /api/broker/audit        (shadow-flagged rows)
 *
 * It ASSERTS (does not merely print): dietary released raw, allergies released
 * as attestation, budget not released, every decision enforced:false, and the
 * audit rows are shadow-flagged.
 *
 * Usage (run against a live dev kernel):
 *   cd apps/kernel
 *   KERNEL_BASE_URL=http://localhost:3001 \
 *   DEMO_AGENT_TOKEN=<bearer> DEMO_AGENT_DID=did:imajin:<agent> \
 *   DATABASE_URL=<postgres> \
 *   npx tsx ../../scripts/demo/tripian-shadow-walkthrough.ts
 *
 * Before #1227 merges, add DEMO_SKIP_VAULT=1 to use an in-memory vault
 * stand-in (see vault-client.ts). See scripts/demo/README-tripian.md.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createVaultClient, type VaultClient } from './vault-client';

// ─── env / config ────────────────────────────────────────────────────────────

function loadEnvLocal(): void {
  try {
    const envPath = resolve(process.cwd(), '.env.local');
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    // rely on the ambient environment
  }
}

interface Config {
  baseUrl: string;
  token: string;
  agentDid: string;
  databaseUrl: string;
}

const PURPOSE = 'restaurant_reservation';
const SCOPE = 'tripian';

// Traveler prefs (Memo's confirmed PoC defaults). Field name -> plaintext value.
const PREFS = {
  dietary: 'vegetarian; no pork',
  allergies: 'peanuts; shellfish',
  budget: '$$ (moderate)',
} as const;

const USAGE = `tripian-shadow-walkthrough (#1232)

Required env:
  KERNEL_BASE_URL    Base URL of the running kernel (e.g. http://localhost:3001)
  DEMO_AGENT_TOKEN   Bearer token for the demo's delegated agent (the requester)
  DEMO_AGENT_DID     DID of that agent; must equal the token's acting DID
  DATABASE_URL       Postgres URL (used to seed the traveler's consent grants)

Optional env:
  DEMO_SKIP_VAULT=1  Use an in-memory vault stand-in until #1227 lands

Run:
  cd apps/kernel && npx tsx ../../scripts/demo/tripian-shadow-walkthrough.ts`;

function readConfig(): Config {
  const baseUrl = process.env.KERNEL_BASE_URL;
  const token = process.env.DEMO_AGENT_TOKEN;
  const agentDid = process.env.DEMO_AGENT_DID;
  const databaseUrl = process.env.DATABASE_URL;

  const missing: string[] = [];
  if (!baseUrl) missing.push('KERNEL_BASE_URL');
  if (!token) missing.push('DEMO_AGENT_TOKEN');
  if (!agentDid) missing.push('DEMO_AGENT_DID');
  if (!databaseUrl) missing.push('DATABASE_URL');
  if (missing.length > 0) {
    console.error(`Missing required env: ${missing.join(', ')}\n\n${USAGE}`);
    process.exit(2);
  }

  return {
    baseUrl: baseUrl!.replace(/\/$/, ''),
    token: token!,
    agentDid: agentDid!,
    databaseUrl: databaseUrl!,
  };
}

// ─── output + assertions ──────────────────────────────────────────────────────

let stepNo = 0;
let failures = 0;

function step(title: string): void {
  stepNo += 1;
  console.log(`\n[${stepNo}] ${title}`);
}

function info(message: string): void {
  console.log(`    ${message}`);
}

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`    \u2713 ${message}`);
  } else {
    failures += 1;
    console.log(`    \u2717 ${message}`);
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function authHeaders(cfg: Readonly<Config>): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.token}` };
}

async function postJson(
  cfg: Readonly<Config>,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    method: 'POST',
    headers: authHeaders(cfg),
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

async function getJson(
  cfg: Readonly<Config>,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${cfg.baseUrl}${path}`, { headers: authHeaders(cfg) });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

// ─── steps ────────────────────────────────────────────────────────────────────

/** Lazy get-or-create a soft DID for a partner-scoped entity (#1230). */
async function mintIdentity(cfg: Readonly<Config>, ref: string, type: string): Promise<string> {
  const { status, json } = await postJson(cfg, '/registry/api/identity', {
    namespace: SCOPE,
    ref,
    type,
  });
  if (status !== 200 && status !== 201) {
    throw new Error(`identity mint failed (${status}) for ${ref}: ${JSON.stringify(json)}`);
  }
  const did = json.did;
  if (typeof did !== 'string') {
    throw new Error(`identity mint returned no DID for ${ref}`);
  }
  info(`${type} ${ref} -> ${did} (created=${String(json.created)})`);
  return did;
}

/**
 * Seed the traveler's consent grants (Memo's defaults) directly into
 * kernel.consent_grants. The consent HTTP endpoint requires subject===acting,
 * which a keypair-less soft traveler DID cannot satisfy; seeding the real rows
 * keeps the broker's consent RESOLUTION (the thing being proven) fully real.
 *
 * dietary -> raw, allergies -> attestation, budget -> (no grant => denied).
 */
async function seedConsent(sql: ReturnType<typeof postgres>, travelerDid: string, agentDid: string): Promise<void> {
  await sql`
    DELETE FROM kernel.consent_grants
    WHERE subject = ${travelerDid} AND granted_to = ${agentDid} AND purpose = ${PURPOSE}
  `;

  const grants: Array<{ fields: string[]; mode: 'raw' | 'attestation' }> = [
    { fields: ['dietary'], mode: 'raw' },
    { fields: ['allergies'], mode: 'attestation' },
    // budget: intentionally NO grant -> broker denies it.
  ];

  for (const grant of grants) {
    await sql`
      INSERT INTO kernel.consent_grants
        (id, subject, granted_to, purpose, allowed_fields, mode, status, consent_ref)
      VALUES (
        ${`consent_${randomUUID().replaceAll('-', '').slice(0, 16)}`},
        ${travelerDid}, ${agentDid}, ${PURPOSE}, ${grant.fields}, ${grant.mode},
        'active', ${`cg_${randomUUID().replaceAll('-', '').slice(0, 16)}`}
      )
    `;
    info(`consent: ${grant.fields.join(',')} -> ${grant.mode}`);
  }
  info('consent: budget -> (none, will be denied)');
}

interface BrokerOutcome {
  status: number;
  released: boolean;
  enforced: unknown;
  mode: unknown;
  releaseMode: unknown;
  data: Record<string, unknown>;
}

/** Issue one shadow-mode broker request for a single field and normalize the result. */
async function brokerShadow(
  cfg: Readonly<Config>,
  travelerDid: string,
  field: string,
  value: string,
): Promise<BrokerOutcome> {
  const { status, json } = await postJson(cfg, '/api/broker/request', {
    type: 'profile.field.request',
    requester: cfg.agentDid,
    subject: travelerDid,
    purpose: PURPOSE,
    fields: [field],
    scope: SCOPE,
    data: { [field]: value },
    mode: 'shadow',
  });

  const envelope = (json.envelope ?? {}) as Record<string, unknown>;
  return {
    status,
    released: json.status === 'released',
    enforced: json.enforced,
    mode: json.mode,
    releaseMode: envelope.mode,
    data: (json.data ?? {}) as Record<string, unknown>,
  };
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  loadEnvLocal();
  const cfg = readConfig();
  const sql = postgres(cfg.databaseUrl);
  const vault: VaultClient = createVaultClient({ baseUrl: cfg.baseUrl, token: cfg.token });

  console.log('Tripian shadow-mode restaurant walkthrough (#1232)');
  console.log(`kernel: ${cfg.baseUrl}  |  agent: ${cfg.agentDid}  |  vault: ${vault.label}`);

  try {
    step('Mint traveler + restaurant DIDs (idempotent, #1230)');
    const travelerDid = await mintIdentity(cfg, 'traveler:demo-jane', 'traveler');
    const restaurantDid = await mintIdentity(cfg, 'restaurant:kai-honolulu', 'restaurant');
    assert(travelerDid.startsWith('did:imajin:'), 'traveler DID is a did:imajin identifier');
    assert(restaurantDid !== travelerDid, 'restaurant and traveler are distinct DIDs');

    step('Seal traveler prefs into the vault, then unseal (round-trip, #1227)');
    for (const [field, value] of Object.entries(PREFS)) {
      await vault.seal(travelerDid, field, value);
    }
    const unsealed: Record<string, string> = {};
    for (const field of Object.keys(PREFS)) {
      unsealed[field] = await vault.unseal(travelerDid, field);
    }
    assert(
      unsealed.dietary === PREFS.dietary
        && unsealed.allergies === PREFS.allergies
        && unsealed.budget === PREFS.budget,
      'vault seal -> unseal round-trip returns the original plaintext',
    );

    step('Seed traveler consent grants (dietary=raw, allergies=attestation, budget=none)');
    await seedConsent(sql, travelerDid, cfg.agentDid);

    step('Restaurant requests each field via the broker in SHADOW mode (#1231)');
    const dietary = await brokerShadow(cfg, travelerDid, 'dietary', unsealed.dietary);
    info(`dietary: http=${dietary.status} released=${dietary.released} mode=${String(dietary.releaseMode)} enforced=${String(dietary.enforced)}`);
    assert(dietary.status === 200, 'dietary request returns HTTP 200 (non-blocking)');
    assert(dietary.released, 'dietary is released');
    assert(dietary.releaseMode === 'raw', 'dietary is released in RAW mode');
    assert(dietary.data.dietary === PREFS.dietary, 'dietary raw value is present');
    assert(dietary.enforced === false, 'dietary decision is advisory (enforced:false)');

    const allergies = await brokerShadow(cfg, travelerDid, 'allergies', unsealed.allergies);
    info(`allergies: http=${allergies.status} released=${allergies.released} mode=${String(allergies.releaseMode)} enforced=${String(allergies.enforced)}`);
    assert(allergies.status === 200, 'allergies request returns HTTP 200 (non-blocking)');
    assert(allergies.released, 'allergies is released');
    assert(allergies.releaseMode === 'attestation', 'allergies is released in ATTESTATION mode');
    assert(allergies.enforced === false, 'allergies decision is advisory (enforced:false)');

    const budget = await brokerShadow(cfg, travelerDid, 'budget', unsealed.budget);
    info(`budget: http=${budget.status} released=${budget.released} enforced=${String(budget.enforced)}`);
    assert(budget.status === 200, 'budget request returns HTTP 200 even when denied (non-blocking)');
    assert(!budget.released, 'budget is NOT released (no consent)');
    assert(budget.enforced === false, 'budget denial is advisory (enforced:false)');

    step('Verify shadow-flagged audit rows were written (#1050)');
    const audit = await getJson(
      cfg,
      `/api/broker/audit?shadow=true&subject=${encodeURIComponent(travelerDid)}`,
    );
    const entries = Array.isArray(audit.json.entries) ? (audit.json.entries as Array<Record<string, unknown>>) : [];
    const allShadow = entries.length > 0 && entries.every((e) => e.shadow === true);
    const released = entries.filter((e) => e.status === 'RELEASED').length;
    const denied = entries.filter((e) => e.status === 'DENIED').length;
    info(`audit rows (shadow=true): ${entries.length} (released=${released}, denied=${denied})`);
    if (entries.length > 0) {
      info(`sample row: ${JSON.stringify(entries[0])}`);
    }
    assert(entries.length >= 3, 'at least 3 shadow-flagged audit rows exist for this traveler');
    assert(allShadow, 'every returned audit row is flagged shadow:true');
    assert(released >= 2 && denied >= 1, 'audit shows 2 releases + 1 denial (nothing gated)');
  } finally {
    await sql.end();
  }

  console.log('');
  if (failures > 0) {
    console.log(`FAILED: ${failures} assertion(s) did not hold.`);
    process.exit(1);
  }
  console.log('All assertions passed. Shadow mode ran the full consent + audit path; nothing was gated.');
}

main().catch((err) => {
  console.error('\nFatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
