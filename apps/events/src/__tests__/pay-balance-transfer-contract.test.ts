/**
 * Contract test (#2002): the events app's balance/transfer call site and the
 * kernel's documented pay.yaml spec must agree on the same path, method, and
 * auth requirement.
 *
 * Not a network test — reads the two source files directly (same style as
 * apps/kernel/src/lib/kernel/__tests__/api-specs.test.ts, which pins reads
 * to the real shipped spec files) so a future drift between the call site
 * and the spec fails CI immediately instead of surfacing as a runtime 404.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CALL_SITE_PATH = resolve(HERE, '../lib/balance-checkout-helpers.ts');
// apps/events/src/__tests__ -> apps/events/src -> apps/events -> apps -> apps/kernel
const PAY_SPEC_PATH = resolve(HERE, '../../../kernel/api-spec/pay.yaml');

describe('pay.yaml balance/transfer contract', () => {
  const spec = readFileSync(PAY_SPEC_PATH, 'utf-8');
  const callSite = readFileSync(CALL_SITE_PATH, 'utf-8');

  it('documents POST /api/balance/transfer', () => {
    expect(spec).toMatch(/\n {2}\/api\/balance\/transfer:\n {4}post:/);
  });

  it('mounts every documented path under the /{service} (pay) prefix in its servers block', () => {
    // servers[].url ends in /{service}, and the {service} variable defaults
    // to "pay" — so /api/balance/transfer is actually served at
    // /pay/api/balance/transfer, which is exactly what the events call site
    // must reach once PAY_SERVICE_URL (already /pay-suffixed) is combined
    // with the endpoint path.
    expect(spec).toMatch(/servers:\n(?:.*\n)*? {6}service:\n {8}default: pay\b/);
  });

  it("requires cookieAuth or bearerAuth on the transfer endpoint, matching resolveEffectiveDid's session-or-bearer contract", () => {
    const section = spec.slice(spec.indexOf('\n  /api/balance/transfer:'));
    const nextPathIndex = section.indexOf('\n  /api/balance/topup:');
    const transferSection = section.slice(0, nextPathIndex);

    expect(transferSection).toContain('- cookieAuth: []');
    expect(transferSection).toContain('- bearerAuth: []');
  });

  it('the events call site targets the documented /api/balance/transfer path, not a duplicated /pay prefix', () => {
    expect(callSite).toContain('${payServiceUrl}/api/balance/transfer');
    expect(callSite).not.toContain('/pay/api/balance/transfer');
  });

  it('the events call site authenticates with the forwarded session cookie, matching cookieAuth', () => {
    // The route forwards the buyer's own session cookie rather than an
    // internal service API key — cookieAuth, not apiKeyAuth.
    expect(callSite).toMatch(/'Cookie':\s*cookieHeader/);
  });
});
