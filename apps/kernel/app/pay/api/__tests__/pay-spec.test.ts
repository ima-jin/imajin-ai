/**
 * `api-spec/pay.yaml` structural validity + the #2177 item 3 contract:
 * rail-generic operations are ADDITIVE aliases of the Stripe-named ones —
 * every pre-existing operationId and path is still present — and every
 * rail-generic path is backed by a real route file.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const KERNEL_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SPEC_PATH = join(KERNEL_ROOT, 'api-spec', 'pay.yaml');
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const spec = parse(readFileSync(SPEC_PATH, 'utf8')) as Json;

function operations(): Array<{ path: string; method: string; op: Json }> {
  return Object.entries(spec.paths as Json).flatMap(([path, item]) =>
    HTTP_METHODS.filter((m) => (item as Json)[m]).map((method) => ({ path, method, op: (item as Json)[method] as Json })),
  );
}

/** Every operationId on `origin/main` before #2177 — clients keyed on these must keep working. */
const PRE_EXISTING: Record<string, { path: string; method: string }> = {
  healthCheck: { path: '/api/health', method: 'get' },
  getBalance: { path: '/api/balance/{did}', method: 'get' },
  giftCredits: { path: '/api/balance/gift', method: 'post' },
  eventTopup: { path: '/api/balance/event-topup', method: 'post' },
  withdraw: { path: '/api/balance/withdraw', method: 'post' },
  transferBalance: { path: '/api/balance/transfer', method: 'post' },
  topupBalance: { path: '/api/balance/topup', method: 'post' },
  createCharge: { path: '/api/charge', method: 'post' },
  createCheckout: { path: '/api/checkout', method: 'post' },
  fairSettle: { path: '/api/settle', method: 'post' },
  createEscrow: { path: '/api/escrow', method: 'post' },
  releaseEscrow: { path: '/api/escrow', method: 'put' },
  stripeConnectOnboard: { path: '/api/connect/onboard', method: 'post' },
  stripeConnectStatus: { path: '/api/connect/status', method: 'get' },
  stripeConnectDashboard: { path: '/api/connect/dashboard', method: 'get' },
  stripeConnectWebhook: { path: '/api/connect/webhook', method: 'post' },
  listTransactions: { path: '/api/transactions/{did}', method: 'get' },
  transactionSummary: { path: '/api/transactions/{did}/summary', method: 'get' },
  stripeWebhook: { path: '/api/webhook', method: 'post' },
  refund: { path: '/api/refund', method: 'post' },
  payReconciliation: { path: '/api/admin/reconciliation', method: 'get' },
  retryPaymentRequestSettlement: { path: '/api/admin/payment-requests/{id}/retry-settlement', method: 'post' },
  createPaymentRequest: { path: '/api/payment-requests', method: 'post' },
  listPaymentRequests: { path: '/api/payment-requests', method: 'get' },
  getPaymentRequest: { path: '/api/payment-requests/{id}', method: 'get' },
  getPaymentRequestByHandle: { path: '/api/payment-requests/by-handle/{handle}', method: 'get' },
  voidPaymentRequest: { path: '/api/payment-requests/{id}/void', method: 'post' },
  createPaymentRequestCheckout: { path: '/api/payment-requests/{id}/checkout', method: 'post' },
  settlePaymentRequestManual: { path: '/api/payment-requests/{id}/settle', method: 'post' },
  getSpec: { path: '/api/spec', method: 'get' },
};

/** Stripe-named operationId → its rail-generic alias. */
const ALIASES: Record<string, string> = {
  stripeConnectOnboard: 'railConnectOnboard',
  stripeConnectStatus: 'railConnectStatus',
  stripeConnectDashboard: 'railConnectDashboard',
  stripeConnectWebhook: 'railConnectWebhook',
  stripeWebhook: 'railWebhook',
};

function resolveRef(ref: string): unknown {
  expect(ref.startsWith('#/')).toBe(true);
  return ref
    .slice(2)
    .split('/')
    .reduce<unknown>((node, key) => (node as Json | undefined)?.[key], spec);
}

function collectRefs(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, out);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') out.push(value);
      else collectRefs(value, out);
    }
  }
  return out;
}

describe('pay.yaml is a structurally valid OpenAPI 3.1 document', () => {
  it('declares openapi 3.1.x with info and paths', () => {
    expect(String(spec.openapi)).toMatch(/^3\.1\./);
    expect(spec.info.title).toBeTruthy();
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
  });

  it('has unique operationIds', () => {
    const ids = operations().map(({ op }) => op.operationId as string);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('resolves every $ref', () => {
    const refs = collectRefs(spec);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(resolveRef(ref), `unresolved $ref ${ref}`).toBeDefined();
  });

  it('declares every {path} parameter on every operation', () => {
    for (const { path, method, op } of operations()) {
      const declared = new Set(
        ((op.parameters ?? []) as Json[])
          .map((p) => (p.$ref ? (resolveRef(p.$ref) as Json) : p))
          .filter((p) => p.in === 'path')
          .map((p) => p.name as string),
      );
      const itemParams = ((spec.paths[path].parameters ?? []) as Json[])
        .map((p) => (p.$ref ? (resolveRef(p.$ref) as Json) : p))
        .filter((p) => p.in === 'path')
        .map((p) => p.name as string);
      for (const name of itemParams) declared.add(name);
      for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
        expect(declared.has(name!), `${method.toUpperCase()} ${path} does not declare {${name}}`).toBe(true);
      }
    }
  });

  it('references only defined security schemes', () => {
    const schemes = new Set(Object.keys(spec.components.securitySchemes));
    for (const { op } of operations()) {
      for (const requirement of (op.security ?? []) as Json[]) {
        for (const name of Object.keys(requirement)) expect(schemes.has(name), `unknown scheme ${name}`).toBe(true);
      }
    }
  });
});

describe('rail-generic operations are additive aliases (#2177 item 3)', () => {
  const byId = new Map(operations().map((o) => [o.op.operationId as string, o]));

  it('keeps every pre-existing operationId on its original path and method', () => {
    for (const [id, { path, method }] of Object.entries(PRE_EXISTING)) {
      const found = byId.get(id);
      expect(found, `operationId ${id} was removed`).toBeDefined();
      expect({ path: found!.path, method: found!.method }, `operationId ${id} moved`).toEqual({ path, method });
    }
  });

  it('documents a rail-generic operation for every Stripe-named connect/webhook operation', () => {
    for (const [legacyId, genericId] of Object.entries(ALIASES)) {
      const legacy = byId.get(legacyId)!;
      const generic = byId.get(genericId);
      expect(generic, `${genericId} is missing`).toBeDefined();
      expect(legacy.op['x-rail-generic-alias']).toBe(genericId);
      expect(generic!.method).toBe(legacy.method);
      // …at the legacy path with the rail segment generalised to {provider}.
      const expectedPath = legacy.path.replace(/^\/api\/connect\/(\w+)$/, '/api/connect/{provider}/$1').replace(/^\/api\/webhook$/, '/api/webhook/{provider}');
      expect(generic!.path).toBe(expectedPath);
    }
  });

  it('keeps rail names out of the rail-generic operations’ ids and paths', () => {
    for (const genericId of Object.values(ALIASES)) {
      const { path } = byId.get(genericId)!;
      expect(genericId.toLowerCase()).not.toContain('stripe');
      expect(path.toLowerCase()).not.toContain('stripe');
    }
  });

  it('makes Stripe one value of the provider enums', () => {
    expect(spec.components.schemas.PaymentProvider.enum).toEqual(expect.arrayContaining(['stripe', 'solana']));
    expect(spec.components.schemas.ConnectProvider.enum).toContain('stripe');
    expect((resolveRef(spec.components.parameters.provider.schema.$ref) as Json).enum).toContain('stripe');
  });

  it('keeps the Stripe-named security scheme as an alias of the rail-generic one', () => {
    expect(spec.components.securitySchemes.railWebhookSignature).toBeDefined();
    expect(spec.components.securitySchemes.stripeWebhook).toBeDefined();
  });

  it('adds customerId/provider to the charge recipient while keeping stripeCustomerId', () => {
    const to = byId.get('createCharge')!.op.requestBody.content['application/json'].schema.properties.to.properties;
    expect(Object.keys(to)).toEqual(expect.arrayContaining(['customerId', 'provider', 'stripeCustomerId', 'solanaAddress', 'did']));
  });

  it('backs every rail-generic path with a route file exporting its method', () => {
    for (const genericId of Object.values(ALIASES)) {
      const { path, method } = byId.get(genericId)!;
      // /api/connect/{provider}/onboard → app/pay/api/connect/[provider]/onboard/route.ts
      const routeFile = join(KERNEL_ROOT, 'app', 'pay', ...path.replace('{provider}', '[provider]').split('/').filter(Boolean), 'route.ts');
      expect(existsSync(routeFile), `${routeFile} is missing`).toBe(true);
      expect(readFileSync(routeFile, 'utf8')).toContain(`export const ${method.toUpperCase()} =`);
    }
  });
});
