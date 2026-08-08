// @vitest-environment jsdom
/**
 * AssetFilename (#1543).
 *
 * Rename is owner-only and refused on immutable assets server-side. The point
 * of these tests is that the UI never offers a rename it cannot complete, that
 * a refused rename does not leave a fake new name on screen, and that the
 * request stays a plain `{ filename }` PATCH — i.e. it never drifts into the
 * content-versioning path.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { AssetFilename, EMPTY_FILENAME_ERROR, IMMUTABLE_RENAME_HINT } from '../AssetFilename';

const ASSET_ID = 'asset_abc123';
const OLD_NAME = 'notes.md';
const NEW_NAME = 'meeting-notes.md';

function installFetch(status = 200, body: unknown = { ok: true, filename: NEW_NAME }) {
  const spy = vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => body,
  }) as unknown as Response);
  vi.stubGlobal('fetch', spy);
  return spy;
}

function renderField(overrides: Partial<Parameters<typeof AssetFilename>[0]> = {}) {
  const onRenamed = vi.fn();
  render(
    <AssetFilename
      assetId={ASSET_ID}
      filename={OLD_NAME}
      isOwner
      immutable={false}
      onRenamed={onRenamed}
      {...overrides}
    />,
  );
  return { onRenamed };
}

function trigger(): HTMLElement {
  return screen.getByRole('button', { name: `Rename ${OLD_NAME}` });
}

function input(): HTMLInputElement {
  return screen.getByRole('textbox', { name: 'Asset filename' }) as HTMLInputElement;
}

function typeAndSubmit(value: string) {
  fireEvent.click(trigger());
  fireEvent.change(input(), { target: { value } });
  fireEvent.keyDown(input(), { key: 'Enter' });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('who sees the affordance', () => {
  it('offers rename to the owner of a mutable asset', () => {
    installFetch();
    renderField();

    expect(trigger()).toBeDefined();
  });

  it('offers nothing to a non-owner', () => {
    installFetch();
    renderField({ isOwner: false });

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(OLD_NAME)).toBeDefined();
  });

  it('offers nothing on an immutable asset, and says why', () => {
    installFetch();
    renderField({ immutable: true });

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByTitle(IMMUTABLE_RENAME_HINT)).toBeDefined();
  });
});

describe('validation', () => {
  it('rejects a whitespace-only name without calling the API', async () => {
    const spy = installFetch();
    const { onRenamed } = renderField();

    typeAndSubmit('   ');

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', EMPTY_FILENAME_ERROR);
    expect(spy).not.toHaveBeenCalled();
    expect(onRenamed).not.toHaveBeenCalled();
    // Still editing — the name has not been thrown away.
    expect(input().value).toBe('   ');
  });

  it('skips the API when the name is unchanged', () => {
    const spy = installFetch();
    renderField();

    typeAndSubmit(OLD_NAME);

    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText(OLD_NAME)).toBeDefined();
  });

  it('trims surrounding whitespace before sending', async () => {
    const spy = installFetch();
    renderField();

    typeAndSubmit(`  ${NEW_NAME}  `);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ filename: NEW_NAME });
  });
});

describe('successful rename', () => {
  it('PATCHes only the filename and reports the confirmed name', async () => {
    const spy = installFetch();
    const { onRenamed } = renderField();

    typeAndSubmit(NEW_NAME);

    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith(NEW_NAME));
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/media/api/assets/${ASSET_ID}`);
    expect(init.method).toBe('PATCH');
    // Rename must stay off the content-versioning path — filename only.
    expect(Object.keys(JSON.parse(String(init.body)))).toEqual(['filename']);
    expect(screen.getByText(NEW_NAME)).toBeDefined();
  });

  it('shows the new name optimistically, before the response lands', async () => {
    let release: (value: Response) => void = () => {};
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => { release = resolve; })),
    );
    renderField();

    typeAndSubmit(NEW_NAME);

    expect(await screen.findByText(NEW_NAME)).toBeDefined();
    release({ ok: true, status: 200, json: async () => ({ filename: NEW_NAME }) } as unknown as Response);
  });

  it('does not fire twice when Enter is followed by a blur', async () => {
    const spy = installFetch();
    renderField();

    fireEvent.click(trigger());
    const field = input();
    fireEvent.change(field, { target: { value: NEW_NAME } });
    fireEvent.keyDown(field, { key: 'Enter' });
    // The input unmounts on commit; a browser fires blur on the way out.
    fireEvent.blur(field);

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
  });
});

describe('cancelling', () => {
  it('Escape restores the old name without calling the API', () => {
    const spy = installFetch();
    renderField();

    fireEvent.click(trigger());
    fireEvent.change(input(), { target: { value: NEW_NAME } });
    fireEvent.keyDown(input(), { key: 'Escape' });
    fireEvent.blur(document.body);

    expect(spy).not.toHaveBeenCalled();
    expect(screen.getByText(OLD_NAME)).toBeDefined();
  });
});

describe('refused rename', () => {
  it('rolls back and explains an immutable refusal', async () => {
    installFetch(403, { error: 'Immutable asset — cannot rename' });
    const { onRenamed } = renderField();

    typeAndSubmit(NEW_NAME);

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Immutable asset — cannot rename',
    );
    expect(screen.getByText(OLD_NAME)).toBeDefined();
    expect(onRenamed).not.toHaveBeenCalled();
  });

  it('rewrites a bare Forbidden into ownership copy', async () => {
    installFetch(403, { error: 'Forbidden' });
    renderField();

    typeAndSubmit(NEW_NAME);

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Only the owner can rename this asset',
    );
  });

  it('surfaces the agent-approval gate rather than hiding it', async () => {
    installFetch(403, {
      error: 'Agent delegation does not permit destructive operations',
      code: 'AGENT_APPROVAL_REQUIRED',
    });
    renderField();

    typeAndSubmit(NEW_NAME);

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Renaming needs owner approval — agents cannot rename assets',
    );
  });

  it('surfaces the 400 for an empty name the server rejects', async () => {
    installFetch(400, { error: 'filename is required' });
    renderField();

    typeAndSubmit(NEW_NAME);

    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'filename is required');
    expect(screen.getByText(OLD_NAME)).toBeDefined();
  });

  it('rolls back on a network failure instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const { onRenamed } = renderField();

    typeAndSubmit(NEW_NAME);

    expect(await screen.findByRole('alert')).toBeDefined();
    expect(screen.getByText(OLD_NAME)).toBeDefined();
    expect(onRenamed).not.toHaveBeenCalled();
  });
});
