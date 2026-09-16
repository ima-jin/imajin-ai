import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// fileURLToPath, not `.pathname`: on Windows the latter yields "/D:/...", which
// node then resolves against the cwd into "C:\D:\..." and cannot load.
const SCRIPT = fileURLToPath(new URL('../ci-guard-stripe-import-scope.mjs', import.meta.url));

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'stripe-import-guard-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'apps', 'kernel', 'src', 'lib', 'pay'), { recursive: true });
  mkdirSync(join(dir, 'apps', 'kernel', 'app', 'pay'), { recursive: true });
  return dir;
}

function writeSource(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function writeAllowlist(dir, violations) {
  writeFileSync(join(dir, 'scripts', 'stripe-import-allowlist.json'), JSON.stringify({ violations }, null, 2), 'utf8');
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
    name: "passes for a file under lib/pay/providers/ that imports 'stripe'",
    file: 'apps/kernel/src/lib/pay/providers/stripe-withdraw-rail.ts',
    content: "import Stripe from 'stripe';\nexport class X {}",
    expectedFailSubstrings: null,
  },
  {
    name: "fails for a file under lib/pay/ (not providers/) that imports 'stripe'",
    file: 'apps/kernel/src/lib/pay/withdraw-intent.ts',
    content: "import Stripe from 'stripe';\nexport const x = 1;",
    expectedFailSubstrings: ['apps/kernel/src/lib/pay/withdraw-intent.ts'],
  },
  {
    name: "fails for a file under app/pay/ (not providers/) that imports 'stripe'",
    file: 'apps/kernel/app/pay/api/balance/withdraw/route.ts',
    content: "import Stripe from 'stripe';\nexport const x = 1;",
    expectedFailSubstrings: ['apps/kernel/app/pay/api/balance/withdraw/route.ts'],
  },
  {
    name: "detects require('stripe') as well as an ES import",
    file: 'apps/kernel/src/lib/pay/legacy-stripe.ts',
    content: "const Stripe = require('stripe');\nmodule.exports = Stripe;",
    expectedFailSubstrings: ['apps/kernel/src/lib/pay/legacy-stripe.ts'],
  },
  {
    name: 'passes when the file does not import stripe at all',
    file: 'apps/kernel/src/lib/pay/ledger.ts',
    content: "import { db } from '@/src/db';\nexport const x = db;",
    expectedFailSubstrings: null,
  },
  {
    name: 'ignores a mention of stripe inside a comment or string',
    file: 'apps/kernel/src/lib/pay/notes.ts',
    content: "// this used to import from 'stripe' directly\nconst label = \"from 'stripe'\";\nexport { label };",
    expectedFailSubstrings: null,
  },
  {
    name: 'excludes test files from scanning',
    file: 'apps/kernel/src/lib/pay/__tests__/withdraw-intent.test.ts',
    content: "import Stripe from 'stripe';\nexport const x = 1;",
    expectedFailSubstrings: null,
  },
];

describe('ci-guard-stripe-import-scope', () => {
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

  it('passes when the only violation is in the allowlist', () => {
    const dir = makeTempRepo();
    writeSource(dir, 'apps/kernel/src/lib/pay/stripe.ts', "import Stripe from 'stripe';\nexport const x = 1;");
    writeAllowlist(dir, [{ file: 'apps/kernel/src/lib/pay/stripe.ts' }]);

    expectPass(dir);
  });

  it('still fails on a NEW violation in a different file even when one is allowlisted', () => {
    const dir = makeTempRepo();
    writeSource(dir, 'apps/kernel/src/lib/pay/stripe.ts', "import Stripe from 'stripe';\nexport const x = 1;");
    writeSource(dir, 'apps/kernel/src/lib/pay/webhook-handlers.ts', "import Stripe from 'stripe';\nexport const y = 1;");
    writeAllowlist(dir, [{ file: 'apps/kernel/src/lib/pay/stripe.ts' }]);

    expectFail(dir, 'apps/kernel/src/lib/pay/webhook-handlers.ts');
  });

  it('--list prints every violation as JSON regardless of the allowlist', () => {
    const dir = makeTempRepo();
    writeSource(dir, 'apps/kernel/src/lib/pay/stripe.ts', "import Stripe from 'stripe';\nexport const x = 1;");
    writeAllowlist(dir, [{ file: 'apps/kernel/src/lib/pay/stripe.ts' }]);

    const result = runGuard(dir, ['--list']);
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ file: 'apps/kernel/src/lib/pay/stripe.ts' });
  });
});
