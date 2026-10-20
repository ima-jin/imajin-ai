// @vitest-environment jsdom
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { KeysPanel } from '../keys-panel';
import type { PublicPayload } from '../public-contract';

const SWEEP = '/api/vault/rotation-sweep';
const ROTATION = '/api/admin/keys/rotation';
// All test material is generated in-process; no real configuration or key fixtures.
const hex = (bytes: number) => randomBytes(bytes).toString('hex');
const publicKey = hex(32);
const oldPublicKey = hex(32);
const marker = `untrusted-${hex(12)}`;
const payload: PublicPayload = {
  oldKid: `auth-${hex(8)}`, newKid: `auth-${hex(8)}`,
  oldPublicKey, newPublicKey: publicKey, effectiveAt: '2026-10-20T12:00:00.000Z',
  oldKeySignature: hex(64), newKeySignature: hex(64),
};
const pending = { pending: true, exported: 3, newPublicKey: publicKey };
const report = {
  ok: true, rotations: 1, currentKid: payload.newKid, errors: [marker], unknown: marker,
  nodeDid: 'did:imajin:node-test', nodeDidSource: 'relay_config', processStartedAt: '2026-10-20T12:00:00.000Z',
};
const receipt = { attestationId: marker, ...payload };
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

function installFetch(status: unknown = { pending: false }) {
  const spy = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : null;
    if (url === SWEEP && !body) return response(status);
    if (url === '/api/vault/migrate-custody') return response({ totalV1Fields: 0, candidateCount: 0, aborted: false, unknown: marker });
    if (url === SWEEP && body?.phase === 'export') return response({ exported: 3, newPublicKey: publicKey, unknown: marker });
    if (url === SWEEP && body?.phase === 'reimport') return response({ resealed: 3, unknown: marker });
    if (url.startsWith(ROTATION) && !body) return response(report);
    if (url === ROTATION && body) return response(receipt);
    throw new Error(marker);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function change(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function ready(status?: unknown) {
  const spy = installFetch(status);
  render(<KeysPanel />);
  await waitFor(() => expect(screen.queryByText('Handoff status unavailable or loading.')).toBeNull());
  return spy;
}

async function upload(value: unknown = payload, options: { name?: string; size?: number; raw?: boolean } = {}) {
  const text = options.raw ? String(value) : JSON.stringify(value);
  const file = new File([text], options.name ?? 'rotation.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => text });
  if (options.size) Object.defineProperty(file, 'size', { value: options.size });
  fireEvent.change(screen.getByLabelText('Public signed rotation JSON'), { target: { files: [file] } });
  await waitFor(() => expect(
    screen.queryByText('Public payload validated and ready for server verification.') || screen.queryByRole('alert'),
  ).toBeTruthy());
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('public-only keys workflow', () => {
  it('runs only a browser-session custody dry-run and renders only whitelisted public counts', async () => {
    const spy = await ready();
    fireEvent.click(button('Check v1 custody'));
    await screen.findByText('Eligible v1 custody check passed. Verify excluded custody separately.');
    expect(spy.mock.calls[1][0]).toBe('/api/vault/migrate-custody');
    expect(JSON.parse(spy.mock.calls[1][1]!.body as string)).toEqual({ dryRun: true });
    expect(document.body.textContent).not.toContain(marker);
  });
  it.each([{ totalV1Fields: 2, candidateCount: 2, aborted: false },
    { totalV1Fields: 0, candidateCount: 0, aborted: true }])('reports STOP on nonzero or aborted custody checks', async (body) => {
    const spy = await ready();
    spy.mockResolvedValueOnce(response(body));
    fireEvent.click(button('Check v1 custody'));
    await screen.findByText('STOP: resolve custody migration before rotating.');
  });
  it.each([{ totalV1Fields: -1, candidateCount: 0, aborted: false },
    { totalV1Fields: 0, candidateCount: marker, aborted: false },
    { totalV1Fields: 0, candidateCount: 0, aborted: marker }])('rejects malformed custody data without rendering it', async (body) => {
    const spy = await ready();
    spy.mockResolvedValueOnce(response(body));
    fireEvent.click(button('Check v1 custody'));
    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain(marker);
  });
  it('renders the public node source and precise signing process start time', async () => {
    await ready();
    fireEvent.click(button('Verify baseline'));
    await screen.findByText('Node DID: did:imajin:node-test (source: relay_config)');
    expect(screen.getByText('Signing process started at (UTC): 2026-10-20T12:00:00.000Z')).toBeTruthy();
  });
  it('refuses a mismatched reimport count rather than declaring completion', async () => {
    const spy = await ready(pending);
    fireEvent.click(screen.getByRole('checkbox'));
    spy.mockResolvedValueOnce(response({ resealed: 2 }));
    fireEvent.click(button('Reimport encrypted handoff'));
    await screen.findByRole('alert');
    expect(screen.queryByText(/Vault reimport complete/)).toBeNull();
    expect(screen.getByText('Encrypted handoff pending. Exported fields: 3')).toBeTruthy();
  });
  it('verifies baseline, exports only the public target, reimports without fields, records public JSON and verifies anchor', async () => {
    const spy = await ready();
    fireEvent.click(button('Verify baseline'));
    await screen.findByText('Key history verified.');
    change('New Ed25519 public key', publicKey);
    fireEvent.click(button('Export encrypted handoff'));
    await screen.findByText('Encrypted handoff pending. Exported fields: 3');
    expect(button('Export encrypted handoff').disabled).toBe(true);
    expect(button('Reimport encrypted handoff').disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button('Reimport encrypted handoff'));
    await screen.findByText('Vault reimport complete. Resealed fields: 3.');
    expect(button('Reimport encrypted handoff').closest('section')?.textContent).toContain('Vault reimport complete.');
    expect(button('Reimport encrypted handoff').disabled).toBe(true);
    await upload();
    fireEvent.click(button('Submit key.rotated'));
    await screen.findByText('key.rotated recorded. Verify from the old public anchor below.');
    expect(button('Submit key.rotated').closest('section')?.textContent).toContain('key.rotated recorded.');
    expect(button('Submit key.rotated').disabled).toBe(true);
    change('Old public anchor', oldPublicKey);
    fireEvent.click(button('Verify anchored history'));
    await screen.findByText('Key history verified.');

    const posts = spy.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(posts.map(([url, init]) => [url, JSON.parse(init!.body as string)])).toEqual([
      [SWEEP, { phase: 'export', newPublicKey: publicKey }],
      [SWEEP, { phase: 'reimport' }],
      [ROTATION, payload],
    ]);
    expect(spy.mock.calls.some(([url]) => url === `${ROTATION}?anchor=${oldPublicKey}`)).toBe(true);
    for (const [url, init] of spy.mock.calls) {
      expect(url.startsWith('/api/')).toBe(true);
      expect(init?.credentials).toBe('same-origin');
      expect(init?.cache).toBe('no-store');
      expect(init?.headers ?? {}).not.toHaveProperty('Authorization');
    }
    expect(document.body.textContent).not.toContain(marker);
    expect(document.querySelector('input[type="password"], textarea')).toBeNull();
  });

  it('recovers server-held pending status on a fresh mount with no browser storage', async () => {
    const spy = await ready(pending);
    expect(screen.getByText(`Target public key: ${publicKey}`)).toBeTruthy();
    expect(button('Export encrypted handoff').disabled).toBe(true);
    expect(button('Reimport encrypted handoff').disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(button('Reimport encrypted handoff'));
    await screen.findByText('Vault reimport complete. Resealed fields: 3.');
    expect(JSON.parse(spy.mock.calls[1][1]!.body as string)).toEqual({ phase: 'reimport' });
  });

  it('requires valid public keys and a known non-pending status for export and anchor controls', async () => {
    await ready();
    for (const value of ['', marker, hex(48), `${publicKey}!`]) {
      change('New Ed25519 public key', value);
      change('Old public anchor', value);
      expect(button('Export encrypted handoff').disabled).toBe(true);
      expect(button('Verify anchored history').disabled).toBe(true);
    }
    change('New Ed25519 public key', publicKey);
    expect(button('Export encrypted handoff').disabled).toBe(false);
    expect(button('Submit key.rotated').disabled).toBe(true);
  });

  it('disables controls during an in-flight request', async () => {
    const spy = await ready();
    let resolve!: (value: Response) => void;
    spy.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.click(button('Verify baseline'));
    expect(button('Verify baseline').disabled).toBe(true);
    expect(button('Refresh handoff status').disabled).toBe(true);
    resolve(response(report));
    await screen.findByText('Key history verified.');
    expect(button('Verify baseline').disabled).toBe(false);
  });

  it('reports a failed verdict without displaying arbitrary errors or history', async () => {
    const spy = await ready();
    spy.mockResolvedValueOnce(response({ ...report, ok: false, history: [{ privateKey: marker }] }));
    fireEvent.click(button('Verify baseline'));
    await screen.findByText(/Key history verification failed/);
    expect(document.body.textContent).not.toContain(marker);
  });
});

describe('upload validation', () => {
  const invalid = [
    ['extra private field', { ...payload, privateKey: hex(32) }],
    ['extra arbitrary field', { ...payload, surprise: marker }],
    ['missing field', { ...payload, oldKid: undefined }],
    ['wrong object', []],
    ['invalid key', { ...payload, newPublicKey: marker }],
    ['unchanged key', { ...payload, newPublicKey: oldPublicKey }],
    ['invalid kid', { ...payload, newKid: marker }],
    ['invalid signature', { ...payload, oldKeySignature: marker }],
    ['invalid instant', { ...payload, effectiveAt: marker }],
  ] as const;

  it.each(invalid)('rejects %s without issuing a POST', async (_, value) => {
    const spy = await ready();
    await upload(value);
    expect(screen.getByRole('alert').textContent).toMatch(/exactly the seven/);
    expect(button('Submit key.rotated').disabled).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(marker);
  });

  it.each([
    ['invalid JSON', '{', { raw: true }],
    ['oversized file', payload, { size: 16385 }],
    ['non-JSON file', payload, { name: 'material.pem' }],
  ])('rejects %s', async (_, value, options) => {
    await ready();
    await upload(value, options as { name?: string; size?: number; raw?: boolean });
    expect(button('Submit key.rotated').disabled).toBe(true);
  });

  it('clears a previously valid upload when the replacement fails or selection is cleared', async () => {
    await ready();
    await upload();
    expect(button('Submit key.rotated').disabled).toBe(false);
    await upload({ ...payload, extra: marker });
    expect(button('Submit key.rotated').disabled).toBe(true);
    await upload();
    fireEvent.change(screen.getByLabelText('Public signed rotation JSON'), { target: { files: [] } });
    expect(button('Submit key.rotated').disabled).toBe(true);
  });
});

describe('request and response failures', () => {
  it.each([401, 403, 500])('handles status lookup HTTP %s and recovers with refresh', async (status) => {
    const spy = installFetch();
    const json = vi.fn(async () => ({ error: marker }));
    spy.mockResolvedValueOnce({ ok: false, status, json } as unknown as Response);
    render(<KeysPanel />);
    await screen.findByRole('alert');
    expect(json).not.toHaveBeenCalled();
    change('New Ed25519 public key', publicKey);
    expect(button('Export encrypted handoff').disabled).toBe(true);
    fireEvent.click(button('Refresh handoff status'));
    await screen.findByText('No encrypted handoff pending.');
    expect(button('Export encrypted handoff').disabled).toBe(false);
    expect(document.body.textContent).not.toContain(marker);
  });

  it.each(['verify', 'export', 'reimport', 'record', 'refresh', 'custody'])('handles %s network failure without exposing raw errors', async (operation) => {
    const spy = await ready(operation === 'reimport' ? pending : undefined);
    if (operation === 'record') await upload();
    if (operation === 'export') change('New Ed25519 public key', publicKey);
    if (operation === 'reimport') fireEvent.click(screen.getByRole('checkbox'));
    spy.mockRejectedValueOnce(new Error(marker));
    const names: Record<string, string> = {
      verify: 'Verify baseline', export: 'Export encrypted handoff', reimport: 'Reimport encrypted handoff',
      record: 'Submit key.rotated', refresh: 'Refresh handoff status', custody: 'Check v1 custody',
    };
    fireEvent.click(button(names[operation]));
    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain(marker);
    expect(button('Verify baseline').disabled).toBe(false);
    if (operation === 'export' || operation === 'refresh') {
      expect(button('Export encrypted handoff').disabled).toBe(true);
    }
  });

  it.each([
    { pending: true, exported: -1, newPublicKey: publicKey },
    { pending: true, exported: 1, newPublicKey: marker },
    { pending: marker }, null, [],
  ])('fails closed on malformed handoff status %#', async (status) => {
    installFetch(status);
    render(<KeysPanel />);
    await screen.findByRole('alert');
    expect(button('Export encrypted handoff').disabled).toBe(true);
    expect(button('Reimport encrypted handoff').disabled).toBe(true);
    expect(document.body.textContent).not.toContain(marker);
  });

  it('refuses legacy plaintext export responses and mismatched target keys', async () => {
    const spy = await ready();
    change('New Ed25519 public key', publicKey);
    spy.mockResolvedValueOnce(response({ fields: [{ field: marker, plaintext: marker }] }));
    fireEvent.click(button('Export encrypted handoff'));
    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain(marker);
    fireEvent.click(button('Refresh handoff status'));
    await screen.findByText('No encrypted handoff pending.');
    spy.mockResolvedValueOnce(response({ exported: 2, newPublicKey: oldPublicKey }));
    fireEvent.click(button('Export encrypted handoff'));
    await screen.findByRole('alert');
    expect(button('Reimport encrypted handoff').disabled).toBe(true);
  });

  it.each(['verify', 'export', 'reimport', 'record'])('handles %s HTTP rejection without reading response bodies', async (operation) => {
    const spy = await ready(operation === 'reimport' ? pending : undefined);
    if (operation === 'record') await upload();
    if (operation === 'export') change('New Ed25519 public key', publicKey);
    if (operation === 'reimport') fireEvent.click(screen.getByRole('checkbox'));
    const json = vi.fn(async () => ({ error: marker }));
    spy.mockResolvedValueOnce({ ok: false, status: 403, json } as unknown as Response);
    const names: Record<string, string> = {
      verify: 'Verify baseline', export: 'Export encrypted handoff', reimport: 'Reimport encrypted handoff',
      record: 'Submit key.rotated',
    };
    fireEvent.click(button(names[operation]));
    await screen.findByRole('alert');
    expect(json).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(marker);
  });

  it.each([
    ['Verify baseline', { ...report, currentKid: marker }],
    ['Verify baseline', { ...report, ok: marker }],
    ['Verify baseline', { ...report, rotations: -1 }],
    ['Verify baseline', { ...report, nodeDid: marker }],
    ['Verify baseline', { ...report, nodeDidSource: marker }],
    ['Verify baseline', { ...report, processStartedAt: marker }],
    ['Reimport encrypted handoff', { resealed: marker }],
    ['Submit key.rotated', { error: marker }],
  ])('rejects malformed successful response for %s %#', async (name, body) => {
    const spy = await ready(pending);
    if (name === 'Reimport encrypted handoff') fireEvent.click(screen.getByRole('checkbox'));
    if (name === 'Submit key.rotated') await upload();
    spy.mockResolvedValueOnce(response(body));
    fireEvent.click(button(name));
    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain(marker);
  });

  it('does not let a delayed initial lookup overwrite a refreshed pending handoff', async () => {
    const spy = installFetch();
    let resolve!: (value: Response) => void;
    spy.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    render(<KeysPanel />);
    spy.mockResolvedValueOnce(response(pending));
    fireEvent.click(button('Refresh handoff status'));
    await screen.findByText('Encrypted handoff pending. Exported fields: 3');
    resolve(response({ pending: false }));
    await waitFor(() => expect(button('Refresh handoff status').disabled).toBe(false));
    expect(screen.getByText('Encrypted handoff pending. Exported fields: 3')).toBeTruthy();
    expect(button('Export encrypted handoff').disabled).toBe(true);
  });
});
