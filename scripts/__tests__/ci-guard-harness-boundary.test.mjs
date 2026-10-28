import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parse } from 'yaml';
import { ALLOWLIST, KINDS, validateAllowlist } from '../ci-guard-harness-boundary.mjs';

const SCRIPT = fileURLToPath(new URL('../ci-guard-harness-boundary.mjs', import.meta.url));
const SOURCE = 'apps/kernel/src/lib/fixture.ts';
const FORBIDDEN_IMPORT = "import 'openclaw';";

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
  ['static import', "import { Client } from 'openclaw';", KINDS.PACKAGE],
  ['multiline import', "import {\n Client\n} from '@openclaw/client';", KINDS.PACKAGE],
  ['side-effect import', "import 'openclaw/register';", KINDS.PACKAGE],
  ['re-export', "export { Client } from '@imajin/gateway-client';", KINDS.PACKAGE],
  ['dynamic import', "await import('@openclaw/sdk');", KINDS.PACKAGE],
  ['require', "const c = require('gateway-client');", KINDS.PACKAGE],
  ['import equals', "import c = require('@gateway/client');", KINDS.PACKAGE],
  ['scoped gateway package', "import c from '@imajin/gateway';", KINDS.PACKAGE],
  ['gateway SDK', "import c from 'gateway-sdk';", KINDS.PACKAGE],
  ['HTTP invoke', "await fetch('/tools/invoke', { method: 'POST' });", KINDS.SURFACE],
  ['URL with line-comment characters', "await fetch('http://localhost:18789/tools/invoke');", KINDS.SURFACE],
  ['template HTTP invoke', 'await fetch(`${base}/tools/invoke`);', KINDS.SURFACE],
  ['session RPC', "await rpc('sessions_history', { sessionKey });", KINDS.RPC],
  ['session RPC in payload', "await rpc({ method: 'sessions_list' });", KINDS.RPC],
  ['direct session call', 'await sessions_send(args);', KINDS.RPC],
  ['chat RPC', "await rpc('chat.history');", KINDS.RPC],
  ['chat method', 'await client.chat.history(args);', KINDS.RPC],
  ['computed chat method', "await client['chat']['history'](args);", KINDS.RPC],
  ['gateway method', "await gatewayClient.request('status');", KINDS.RPC],
  ['gateway hostname', "await fetch('https://gateway.internal/status');", KINDS.SURFACE],
  ['OpenClaw hostname', "const socket = new WebSocket('ws://openclaw:9000');", KINDS.SURFACE],
  ['gateway port', "await fetch('http://127.0.0.1:18789/status');", KINDS.SURFACE],
  ['gateway URL from environment', 'await fetch(process.env.OPENCLAW_GATEWAY_URL);', KINDS.SURFACE],
  ['gateway host from environment', 'connect({ host: process.env.GATEWAY_HOST });', KINDS.SURFACE],
  ['gateway port from environment', 'connect({ port: process.env.GATEWAY_PORT });', KINDS.SURFACE],
  ['numeric gateway port', "connect({ host: 'localhost', port: 18789 });", KINDS.SURFACE],
  ['secondary gateway port', "connect({ port: 18790 });", KINDS.SURFACE],
  ['transcript file', "await readFile('/home/agent/.openclaw/agents/main/sessions/id.jsonl');", KINDS.STORE],
  ['Windows transcript', String.raw`readFile('C:\\Users\\agent\\.openclaw\\agents\\main\\sessions\\id.jsonl');`, KINDS.STORE],
  ['legacy store', "readFile('/home/agent/.clawdbot/sessions.json');", KINDS.STORE],
  ['session index', "readFile(join(root, 'sessions.json'));", KINDS.STORE],
  ['session JSONL', "readFile('/agents/main/sessions/id.jsonl');", KINDS.STORE],
  ['template session JSONL', 'readFile(`${root}/sessions/${id}.jsonl`);', KINDS.STORE],
  ['session store path', "readFile('/data/session-store/index.json');", KINDS.STORE],
  ['transcript path', "readFile('/data/transcripts/id.jsonl');", KINDS.STORE],
  ['relative transcript path', "readFile('transcripts/id.jsonl');", KINDS.STORE],
  ['joined harness directory', "readFile(join(home, '.openclaw', 'agents', id));", KINDS.STORE],
  ['joined legacy directory', "readFile(join(home, '.clawdbot', 'sessions.json'));", KINDS.STORE],
  ['transcript read', 'await readTranscript(sessionKey);', KINDS.READ],
  ['transcript client', 'await client.getTranscript(sessionKey);', KINDS.READ],
  ['session store reader', 'await loadSessionStore();', KINDS.READ],
  ['session store method', 'await sessionStore.get(key);', KINDS.READ],
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
    expect(runGuard(fixture(FORBIDDEN_IMPORT, file)).status).toBe(1);
  });

  it.each(['js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'ts', 'tsx'])('scans .%s source', (extension) => {
    expect(runGuard(fixture(FORBIDDEN_IMPORT, `apps/kernel/src/client.${extension}`)).status).toBe(1);
  });
  it.each([
    'apps/kernel/app/build/x/route.ts',
    'apps/kernel/src/lib/tests/hidden.ts',
    'apps/kernel/app/tests/fixture.ts',
    'apps/kernel/src/dist/client.js',
    'apps/kernel/src/lib/build/client.ts',
    'apps/kernel/src/coverage/client.ts',
  ])('scans production source in %s and reports file:line', (file) => {
    const result = runGuard(fixture('// production source\n\nclient.sessions_send();', file));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file}:3: ${KINDS.RPC} (client.sessions_send)`);
  });

  it.each([
    'apps/kernel/src/__tests__/helper.ts',
    'apps/kernel/src/lib/node_modules/client.js',
    'apps/kernel/app/build/.next/client.ts',
    'apps/kernel/src/client.test.ts',
    'apps/kernel/app/client.spec.tsx',
    'apps/kernel/src/client.test.mjs',
    'apps/other/src/client.ts',
    'packages/plugin/src/client.ts',
  ])('excludes %s', (file) => {
    expect(runGuard(fixture(FORBIDDEN_IMPORT, file)).status).toBe(0);
  });

  it('passes on the current kernel without runtime changes', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const result = runGuard(root);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('has a nonempty one-line reason for every exact allowlist entry', () => {
    expect(validateAllowlist(ALLOWLIST).size).toBe(ALLOWLIST.length);
    expect(validateAllowlist([]).size).toBe(0);
  });

  it.each(['', '   ', 'reason\nwith newline'])('rejects invalid exception reason %j', (reason) => {
    expect(() => validateAllowlist([{ ...ALLOWLIST[0], reason }])).toThrow('one-line reason');
  });

  it('rejects incomplete and duplicate exceptions', () => {
    expect(() => validateAllowlist([{ reason: 'Missing exact key' }])).toThrow('file, kind, value');
    expect(() => validateAllowlist([ALLOWLIST[0], ALLOWLIST[0]])).toThrow('Duplicate');
  });

  it.each(ALLOWLIST)('allows only the recorded detection in $file ($value)', (entry) => {
    const content = entry.kind === KINDS.READ ? `${entry.value}();` : `fetch('${entry.value}');`;
    const root = fixture(content, entry.file);
    expect(runGuard(root).status).toBe(0);
    const listed = runGuard(root, ['--list']);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([{
      file: entry.file, line: 1, kind: entry.kind, value: entry.value,
    }]);
    writeSource(root, entry.file, `${content}\nfetch('/tools/invoke');`);
    expect(runGuard(root).status).toBe(1);
    expect(runGuard(fixture(content)).status).toBe(1);
  });

  it('reports all violations with accurate lines through comments and multiline imports', () => {
    const result = runGuard(fixture("// comment\n/* block\n */\nimport {\nClient\n} from 'openclaw';\nrpc('sessions_list');"), ['--list']);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { file: SOURCE, line: 4, kind: KINDS.PACKAGE, value: 'openclaw' },
      { file: SOURCE, line: 7, kind: KINDS.RPC, value: 'sessions_list' },
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
    expect(contract).toContain('static tripwire, not a proof');
    for (const limitation of [
      "'/tools/' + 'invoke'", "'sessions' + '_send'", 'import(variable)',
      '{ sessions_send: send }', '`spawn`/`execSync` of `openclaw`', 'OPENCLAW_GATEWAY_TOKEN',
    ]) {
      expect(contract).toContain(limitation);
    }
  });
});
