import { describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
vi.mock('../../kernel/api-specs', () => ({ listApiSpecServices: () => [], readApiSpec: () => null }));
vi.mock('../edge-registry', () => ({ listRegisteredEdgeApps: vi.fn() }));
vi.mock('../edge-spec-loader', () => ({ loadRegistryEdgeSpec: vi.fn() }));
import { buildClassificationReport } from '../classification';
import { imajinClassificationFixture, imajinFixtureRecords } from '../../../../app/dev/cloudflare-preview/classification-fixture';

describe('generated imajin.ai report (synthetic evidence only)', () => {
  it('produces host decisions, bounded proposals and safe cache rules from fixture route evidence', () => {
    const manifests = imajinClassificationFixture.hosts.map(host => ({ hostname: host.hostname, routes: host.routes }));
    const report = buildClassificationReport('imajin.ai', imajinFixtureRecords, manifests, ['SYNTHETIC FIXTURE — not a live zone scan.']);
    const decisions = Object.fromEntries(report.hosts.map(host => [host.hostname, host.proxied]));
    expect(decisions).toEqual({
      'kernel.imajin.ai': false, 'www.imajin.ai': true, 'thirdparty.imajin.ai': false,
      'imajin.ai': false, '_verification.imajin.ai': false,
    });
    expect(report.hosts.every(host => !!host.reason && host.records.every(record => !!record.reason))).toBe(true);
    expect(report.hosts.find(host => host.hostname === 'kernel.imajin.ai')?.blockingRoutes).toHaveLength(2);
    expect(report.hosts.find(host => host.hostname === 'kernel.imajin.ai')?.remedy).toContain('separate DNS-only host');
    expect(report.proxyBatches.flat()).toHaveLength(4);
    expect(report.proxyBatches.every(batch => batch.length <= 20)).toBe(true);
    expect(report.cacheRules.filter(rule => rule.action_parameters.cache)).toHaveLength(1);
    expect(report.cacheRules.at(-1)?.action_parameters.cache).toBe(false);
    if (process.env.EDGE_REPORT_OUTPUT) writeFileSync(process.env.EDGE_REPORT_OUTPUT, JSON.stringify(report, null, 2) + '\n');
  });
});
