import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CONSUMER_FILES, HISTORY_DIRECTORIES, HISTORY_RECORDS, ROUTE_BLOCK_THRESHOLD, scanDocument, scanRepo,
} from '../ci-guard-current-state-docs.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts/ci-guard-current-state-docs.mjs');
const temporaryDirectories = [];
afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'consumer-docs-'));
  temporaryDirectories.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

const routes = (count, shape = n => `- GET, OPTIONS /auth/api/example/${n} — apps/kernel/app/example/route.ts`) =>
  Array.from({ length: count }, (_, n) => shape(n)).join('\n');
const run = dir => spawnSync(process.execPath, [script], {
  encoding: 'utf8', env: { ...process.env, CI_GUARD_WORKDIR: dir },
});

describe('current-state consumer documentation guard', () => {
  it.each([
    '## v0.9.9 addendum', '# v12.123.456', '### Release ADDENDUM',
    '#### Version delta', '###### Current v1.2.3 behavior',
    'Release v0.9.9\n---', 'Release delta\n===', 'Version addendum\n---',
    '## Addendum release', '## Delta version', '## Release: delta',
  ])('rejects history headings: %s', heading => {
    expect(scanDocument(heading)).toContainEqual(expect.objectContaining({ rule: 'history heading' }));
  });

  it.each([
    'docs/REGISTRATION.md', 'migrations/OWNERSHIP.md',
    'packages/openclaw-infer-passthrough/README.md', 'docs/ENVIRONMENTS.md',
    'docs/notify-operator-approvals-contract.md', 'docs/warp-notification-chain.md',
    'docs/npm-publishing.md', 'docs/mjn-whitepaper.md', 'docs/loops-rail-contract.md',
    'docs/security/node-key-roles-and-rotation.md', 'docs/agents/nanoclaw-first-boot.md', 'docs/DEVELOPER.md',
  ])('retains deferred consumer %s in guard coverage', file => {
    expect(CONSUMER_FILES).toContain(file);
  });

  it.each(['llms.txt', 'llms-full.txt'])('%s retains only the existing llms blockquote wording', name => {
    const text = readFileSync(join(root, 'apps/kernel/public', name), 'utf8');
    expect(text.split(/\r?\n/)[2]).toBe(
      '> You compose. Imajin orchestrates. Signed. Legible. Imajin is Agentic Relation Management.',
    );
  });

  it.each([
    ['deploy/README.md', 'PM2_ALERT_WEBHOOK', 'protected'],
    ['deploy/README.md', 'RESTART_ALERT_WEBHOOK', 'crontab and logs'],
    ['deploy/README.md', 'RESTART_ALERT_THRESHOLD', 'default 5'],
    ['deploy/README.md', 'RESTART_ALERT_WINDOW', 'default 600'],
    ['deploy/README.md', 'RESTART_ALERT_STATE', '~/.cache/imajin/pm2-restarts.<scope>.json'],
    ['deploy/README.md', 'STATUS_ALERT_WEBHOOK', 'RESTART_ALERT_WEBHOOK'],
    ['deploy/README.md', 'STATUS_ALERT_REPEAT', 'default 3600'],
    ['deploy/README.md', 'CRON_STATE_PATH', 'apps/kernel/.cron-state.json'],
    ['deploy/README.md', 'CRON_VAULT_FETCH_TIMEOUT_MS', 'default 120000'],
    ['deploy/README.md', 'scripts/ci-guard-cron-manifest.mjs', 'route/schedule agreement'],
    ['deploy/README.md', 'PORT_REAP_FAILED', 'scripts/lib/reap-port.sh'],
    ['deploy/README.md', 'scripts/build-restart-failed.test.sh', 'exit code 2'],
    ['deploy/README.md', 'UND_ERR_HEADERS_TIMEOUT', 'packages/auth/src/internal-fetch.cjs'],
    ['deploy/README.md', 'REPRO_DEFAULT_HEADERS=1', 'not the bounded-pass criterion'],
    ['deploy/README.md', 'NODE_CARD_RAIL_NOT_CONFIGURED', 'HTTP 503'],
    ['apps/kernel/README.md', 'PROFILE_INTERNAL_API_KEY', 'never in browser code'],
    ['apps/kernel/README.md', 'OPERATOR_APPROVAL_EXPIRY_DAYS', 'default seven days'],
    ['docs/ops/DEPLOY-POSTURE.md', 'scripts/ci-guard-required-contexts.mjs', 'required CI jobs'],
    ['docs/ops/DEPLOY-POSTURE.md', 'scripts/lib/git-version.mjs', 'no release tag exists'],
  ])('preserves current operator fact %s: %s', (file, token, fact) => {
    const lines = readFileSync(join(root, file), 'utf8').split(/\r?\n/);
    const line = lines.find(value => value.includes(`\`${token}\``));
    expect(line).toBeDefined();
    expect(line).toContain(fact);
    expect(line).not.toMatch(/\bv\d+\.\d+\.\d+\b|#\d+/);
  });

  it('links the existing OpenClaw MCP runbook from a consumer entry point', () => {
    const readme = readFileSync(join(root, 'apps/kernel/README.md'), 'utf8');
    expect(readme).toContain('](../../docs/ops/openclaw-mcp.md)');
    expect(readFileSync(join(root, 'docs/ops/openclaw-mcp.md'), 'utf8')).not.toBe('');
  });

  it.each([
    '# Current integration', 'A single GET /auth/api/example route in prose.',
    'See the [auth spec](https://jin.imajin.ai/auth/api/spec).',
    'The version field is a wire-format field, not release history.',
    '```md\n## Example addendum heading in a literal\n```',
    '~~~md\n## Example delta heading in a literal\n~~~',
    '### Deltastream is a name', '### v1.2 wire format',
    '## Delta sync', '## Addendum', 'Contract delta\n===', 'Source addendum\n---',
  ])('allows concepts, links, single routes and literals: %s', content => {
    expect(scanDocument(content)).toEqual([]);
  });

  it.each([
    n => `- GET, OPTIONS /auth/api/${n} — source`,
    n => `GET /auth/api/${n}`,
    n => `| POST | /media/api/${n} | Description |`,
    n => `| GET | /auth/api/${n} | route.ts | Generated description |`,
    n => `- \`GET\` \`/auth/api/${n}\``,
    n => `- /auth/api/${n} — source`,
    n => `1. DELETE https://node.example/auth/api/${n}`,
  ])('rejects inventories in list, table and raw forms', shape => {
    const block = routes(ROUTE_BLOCK_THRESHOLD, shape);
    expect(scanDocument(block)).toEqual([{ file: 'README.md', line: 1, rule: 'route inventory' }]);
    expect(scanDocument(`\`\`\`text\n${block}\n\`\`\``)).toEqual([]);
    expect(scanDocument(routes(ROUTE_BLOCK_THRESHOLD - 1, shape))).toEqual([]);
  });

  it('reports one start per run and resets after prose or a blank line', () => {
    expect(scanDocument(routes(12))).toHaveLength(1);
    expect(scanDocument(`${routes(5)}\n\n${routes(5)}`)).toEqual([]);
    expect(scanDocument(`${routes(5)}\nIntegration explanation.\n${routes(5)}`)).toEqual([]);
    expect(scanDocument(`# Guide\r\n${routes(6).replaceAll('\n', '\r\n')}`)[0].line).toBe(2);
    expect(scanDocument(routes(6, n => `| GET /api/${n} | owner | **irreversible** | reason |`))).toEqual([]);
  });

  it.each(CONSUMER_FILES)('covers the explicit consumer path %s', file => {
    const dir = fixture({ [file]: '## v0.9.9 addendum' });
    expect(scanRepo(dir)).toEqual([{ file, line: 1, rule: 'history heading' }]);
  });

  it('retains exact records and exempts new documents in each records tier', () => {
    expect(HISTORY_RECORDS.size).toBe(10);
    const files = Object.fromEntries([...HISTORY_RECORDS].map(file => [file, '## v0.9.9 addendum']));
    for (const dir of HISTORY_DIRECTORIES) files[`${dir}new-record.md`] = `## v0.9.9 addendum\n${routes(6)}`;
    files['docs/guide/consumer-guide.md'] = routes(6);
    const dir = fixture(files);
    expect(scanRepo(dir)).toEqual([{ file: 'docs/guide/consumer-guide.md', line: 1, rule: 'route inventory' }]);
  });

  it.each([
    ['docs/adr/0009.md', '## Context (v0.9.0 cut)'],
    ['docs/canon/rfcs/RFC-41-x.md', '## Addendum'],
    ['docs/guide/sync.md', '## Delta sync'],
    ['docs/guide/example.md', '```http\nGET /a\nGET /b\nGET /c\nGET /d\nGET /e\nGET /f\n```'],
  ])('passes the review probe through scanner and real CLI: %s', (file, content) => {
    const dir = fixture({ [file]: content });
    expect(scanRepo(dir)).toEqual([]);
    const passed = run(dir);
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain('PASS:');
  });

  it.each(['docs/adrs/', 'docs/canonical/', 'docs/rfcs-guide/', 'docs/audits-guide/'])(
    'does not exempt directory names merely prefixed like records: %s', dir => {
      expect(scanRepo(fixture({ [`${dir}guide.md`]: '## v0.9.9 addendum' }))).toHaveLength(1);
    },
  );

  it.each(['```', '~~~~'])('resets route runs at %s fences and resumes after the closing fence', fence => {
    const literal = `${fence}text\n${routes(6)}\n## v0.9.9 addendum\n${fence}`;
    expect(scanDocument(`${routes(5)}\n${literal}\n${routes(5)}`)).toEqual([]);
    expect(scanDocument(`${literal}\n${routes(6)}`)).toEqual([
      { file: 'README.md', line: 10, rule: 'route inventory' },
    ]);
  });

  it('does not scan CHANGELOG, GitHub metadata, numbered SQL or unrelated app docs', () => {
    const dir = fixture(Object.fromEntries([
      'CHANGELOG.md', '.github/README.md', 'migrations/9999_example.sql', 'apps/example/README.md',
    ].map(file => [file, '## v0.9.9 addendum'])));
    expect(scanRepo(dir)).toEqual([]);
    expect(scanRepo(join(dir, 'absent'))).toEqual([]);
  });

  it.each(['## v0.9.9 addendum', routes(6)])('makes the real CLI fail a planted violation, then pass a rewrite', content => {
    const dir = fixture({ 'README.md': content });
    const failed = run(dir);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('README.md:1:');
    writeFileSync(join(dir, 'README.md'), '# Guide\n\nUse the [auth spec](https://node.example/auth/api/spec).\n');
    expect(run(dir).status).toBe(0);
  });

  it('passes records through the real CLI and reports unreadable trees as failure', () => {
    expect(run(fixture(Object.fromEntries([...HISTORY_RECORDS].map(file => [file, '## Addendum'])))).status).toBe(0);
    const dir = fixture({ 'placeholder': '' });
    mkdirSync(join(dir, 'README.md'));
    const failed = run(dir);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('ci-guard-current-state-docs:');
  });

  it('is wired into the CI Guards job and the package check command', () => {
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    const guards = ci.split('\n  ci-guards:')[1].split('\n  sonarcloud:')[0];
    expect(guards).toContain('run: node scripts/ci-guard-current-state-docs.mjs');
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts['check:current-state-docs']).toBe('node scripts/ci-guard-current-state-docs.mjs');
  });
  it('passes the actual repository with records-tier exemptions', () => {
    expect(scanRepo(root)).toEqual([]);
  });

  it.each([
    'README.md', 'CLAUDE.md', 'apps/kernel/README.md',
    'apps/kernel/public/llms.txt', 'apps/kernel/public/llms-full.txt',
    'docs/developer-guide.md', 'docs/ops/DEPLOY-POSTURE.md',
    'deploy/README.md', 'deploy/infer-passthrough/README.md', 'migrations/BASELINE.md',
  ])('keeps the rewritten consumer document %s free of release and issue history', file => {
    const text = readFileSync(join(root, file), 'utf8');
    expect(text).not.toMatch(/\bv\d+\.\d+(?:\.\d+)?\b|(?:issues|pull)\/\d+|#\d{3,}|\b\d{4}-\d{2}-\d{2}\b/);
    expect(scanDocument(text, file)).toEqual([]);
  });

  it.each(['llms.txt', 'llms-full.txt'])('%s is concept-first, compact and links every defined service spec', name => {
    const text = readFileSync(join(root, 'apps/kernel/public', name), 'utf8');
    expect(text).toMatch(/^# Imajin\r?\n\r?\n> [^\r\n]+\r?\n/);
    for (const heading of ['What Imajin is', 'Key concepts', 'How to integrate', 'Service specifications', 'Further reading']) {
      expect(text).toContain(`## ${heading}`);
    }
    expect(text).not.toMatch(/\bv\d+\.\d+(?:\.\d+)?\b|(?:issues|pull)\/\d+|#\d{3,}/);
    expect(scanDocument(text)).toEqual([]);
    expect(Buffer.byteLength(text)).toBeLessThan(40_000);
    if (name === 'llms.txt') expect(text.trimEnd().split('\n').length).toBeLessThanOrEqual(150);
    for (const file of readdirSync(join(root, 'apps/kernel/api-spec')).filter(file => file.endsWith('.yaml'))) {
      expect(text).toContain(`https://jin.imajin.ai/${file.slice(0, -5)}/api/spec`);
    }
  });
});
