import { z } from 'zod';
import { CloudflareError } from './schemas';

const BASE = 'https://api.cloudflare.com/client/v4';
const MAX_PAGES = 10;
const envelope = z.object({
  success: z.literal(true), result: z.unknown(),
  result_info: z.object({ total_pages: z.number().int().min(0).max(MAX_PAGES) }).optional(),
}).strip();

/** In-memory bearer only; callers must never serialize this object or provider errors. */
export class CloudflareClient {
  readonly #secret: string;
  constructor(secret: string, private readonly zoneId: string) { this.#secret = secret; }

  async request<T>(path: string, schema: z.ZodType<T>, method = 'GET', body?: unknown, allowMissing = false): Promise<T> {
    const parsed = schema.safeParse((await this.envelope(path, method, body, allowMissing)).result);
    if (!parsed.success) throw new CloudflareError(502, 'cloudflare_unavailable');
    return parsed.data;
  }

  private async envelope(path: string, method: string, body?: unknown, allowMissing = false) {
    if (path !== '' && !/^\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*(?:\?page=\d+&per_page=100)?$/.test(path)) {
      throw new CloudflareError(400, 'invalid_provider_path');
    }
    try {
      const response = await fetch(`${BASE}/zones/${this.zoneId}${path}`, {
        method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${this.#secret}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 404 && allowMissing && method === 'GET'
        && path === '/rulesets/phases/http_request_cache_settings/entrypoint') {
        await response.body?.cancel();
        return { success: true, result: null, result_info: undefined };
      }
      if (!response.ok || Number(response.headers.get('content-length')) > 2_000_000) throw new Error('Unavailable');
      const text = await boundedText(response);
      // A malicious/reflected provider field must not disclose the bearer even
      // when it occupies an otherwise allowlisted response field.
      if (text.length > 2_000_000 || !this.#secret || text.includes(this.#secret)) throw new Error('Unavailable');
      const parsed: unknown = JSON.parse(text);
      if (JSON.stringify(parsed).includes(this.#secret)) throw new Error('Unavailable');
      return envelope.parse(parsed);
    } catch {
      throw new CloudflareError(502, 'cloudflare_unavailable');
    }
  }

  async list<T>(path: string, schema: z.ZodType<T>): Promise<T[]> {
    const result: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const response = await this.envelope(`${path}?page=${page}&per_page=100`, 'GET');
      const records = z.array(schema).max(100).safeParse(response.result);
      if (!records.success) throw new CloudflareError(502, 'cloudflare_unavailable');
      result.push(...records.data);
      if (response.result_info ? page >= response.result_info.total_pages : records.data.length < 100) return result;
    }
    throw new CloudflareError(502, 'cloudflare_pagination_limit');
  }
}

async function boundedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Unavailable');
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2_000_000) { await reader.cancel(); throw new Error('Unavailable'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
