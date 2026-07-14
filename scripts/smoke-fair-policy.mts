/**
 * Smoke test for /.well-known/fair-policy.json
 * Exercises the pure policy-building logic from constants — no server needed.
 *
 * Run: npx tsx scripts/smoke-fair-policy.mts
 */

// Constants mirrored from packages/fair/src/constants.ts
// (inlined to avoid ESM/CJS interop in this standalone script)
const PROTOCOL_FEE_BPS        = 100;  // 1.0%
const PROTOCOL_DID             = 'did:imajin:c6e6c109db4a1cc52995c0836f73cc6833d7e4624bc86e048118d72820873213';
const NODE_FEE_DEFAULT_BPS     = 50;  // 0.5%
const BUYER_CREDIT_DEFAULT_BPS = 25;  // 0.25%
const SCOPE_FEE_DEFAULT_BPS    = 25;  // 0.25%

process.env.NEXT_PUBLIC_DOMAIN = 'imajin.ai';
process.env.NEXT_PUBLIC_SERVICE_PREFIX = 'https://';

// ── Inline the route logic (mirrors route.ts exactly) ──────────────────────
function bpsToRate(bps: number): number { return bps / 10000; }

function buildPolicy() {
  const domain = process.env.NEXT_PUBLIC_DOMAIN ?? 'imajin.ai';
  const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX ?? 'https://';

  return {
    version: '1.0.0',
    node: `${prefix}${domain}`,
    fees: {
      mjn:   { rateBps: PROTOCOL_FEE_BPS,          rate: bpsToRate(PROTOCOL_FEE_BPS),          recipient: PROTOCOL_DID },
      node:  { rateBps: NODE_FEE_DEFAULT_BPS,       rate: bpsToRate(NODE_FEE_DEFAULT_BPS) },
      buyer: { rateBps: BUYER_CREDIT_DEFAULT_BPS,   rate: bpsToRate(BUYER_CREDIT_DEFAULT_BPS) },
      scope: { rateBps: SCOPE_FEE_DEFAULT_BPS,      rate: bpsToRate(SCOPE_FEE_DEFAULT_BPS) },
    },
    settlement: {
      methods: ['stripe', 'mjnx', 'usdc-base', 'usdc-solana'],
      minimum: { amount: '0.01', currency: 'USD' },
    },
    attribution: { required: true, manifest_format: 'fair-v1', chain_inclusion: true },
  };
}

// ── Assertions ───────────────────────────────────────────────────────────────
const policy = buildPolicy();
let passed = 0;
let failed = 0;
const EPS = 1e-9;

// S2301: split boolean-parameter assert into two focused helpers
function pass(label: string): void {
  console.log('  ✓  ' + label);
  passed++;
}

function fail(label: string, got?: unknown): void {
  // S4624: avoid nested template literals — use concatenation for the detail
  const detail = got !== undefined ? ' — got: ' + JSON.stringify(got) : '';
  console.error('  ✗  ' + label + detail);
  failed++;
}

function assertEqual<T>(label: string, actual: T, expected: T): void {
  if (actual === expected) pass(label); else fail(label, actual);
}

// S1244: never compare floats with ===; always use a range
function assertClose(label: string, actual: number, expected: number): void {
  if (Math.abs(actual - expected) < EPS) pass(label); else fail(label, actual);
}

function assertIncludes(label: string, arr: string[], value: string): void {
  if (arr.includes(value)) pass(label); else fail(label, arr);
}

function assertStartsWith(label: string, actual: string, prefix: string): void {
  if (actual.startsWith(prefix)) pass(label); else fail(label, actual);
}

console.log('\n/.well-known/fair-policy.json — smoke test\n');

equal: {
  assertEqual('version is 1.0.0',              policy.version, '1.0.0');
  assertEqual('node URL is https://imajin.ai',  policy.node, 'https://imajin.ai');

  assertEqual('fees.mjn.rateBps === 100',       policy.fees.mjn.rateBps, 100);
  assertEqual('fees.node.rateBps === 50',        policy.fees.node.rateBps, 50);
  assertEqual('fees.buyer.rateBps === 25',       policy.fees.buyer.rateBps, 25);
  assertEqual('fees.scope.rateBps === 25',       policy.fees.scope.rateBps, 25);

  assertEqual('settlement method count === 4',   policy.settlement.methods.length, 4);
  assertEqual('attribution.required === true',   policy.attribution.required, true);
  assertEqual('attribution.manifest_format',     policy.attribution.manifest_format, 'fair-v1');
  assertEqual('attribution.chain_inclusion',     policy.attribution.chain_inclusion, true);
}

floats: {
  assertClose('fees.mjn.rate ≈ 0.01',            policy.fees.mjn.rate, 0.01);
  assertClose('fees.node.rate ≈ 0.005',           policy.fees.node.rate, 0.005);
  assertClose('fees.buyer.rate ≈ 0.0025',         policy.fees.buyer.rate, 0.0025);
  assertClose('fees.scope.rate ≈ 0.0025',         policy.fees.scope.rate, 0.0025);

  const feeTotal = policy.fees.mjn.rate + policy.fees.node.rate + policy.fees.buyer.rate + policy.fees.scope.rate;
  if (feeTotal > 1.0) fail('total fee cascade ≤ 1.0', feeTotal); else pass('total fee cascade ≤ 1.0');
  assertClose('total fee cascade ≈ 2.0%',         feeTotal, 0.02);
}

strings: {
  assertStartsWith('fees.mjn.recipient is did:imajin:', policy.fees.mjn.recipient, 'did:imajin:');
  assertIncludes('settlement includes stripe',    policy.settlement.methods, 'stripe');
  assertIncludes('settlement includes mjnx',      policy.settlement.methods, 'mjnx');
  assertIncludes('settlement includes usdc-base', policy.settlement.methods, 'usdc-base');
}

console.log('\n' + String(passed) + ' passed, ' + String(failed) + ' failed\n');

if (failed > 0) process.exit(1);
