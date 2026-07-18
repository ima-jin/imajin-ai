import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before any imports so vi.mock factories can reference them
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => ({
  optionalAuth: vi.fn(),
  rateLimit: vi.fn(),
  getClientIP: vi.fn(),
  corsHeaders: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  randomBytes: vi.fn(),
  tmpdir: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({ optionalAuth: mocks.optionalAuth }));

vi.mock('@imajin/config', () => ({
  rateLimit: mocks.rateLimit,
  getClientIP: mocks.getClientIP,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: mocks.corsHeaders,
  corsOptions: vi.fn(() => new Response(null, { status: 204 })),
}));

// Pass-through: invoke the handler directly with a minimal log stub.
vi.mock('@imajin/logger', () => ({
  withLogger:
    (_service: string, handler: Function) =>
    (req: Request) =>
      handler(req, {
        log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
        correlationId: 'test-cor',
      }),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: mocks.writeFile,
  unlink: mocks.unlink,
}));

vi.mock('node:crypto', () => ({ randomBytes: mocks.randomBytes }));

vi.mock('node:os', () => ({ tmpdir: mocks.tmpdir }));

import { POST } from '../route';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const GPU_NODE_URL = 'https://gpu.example.com';
const CORS = { 'Access-Control-Allow-Origin': '*' };

function gpuOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function gpuError(status = 500): Response {
  return new Response('GPU error', { status });
}

function makeJsonRequest(body: unknown): Request {
  return new Request('https://kernel.example.com/media/api/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeFileRequest(opts: { fileName?: string; content?: string; language?: string } = {}): Request {
  const { fileName = 'audio.webm', content = 'audio-bytes', language } = opts;
  const formData = new FormData();
  formData.append('file', new Blob([content], { type: 'audio/webm' }), fileName);
  if (language) formData.append('language', language);
  return new Request('https://kernel.example.com/media/api/transcribe', {
    method: 'POST',
    body: formData,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('POST /media/api/transcribe', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    process.env.GPU_NODE_URL = GPU_NODE_URL;
    delete process.env.GPU_AUTH_TOKEN;

    mocks.optionalAuth.mockResolvedValue(null);
    mocks.rateLimit.mockReturnValue({ limited: false, retryAfter: 0 });
    mocks.getClientIP.mockReturnValue('127.0.0.1');
    mocks.corsHeaders.mockReturnValue(CORS);
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.unlink.mockResolvedValue(undefined);
    mocks.randomBytes.mockReturnValue(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x12, 0x34, 0x56, 0x78]));
    mocks.tmpdir.mockReturnValue('/tmp');

    vi.stubGlobal('fetch', mocks.fetch);
  });

  // -------------------------------------------------------------------------
  // Infrastructure guards
  // -------------------------------------------------------------------------
  describe('infrastructure guards', () => {
    it('returns 503 when GPU_NODE_URL is not set', async () => {
      delete process.env.GPU_NODE_URL;
      const res = await POST(makeJsonRequest({ url: 'https://example.com/v.mp4' }) as any);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining('unavailable') });
    });

    it('returns 429 when rate limit is exceeded', async () => {
      mocks.rateLimit.mockReturnValue({ limited: true, retryAfter: 3600 });
      const res = await POST(makeJsonRequest({ url: 'https://example.com/v.mp4' }) as any);
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ error: expect.stringContaining('Rate limit') });
    });
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------
  describe('input validation', () => {
    it('returns 400 for multipart request with no file field', async () => {
      const formData = new FormData();
      const req = new Request('https://kernel.example.com/media/api/transcribe', {
        method: 'POST',
        body: formData,
      });
      const res = await POST(req as any);
      expect(res.status).toBe(400);
    });

    it('returns 400 for JSON body with no url field', async () => {
      const res = await POST(makeJsonRequest({ language: 'en' }) as any);
      expect(res.status).toBe(400);
    });

    it('returns 400 for JSON body with empty url string', async () => {
      const res = await POST(makeJsonRequest({ url: '' }) as any);
      expect(res.status).toBe(400);
    });

    it('returns 400 for JSON body with invalid URL', async () => {
      const res = await POST(makeJsonRequest({ url: 'not-a-url' }) as any);
      expect(res.status).toBe(400);
    });

    it('returns 400 for non-https URL (SSRF guard — http)', async () => {
      const res = await POST(makeJsonRequest({ url: 'http://internal.service/secret' }) as any);
      expect(res.status).toBe(400);
    });

    it('returns 400 for non-https URL (SSRF guard — file protocol)', async () => {
      const res = await POST(makeJsonRequest({ url: 'file:///etc/passwd' }) as any);
      expect(res.status).toBe(400);
    });

    it('accepts content-type with charset suffix (application/json; charset=utf-8)', async () => {
      mocks.fetch.mockResolvedValue(gpuOk({ text: 'hi', segments: [] }));
      const req = new Request('https://kernel.example.com/media/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ url: 'https://example.com/v.mp4' }),
      });
      const res = await POST(req as any);
      expect(res.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // URL transcription path
  // -------------------------------------------------------------------------
  describe('URL path → stream2text', () => {
    it('relays to the stream2text endpoint and returns the GPU result', async () => {
      const transcript = { text: 'Hello world', segments: [{ start: 0, end: 1, text: 'Hello world' }] };
      mocks.fetch.mockResolvedValue(gpuOk(transcript));

      const res = await POST(makeJsonRequest({ url: 'https://example.com/video.mp4', language: 'en' }) as any);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(transcript);

      expect(mocks.fetch).toHaveBeenCalledOnce();
      const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${GPU_NODE_URL}/api/stream2text/transcribe`);
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      expect(JSON.parse(init.body as string)).toEqual({ url: 'https://example.com/video.mp4', language: 'en' });
    });

    it('returns 502 when the GPU node responds with a non-ok status', async () => {
      mocks.fetch.mockResolvedValue(gpuError());
      const res = await POST(makeJsonRequest({ url: 'https://example.com/video.mp4' }) as any);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: 'Transcription failed' });
    });

    it('includes Authorization header when GPU_AUTH_TOKEN is set', async () => {
      process.env.GPU_AUTH_TOKEN = 'secret-token';
      mocks.fetch.mockResolvedValue(gpuOk({ text: 'hi' }));

      await POST(makeJsonRequest({ url: 'https://example.com/video.mp4' }) as any);

      const headers = mocks.fetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer secret-token');
    });

    it('omits Authorization header when GPU_AUTH_TOKEN is not set', async () => {
      mocks.fetch.mockResolvedValue(gpuOk({ text: 'hi' }));

      await POST(makeJsonRequest({ url: 'https://example.com/video.mp4' }) as any);

      const headers = mocks.fetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers).not.toHaveProperty('Authorization');
    });

    it('does not write any tmp file on the URL path', async () => {
      mocks.fetch.mockResolvedValue(gpuOk({ text: 'hi' }));
      await POST(makeJsonRequest({ url: 'https://example.com/video.mp4' }) as any);
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // File transcription path
  // -------------------------------------------------------------------------
  describe('file path → whisper', () => {
    it('writes tmp file, calls whisper endpoint, and returns GPU result', async () => {
      const transcript = { text: 'Hello', segments: [] };
      mocks.fetch.mockResolvedValue(gpuOk(transcript));

      const res = await POST(makeFileRequest() as any);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(transcript);
      expect(mocks.writeFile).toHaveBeenCalledOnce();
      const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${GPU_NODE_URL}/api/whisper/transcribe`);
      expect(init.method).toBe('POST');
    });

    it('returns 502 when the GPU node responds with a non-ok status', async () => {
      mocks.fetch.mockResolvedValue(gpuError());
      const res = await POST(makeFileRequest() as any);
      expect(res.status).toBe(502);
      expect(await res.json()).toMatchObject({ error: 'Transcription failed' });
    });

    it('returns 503 and still unlinks the tmp file when fetch throws', async () => {
      mocks.fetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const res = await POST(makeFileRequest() as any);
      expect(res.status).toBe(503);
      expect(mocks.unlink).toHaveBeenCalledOnce();
    });

    it('always unlinks the tmp file after a successful transcription', async () => {
      mocks.fetch.mockResolvedValue(gpuOk({ text: 'hi' }));
      await POST(makeFileRequest() as any);
      expect(mocks.unlink).toHaveBeenCalledOnce();
    });

    it('always unlinks the tmp file after a GPU 502 error', async () => {
      mocks.fetch.mockResolvedValue(gpuError());
      await POST(makeFileRequest() as any);
      expect(mocks.unlink).toHaveBeenCalledOnce();
    });

    it('appends the language field to the GPU form when provided', async () => {
      mocks.fetch.mockResolvedValue(gpuOk({ text: 'hi' }));
      await POST(makeFileRequest({ language: 'fr' }) as any);

      const gpuForm = mocks.fetch.mock.calls[0][1].body as FormData;
      expect(gpuForm.get('language')).toBe('fr');
    });

    it('does not append a language field when language is absent', async () => {
      mocks.fetch.mockResolvedValue(gpuOk({ text: 'hi' }));
      await POST(makeFileRequest() as any);

      const gpuForm = mocks.fetch.mock.calls[0][1].body as FormData;
      expect(gpuForm.get('language')).toBeNull();
    });

    it('forwards callerDid from authenticated identity', async () => {
      mocks.optionalAuth.mockResolvedValue({ id: 'did:imajin:alice' });
      mocks.fetch.mockResolvedValue(gpuOk({ text: 'hi' }));
      await POST(makeFileRequest() as any);

      const headers = mocks.fetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['X-Caller-DID']).toBe('did:imajin:alice');
    });

    it('uses anonymous as callerDid when no identity is present', async () => {
      mocks.fetch.mockResolvedValue(gpuOk({ text: 'hi' }));
      await POST(makeFileRequest() as any);

      const headers = mocks.fetch.mock.calls[0][1].headers as Record<string, string>;
      expect(headers['X-Caller-DID']).toBe('anonymous');
    });
  });
});
