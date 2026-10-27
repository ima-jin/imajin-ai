import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { state } = vi.hoisted(() => ({
  state: {
    vault: new Map<string, string>(),
    principal: 'did:imajin:billing-owner',
    client: null as unknown as import('@electric-sql/pglite').PGlite,
  },
}));
vi.mock('@/src/db', async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { pgSchema, text, jsonb } = await import('drizzle-orm/pg-core');
  const usage = await import('@/src/db/schemas/usage');
  const channelLinks = pgSchema('auth').table('channel_links', {
    did: text('did'), channel: text('channel'), appDid: text('app_did'),
    status: text('status'), scopes: jsonb('scopes'),
  });
  state.client = new PGlite();
  return { db: drizzle(state.client), channelLinks, ...usage };
});
vi.mock('@imajin/db', () => {
  const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((query, part, i) => query + (i ? `$${i}` : '') + part, '');
    const params = values.map(value => value instanceof Date ? value.toISOString() : value);
    return state.client.query(text, params);
  }, { json: (value: unknown) => JSON.stringify(value) });
  return { getClient: () => sql };
});
vi.mock('@/src/lib/vault', () => ({
  sealAndStoreV2: async (field: string, value: string) => { state.vault.set(field, value); },
  sealAndStore: vi.fn(),
  loadAndUnseal: async (field: string) => state.vault.get(field),
  vaultFieldStatus: async (field: string) => state.vault.has(field) ? 'ready' : 'absent',
  revokeVaultDelegationGrantsForConnector: vi.fn(),
}));
vi.mock('@/src/lib/kernel/connector-registry-store', () => ({
  recordConnectorRegistration: vi.fn(), revokeConnectorRegistration: vi.fn(),
}));
vi.mock('@/src/lib/notify/connector-events', () => ({
  notifyConnectorCredentialSealed: vi.fn(), notifyConnectorCredentialUnsealed: vi.fn(),
}));
vi.mock('@/src/lib/kernel/connector-owner-did', () => ({
  resolveConnectorOwnerDid: async () => ({ ok: true, ownerDid: state.principal }),
}));
vi.mock('@imajin/auth', () => ({
  resolveEffectiveDid: async () => ({ ok: true, effectiveDid: state.principal }),
}));
vi.mock('@/src/cron/auth', () => ({ requireCronAuth: async () => null }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: () => ({}), corsOptions: vi.fn() }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

// Keep the sweep, credential gate, SQL upsert and reconciliation real. Only the
// remote billing API is substituted, so no live credentials/network are needed.
vi.mock('../anthropic', () => ({
  createAnthropicBilledUsageReader: () => ({
    fetch: async () => [{ model: 'fixture-anthropic-model', tokensIn: 10, tokensOut: 2, billedUsd: 3, raw: {} }],
  }),
}));
vi.mock('../openai', () => ({
  createOpenAIBilledUsageReader: () => ({
    fetch: async () => [{ model: 'fixture-openai-model', tokensIn: 20, tokensOut: 4, billedUsd: 5, raw: {} }],
  }),
}));

import { GET as cron } from '@/app/api/cron/usage-billed-ingest/route';
import { GET as reconciliation } from '@/app/usage/api/reconciliation/route';
import { POST as sealAnthropic } from '@/app/anthropic/api/billing-key/route';
import { POST as sealOpenai } from '@/app/openai/api/billing-key/route';

beforeAll(async () => {
  await state.client.exec(`
    CREATE SCHEMA auth; CREATE SCHEMA usage;
    CREATE TABLE auth.channel_links (did text, channel text, app_did text, status text, scopes jsonb);
    CREATE TABLE usage.billed (
      id text PRIMARY KEY, principal_did text, provider text, period_start timestamptz,
      period_end timestamptz, granularity text, model text, tokens_in bigint,
      tokens_out bigint, billed_usd numeric, raw jsonb, fetched_at timestamptz,
      source text NOT NULL DEFAULT 'api'
    );
    CREATE UNIQUE INDEX billed_period ON usage.billed
      (principal_did, provider, period_start, granularity, COALESCE(model, ''));
    CREATE TABLE usage.incurred (
      principal_did text, provider text, model text, created_at timestamptz,
      tokens_in integer, tokens_out integer, cost_usd numeric
    );
    INSERT INTO auth.channel_links VALUES
      ('did:imajin:billing-owner', 'anthropic', 'did:imajin:anthropic-connector', 'active', '["anthropic:billing"]'),
      ('did:imajin:billing-owner', 'openai', 'did:imajin:openai-connector', 'active', '["openai:billing"]');
  `);
}, 30_000);
afterAll(async () => { await state.client.close(); });

describe('billing seal acceptance (#3136)', () => {
  it('stops skipping after UI-route sealing, writes source=api and returns daily/model drift', async () => {
    const request = () => new NextRequest('https://kernel.test/api/cron/usage-billed-ingest');
    const before = await (await cron(request())).json();
    expect(before.results).toEqual([]);

    for (const seal of [sealAnthropic, sealOpenai]) {
      const response = await seal(new NextRequest('https://kernel.test/billing-key', {
        method: 'POST', body: JSON.stringify({ token: 'fixture-not-a-provider-key' }),
      }));
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ sealed: true });
    }
    const after = await (await cron(request())).json();
    expect(after.failures).toEqual([]);
    expect(after.results).toHaveLength(4);
    expect(after.results.every((result: { rowsWritten: number }) => result.rowsWritten === 1)).toBe(true);
    const billed = await state.client.query<{ provider: string; source: string }>('SELECT provider, source FROM usage.billed');
    expect(billed.rows).toHaveLength(4);
    expect(billed.rows.every(row => row.source === 'api')).toBe(true);

    await state.client.exec(`
      INSERT INTO usage.incurred
      SELECT principal_did, provider, model, period_start, 10, 2, billed_usd - 1
      FROM usage.billed WHERE granularity = 'day';
    `);
    const result = await reconciliation(new NextRequest('https://kernel.test/usage/api/reconciliation'));
    expect(result.status).toBe(200);
    const { rows } = await result.json();
    expect(rows).toHaveLength(2); // month buckets must not double-count the day
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'anthropic', model: 'fixture-anthropic-model', billedUsd: 3, driftUsd: 1 }),
      expect.objectContaining({ provider: 'openai', model: 'fixture-openai-model', billedUsd: 5, driftUsd: 1 }),
    ]));
    expect(rows.every((row: { date: string }) => /^\d{4}-\d{2}-\d{2}$/.test(row.date))).toBe(true);
    await cron(request());
    expect((await state.client.query('SELECT id FROM usage.billed')).rows).toHaveLength(4);
    state.principal = 'did:imajin:other-owner';
    expect(await (await reconciliation(new NextRequest('https://kernel.test/usage/api/reconciliation'))).json()).toEqual({ rows: [] });
  }, 30_000);
});
