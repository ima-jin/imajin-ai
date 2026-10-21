// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { CloudflarePanel } from '../cloudflare-panel';
import { classificationPlans, isEdgeClassification, type EdgeClassification } from '../cloudflare-classification-client';
import { useCloudflareClassification } from '../use-cloudflare-classification';
import { imajinClassificationFixture } from '../../dev/cloudflare-preview/classification-fixture';
import { APPROVALS_REFRESH_EVENT } from '../approval-anchor';

const zone = { domain: 'imajin.ai', zoneId: 'a'.repeat(32) };
const fixture = (): EdgeClassification => structuredClone(imajinClassificationFixture);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const readBody = (mock: ReturnType<typeof vi.fn>, index: number) => JSON.parse(mock.mock.calls[index][1].body);
async function open(report = fixture(), fetchMock?: ReturnType<typeof vi.fn>) {
  const request = fetchMock ?? vi.fn().mockImplementation((_url: string, options: RequestInit) => {
    if (options.method === 'GET') return Promise.resolve(Response.json({ classification: report }));
    const body = JSON.parse(String(options.body));
    return Promise.resolve(Response.json(body.dryRun ? { before: [], after: body }
      : { approval: { proposalId: `proposal-${request.mock.calls.length}` } }));
  });
  vi.stubGlobal('fetch', request);
  render(<CloudflarePanel />);
  fireEvent.change(screen.getByLabelText('Verified zone domain'), { target: { value: zone.domain } });
  fireEvent.change(screen.getByLabelText('Cloudflare zone ID'), { target: { value: zone.zoneId } });
  fireEvent.change(screen.getByLabelText('Initial zone view'), { target: { value: 'Edge classification' } });
  fireEvent.click(button('Load zone'));
  await screen.findByRole('region', { name: 'Edge classification report' });
  await waitFor(() => expect(button('Load zone').disabled).toBe(false));
  return request;
}
async function preview() {
  fireEvent.click(button('Preview all dry runs'));
  await waitFor(() => expect(button('Request approval').disabled).toBe(false));
}

describe('classification report browser contract', () => {
  it('validates all five route classes and rejects malformed nested values', () => {
    const report = fixture();
    expect(isEdgeClassification(report)).toBe(true);
    for (const value of [null, [], {}, { ...report, warnings: [null] }, { ...report, proxyBatches: [[null]] },
      { ...report, hosts: [{ ...report.hosts[0], records: [null] }] },
      { ...report, hosts: [{ ...report.hosts[0], routes: [{ ...report.hosts[0].routes[0], class: 'safe' }] }] }]) {
      expect(isEdgeClassification(value)).toBe(false);
    }
  });
  it('chunks at 20, strips provider cache IDs and rejects duplicate record plans', () => {
    const report = fixture();
    report.proxyBatches = [Array.from({ length: 41 }, (_, index) => ({ recordId: `id-${index}`, proxied: true }))];
    report.cacheRules[0].id = 'provider-id';
    const plans = classificationPlans(report);
    expect(plans.map(plan => 'changes' in plan.body ? plan.body.changes.length : 'cache')).toEqual([20, 20, 1, 'cache']);
    expect(plans.at(-1)?.body).not.toHaveProperty('rules.0.id');
    report.proxyBatches[0].push(report.proxyBatches[0][0]);
    expect(() => classificationPlans(report)).toThrow('Duplicate');
  });
  it('previews an empty ruleset as an explicit full replacement rather than silently keeping stale rules', async () => {
    const report = fixture(); report.proxyBatches = []; report.cacheRules = [];
    const request = await open(report);
    expect(screen.getByText(/Empty replacement/)).toBeDefined();
    await preview();
    expect(readBody(request, 1)).toEqual({ domain: zone.domain, rules: [], dryRun: true });
    expect(request.mock.calls[1][1].method).toBe('PUT');
  });
});

describe('classification preview and approval UI', () => {
  it('reads only until Preview, previews every plan, then stages proposals without execution or duplicates', async () => {
    const report = fixture();
    report.proxyBatches = [Array.from({ length: 41 }, (_, index) => ({ recordId: `id-${index}`, proxied: true }))];
    const refresh = vi.fn();
    globalThis.addEventListener(APPROVALS_REFRESH_EVENT, refresh);
    try {
      const request = await open(report);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][1].method).toBe('GET');
      expect(request.mock.calls[0][0]).toContain('/classification?domain=imajin.ai');
      expect(button('Request approval').disabled).toBe(true);
      fireEvent.click(button('Request approval'));
      expect(request).toHaveBeenCalledTimes(1);
      await preview();
      expect(request).toHaveBeenCalledTimes(5);
      expect([1, 2, 3].map(index => readBody(request, index).changes.length)).toEqual([20, 20, 1]);
      for (let index = 1; index <= 4; index += 1) expect(readBody(request, index).dryRun).toBe(true);
      const approve = button('Request approval');
      fireEvent.click(approve); fireEvent.click(approve);
      await screen.findByText(/All proposals pending approval/);
      expect(request).toHaveBeenCalledTimes(9);
      for (let index = 5; index <= 8; index += 1) expect(readBody(request, index)).toEqual({ ...readBody(request, index - 4), dryRun: false });
      expect(screen.getAllByRole('link', { name: /Review proposal/ })).toHaveLength(4);
      expect(refresh).toHaveBeenCalledTimes(4);
      expect(button('Request approval').disabled).toBe(true);
      expect(button('Preview all dry runs').disabled).toBe(true);
      expect(request.mock.calls.every(([url]) => !String(url).includes('execute'))).toBe(true);
      expect(request.mock.calls.every(([, options]) => options.method !== 'PATCH')).toBe(true);
    } finally { globalThis.removeEventListener(APPROVALS_REFRESH_EVENT, refresh); }
  });
  it('presents accessible host decisions, evidence, before/after, warnings and current documentation', async () => {
    await open();
    expect(screen.getByRole('complementary', { name: 'Classification warnings' }).textContent).toContain('DEVELOPMENT FIXTURE');
    expect(screen.getByRole('heading', { name: 'kernel.imajin.ai' })).toBeDefined();
    expect(screen.getByRole('list', { name: 'Record decisions for kernel.imajin.ai' }).textContent).toContain('Before: Proxied → After: DNS-only');
    for (const text of ['cacheable', 'proxy-bypass', 'proxy-unsafe', 'never-proxied', 'unclassified']) {
      expect(screen.getAllByText(text).length).toBeGreaterThan(0);
    }
    const safety = screen.getByRole('region', { name: 'Preview and request approval' });
    expect(within(safety).getByRole('status').getAttribute('aria-live')).toBe('polite');
    expect(screen.getByRole('link', { name: /WebSockets are supported/ }).getAttribute('href')).toBe('https://developers.cloudflare.com/network/websockets/');
    expect(screen.getByRole('link', { name: /125 seconds/ }).getAttribute('href')).toContain('/connection-limits/');
    expect(screen.getByRole('link', { name: /Upload limits/ }).getAttribute('href')).toContain('/error-413/');
    expect(screen.queryByRole('button', { name: /execute|apply now/i })).toBeNull();
  });
  it('invalidates a complete preview on refresh and uses a newly generated plan', async () => {
    const request = await open();
    await preview();
    const next = fixture(); next.proxyBatches = [[{ recordId: 'changed-record', proxied: false }]];
    request.mockResolvedValueOnce(Response.json({ classification: next }));
    fireEvent.click(button('Refresh zone data'));
    await waitFor(() => expect(button('Load zone').disabled).toBe(false));
    expect(button('Request approval').disabled).toBe(true);
    await preview();
    expect(readBody(request, 4).changes).toEqual(next.proxyBatches[0]);
  });
  it('invalidates on zone input changes, including before a new zone is submitted', async () => {
    await open(); await preview();
    fireEvent.change(screen.getByLabelText('Verified zone domain'), { target: { value: 'other.example.com' } });
    expect(screen.queryByRole('button', { name: 'Request approval' })).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('unavailable');
  });
  it('requires complete preview after a partial dry-run failure and keeps provider errors hidden', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ classification: fixture() }))
      .mockResolvedValueOnce(Response.json({ changes: [] }))
      .mockResolvedValueOnce(Response.json({ error: 'PRIVATE_PROVIDER_DETAIL' }, { status: 502 }));
    await open(fixture(), request);
    fireEvent.click(button('Preview all dry runs'));
    await screen.findByText(/Preview incomplete/);
    expect(button('Request approval').disabled).toBe(true);
    expect(screen.getByText(/1 \/|Preview incomplete/)).toBeDefined();
    expect(document.body.textContent).not.toContain('PRIVATE_PROVIDER_DETAIL');
    request.mockResolvedValueOnce(Response.json({ changes: [] })).mockResolvedValueOnce(Response.json({ before: [], after: [] }));
    await preview();
    expect(request).toHaveBeenCalledTimes(5);
    expect([1, 2, 3, 4].every(index => readBody(request, index).dryRun)).toBe(true);
  });
  it('preserves partial staged links and locks retries after an ambiguous staging failure', async () => {
    const request = await open(); await preview();
    request.mockResolvedValueOnce(Response.json({ approval: { proposalId: 'confirmed-one' } }))
      .mockRejectedValueOnce(new Error('PRIVATE_NETWORK_DETAIL'));
    fireEvent.click(button('Request approval'));
    await screen.findByText(/Approval request stopped \(1 confirmed proposals\)/);
    expect(screen.getByRole('link', { name: /Review proposal 1:/ }).getAttribute('href')).toBe('#approval-confirmed-one');
    expect(button('Request approval').disabled).toBe(true);
    fireEvent.click(button('Request approval')); fireEvent.click(button('Preview all dry runs'));
    expect(request).toHaveBeenCalledTimes(5);
    expect(document.body.textContent).not.toContain('PRIVATE_NETWORK_DETAIL');
  });
  it('rejects malformed or cross-zone reports before exposing mutation buttons', async () => {
    const request = vi.fn().mockResolvedValue(Response.json({ classification: { ...fixture(), domain: 'other.example.com' } }));
    vi.stubGlobal('fetch', request); render(<CloudflarePanel />);
    fireEvent.change(screen.getByLabelText('Verified zone domain'), { target: { value: zone.domain } });
    fireEvent.change(screen.getByLabelText('Cloudflare zone ID'), { target: { value: zone.zoneId } });
    fireEvent.change(screen.getByLabelText('Initial zone view'), { target: { value: 'Edge classification' } });
    fireEvent.click(button('Load zone'));
    await screen.findByRole('status');
    expect(screen.queryByRole('button', { name: 'Preview all dry runs' })).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not enable staging when an in-flight preview belongs to an invalidated report', async () => {
    let resolvePreview!: (response: Response) => void;
    const request = vi.fn().mockResolvedValueOnce(Response.json({ classification: fixture() }))
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolvePreview = resolve; }));
    vi.stubGlobal('fetch', request);
    const { result } = renderHook(() => useCloudflareClassification());
    await act(async () => { await result.current.loadClassification(zone); });
    let pending!: Promise<void>;
    act(() => { pending = result.current.previewClassification(zone); });
    act(() => { result.current.invalidate(); });
    await act(async () => { resolvePreview(Response.json({ changes: [] })); await pending; });
    expect(result.current.complete).toBe(false);
    expect(result.current.previews).toEqual([]);
    await act(async () => { await result.current.requestClassificationApproval(zone); });
    expect(request).toHaveBeenCalledTimes(2);
  });
});
