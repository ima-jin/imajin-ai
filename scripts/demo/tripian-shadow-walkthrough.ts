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
 * as a computed attestation without the raw list, budget not released, every
 * decision enforced:false, and the audit rows are shadow-flagged.
 *
 * Usage (run against a live dev kernel):
 *   cd apps/kernel
 *   KERNEL_BASE_URL=http://localhost:3001 \
 *   DEMO_AGENT_TOKEN=<bearer> DEMO_AGENT_DID=did:imajin:<agent> \
 *   DATABASE_URL=<postgres> \
 *   npx tsx ../../scripts/demo/tripian-shadow-walkthrough.ts
 *
 * The vault round-trip uses #1227's in-process seal/unseal (see vault-client.ts);
 * it needs AUTH_PRIVATE_KEY and VAULT_PATH. See scripts/demo/README-tripian.md.
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
  AUTH_PRIVATE_KEY   Node key for #1227 vault seal/unseal (dev fallback if unset)

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
  releaseId: unknown;
  data: Record<string, unknown>;
}

/** Issue one shadow-mode broker request and normalize the result. */
async function brokerShadow(
  cfg: Readonly<Config>,
  travelerDid: string,
  fields: string[],
  data: Record<string, string>,
  predicates?: Record<string, unknown>,
): Promise<BrokerOutcome> {
  const { status, json } = await postJson(cfg, '/api/broker/request', {
    type: 'profile.field.request',
    requester: cfg.agentDid,
    subject: travelerDid,
    purpose: PURPOSE,
    fields,
    scope: SCOPE,
    data,
    predicates,
    mode: 'shadow',
  });

  const envelope = (json.envelope ?? {}) as Record<string, unknown>;
  return {
    status,
    released: json.status === 'released',
    enforced: json.enforced,
    mode: json.mode,
    releaseMode: envelope.mode,
    releaseId: envelope.releaseId,
    data: (json.data ?? {}) as Record<string, unknown>,
  };
}

/**
 * Fetch broker.release attestations minted for a subject (#1508), newest first.
 * Uses the DEMO_AGENT_TOKEN's bearer auth same as every other call in this script.
 */
async function getBrokerReleaseAttestations(
  cfg: Readonly<Config>,
  subjectDid: string,
): Promise<Array<Record<string, unknown>>> {
  const { status, json } = await getJson(
    cfg,
    `/auth/api/attestations/${encodeURIComponent(subjectDid)}?type=broker.release`,
  );
  if (status !== 200 || !Array.isArray(json)) return [];
  return json as unknown as Array<Record<string, unknown>>;
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
  const vault: VaultClient = createVaultClient();

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

    step('Restaurant requests dietary + allergy gate via the broker in SHADOW mode (#1231/#1511)');
    const restaurantRelease = await brokerShadow(
      cfg,
      travelerDid,
      ['dietary', 'allergies'],
      { dietary: unsealed.dietary, allergies: unsealed.allergies },
      { allergies: { predicate: 'overlaps', arg: ['peanut', 'egg', 'wheat'] } },
    );
    info(`restaurant: http=${restaurantRelease.status} released=${restaurantRelease.released} mode=${String(restaurantRelease.releaseMode)} enforced=${String(restaurantRelease.enforced)}`);
    assert(restaurantRelease.status === 200, 'restaurant request returns HTTP 200 (non-blocking)');
    assert(restaurantRelease.released, 'dietary + allergy gate is released');
    assert(restaurantRelease.releaseMode === 'mixed', 'release is MIXED mode (dietary raw, allergies attestation)');
    assert(restaurantRelease.data.dietary === PREFS.dietary, 'dietary raw value is present');
    const allergyClaim = restaurantRelease.data.allergies as Record<string, unknown> | undefined;
    assert(allergyClaim?.predicate === 'overlaps', 'allergies response is a predicate claim');
    assert(allergyClaim?.result === true, 'allergy overlap predicate returns true for the declared dish set');
    assert(!JSON.stringify(restaurantRelease.data).includes(unsealed.allergies), 'raw allergies value is absent from broker response');
    assert(restaurantRelease.enforced === false, 'restaurant decision is advisory (enforced:false)');

    step('Verify the attestation-mode field minted a signed claim, not just mode=attestation (#1508/#1515)');
    const releaseAttestations = await getBrokerReleaseAttestations(cfg, travelerDid);
    const allergiesAttestation = releaseAttestations.find(
      (a) => a.contextId === restaurantRelease.releaseId,
    );
    info(`broker.release attestations for traveler: ${releaseAttestations.length} (releaseId=${String(restaurantRelease.releaseId)})`);
    assert(!!allergiesAttestation, 'a broker.release attestation exists referencing the mixed releaseId');
    assert(
      typeof allergiesAttestation?.signature === 'string' && (allergiesAttestation.signature as string).length > 0,
      'the attestation carries a non-empty signature — a signed claim, not a bare tag',
    );
    const attestationPayload = JSON.stringify(allergiesAttestation?.payload ?? {});
    assert(
      !attestationPayload.includes(unsealed.allergies),
      'the attestation payload never carries the raw allergies value (withheld, unchanged)',
    );
    assert(
      attestationPayload.includes('predicateClaims'),
      'the release attestation carries predicate claim metadata',
    );

    const budget = await brokerShadow(cfg, travelerDid, ['budget'], { budget: unsealed.budget });
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
