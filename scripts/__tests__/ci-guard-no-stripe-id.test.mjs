import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// fileURLToPath, not `.pathname`: on Windows the latter yields "/D:/...", which
// node then resolves against the cwd into "C:\D:\..." and cannot load.
const SCRIPT = fileURLToPath(new URL('../ci-guard-no-stripe-id.mjs', import.meta.url));

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'no-stripe-id-guard-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'apps', 'kernel', 'src'), { recursive: true });
  mkdirSync(join(dir, 'packages'), { recursive: true });
  return dir;
}

function writeSource(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function writeAllowlist(dir, violations) {
  writeFileSync(join(dir, 'scripts', 'stripe-id-allowlist.json'), JSON.stringify({ violations }, null, 2), 'utf8');
}

function runGuard(dir, extraArgs = []) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...extraArgs], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, CI_GUARD_WORKDIR: dir },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      status: e.status ?? 1,
    };
  }
}

function expectPass(dir) {
  const result = runGuard(dir);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('PASS');
}

function expectFail(dir, ...expectedSubstrings) {
  const result = runGuard(dir);
  const output = result.stdout + result.stderr;
  expect(result.status).toBe(1);
  expect(output).toContain('FAIL');
  for (const substring of expectedSubstrings) {
    expect(output).toContain(substring);
  }
  return output;
}

const SINGLE_FILE_CASES = [
  {
    name: 'fails for a drizzle column definition of stripe_id',
    file: 'apps/kernel/src/db/schemas/pay.ts',
    content: "export const t = { stripeId: text('stripe_id') };",
    expectedFailSubstrings: ['apps/kernel/src/db/schemas/pay.ts:1'],
  },
  {
    name: 'fails for a reader of the `stripeId` property',
    file: 'apps/kernel/src/lib/pay/refund.ts',
    content: 'const ref = originalTx.stripeId;\nexport { ref };',
    expectedFailSubstrings: ['apps/kernel/src/lib/pay/refund.ts:1', 'stripeId'],
  },
  {
    name: 'fails for a raw-SQL reference in another app (cross-schema join)',
    file: 'apps/events/app/api/sales/route.ts',
    content: 'const q = `\n  LEFT JOIN pay.transactions tx ON tx.stripe_id = o.stripe_session_id\n`;\nexport { q };',
    expectedFailSubstrings: ['apps/events/app/api/sales/route.ts:2', 'stripe_id'],
  },
  {
    name: 'fails for a snake_cased alias that embeds the name (tx_stripe_id)',
    file: 'apps/events/app/api/sales/route.ts',
    content: "const q = 'SELECT tx.x AS tx_stripe_id';\nexport { q };",
    expectedFailSubstrings: ['apps/events/app/api/sales/route.ts:1'],
  },
  {
    name: 'fails for a reference under packages/',
    file: 'packages/pay-types/src/index.ts',
    content: 'export interface Tx { stripe_id: string | null }',
    expectedFailSubstrings: ['packages/pay-types/src/index.ts:1'],
  },
  {
    name: 'passes for the rail-generic columns',
    file: 'apps/kernel/src/lib/pay/external-ref.ts',
    content: "export const cols = { rail: 'stripe', externalRef: 'cs_1' };\nexport const sql = 'external_ref';",
    expectedFailSubstrings: null,
  },
  {
    name: 'ignores identifiers that merely contain the name (stripeIdx, checkoutStripeId, stripe_identity)',
    file: 'apps/kernel/src/db/schemas/pay.ts',
    content: "const stripeIdx = 1;\nconst checkoutStripeId = 2;\nconst stripe_identity = 3;\nexport { stripeIdx, checkoutStripeId, stripe_identity };",
    expectedFailSubstrings: null,
  },
  {
    name: 'ignores a mention inside a line or block comment',
    file: 'apps/kernel/src/lib/pay/notes.ts',
    content: '// stripe_id was dropped in #2650\n/* the old stripeId alias\n   is gone */\nexport const x = 1;',
    expectedFailSubstrings: null,
  },
  {
    name: 'excludes test files from scanning',
    file: 'apps/kernel/src/lib/pay/__tests__/refund.test.ts',
    content: "expect(sql).not.toContain('stripe_id');",
    expectedFailSubstrings: null,
  },
  {
    name: 'excludes node_modules',
    file: 'apps/kernel/node_modules/x/index.js',
    content: 'module.exports = { stripe_id: 1 };',
    expectedFailSubstrings: null,
  },
];

describe('ci-guard-no-stripe-id', () => {
  for (const testCase of SINGLE_FILE_CASES) {
    it(testCase.name, () => {
      const dir = makeTempRepo();
      writeSource(dir, testCase.file, testCase.content);

      if (testCase.expectedFailSubstrings) {
        expectFail(dir, ...testCase.expectedFailSubstrings);
      } else {
        expectPass(dir);
      }
    });
  }

  it('reports every hit with its file:line', () => {
    const dir = makeTempRepo();
    writeSource(dir, 'apps/kernel/src/a.ts', 'const a = 1;\nconst b = row.stripe_id;\nconst c = row.stripeId;');
    const output = expectFail(dir, 'apps/kernel/src/a.ts:2', 'apps/kernel/src/a.ts:3');
    expect(output).toContain('2 reference(s)');
  });

  it('passes when the only reference is in the allowlist (the deprecated public API field)', () => {
    const dir = makeTempRepo();
    writeSource(dir, 'apps/kernel/app/pay/api/transactions/route.ts', 'const r = { stripe_id: tx.externalRef };\nexport { r };');
    writeAllowlist(dir, [{ file: 'apps/kernel/app/pay/api/transactions/route.ts' }]);

    expectPass(dir);
  });

  it('still fails on a NEW reference in a different file even when one is allowlisted', () => {
    const dir = makeTempRepo();
    writeSource(dir, 'apps/kernel/app/pay/api/transactions/route.ts', 'const r = { stripe_id: tx.externalRef };\nexport { r };');
    writeSource(dir, 'apps/kernel/src/lib/pay/refund.ts', 'export const x = tx.stripeId;');
    writeAllowlist(dir, [{ file: 'apps/kernel/app/pay/api/transactions/route.ts' }]);

    expectFail(dir, 'apps/kernel/src/lib/pay/refund.ts:1');
  });

  it('--list prints every hit as JSON regardless of the allowlist', () => {
    const dir = makeTempRepo();
    writeSource(dir, 'apps/kernel/src/a.ts', 'export const x = row.stripe_id;');
    writeAllowlist(dir, [{ file: 'apps/kernel/src/a.ts' }]);

    const result = runGuard(dir, ['--list']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toEqual([{ file: 'apps/kernel/src/a.ts', line: 1, name: 'stripe_id' }]);
  });

  it('passes on a repo with no apps/packages sources at all', () => {
    expectPass(makeTempRepo());
  });
});
