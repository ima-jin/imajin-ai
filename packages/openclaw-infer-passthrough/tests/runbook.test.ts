import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadRoutes } from '../src/config.js';

const packageUrl = new URL('../', import.meta.url);

describe('principal migration runbook (#3041)', () => {
  it('installs tracked units/helpers from an approved release and follows the production gate (#3082)', () => {
    const deployUrl = new URL('../../../deploy/infer-passthrough/', import.meta.url);
    const runbook = readFileSync(new URL('README.md', deployUrl), 'utf8');
    const updaterUnit = readFileSync(new URL('infer-passthrough-update.service', deployUrl), 'utf8');
    expect(runbook).toContain('The updater follows the production gate');
    expect(runbook).toContain('git merge-base --is-ancestor');
    expect(runbook).toContain('latest status is `success`');
    expect(runbook).toContain('Deployments: read');
    expect(runbook).toContain('no write');
    expect(runbook).toContain('git clone --bare');
    expect(runbook).toContain('install -m 0644 deploy/infer-passthrough/production-deployment.mjs');
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
    const routes = loadRoutes(new URL('config/routes.example.json', packageUrl).pathname);
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
