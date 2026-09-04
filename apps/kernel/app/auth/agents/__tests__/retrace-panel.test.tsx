// @vitest-environment jsdom
/**
 * Retrace pane (#1962): render the chain, expand a hop to see its linked
 * input/output + signature status, and render a tombstone row for a hop
 * the caller isn't authorized to read.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import RetracePane from '../retrace-panel';
import type { RetraceResult } from '../retrace-panel';

function installFetch(result: RetraceResult | { error: string }, status = 200) {
  const spy = vi.fn(async () => ({
    ok: status < 400,
    status,
    json: async () => result,
  } as unknown as Response));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RetracePane', () => {
  it('renders the chain newest-to-oldest with a terminal summary', async () => {
    installFetch({
      hops: [
        { kind: 'attestation', actorDid: 'did:imajin:agent', onBehalfOf: null, grant: { grantId: 'grant_1', capability: 'messages:write' }, input: 'att_parent', output: 'att_child', route: 'attestation.created', timestamp: '2026-01-01T00:00:00.000Z', signature: 'verified' },
        { kind: 'attestation', actorDid: 'did:imajin:owner', onBehalfOf: null, grant: null, input: null, output: 'att_parent', route: 'attestation.created', timestamp: '2025-12-31T00:00:00.000Z', signature: 'verified' },
      ],
      terminal: { reached: true, ref: { kind: 'attestation', id: 'att_parent' }, reason: 'origin' },
      truncated: false,
    });

    render(<RetracePane initialArtifact="att_child" />);

    await waitFor(() => expect(screen.getByText(/Reached the origin of this chain/)).toBeDefined());
    expect(screen.getAllByText('verified')).toHaveLength(2);
  });

  it('expands a hop to reveal its linked input/output and route', async () => {
    installFetch({
      hops: [
        { kind: 'agent_provision', actorDid: 'did:imajin:owner', onBehalfOf: null, grant: { grantId: 'grant_9' }, input: null, output: 'prov_1', route: 'agent.provisioned', timestamp: '2026-01-01T00:00:00.000Z', signature: 'unsigned' },
      ],
      terminal: { reached: true, ref: { kind: 'agent_provision', id: 'prov_1' }, reason: 'origin' },
      truncated: false,
    });

    render(<RetracePane initialArtifact="prov_1" />);
    await waitFor(() => expect(screen.getByText('unsigned')).toBeDefined());

    fireEvent.click(screen.getByText('did:imajin:owner').closest('button')!);

    expect(screen.getByText('agent.provisioned')).toBeDefined();
    expect(screen.getByText('prov_1')).toBeDefined();
    expect(screen.getByText('grant_9')).toBeDefined();
  });

  it('renders an unauthorized hop as a locked tombstone row', async () => {
    installFetch({
      hops: [
        { kind: 'attestation', actorDid: 'did:imajin:agent', onBehalfOf: null, grant: null, input: null, output: 'att_child', route: 'attestation.created', timestamp: '2026-01-01T00:00:00.000Z', signature: 'verified' },
        { kind: 'tombstone', timestamp: '2025-12-31T00:00:00.000Z', hash: 'abcdef0123456789' },
      ],
      terminal: { reached: false, ref: null, reason: null },
      truncated: false,
    });

    render(<RetracePane initialArtifact="att_child" />);

    await waitFor(() => expect(screen.getByText('Hop not visible to you')).toBeDefined());
    expect(screen.getByText(/abcdef012345…/)).toBeDefined();
  });

  it('shows the error message when the request fails', async () => {
    installFetch({ error: 'Artifact not found' }, 404);

    render(<RetracePane initialArtifact="att_missing" />);

    await waitFor(() => expect(screen.getByText('Artifact not found')).toBeDefined());
  });

  it('runs a fresh retrace when the operator submits a typed artifact id', async () => {
    const spy = installFetch({ hops: [], terminal: { reached: true, ref: null, reason: 'origin' }, truncated: false });

    render(<RetracePane />);
    fireEvent.change(screen.getByLabelText('Artifact id to retrace'), { target: { value: 'att_manual' } });
    fireEvent.click(screen.getByRole('button', { name: 'Retrace' }));

    await waitFor(() => expect(spy).toHaveBeenCalledWith(expect.stringContaining('artifact=att_manual'), expect.anything()));
  });
});
