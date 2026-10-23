// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import LegalEntityForm from '../LegalEntityForm';
import { legalEntityFixture, ownerDid } from '@/src/lib/profile/__tests__/legal-entity-fixture';
const fetchMock = vi.fn();
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
beforeEach(() => {
  vi.resetAllMocks();
  fetchMock.mockResolvedValue(response({ document: null }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('confirm', vi.fn().mockReturnValue(true));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function loaded() {
  render(<LegalEntityForm did={ownerDid} />);
  await screen.findByRole('button', { name: 'Save signed document' });
}
function fill() {
  for (const [label, value] of [
    ['Legal name', 'Example Legal Ltd'], ['Address line 1', '123 Example Street'],
    ['City', 'Toronto'], ['Country (ISO 3166-1 alpha-2)', 'CA'],
  ]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
}
describe('legal entity owner settings form', () => {
  it('shows every field and its own three-level visibility selector, private by default', async () => {
    await loaded();
    expect(screen.getAllByRole('textbox')).toHaveLength(8);
    const controls = screen.getAllByRole('combobox') as HTMLSelectElement[];
    expect(controls).toHaveLength(8);
    for (const control of controls) {
      expect(control.value).toBe('on-consent');
      expect([...control.options].map(option => option.value)).toEqual(['public', 'on-consent', 'never']);
    }
    expect(screen.getByText(/Tax numbers stay in Tax/)).toBeDefined();
  });
  it('validates locally and never sends a bad field', async () => {
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Save signed document' }));
    expect(screen.getByRole('alert').textContent).toContain('legalName');
    fill();
    fireEvent.change(screen.getByLabelText('Country (ISO 3166-1 alpha-2)'), { target: { value: 'ZZ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save signed document' }));
    expect(screen.getByRole('alert').textContent).toContain('address.country');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('sends validated values and independently changed visibility to the signed-save endpoint', async () => {
    await loaded();
    fill();
    fireEvent.change(screen.getByLabelText('Legal name visibility'), { target: { value: 'never' } });
    fireEvent.change(screen.getByLabelText('Address line 1 visibility'), { target: { value: 'public' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save signed document' }));
    await screen.findByText('Signed legal-entity document saved.');
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('/auth/api/legal-entity');
    expect(init.method).toBe('PUT');
    const input = JSON.parse(init.body);
    expect(input.schema).toBe('legal-entity:v1');
    expect(input.visibility.legalName).toBe('never');
    expect(input.visibility['address.line1']).toBe('public');
    expect(input.visibility['address.city']).toBe('on-consent');
  });
  it('loads and edits the existing record without dropping other fields or gates', async () => {
    const record = legalEntityFixture();
    record.visibility.legalName = 'never';
    fetchMock.mockResolvedValueOnce(response({ document: { record } }));
    await loaded();
    expect((screen.getByLabelText('Legal name') as HTMLInputElement).value).toBe(record.legalName);
    expect((screen.getByLabelText('Legal name visibility') as HTMLSelectElement).value).toBe('never');
    fireEvent.change(screen.getByLabelText('Operating name (optional)'), { target: { value: 'Edited name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save signed document' }));
    await screen.findByText('Signed legal-entity document saved.');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ ...record, operatingName: 'Edited name' });
  });
  it.each([false, true])('shows server/network failures and preserves the draft (%s)', async network => {
    await loaded();
    fill();
    if (network) fetchMock.mockRejectedValueOnce(new Error('Connection unavailable'));
    else fetchMock.mockResolvedValueOnce(response({ error: 'Signing unavailable' }, false));
    fireEvent.click(screen.getByRole('button', { name: 'Save signed document' }));
    expect((await screen.findByRole('alert')).textContent).toContain(network ? 'Connection unavailable' : 'Signing unavailable');
    expect((screen.getByLabelText('Legal name') as HTMLInputElement).value).toBe('Example Legal Ltd');
  });
  it('blocks editing after a load failure rather than overwriting an unread document', async () => {
    fetchMock.mockResolvedValueOnce(response({ error: 'Owner access required' }, false));
    await loaded();
    expect(screen.getByRole('alert').textContent).toContain('Owner access required');
    expect(screen.getByRole('button', { name: 'Save signed document' }).closest('fieldset')?.disabled).toBe(true);
  });
  it('confirms revocation, clears values, and reports retained history', async () => {
    fetchMock.mockResolvedValueOnce(response({ document: { record: legalEntityFixture() } }));
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke document' }));
    await screen.findByText('Legal-entity document revoked. Signed history is retained.');
    expect(fetchMock).toHaveBeenLastCalledWith('/auth/api/legal-entity', { method: 'DELETE' });
    expect((screen.getByLabelText('Legal name') as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('button', { name: 'Revoke document' })).toBeNull();
  });
  it('does not revoke when confirmation is cancelled', async () => {
    fetchMock.mockResolvedValueOnce(response({ document: { record: legalEntityFixture() } }));
    await loaded();
    vi.mocked(globalThis.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke document' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('preserves the existing document if revocation fails', async () => {
    fetchMock.mockResolvedValueOnce(response({ document: { record: legalEntityFixture() } }));
    await loaded();
    fetchMock.mockResolvedValueOnce(response({ error: 'Revoke unavailable' }, false));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke document' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Revoke unavailable'));
    expect((screen.getByLabelText('Legal name') as HTMLInputElement).value).toBe('Example Legal Ltd');
  });
});
