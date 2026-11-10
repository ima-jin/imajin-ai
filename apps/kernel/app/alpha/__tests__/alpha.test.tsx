// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import AlphaPage, { metadata } from '../page';
import { ALPHA_CHOICES, ALPHA_INTENTS } from '@/src/lib/alpha/contract';
import sitemap from '@/app/sitemap';
import { GET as spec } from '@/app/api/spec/route';

vi.mock('@/src/lib/www/articles', () => ({ getAllArticles: async () => [] }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function mount(intent?: string | string[]) {
  return render(await AlphaPage({ searchParams: Promise.resolve({ intent }) }));
}
function fill() {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Example Person' } });
  fireEvent.change(screen.getByLabelText('Work email'), { target: { value: 'person@example.com' } });
  fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Example' } });
  fireEvent.change(screen.getByLabelText('What will your agents do for people?'), { target: { value: 'Book travel.' } });
}
describe('/alpha public page', () => {
  it.each(ALPHA_INTENTS)('preselects %s from query and submits without auth', async intent => {
    const send = vi.fn().mockResolvedValue(Response.json({}, { status: 201 }));
    vi.stubGlobal('fetch', send);
    await mount(intent);
    expect((screen.getByRole('radio', { name: new RegExp(ALPHA_CHOICES.find(choice => choice.value === intent)!.label) }) as HTMLInputElement).checked).toBe(true);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    await screen.findByRole('status');
    expect(screen.getByText('Thank you — someone from Imajin will reach out to you.')).toBeDefined();
    expect(send).toHaveBeenCalledWith('/api/alpha', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({
      name: 'Example Person', email: 'person@example.com', company: 'Example', purpose: 'Book travel.', intent, website: '',
    });
    expect(screen.queryByRole('button', { name: 'Send request' })).toBeNull();
  });
  it.each([undefined, 'unknown', ['demo', 'partner']])('uses tester for absent, unknown or repeated intent %j', async intent => {
    await mount(intent);
    expect((screen.getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(true);
  });
  it('states alpha honestly, describes every choice in one line and collapses supporting details', async () => {
    const { container } = await mount();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Identity and authority for AI agents.');
    expect(screen.getByText(/This is an alpha, not self-serve sign-up/)).toBeDefined();
    for (const choice of ALPHA_CHOICES) expect(screen.getByText(choice.description)).toBeDefined();
    expect(container.querySelector('details')?.open).toBe(false);
    expect(screen.queryByText('Create account')).toBeNull();
    expect(metadata.description).toContain('trust layer for AI agents');
    expect(metadata.alternates).toEqual({ canonical: '/alpha' });
  });
  it('enforces browser field limits and hides the bot guard from keyboard and accessibility navigation', async () => {
    await mount();
    for (const [label, max] of [['Name', 120], ['Work email', 254], ['Company', 200], ['What will your agents do for people?', 1000]] as const) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      expect(input.maxLength).toBe(max); expect(input.required).toBe(true);
    }
    expect((screen.getByLabelText('Work email') as HTMLInputElement).type).toBe('email');
    expect(screen.getByLabelText('Leave this empty').tabIndex).toBe(-1);
    expect(screen.getByLabelText('Leave this empty').parentElement?.getAttribute('aria-hidden')).toBe('true');
  });
  it('allows changing the preselected intent', async () => {
    await mount('demo');
    fireEvent.click(screen.getByRole('radio', { name: /Integrator/ }));
    expect((screen.getByRole('radio', { name: /Integrator/ }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole('radio', { name: /Book a demo/ }) as HTMLInputElement).checked).toBe(false);
  });
  it.each([429, 503, 'network'])('shows a safe retry error for %s and retains the form', async status => {
    const send = vi.fn();
    if (status === 'network') send.mockRejectedValue(new Error('private exception'));
    else send.mockResolvedValue(new Response('private error', { status }));
    vi.stubGlobal('fetch', send);
    await mount(); fill();
    fireEvent.click(screen.getByRole('button', { name: 'Send request' }));
    const error = await screen.findByRole('alert');
    expect(error.textContent).not.toContain('private');
    expect(error.textContent).toContain(status === 429 ? 'Too many' : 'Could not save');
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Example Person');
    expect((screen.getByRole('button', { name: 'Send request' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('disables duplicate sends while a request is pending', async () => {
    let finish!: (response: Response) => void;
    const send = vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', send);
    const { container } = await mount(); fill();
    fireEvent.submit(container.querySelector('form')!);
    fireEvent.submit(container.querySelector('form')!);
    expect(send).toHaveBeenCalledOnce();
    expect((screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { finish(Response.json({}, { status: 201 })); });
    await screen.findByRole('status');
  });
  it('publishes the page in the sitemap, not main navigation, and documents both routes', async () => {
    expect(await sitemap()).toContainEqual(expect.objectContaining({ url: 'https://imajin.ai/alpha' }));
    const nav = readFileSync(resolve('apps/kernel/app/components/NavBarWithUnread.tsx'), 'utf8');
    expect(nav).not.toContain('/alpha');
    const publicSpec = parse(await spec().text());
    expect(publicSpec.paths['/api/alpha'].post.responses['429']).toBeDefined();
    const jin = parse(readFileSync(resolve('apps/kernel/api-spec/jin.yaml'), 'utf8'));
    expect(jin.paths['/jin/api/alpha-submissions'].get.responses['403']).toBeDefined();
  });
});
