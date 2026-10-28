import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { ALLOWLIST, validateAllowlist } from '../ci-guard-harness-boundary.mjs';

const SCRIPT = fileURLToPath(new URL('../ci-guard-harness-boundary.mjs', import.meta.url));
const SOURCE = 'apps/kernel/src/lib/fixture.ts';

function fixture(content, file = SOURCE) {
  const root = mkdtempSync(join(tmpdir(), 'harness-boundary-'));
  writeSource(root, file, content);
  return root;
}

function writeSource(root, file, content) {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function runGuard(root, args = []) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CI_GUARD_WORKDIR: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const FORBIDDEN = [
  ['static import', "import { Client } from 'openclaw';", 'package-import'],
  ['multiline import', "import {\n Client\n} from '@openclaw/client';", 'package-import'],
  ['side-effect import', "import 'openclaw/register';", 'package-import'],
  ['re-export', "export { Client } from '@imajin/gateway-client';", 'package-import'],
  ['dynamic import', "await import('@openclaw/sdk');", 'package-import'],
  ['require', "const c = require('gateway-client');", 'package-import'],
  ['import equals', "import c = require('@gateway/client');", 'package-import'],
  ['HTTP invoke', "await fetch('/tools/invoke', { method: 'POST' });", 'gateway-surface'],
  ['URL with line-comment characters', "await fetch('http://localhost:18789/tools/invoke');", 'gateway-surface'],
  ['template HTTP invoke', 'await fetch(`${base}/tools/invoke`);', 'gateway-surface'],
  ['session RPC', "await rpc('sessions_history', { sessionKey });", 'gateway-rpc'],
  ['session RPC in payload', "await rpc({ method: 'sessions_list' });", 'gateway-rpc'],
  ['direct session call', 'await sessions_send(args);', 'gateway-rpc'],
  ['chat RPC', "await rpc('chat.history');", 'gateway-rpc'],
  ['chat method', 'await client.chat.history(args);', 'gateway-rpc'],
  ['computed chat method', "await client['chat']['history'](args);", 'gateway-rpc'],
  ['gateway method', "await gatewayClient.request('status');", 'gateway-rpc'],
  ['gateway hostname', "await fetch('https://gateway.internal/status');", 'gateway-surface'],
  ['OpenClaw hostname', "const socket = new WebSocket('ws://openclaw:9000');", 'gateway-surface'],
  ['gateway port', "await fetch('http://127.0.0.1:18789/status');", 'gateway-surface'],
  ['numeric gateway port', "connect({ host: 'localhost', port: 18789 });", 'gateway-surface'],
  ['secondary gateway port', "connect({ port: 18790 });", 'gateway-surface'],
  ['transcript file', "await readFile('/home/agent/.openclaw/agents/main/sessions/id.jsonl');", 'harness-store'],
  ['Windows transcript', String.raw`readFile('C:\\Users\\agent\\.openclaw\\agents\\main\\sessions\\id.jsonl');`, 'harness-store'],
  ['legacy store', "readFile('/home/agent/.clawdbot/sessions.json');", 'harness-store'],
  ['session index', "readFile(join(root, 'sessions.json'));", 'harness-store'],
  ['session JSONL', "readFile('/agents/main/sessions/id.jsonl');", 'harness-store'],
  ['session store path', "readFile('/data/session-store/index.json');", 'harness-store'],
  ['transcript path', "readFile('/data/transcripts/id.jsonl');", 'harness-store'],
  ['transcript read', 'await readTranscript(sessionKey);', 'harness-read'],
  ['transcript client', 'await client.getTranscript(sessionKey);', 'harness-read'],
  ['session store reader', 'await loadSessionStore();', 'harness-read'],
  ['session store method', 'await sessionStore.get(key);', 'harness-read'],
];

describe('ci-guard-harness-boundary', () => {
  it.each(FORBIDDEN)('rejects %s', (_name, content, kind) => {
    const result = runGuard(fixture(content));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${SOURCE}:1: ${kind}`);
  });

  it.each([
    ['signed session ref', 'const sessionKey = event.payload.refs.sessionKey;'],
    ['query/spend ref', "query.where(sql`${events.refs}->>'sessionKey' = ${refs.sessionKey}`);"],
    ['signed transcript event', "bus.subscribe('meet.transcript.available', handle);"],
    ['signed harness identity', "publish({ kind: 'openclaw.session', refs: { sessionKey } });"],
    ['comments', "// await rpc('sessions_list');\n/* import c from 'openclaw'; fetch('/tools/invoke'); */"],
    ['ordinary URLs', "await fetch('https://api.example.com/history');"],
    ['kernel session', "await getSession(); const column = text('session_id');"],
    ['media transcript data', "const label = 'Transcript'; const field = text('transcript');"],
    ['text mentioning imports', 'const note = "import c from \'openclaw\'";'],
    ['event payload access', 'const value = event.transcript; const key = refs.sessionKey;'],
  ])('allows %s', (_name, content) => {
    const result = runGuard(fixture(content));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it.each(['src', 'app'])('scans the kernel %s tree', (tree) => {
    const file = `apps/kernel/${tree}/nested/route.tsx`;
    expect(runGuard(fixture("import 'openclaw';", file)).status).toBe(1);
  });

  it.each(['js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'ts', 'tsx'])('scans .%s source', (extension) => {
    expect(runGuard(fixture("import 'openclaw';", `apps/kernel/src/client.${extension}`)).status).toBe(1);
  });

  it.each([
    'apps/kernel/src/__tests__/helper.ts',
    'apps/kernel/app/tests/fixture.ts',
    'apps/kernel/src/client.test.ts',
    'apps/kernel/app/client.spec.tsx',
    'apps/kernel/src/client.test.mjs',
    'apps/kernel/src/dist/client.js',
    'apps/other/src/client.ts',
    'packages/plugin/src/client.ts',
  ])('excludes %s', (file) => {
    expect(runGuard(fixture("import 'openclaw';", file)).status).toBe(0);
  });

  it('passes on the current kernel without runtime changes', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = runGuard(root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('has a nonempty one-line reason for every exact allowlist entry', () => {
    expect(ALLOWLIST.length).toBeGreaterThan(0);
    expect(validateAllowlist(ALLOWLIST).size).toBe(ALLOWLIST.length);
  });

  it.each(['', '   ', 'reason\nwith newline'])('rejects invalid exception reason %j', (reason) => {
    expect(() => validateAllowlist([{ ...ALLOWLIST[0], reason }])).toThrow('one-line reason');
  });

  it('rejects incomplete and duplicate exceptions', () => {
    expect(() => validateAllowlist([{ reason: 'Missing exact key' }])).toThrow('file, kind, value');
    expect(() => validateAllowlist([ALLOWLIST[0], ALLOWLIST[0]])).toThrow('Duplicate');
  });

  it.each(ALLOWLIST)('allows only the recorded detection in $file ($value)', (entry) => {
    const content = entry.kind === 'harness-read' ? `${entry.value}();` : `fetch('${entry.value}');`;
    const root = fixture(content, entry.file);
    expect(runGuard(root).status).toBe(0);
    const listed = runGuard(root, ['--list']);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([{
      file: entry.file, line: 1, kind: entry.kind, value: entry.value,
    }]);
    writeSource(root, entry.file, `${content}\nfetch('/tools/invoke');`);
    expect(runGuard(root).status).toBe(1);
    writeSource(root, SOURCE, content);
    expect(runGuard(root).status).toBe(1);
  });

  it('reports all violations with accurate lines through comments and multiline imports', () => {
    const result = runGuard(fixture("// comment\n/* block\n */\nimport {\nClient\n} from 'openclaw';\nrpc('sessions_list');"), ['--list']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { file: SOURCE, line: 4, kind: 'package-import', value: 'openclaw' },
      { file: SOURCE, line: 7, kind: 'gateway-rpc', value: 'sessions_list' },
    ]);
  });

  it('is a blocking step in the existing ci-guards job', () => {
    const workflow = parse(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'));
    const steps = workflow.jobs['ci-guards'].steps;
    const guards = steps.filter((step) => step.run === 'node scripts/ci-guard-harness-boundary.mjs');
    expect(guards).toHaveLength(1);
    expect(guards[0].if).toBeUndefined();
    expect(guards[0]['continue-on-error']).toBeUndefined();
    expect(steps[steps.indexOf(guards[0]) - 1].run).toBe('node scripts/ci-guard-cross-schema-reads.mjs');
  });

  it('documents enforcement and opaque refs in the rail contract', () => {
    const contract = readFileSync(new URL('../../docs/loops-rail-contract.md', import.meta.url), 'utf8');
    expect(contract).toContain('CI-enforced by');
    expect(contract).toContain('scripts/ci-guard-harness-boundary.mjs');
    expect(contract).toContain('refs.sessionKey');
    expect(contract).toContain('meet.transcript.available');
  });
});
