// Only loaded from the org repo's trusted main through the GitHub API. PR data is never
// imported, spawned, installed, or interpolated into shell/scanner arguments.
import { lstat, readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve, relative, posix, dirname, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const PROJECT = 'ima-jin_imajin-ai';
const HOST = 'https://sonarcloud.io';
const STATUS_DESCRIPTIONS = {
  success: 'Exact-head trusted scan: quality gate OK',
  pending: 'Trusted fork scan in progress',
  failure: 'Trusted scan failed or CI/PR could not be authenticated',
};
const SHA = /^[a-f0-9]{40}$/;
const MAX_LCOV = 50 * 1024 * 1024;
const ROOT_SCAN_SETTINGS = 'sonar-project.properties';
const LCOV_COUNTS = new Set(['FNF', 'FNH', 'LF', 'LH', 'BRF', 'BRH']);
const FUNCTION_METRIC = /^\d+,.+$/;
const LCOV_METRICS = new Map([
  ['DA', /^\d+,\d+(?:,[a-fA-F0-9]+)?$/],
  ['BRDA', /^\d+,\d+,\d+,(?:\d+|-)$/],
  ['FN', FUNCTION_METRIC],
  ['FNDA', FUNCTION_METRIC],
]);
const root = () => process.env.GITHUB_WORKSPACE;
const statePath = () => join(root(), 'trusted', 'fork-state.json');
export function scanSettingsPath(workspace = root()) {
  assert(typeof workspace === 'string' && isAbsolute(workspace), 'Container workspace must be absolute');
  return join(workspace, 'trusted', 'fork-scan.properties');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function selectPr(prs, sha, repository) {
  const matches = prs.filter((pr) =>
    pr.state === 'open' && pr.head?.sha === sha && pr.base?.repo?.full_name === repository);
  assert(matches.length === 1, 'Expected exactly one open PR for the exact CI head SHA');
  const pr = matches[0];
  assert(pr.head.repo?.fork === true && pr.head.repo.full_name !== repository, 'Not a fork PR');
  assert(pr.base.ref === 'main' && SHA.test(pr.base.sha), 'Expected a trusted main base');
  assert(Number.isSafeInteger(pr.number) && pr.number > 0, 'Invalid API PR number');
  // Scanner properties expand ${...}, including environment variables. Fail
  // closed on unusual refs rather than permit PR-controlled interpolation.
  assert(typeof pr.head.ref === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pr.head.ref), 'Unsafe PR branch name');
  return pr;
}

async function getRun(github, context, id) {
  const { data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: id });
  const { data: ci } = await github.rest.actions.getWorkflow({ ...context.repo, workflow_id: 'ci.yml' });
  assert(run.workflow_id === ci.id && run.path === '.github/workflows/ci.yml', 'Not the canonical CI workflow');
  assert(run.repository.full_name === `${context.repo.owner}/${context.repo.repo}`, 'Wrong run repository');
  return run;
}

async function openPrs(github, context) {
  // Commit-to-PR association also returns [] for the live fork repros. Enumerate
  // open PRs in the base repo, then enforce exact-SHA uniqueness in selectPr.
  return github.paginate(github.rest.pulls.list,
    { ...context.repo, state: 'open', per_page: 100 });
}

async function postStatus(github, context, sha, state, number) {
  await github.rest.repos.createCommitStatus({
    ...context.repo, sha, state, context: 'sonarcloud/trusted',
    description: STATUS_DESCRIPTIONS[state],
    target_url: number ? `${HOST}/dashboard?id=${PROJECT}&pullRequest=${number}` :
      `https://github.com/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
  });
}

export async function resolveRun({ github, context, core }) {
  const event = context.payload.workflow_run;
  const sha = event.head_sha;
  assert(SHA.test(sha), 'Invalid triggering SHA');
  let number;
  try {
    const run = await getRun(github, context, event.id);
    assert(run.head_sha === sha, 'CI run SHA differs from triggering SHA');
    // Same-repo/push scans remain owned entirely by ci.yml.
    if (run.event !== 'pull_request' || run.head_repository?.full_name === run.repository.full_name) return;
    const pr = selectPr(await openPrs(github, context), sha, run.repository.full_name);
    number = pr.number;
    assert(run.head_repository?.id === pr.head.repo.id, 'CI head repository differs from PR');
    assert(run.status === 'completed' && run.conclusion === 'success', 'CI did not complete successfully');
    assert(run.run_attempt === event.run_attempt, 'Superseded CI attempt');
    await postStatus(github, context, sha, 'pending', number);
    await writeFile(statePath(), JSON.stringify({
      sha, number, branch: pr.head.ref, base: pr.base.ref, baseSha: pr.base.sha,
      runId: run.id, attempt: run.run_attempt, headRepoId: pr.head.repo.id,
    }));
    core.setOutput('sha', sha);
    core.setOutput('run_id', String(run.id));
    core.setOutput('scan', 'true');
  } catch (error) {
    await postStatus(github, context, sha, 'failure', number);
    throw error;
  }
}

export function parseTree(tree) {
  const files = tree.split('\0').filter(Boolean).map((entry) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([^\x00-\x1f]+)$/.exec(entry);
    assert(match, 'Only regular Git blobs may be scanned (no symlinks or submodules)');
    const [, , oid, path] = match;
    assert(!path.includes('\\') && !path.includes(':') && !posix.isAbsolute(path), 'Unsafe Git path');
    const parts = path.split('/');
    assert(parts.every((part) => part && !['.', '..', '.git', '.scannerwork'].includes(part)), 'Unsafe Git path');
    assert(parts[0] !== 'trusted', 'Top-level trusted paths are reserved for scan orchestration');
    return { oid, path };
  });
  assert(files.length > 0 && files.length <= 20_000, 'Empty or oversized Git tree');
  return files;
}

export function gitArguments(args) {
  // The numeric hosted UID need not exist in the image's passwd database.
  // Ephemeral refs need no reflogs (or committer identity lookup); source commit
  // history and original author/committer metadata remain untouched.
  return ['-c', 'core.hooksPath=/dev/null', '-c', 'core.logAllRefUpdates=false', ...args];
}

// No checkout is performed. Read the validated tree and blobs with core Git
// plumbing, bypassing PR .gitattributes filters, hooks and executable file modes.
// Git metadata stays available for scanner blame, but is created only by Git.
export async function materializeSource(runGit) {
  const state = JSON.parse(await readFile(statePath(), 'utf8'));
  assert(SHA.test(state.sha), 'Invalid source SHA');
  const source = join(root(), 'source');
  await mkdir(source);
  const git = runGit ?? ((args, input) => execFileSync('/usr/bin/git', gitArguments(args), {
    cwd: source, input, maxBuffer: 256 * 1024 * 1024,
    env: {
      PATH: '/usr/bin:/bin', HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }));
  git(['init']);
  git(['remote', 'add', 'origin', 'https://github.com/ima-jin/imajin-ai.git']);
  git(['fetch', '--no-tags', '--no-recurse-submodules', 'origin',
    state.sha, '+refs/heads/main:refs/remotes/origin/main']);
  git(['update-ref', 'HEAD', state.sha]);
  git(['read-tree', state.sha]); // Index only; never populates a worktree.
  const files = parseTree(git(['ls-tree', '-r', '-z', '--full-tree', state.sha]).toString('utf8'));
  const blobs = git(['cat-file', '--batch'], files.map(({ oid }) => `${oid}\n`).join(''));
  let offset = 0;
  for (const { oid, path } of files) {
    const end = blobs.indexOf(10, offset);
    const header = blobs.subarray(offset, end).toString('ascii');
    const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
    assert(match && match[1] === oid, 'Unexpected Git blob response');
    const size = Number(match[2]);
    offset = end + 1;
    assert(Number.isSafeInteger(size) && offset + size < blobs.length &&
      blobs[offset + size] === 10, 'Truncated Git blob');
    // Every normal fork inherits this tracked file. Consume its blob but never
    // put PR-side root settings in the scan tree, even as a fallback config.
    if (path !== ROOT_SCAN_SETTINGS) {
      const destination = join(source, path);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, blobs.subarray(offset, offset + size), { flag: 'wx', mode: 0o644 });
    }
    offset += size + 1;
  }
  assert(offset === blobs.length, 'Unexpected trailing Git data');
}
// Reject rather than follow links: neither analyzers nor coverage may read files
// outside the source tree (runner credentials, trusted scripts or settings).
export async function validateSource(directory, repositoryRoot = true) {
  await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => {
    assert(!entry.isSymbolicLink(), 'Source symlinks are not allowed in trusted scans');
    assert(!repositoryRoot || !['trusted', ROOT_SCAN_SETTINGS].includes(entry.name),
      'Fork-controlled root scan settings are forbidden');
    if (repositoryRoot && entry.name === '.git') {
      assert(entry.isDirectory(), 'Expected Git-owned metadata directory');
      return;
    }
    assert(entry.name !== '.scannerwork', 'PR-supplied scanner work directories are forbidden');
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await validateSource(path, false);
    else assert(entry.isFile(), 'Only regular source files are allowed');
  }));
}

export function coverageSource(value) {
  // Vitest normally emits relative SF paths. Accept only the two known GitHub
  // runner roots as well; never arbitrary absolute paths, URLs or traversal.
  const normalized = value.replaceAll('\\', '/');
  const prefixes = ['/__w/imajin-ai/imajin-ai/', '/home/runner/work/imajin-ai/imajin-ai/'];
  const prefix = prefixes.find((candidate) => normalized.startsWith(candidate));
  const path = prefix ? normalized.slice(prefix.length) : normalized;
  assert(path && !posix.isAbsolute(path) && !/[:\x00-\x1f]/.test(path), 'Unsafe lcov source path');
  assert(path.split('/').every((part) => part && part !== '.' && part !== '..' && part !== '.git'),
    'Unsafe lcov source path');
  return path;
}

function validMetric(line) {
  const separator = line.indexOf(':');
  if (separator < 0) return false;
  const kind = line.slice(0, separator);
  const value = line.slice(separator + 1);
  if (LCOV_COUNTS.has(kind)) return /^\d+$/.test(value);
  return LCOV_METRICS.get(kind)?.test(value) ?? false;
}

export async function validateLcov(text, source) {
  assert(text.length > 0 && Buffer.byteLength(text) <= MAX_LCOV, 'Empty or oversized lcov');
  const result = [];
  const sources = [];
  let inRecord = false;
  let records = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    assert(!/[\x00-\x08\x0b-\x1f\x7f]/.test(line), 'Control characters in lcov');
    if (line.startsWith('SF:')) {
      assert(!inRecord, 'Nested lcov record');
      const path = coverageSource(line.slice(3));
      const file = resolve(source, path);
      assert(!relative(source, file).startsWith('..'), 'Coverage escaped source');
      sources.push(file);
      result.push(`SF:${path}`);
      inRecord = true;
      records++;
    } else if (line === 'end_of_record') {
      assert(inRecord, 'Unexpected lcov record end');
      inRecord = false;
      result.push(line);
    } else if (line.startsWith('TN:')) {
      assert(!inRecord, 'Unexpected lcov test name');
      result.push('TN:'); // No PR-controlled labels are needed.
    } else {
      assert(inRecord && validMetric(line), 'Invalid lcov record');
      result.push(line);
    }
  }
  assert(records > 0 && !inRecord, 'Missing or incomplete lcov records');
  await Promise.all(sources.map(async (file) => {
    assert((await lstat(file)).isFile(), 'Coverage source must be a regular source file');
  }));
  return `${result.join('\n')}\n`;
}

// Java properties escaping, not shell quoting. Branch names never become CLI
// args, output commands, filenames, or executable JavaScript.
export function property(value) {
  assert(typeof value === 'string' && value.length > 0, 'Empty scan property');
  return value.replaceAll(String.fromCodePoint(92), String.raw`\\`)
    .replaceAll('\r', String.raw`\r`).replaceAll('\n', String.raw`\n`)
    .replaceAll('\t', String.raw`\t`).replaceAll('=', String.raw`\=`)
    .replaceAll(':', String.raw`\:`).replaceAll(' ', String.raw`\ `);
}

export async function prepareScan({ github, context }) {
  const settingsPath = scanSettingsPath();
  const state = JSON.parse(await readFile(statePath(), 'utf8'));
  const source = join(root(), 'source');
  await validateSource(source);
  const incoming = join(root(), 'incoming-coverage');
  const entries = await readdir(incoming);
  assert(entries.length === 1 && entries[0] === 'lcov.info', 'Expected only lcov.info in artifact');
  const info = await lstat(join(incoming, 'lcov.info'));
  assert(info.isFile() && !info.isSymbolicLink() && info.size <= MAX_LCOV, 'Unsafe lcov artifact');
  const lcov = await validateLcov(await readFile(join(incoming, 'lcov.info'), 'utf8'), source);
  await writeFile(join(root(), 'trusted', 'fork-lcov.info'), lcov);
  const { data: config } = await github.rest.repos.getContent({
    ...context.repo, path: ROOT_SCAN_SETTINGS, ref: state.baseSha,
  });
  assert(config.type === 'file' && config.encoding === 'base64', 'Missing trusted base config');
  const baseConfig = Buffer.from(config.content, 'base64').toString('utf8');
  // Explicit settings bypass PR sonar-project.properties. Last values win in
  // Java properties; sensitive paths/settings cannot come from the fork.
  const overrides = {
    'sonar.projectKey': PROJECT,
    'sonar.organization': 'ima-jin',
    'sonar.host.url': HOST,
    'sonar.pullrequest.key': String(state.number),
    'sonar.pullrequest.branch': state.branch,
    'sonar.pullrequest.base': state.base,
    'sonar.scm.revision': state.sha,
    // PR .gitignore edits must not narrow the trusted base's scan scope.
    'sonar.scm.exclusions.disabled': 'true',
    'sonar.javascript.lcov.reportPaths': join(root(), 'trusted', 'fork-lcov.info'),
    'sonar.scanner.metadataFilePath': join(root(), 'trusted', 'fork-report-task.txt'),
    'sonar.working.directory': join(root(), 'trusted', 'scannerwork'),
    'sonar.qualitygate.wait': 'true',
    'sonar.qualitygate.timeout': '300',
    // Do not resolve PR-supplied tsconfig extends/plugins or Node executables.
    'sonar.typescript.tsconfigPaths': join(root(), 'trusted', 'fork-tsconfig.json'),
    'sonar.nodejs.executable': '/usr/bin/node',
  };
  await writeFile(join(root(), 'trusted', 'fork-tsconfig.json'), JSON.stringify({
    compilerOptions: { allowJs: true, noEmit: true },
    include: ['../source/**/*.ts', '../source/**/*.tsx', '../source/**/*.js'],
  }));
  const settings = Object.entries(overrides).map(([key, value]) => `${key}=${property(value)}`).join('\n');
  await writeFile(settingsPath, `${baseConfig}\n${settings}\n`);
  return settingsPath;
}

export async function verifyGate(report, request) {
  const taskId = /^ceTaskId=([A-Za-z0-9_-]+)$/m.exec(report)?.[1];
  assert(taskId, 'Missing scanner task id');
  // Never follow ceTaskUrl/serverUrl supplied in a report: host is fixed.
  const { task } = await request(`/api/ce/task?id=${encodeURIComponent(taskId)}`);
  assert(task?.status === 'SUCCESS' && task.componentKey === PROJECT &&
    /^[A-Za-z0-9_-]+$/.test(task.analysisId ?? ''), 'Analysis task did not succeed for this project');
  const { projectStatus } = await request(`/api/qualitygates/project_status?analysisId=${encodeURIComponent(task.analysisId)}`);
  assert(projectStatus?.status === 'OK', 'Exact analysis quality gate is not OK');
}

export async function finishScan({ github, context, core, request = sonarRequest }) {
  const state = JSON.parse(await readFile(statePath(), 'utf8'));
  try {
    assert(process.env.SCAN_OUTCOME === 'success', 'Scanner did not succeed');
    await verifyGate(await readFile(join(root(), 'trusted', 'fork-report-task.txt'), 'utf8'), request);
    const run = await getRun(github, context, state.runId);
    assert(run.head_sha === state.sha && run.conclusion === 'success' && run.status === 'completed' &&
      run.run_attempt === state.attempt, 'CI was rerun or is no longer green');
    const pr = selectPr(await openPrs(github, context), state.sha,
      `${context.repo.owner}/${context.repo.repo}`);
    assert(pr.number === state.number && pr.head.repo.id === state.headRepoId, 'PR changed during scan');
    await postStatus(github, context, state.sha, 'success', state.number);
  } catch {
    await postStatus(github, context, state.sha, 'failure', state.number);
    // Do not log remote response bodies, PR-controlled data or credentials.
    core.setFailed('Trusted fork analysis failed; inspect scanner and CI eligibility steps');
  }
}

async function sonarRequest(path) {
  assert(process.env.SONAR_TOKEN, 'SONAR_TOKEN is required');
  const response = await fetch(`${HOST}${path}`, {
    headers: { Authorization: `Bearer ${process.env.SONAR_TOKEN}` },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, 'Sonar API request failed');
  return response.json();
}
