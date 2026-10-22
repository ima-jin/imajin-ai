import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadRoutes } from '../src/config.js';

const packageUrl = new URL('../', import.meta.url);

describe('principal migration runbook (#3041)', () => {
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
