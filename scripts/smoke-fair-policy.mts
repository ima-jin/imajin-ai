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
const FOUNDATION_SHARE = 0.10;
const DEVELOPER_SHARE  = 0.10;
const COMMUNITY_SHARE  = 0.80;

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
    policy: {
      foundation: { share: FOUNDATION_SHARE, recipient: PROTOCOL_DID },
      developers: { share: DEVELOPER_SHARE,  recipient: 'did:imajin:DEV_POOL' },
      community:  { share: COMMUNITY_SHARE,  recipient: 'did:imajin:COMMUNITY_POOL' },
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

function assert(label: string, condition: boolean, got?: unknown) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ''}`);
    failed++;
  }
}

console.log('\n/.well-known/fair-policy.json — smoke test\n');

assert('version is 1.0.0',               policy.version === '1.0.0', policy.version);
assert('node URL is https://imajin.ai',   policy.node === 'https://imajin.ai', policy.node);

assert('fees.mjn.rateBps === 100',        policy.fees.mjn.rateBps === 100, policy.fees.mjn.rateBps);
assert('fees.mjn.rate === 0.01',          policy.fees.mjn.rate === 0.01,   policy.fees.mjn.rate);
assert('fees.mjn.recipient set',          typeof policy.fees.mjn.recipient === 'string' && policy.fees.mjn.recipient.startsWith('did:imajin:'));

assert('fees.node.rateBps === 50',        policy.fees.node.rateBps === 50,   policy.fees.node.rateBps);
assert('fees.node.rate === 0.005',        policy.fees.node.rate === 0.005,   policy.fees.node.rate);

assert('fees.buyer.rateBps === 25',       policy.fees.buyer.rateBps === 25,  policy.fees.buyer.rateBps);
assert('fees.buyer.rate === 0.0025',      policy.fees.buyer.rate === 0.0025, policy.fees.buyer.rate);

assert('fees.scope.rateBps === 25',       policy.fees.scope.rateBps === 25,  policy.fees.scope.rateBps);
assert('fees.scope.rate === 0.0025',      policy.fees.scope.rate === 0.0025, policy.fees.scope.rate);

const feeTotal = policy.fees.mjn.rate + policy.fees.node.rate + policy.fees.buyer.rate + policy.fees.scope.rate;
assert('total fee cascade ≤ 1.0',         feeTotal <= 1.0, feeTotal);
assert('total fee cascade = 2.0%',        Math.abs(feeTotal - 0.02) < 0.000001, feeTotal);

assert('policy.foundation.share === 0.10', policy.policy.foundation.share === FOUNDATION_SHARE);
assert('policy.developers.share === 0.10', policy.policy.developers.share === DEVELOPER_SHARE);
assert('policy.community.share === 0.80',  policy.policy.community.share === COMMUNITY_SHARE);

const policyTotal = policy.policy.foundation.share + policy.policy.developers.share + policy.policy.community.share;
assert('policy splits sum to 1.0',        Math.abs(policyTotal - 1.0) < 0.000001, policyTotal);

assert('settlement has 4 methods',        policy.settlement.methods.length === 4, policy.settlement.methods);
assert('settlement includes stripe',      policy.settlement.methods.includes('stripe'));
assert('settlement includes mjnx',        policy.settlement.methods.includes('mjnx'));
assert('settlement includes usdc-base',   policy.settlement.methods.includes('usdc-base'));

assert('attribution.required === true',   policy.attribution.required === true);
assert('attribution.manifest_format',     policy.attribution.manifest_format === 'fair-v1');
assert('attribution.chain_inclusion',     policy.attribution.chain_inclusion === true);

console.log(`\n${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exit(1);
