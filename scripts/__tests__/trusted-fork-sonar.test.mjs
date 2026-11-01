import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  coverageSource, finishScan, prepareScan, property, resolveRun, selectPr,
  validateLcov, validateSource, verifyGate, materializeSource, parseTree,
} from '../sonar/trusted-fork.mjs';

const sha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const repository = 'ima-jin/imajin-ai';
const pr = () => ({
  number: 3200, state: 'open',
  head: { sha, ref: 'fork-branch', repo: { id: 22, fork: true, full_name: 'someone/imajin-ai' } },
  base: { sha: baseSha, ref: 'main', repo: { full_name: repository } },
});
const run = () => ({
  id: 123, workflow_id: 7, path: '.github/workflows/ci.yml',
  repository: { full_name: repository }, head_sha: sha,
  head_repository: { id: 22, full_name: 'someone/imajin-ai' },
  event: 'pull_request', status: 'completed', conclusion: 'success', run_attempt: 1,
});
let dir;
let github;
let context;
let core;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trusted-sonar-'));
  for (const name of ['trusted', 'source', 'incoming-coverage']) await mkdir(join(dir, name));
  vi.stubEnv('GITHUB_WORKSPACE', dir);
  vi.stubEnv('SCAN_OUTCOME', 'success');
  github = {
    rest: {
      actions: {
        getWorkflowRun: vi.fn().mockResolvedValue({ data: run() }),
        getWorkflow: vi.fn().mockResolvedValue({ data: { id: 7 } }),
      },
      repos: {
        listPullRequestsAssociatedWithCommit: vi.fn(),
        createCommitStatus: vi.fn().mockResolvedValue({}),
        getContent: vi.fn().mockResolvedValue({ data: {
          type: 'file', encoding: 'base64',
          content: Buffer.from('sonar.projectKey=ima-jin_imajin-ai\nsonar.exclusions=base-only\n').toString('base64'),
        } }),
      },
    },
    paginate: vi.fn().mockResolvedValue([pr()]),
  };
  context = {
    repo: { owner: 'ima-jin', repo: 'imajin-ai' }, runId: 999,
    payload: { workflow_run: { id: 123, head_sha: sha, run_attempt: 1, pull_requests: [] } },
  };
  core = { setOutput: vi.fn(), setFailed: vi.fn() };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

const statuses = () => github.rest.repos.createCommitStatus.mock.calls.map(([value]) => value);
const resolveCi = () => resolveRun({ github, context, core });
const lcov = (path = 'file.ts') => `TN:\nSF:${path}\nFN:1,example\nFNDA:1,example\nFNF:1\nFNH:1\nDA:1,1\nLF:1\nLH:1\nBRDA:1,0,0,-\nBRF:1\nBRH:0\nend_of_record\n`;
async function seedScan() {
  await resolveCi();
  await writeFile(join(dir, 'source', 'file.ts'), 'export const example = 1;\n');
  await writeFile(join(dir, 'incoming-coverage', 'lcov.info'), lcov());
}
const requestOk = () => vi.fn()
  .mockResolvedValueOnce({ task: { status: 'SUCCESS', componentKey: 'ima-jin_imajin-ai', analysisId: 'analysis-1' } })
  .mockResolvedValueOnce({ projectStatus: { status: 'OK' } });
async function finish(request = requestOk()) {
  await writeFile(join(dir, 'trusted', 'fork-report-task.txt'), 'ceTaskId=task-1\nceTaskUrl=https://untrusted.invalid\n');
  await finishScan({ github, context, core, request });
}

describe('CI and unique PR authentication', () => {
  it('resolves fork PRs even when event pull_requests is empty and posts pending on exact SHA', async () => {
    await resolveCi();
    expect(core.setOutput).toHaveBeenCalledWith('scan', 'true');
    expect(core.setOutput).toHaveBeenCalledWith('sha', sha);
    expect(core.setOutput).toHaveBeenCalledWith('run_id', '123');
    expect(statuses()).toEqual([expect.objectContaining({ sha, state: 'pending', context: 'sonarcloud/trusted' })]);
    expect(github.paginate).toHaveBeenCalledWith(github.rest.repos.listPullRequestsAssociatedWithCommit,
      expect.objectContaining({ commit_sha: sha, per_page: 100 }));
  });

  it('ignores spoofed event PR number, branch, repository and conclusion', async () => {
    Object.assign(context.payload.workflow_run, {
      conclusion: 'failure', head_branch: 'spoof', head_repository: { full_name: 'spoof' },
      pull_requests: [{ number: 1 }],
    });
    await resolveCi();
    const state = JSON.parse(await readFile(join(dir, 'trusted', 'fork-state.json'), 'utf8'));
    expect(state).toMatchObject({ number: 3200, branch: 'fork-branch', baseSha, sha });
  });

  it.each(['failure', 'cancelled', 'timed_out', 'neutral', 'skipped', null])(
    'never scans CI conclusion %s', async (conclusion) => {
      github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { ...run(), conclusion } });
      await expect(resolveCi()).rejects.toThrow('successfully');
      expect(core.setOutput).not.toHaveBeenCalled();
      expect(statuses().at(-1)).toMatchObject({ sha, state: 'failure' });
    },
  );

  it.each([
    { head_sha: 'c'.repeat(40) }, { workflow_id: 999 }, { path: '.github/workflows/evil.yml' },
    { repository: { full_name: 'someone/imajin-ai' } }, { status: 'in_progress' },
    { run_attempt: 2 }, { head_repository: { id: 44, full_name: 'other/imajin-ai' } },
  ])('fails closed for unauthenticated run metadata %j', async (change) => {
    github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { ...run(), ...change } });
    await expect(resolveCi()).rejects.toThrow();
    expect(statuses().at(-1).state).toBe('failure');
    expect(core.setOutput).not.toHaveBeenCalled();
  });

  it.each([[], [pr(), { ...pr(), number: 3201 }], [{ ...pr(), state: 'closed' }],
    [{ ...pr(), head: { ...pr().head, sha: 'c'.repeat(40) } }]].map((prs) => ({ prs })))(
    'requires exactly one open exact-SHA PR', async ({ prs }) => {
      github.paginate.mockResolvedValue(prs);
      await expect(resolveCi()).rejects.toThrow('exactly one');
      expect(statuses().at(-1).state).toBe('failure');
      expect(core.setOutput).not.toHaveBeenCalled();
    },
  );

  it.each(['push', 'merge_group', 'workflow_dispatch'])('leaves %s scans alone', async (event) => {
    github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { ...run(), event } });
    await resolveCi();
    expect(statuses()).toEqual([]);
    expect(core.setOutput).not.toHaveBeenCalled();
  });

  it('leaves same-repo PR scans alone', async () => {
    github.rest.actions.getWorkflowRun.mockResolvedValue({
      data: { ...run(), head_repository: { id: 1, full_name: repository } },
    });
    await resolveCi();
    expect(statuses()).toEqual([]);
    expect(core.setOutput).not.toHaveBeenCalled();
  });

  it('rejects invalid SHA before any status or API call', async () => {
    context.payload.workflow_run.head_sha = 'bad\nsha';
    await expect(resolveCi()).rejects.toThrow('SHA');
    expect(github.rest.actions.getWorkflowRun).not.toHaveBeenCalled();
    expect(statuses()).toEqual([]);
  });

  it.each([
    { number: -1 }, { number: '3200' }, { base: { ...pr().base, ref: 'untrusted' } },
    { base: { ...pr().base, sha: 'bad' } },
    { base: { ...pr().base, repo: { full_name: 'other/repo' } } },
    { head: { ...pr().head, repo: { id: 22, fork: false, full_name: repository } } },
  ])('rejects invalid API PR boundary %j', (change) => {
    expect(() => selectPr([{ ...pr(), ...change }], sha, repository)).toThrow();
  });

  it('fails closed when the PR API is unavailable', async () => {
    github.paginate.mockRejectedValue(new Error('API unavailable'));
    await expect(resolveCi()).rejects.toThrow('API unavailable');
    expect(statuses().at(-1).state).toBe('failure');
  });

  it.each(['${env.SONAR_TOKEN}', 'branch\nsonar.host.url=evil', 'branch\\escape', 'branch"quote', undefined, 123])(
    'rejects branch property-substitution or argument injection %s', (ref) => {
      expect(() => selectPr([{ ...pr(), head: { ...pr().head, ref } }], sha, repository)).toThrow('branch');
    },
  );
});

describe('untrusted source, properties and artifact', () => {
  it('reads exact-SHA blobs without checkout, shell execution, filters or executable modes', async () => {
    await resolveCi();
    await rm(join(dir, 'source'), { recursive: true });
    const oid = 'd'.repeat(40);
    const content = Buffer.from('export const safe = 1;\n');
    const runGit = vi.fn((args) => {
      if (args[0] === 'ls-tree') return Buffer.from(`100755 blob ${oid}\tpath/file.ts\0`);
      if (args[0] === 'cat-file') return Buffer.concat([Buffer.from(`${oid} blob ${content.length}\n`), content, Buffer.from('\n')]);
      return Buffer.alloc(0);
    });
    await materializeSource(runGit);
    expect(await readFile(join(dir, 'source', 'path', 'file.ts'), 'utf8')).toBe(content.toString());
    expect(runGit.mock.calls.map(([args]) => args[0])).toEqual([
      'init', 'remote', 'fetch', 'update-ref', 'read-tree', 'ls-tree', 'cat-file',
    ]);
    expect(runGit).toHaveBeenCalledWith(['ls-tree', '-r', '-z', '--full-tree', sha]);
    expect(runGit).toHaveBeenCalledWith(['cat-file', '--batch'], `${oid}\n`);
  });

  it.each([
    `120000 blob ${sha}\tlink\0`, `160000 commit ${sha}\tsubmodule\0`,
    `100644 blob ${sha}\t../trusted/secret\0`, `100644 blob ${sha}\t.git/config\0`,
    `100644 blob ${sha}\t/scanner\0`, `100644 blob ${sha}\ta\\b\0`,
    `100644 blob ${sha}\t.scannerwork/report-task.txt\0`, `100644 blob ${sha}\tC:escape\0`,
    `100644 blob ${sha}\tcontrol\nname\0`, '',
  ])('rejects unsafe Git trees before writing any PR data %j', (tree) => {
    expect(() => parseTree(tree)).toThrow();
  });

  it('rejects oversized Git trees', () => {
    expect(() => parseTree(`100644 blob ${sha}\tfile.ts\0`.repeat(20_001))).toThrow('oversized');
  });

  it('rejects invalid source SHA before invoking Git', async () => {
    await writeFile(join(dir, 'trusted', 'fork-state.json'), JSON.stringify({ sha: '--unsafe' }));
    const runGit = vi.fn();
    await expect(materializeSource(runGit)).rejects.toThrow('source SHA');
    expect(runGit).not.toHaveBeenCalled();
  });

  it.each(['wrong header\n', `${sha} blob 100\nshort\n`, `${'c'.repeat(40)} blob 1\nx\n`,
    `${sha} blob 1\nx!`, `${sha} blob 9007199254740992\nx\n`])('rejects corrupt blob data %s', async (blob) => {
    await resolveCi();
    await rm(join(dir, 'source'), { recursive: true });
    const runGit = vi.fn((args) => {
      if (args[0] === 'ls-tree') return Buffer.from(`100644 blob ${sha}\tfile.ts\0`);
      if (args[0] === 'cat-file') return Buffer.from(blob);
      return Buffer.alloc(0);
    });
    await expect(materializeSource(runGit)).rejects.toThrow('Git blob');
  });

  it('rejects unexpected trailing blob data', async () => {
    await resolveCi();
    await rm(join(dir, 'source'), { recursive: true });
    const runGit = vi.fn((args) => {
      if (args[0] === 'ls-tree') return Buffer.from(`100644 blob ${sha}\tfile.ts\0`);
      if (args[0] === 'cat-file') return Buffer.from(`${sha} blob 1\nx\nunexpected`);
      return Buffer.alloc(0);
    });
    await expect(materializeSource(runGit)).rejects.toThrow('trailing');
  });
  it('uses base SHA properties and validated lcov, never the PR properties', async () => {
    await seedScan();
    await writeFile(join(dir, 'source', 'sonar-project.properties'),
      'sonar.projectKey=evil\nsonar.host.url=https://evil.invalid\nsonar.exclusions=**\n');
    await writeFile(join(dir, 'source', 'package.json'), '{"scripts":{"install":"exit 99"}}');
    await prepareScan({ github, context });
    expect(github.rest.repos.getContent).toHaveBeenCalledWith(expect.objectContaining({
      path: 'sonar-project.properties', ref: baseSha,
    }));
    const config = await readFile(join(dir, 'trusted', 'fork-scan.properties'), 'utf8');
    expect(config).toContain('sonar.exclusions=base-only');
    expect(config).toContain(`sonar.scm.revision=${sha}`);
    expect(config).toContain('sonar.pullrequest.key=3200');
    expect(config).toContain('sonar.qualitygate.wait=true');
    expect(config).toContain('sonar.nodejs.executable=/usr/bin/node');
    expect(config).toContain('sonar.scm.exclusions.disabled=true');
    expect(config).not.toContain('evil');
    expect(config).not.toContain('sonar.exclusions=**');
    expect(await readFile(join(dir, 'trusted', 'fork-lcov.info'), 'utf8')).toBe(lcov());
    const tsconfig = JSON.parse(await readFile(join(dir, 'trusted', 'fork-tsconfig.json'), 'utf8'));
    expect(tsconfig.extends).toBeUndefined();
    expect(tsconfig.compilerOptions.plugins).toBeUndefined();
    expect(tsconfig.include).toContain('../source/**/*.ts');
  });

  it('escapes property injection and never turns branch text into scanner arguments', () => {
    expect(property('branch\nsonar.host.url=https://evil.invalid')).toBe('branch\\nsonar.host.url\\=https\\://evil.invalid');
    expect(property('a\\b c\r\td')).toBe('a\\\\b\\ c\\r\\td');
    expect(() => property('')).toThrow();
  });

  it.each(['../secret', '/etc/passwd', 'file:///etc/passwd', 'C:\\secret', 'a/../../secret',
    'a//file.ts', '.git/config', 'a/./file.ts', '', 'a\0b', '//host/share'])(
    'rejects unsafe lcov source %s', (path) => {
      expect(() => coverageSource(path)).toThrow();
    },
  );

  it.each(['/__w/imajin-ai/imajin-ai/file.ts', '/home/runner/work/imajin-ai/imajin-ai/file.ts', 'file.ts'])(
    'normalizes known runner path %s', (path) => expect(coverageSource(path)).toBe('file.ts'),
  );

  it.each([
    '', 'TN:\n', 'end_of_record\n', 'SF:file.ts\nDA:1,1\n',
    'SF:file.ts\nSF:file.ts\nend_of_record\n', 'SF:file.ts\nDA:bad\nend_of_record\n',
    'SF:file.ts\nsonar.host.url=evil\nend_of_record\n', 'SF:file.ts\nTN:nested\nend_of_record\n',
    'SF:file.ts\nDA:1,1\0\nend_of_record\n',
    'SF:file.ts\nLF:bad\nend_of_record\n',
    'SF:file.ts\nBRDA:1,0,a,-\nend_of_record\n',
    'SF:file.ts\nFN:bad,name\nend_of_record\n',
    'SF:file.ts\nnot-even-a-record\nend_of_record\n',
  ])('rejects malformed lcov %j', async (text) => {
    await writeFile(join(dir, 'source', 'file.ts'), '');
    await expect(validateLcov(text, join(dir, 'source'))).rejects.toThrow();
  });

  it('rejects oversized lcov before parsing', async () => {
    await expect(validateLcov('x'.repeat(50 * 1024 * 1024 + 1), join(dir, 'source'))).rejects.toThrow('oversized');
  });

  it('rejects coverage paths missing from the exact checkout', async () => {
    await expect(validateLcov(lcov('missing.ts'), join(dir, 'source'))).rejects.toThrow();
  });

  it('rejects coverage paths pointing at directories', async () => {
    await mkdir(join(dir, 'source', 'folder'));
    await expect(validateLcov(lcov('folder'), join(dir, 'source'))).rejects.toThrow('regular');
  });

  it('rejects source directory links, including nested .git links', async () => {
    await mkdir(join(dir, 'source', 'nested'));
    await symlink(join(dir, 'trusted'), join(dir, 'source', 'nested', '.git'), 'junction');
    await expect(validateSource(join(dir, 'source'))).rejects.toThrow('symlinks');
  });

  it('rejects PR-supplied scanner metadata directories', async () => {
    await mkdir(join(dir, 'source', '.scannerwork'));
    await expect(validateSource(join(dir, 'source'))).rejects.toThrow('scanner');
  });

  it('accepts Git-owned metadata but rejects a .git file', async () => {
    await mkdir(join(dir, 'source', '.git'));
    await expect(validateSource(join(dir, 'source'))).resolves.toBeUndefined();
    await rm(join(dir, 'source', '.git'), { recursive: true });
    await writeFile(join(dir, 'source', '.git'), 'gitdir: ../trusted');
    await expect(validateSource(join(dir, 'source'))).rejects.toThrow('Git-owned');
  });

  it('rejects artifact extras instead of trusting filenames or PR metadata', async () => {
    await seedScan();
    await writeFile(join(dir, 'incoming-coverage', 'pr-number'), '1');
    await expect(prepareScan({ github, context })).rejects.toThrow('only lcov.info');
  });

  it('rejects non-file lcov artifacts', async () => {
    await resolveCi();
    await mkdir(join(dir, 'incoming-coverage', 'lcov.info'));
    await expect(prepareScan({ github, context })).rejects.toThrow('Unsafe lcov artifact');
  });

  it('fails closed if base config is missing or not a file', async () => {
    await seedScan();
    github.rest.repos.getContent.mockResolvedValue({ data: { type: 'dir' } });
    await expect(prepareScan({ github, context })).rejects.toThrow('base config');
  });
});

describe('exact-task quality gate and final status', () => {
  it('queries the scanner task then its immutable analysis ID, ignoring report URLs', async () => {
    const request = requestOk();
    await verifyGate('ceTaskId=task-1\nceTaskUrl=https://evil.invalid\n', request);
    expect(request.mock.calls).toEqual([
      ['/api/ce/task?id=task-1'], ['/api/qualitygates/project_status?analysisId=analysis-1'],
    ]);
  });

  it.each(['', 'ceTaskId=https://evil.invalid', 'ceTaskId=../evil'])('rejects invalid task report %s', async (report) => {
    const request = vi.fn();
    await expect(verifyGate(report, request)).rejects.toThrow('task id');
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'PENDING' }, { status: 'FAILED' }, { status: 'CANCELED' },
    { componentKey: 'evil' }, { analysisId: undefined }, { analysisId: '../evil' },
  ])('rejects non-successful or wrong-project tasks %j', async (change) => {
    const request = vi.fn().mockResolvedValue({ task: {
      status: 'SUCCESS', componentKey: 'ima-jin_imajin-ai', analysisId: 'analysis-1', ...change,
    } });
    await expect(verifyGate('ceTaskId=task-1', request)).rejects.toThrow('Analysis task');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['ERROR', 'WARN', 'NONE', undefined])('rejects non-OK gate %s', async (status) => {
    const request = vi.fn()
      .mockResolvedValueOnce({ task: { status: 'SUCCESS', componentKey: 'ima-jin_imajin-ai', analysisId: 'analysis-1' } })
      .mockResolvedValueOnce({ projectStatus: { status } });
    await expect(verifyGate('ceTaskId=task-1', request)).rejects.toThrow('not OK');
  });

  it('posts success only on the authenticated head after exact-task gate OK', async () => {
    await resolveCi();
    await finish();
    expect(statuses().map((status) => status.state)).toEqual(['pending', 'success']);
    expect(statuses().at(-1)).toMatchObject({ sha, target_url: expect.stringContaining('pullRequest=3200') });
    expect(core.setFailed).not.toHaveBeenCalled();
  });

  it.each(['failure', 'cancelled', 'skipped', undefined])('never reports success for scanner outcome %s', async (outcome) => {
    await resolveCi();
    if (outcome === undefined) delete process.env.SCAN_OUTCOME;
    else vi.stubEnv('SCAN_OUTCOME', outcome);
    const request = vi.fn();
    await finish(request);
    expect(request).not.toHaveBeenCalled();
    expect(statuses().at(-1).state).toBe('failure');
    expect(core.setFailed).toHaveBeenCalled();
  });

  it('never reports success when the Sonar API fails or returns 404', async () => {
    await resolveCi();
    await finish(vi.fn().mockRejectedValue(new Error('404')));
    expect(statuses().at(-1).state).toBe('failure');
  });

  it('never reports success when scanner task metadata is missing', async () => {
    await resolveCi();
    await finishScan({ github, context, core, request: requestOk() });
    expect(statuses().at(-1).state).toBe('failure');
  });

  it('rejects heads changed during analysis', async () => {
    await resolveCi();
    github.paginate.mockResolvedValue([{ ...pr(), head: { ...pr().head, sha: 'c'.repeat(40) } }]);
    await finish();
    expect(statuses().at(-1).state).toBe('failure');
  });

  it('rejects CI reruns started during analysis', async () => {
    await resolveCi();
    github.rest.actions.getWorkflowRun.mockResolvedValue({ data: { ...run(), run_attempt: 2 } });
    await finish();
    expect(statuses().at(-1).state).toBe('failure');
  });

  it('rejects ambiguous PRs even if the gate is green', async () => {
    await resolveCi();
    github.paginate.mockResolvedValue([pr(), { ...pr(), number: 3201 }]);
    await finish();
    expect(statuses().at(-1).state).toBe('failure');
  });
});

describe('workflow boundary and same-repo compatibility', () => {
  const load = async (name) => YAML.parse(await readFile(fileURLToPath(new URL(`../../.github/workflows/${name}`, import.meta.url)), 'utf8'));

  it('uses only default-branch workflow_run with least job permissions and ephemeral runner', async () => {
    const workflow = await load('sonarcloud-fork.yml');
    expect(workflow.on).toEqual({ workflow_run: { workflows: ['CI'], types: ['completed'] } });
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs.scan.permissions).toEqual({
      contents: 'read', actions: 'read', 'pull-requests': 'read', statuses: 'write', packages: 'read',
    });
    expect(workflow.jobs.scan.container.credentials.password).toBe('${{ secrets.GITHUB_TOKEN }}');
    expect(workflow.jobs.scan['runs-on']).toBe('ubuntu-latest');
    expect(workflow.jobs.scan.container.volumes).toBeUndefined();
  });

  it('pins actions, never persists checkout credentials, and has no PR execution steps', async () => {
    const { jobs } = await load('sonarcloud-fork.yml');
    for (const step of jobs.scan.steps) {
      expect(step.uses).toMatch(/@[a-f0-9]{40}$/);
      expect(step.run).toBeUndefined();
      expect(step.uses).not.toMatch(/^\.\//);
      if (step.uses.startsWith('actions/checkout@')) expect(step.with['persist-credentials']).toBe(false);
      if (step.with?.script) {
        expect(step.with.script).toContain('/trusted/scripts/sonar/trusted-fork.mjs');
        expect(step.with.script).not.toContain('${{');
      }
    }
    const checkout = jobs.scan.steps.find((step) => step.with?.path === 'trusted');
    expect(checkout.with.ref).toBe('main');
    expect(jobs.scan.steps.filter((step) => step.uses.startsWith('actions/checkout@'))).toHaveLength(1);
    const source = jobs.scan.steps.find((step) => step.name.startsWith('Materialize'));
    expect(source.with.script).toContain('await materializeSource()');
  });

  it('downloads coverage by authenticated run ID and isolates token to scan/finalization', async () => {
    const { jobs } = await load('sonarcloud-fork.yml');
    const download = jobs.scan.steps.find((step) => step.uses.startsWith('actions/download-artifact@'));
    expect(download.with).toMatchObject({
      name: 'coverage-lcov', 'run-id': '${{ steps.resolve.outputs.run_id }}',
      'github-token': '${{ github.token }}', path: 'incoming-coverage',
    });
    for (const step of jobs.scan.steps) {
      if (step.env?.SONAR_TOKEN) {
        expect(step.uses.startsWith('SonarSource/') || step.name.startsWith('Publish')).toBe(true);
      }
    }
    const scan = jobs.scan.steps.find((step) => step.id === 'scan');
    expect(scan.with).toEqual({
      projectBaseDir: 'source', args: '-Dproject.settings=trusted/fork-scan.properties',
    });
    const final = jobs.scan.steps.at(-1);
    expect(final.if).toContain('always()');
    expect(final.env.SCAN_OUTCOME).toBe('${{ steps.scan.outcome }}');
  });

  it('retains existing scanner pin/image and required SonarCloud context with explicit fork warning', async () => {
    const ci = await load('ci.yml');
    const fork = await load('sonarcloud-fork.yml');
    expect(ci.on.pull_request.branches).toEqual(['main']);
    expect(ci.on.push.branches).toEqual(['main']);
    expect(ci.jobs.sonarcloud.name).toBe('SonarCloud');
    expect(ci.jobs.sonarcloud.if).toBe("github.event_name != 'merge_group'");
    expect(ci.jobs.sonarcloud.container.image).toBe(fork.jobs.scan.container.image);
    const scan = ci.jobs.sonarcloud.steps.find((step) => step.name === 'SonarCloud Scan');
    expect(scan.if).toBe("${{ env.SONAR_TOKEN != '' }}");
    expect(scan.with).toBeUndefined();
    expect(scan.uses).toBe(fork.jobs.scan.steps.find((step) => step.id === 'scan').uses);
    const note = ci.jobs.sonarcloud.steps.at(-1);
    expect(note.name).toContain('NOT SCANNED');
    expect(note.run).toContain('::warning::');
    expect(note.run).toContain('$GITHUB_STEP_SUMMARY');
    expect(note.run).toContain('sonarcloud/trusted');
  });
});
