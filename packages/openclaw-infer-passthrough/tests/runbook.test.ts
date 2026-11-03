import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadRoutes } from '../src/config.js';

const packageUrl = new URL('../', import.meta.url);

describe('principal migration runbook (#3041)', () => {
  it('keeps the declared-mode gate and executable operator interlock explicit (#3230)', () => {
    const runbook = readFileSync(new URL('../../../deploy/infer-passthrough/README.md', import.meta.url), 'utf8');
    for (const contract of [
      'Unset or empty means undeclared', 'Agent liveness without routes fails',
      'credentialRequired === true', 'A host-static route payload fails',
      'no reinstall is', 'needed for option (a)', 'not live',
      '/usr/local/libexec/infer-passthrough', 'both checker + update.sh',
      'Do not "fix" the checker alone', 'deployed <tag>',
      'one model call through :8787 **from an agent** succeeds',
      'update.sh --check',
    ]) expect(runbook).toContain(contract);
    const operator = runbook.slice(runbook.indexOf('**(b) Agent-native'));
    const plugin = operator.indexOf('deploy plugin PR #151');
    const declaration = operator.indexOf('Set the explicit line `INFER_PROXY_AUTH_MODE=agent`');
    const reinstall = operator.indexOf('Reinstall **both checker + update.sh**');
    const promote = operator.indexOf('Only then let the tag promote');
    expect(plugin).toBeGreaterThanOrEqual(0);
    expect(declaration).toBeGreaterThan(plugin);
    expect(reinstall).toBeGreaterThan(declaration);
    expect(promote).toBeGreaterThan(reinstall);
    expect(runbook).toContain('install -o root -g root -m 0755 deploy/infer-passthrough/bootstrap.sh deploy/infer-passthrough/update.sh /usr/local/libexec/infer-passthrough/');
    expect(runbook).toContain('deploy/infer-passthrough/check-health.mjs');
  });
  it('documents assigned org bots, personal isolation and the partial operator proof (#3184)', () => {
    const readme = readFileSync(new URL('README.md', packageUrl), 'utf8');
    for (const contract of [
      'org bot = agent assigned to the org DID using the org',
      'Personal agents stay on their human', 'No per-session act-as',
      'no per-member grant', 'connection_not_loaded',
      'artifact-org-bot-smoke.mjs --dry-run', 'usageIds',
      'no Warp implementation or placeholder', 'plugin PR #151',
    ]) expect(readme).toContain(contract);
  });
  it('documents per-agent transport, refusals and the host-only opt-in (#3224)', () => {
    const runbook = readFileSync(new URL('../../../deploy/infer-passthrough/README.md', import.meta.url), 'utf8');
    for (const contract of [
      'Authorization: Bearer', 'x-api-key', 'x-acting-as', 'app+jwt', 'azp', 'sub',
      'invalid_agent_credential', '401', '403', '502', 'INFER_PROXY_AUTH_MODE=host-static',
      '#3182', 'No running host',
    ]) expect(runbook).toContain(contract);
  });
  it('installs tracked units/helpers from an approved release and follows the production gate (#3082)', () => {
    const deployUrl = new URL('../../../deploy/infer-passthrough/', import.meta.url);
    const runbook = readFileSync(new URL('README.md', deployUrl), 'utf8');
    const updaterUnit = readFileSync(new URL('infer-passthrough-update.service', deployUrl), 'utf8');
    expect(runbook).toContain('The updater follows the production gate');
    expect(runbook).toContain('git merge-base --is-ancestor');
    expect(runbook).toContain('latest status is `success`');
    expect(runbook).toContain('Deployments: read');
    expect(runbook).toContain('no write');
    expect(runbook).toContain('bootstrap.sh');
    expect(runbook).toContain('TODO #3190');
    expect(runbook).toContain('production-deployment.mjs');
    expect(runbook).toContain('Keep the existing unit as-is until this change lands');
    expect(runbook).not.toContain('independent of the production');
    expect(updaterUnit).toContain('LoadCredential=github-token:/etc/imajin/infer-passthrough-github-token');
    expect(updaterUnit).not.toMatch(/GRANT_ID|ATTESTATION_ID|GH_TOKEN=|GITHUB_TOKEN=/);
  });
  it('ships a grant-free service/env template and a recurring updater timer', () => {
    const deployUrl = new URL('../../../deploy/infer-passthrough/', import.meta.url);
    const env = readFileSync(new URL('infer-passthrough.env.example', deployUrl), 'utf8');
    const unit = readFileSync(new URL('infer-passthrough.service', deployUrl), 'utf8');
    const timer = readFileSync(new URL('infer-passthrough-update.timer', deployUrl), 'utf8');
    expect(env).toContain('INFER_PROXY_PRINCIPAL_DID=');
    expect(env).not.toMatch(/^[^#\n]*(?:GRANT_ID|ATTESTATION_ID|INFER_PROXY_ROUTES_CONFIG)=/m);
    expect(unit).toContain('EnvironmentFile=/etc/imajin/infer-passthrough.env');
    expect(unit).toContain('/current/node_modules/.bin/tsx');
    expect(unit).not.toMatch(/GRANT_ID|ATTESTATION_ID/);
    expect(timer).toContain('OnUnitInactiveSec=2min');
    const runbook = readFileSync(new URL('README.md', deployUrl), 'utf8');
    expect(runbook).toContain('systemctl enable --now infer-passthrough-update.timer');
    expect(runbook).toContain('check-health.mjs 8787');
  });
  it('ships grant-free optional example routes', () => {
    const routes = loadRoutes(fileURLToPath(new URL('config/routes.example.json', packageUrl)));
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) {
      expect(route.principalDid).toBeTruthy();
      expect(route).not.toHaveProperty('attestationId');
    }
  });

  it('documents fileless setup and the one-time unit cleanup, not a re-grant restart', () => {
    const readme = readFileSync(new URL('README.md', packageUrl), 'utf8');
    expect(readme).toContain('No routes file is needed for normal operation');
    expect(readme).toContain('Remove **every** `INFER_PROXY_ROUTES_CONFIG` assignment');
    expect(readme).toContain('Set **`INFER_PROXY_PRINCIPAL_DID`**');
    expect(readme).toContain('systemctl daemon-reload');
    expect(readme).toContain('not changes applied by this PR');
    expect(readme).toContain('not** needed for any subsequent re-grant');
    expect(readme).not.toContain('REPLACE_WITH_APP_AUTHORIZED_ATTESTATION_ID');
  });
});
