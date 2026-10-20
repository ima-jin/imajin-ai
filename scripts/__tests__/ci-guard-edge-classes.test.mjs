import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkEdgeClasses } from '../ci-guard-edge-classes.mjs';

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'edge-guard-'));
  for (const [name, text] of Object.entries(files)) {
    const filename = join(dir, name);
    mkdirSync(join(filename, '..'), { recursive: true });
    writeFileSync(filename, text);
  }
  return dir;
}

describe('edge class CI guard', () => {
  it.each([
    ['missing reexport', 'export { GET } from "./unknown";'],
    ['unknown socket helper', 'import { openSocket } from "./socket"; export const GET = openSocket;'],
    ['unknown upload helper', 'import { acceptUpload } from "./upload"; export const POST = acceptUpload;'],
    ['computed helper', 'const handler = import(process.env.HANDLER); export const GET = handler;'],
    ['empty route', 'const arbitrary = true;'],
    ['malformed handler', 'export const GET = 123;'],
    ['missing handler', 'export const GET = missing;'],
    ['unresolved handler factory', 'export const GET = missingFactory();'],
    ['syntax error', 'export async function POST( {'],
    ['unresolved duration', 'export const maxDuration = Number(process.env.DEADLINE); export function POST(){}'],
  ])('fails closed for %s', (_name, text) => {
    expect(checkEdgeClasses(fixture({ 'app/api/new/route.ts': text })).failures.length).toBeGreaterThan(0);
  });

  it('follows helper indirection and classifies proven risk as DNS-only', () => {
    const result = checkEdgeClasses(fixture({
      'app/api/new/route.ts': 'export { GET } from "../../../helper";',
      'helper.ts': 'export function GET(){return new Response(new ReadableStream())}',
    }));
    expect(result.failures).toEqual([]);
    expect(result.routes[0].class).toBe('proxy-unsafe');
    expect(result.routes[0].reason).toContain('stream');
  });

  it('passes the real repository without a manually maintained override manifest', () => {
    const result = checkEdgeClasses();
    expect(result.routes.length).toBeGreaterThan(1000);
    expect(result.failures).toEqual([]);
    expect(result.routes.some(route => route.path === '/ws' && route.class === 'proxy-unsafe')).toBe(true);
    expect(result.routes.some(route => route.path.startsWith('/.well-known/'))).toBe(true);
  }, 120_000);

  it.each([
    ['websocket', 'export function GET(){ return new WebSocket("wss://fixture.invalid"); }'],
    ['upload', 'export async function POST(request){ const file = await request.formData(); return file.arrayBuffer(); }'],
  ])('fails an implemented new %s route on a prospective proxied host', (_name, text) => {
    const kernel = fixture({ 'app/api/new/route.ts': text });
    const dnsOnly = checkEdgeClasses(kernel);
    expect(dnsOnly.routes[0].class).toBe('proxy-unsafe');
    expect(dnsOnly.failures).toEqual([]);
    const proxied = checkEdgeClasses(kernel, { proxied: true });
    expect(proxied.failures[0].source).toBe('app/api/new/route.ts');
  });

  it('checks ambiguous spec-only operations and resolves source ambiguity via OpenAPI, not comments', () => {
    const kernel = fixture({
      'app/api/new/route.ts': 'export const maxDuration = Number(process.env.DEADLINE); export function POST(){}',
      'api-spec/new.yaml': 'servers: [{url: /}]\npaths:\n  /api/new:\n    post:\n      x-edge-class: proxy-unsafe\n      x-edge-reason: Unbounded operator-configured request deadline\n',
    });
    expect(checkEdgeClasses(kernel).failures).toEqual([]);
    writeFileSync(join(kernel, 'api-spec/new.yaml'), 'paths:\n  /unknown:\n    get:\n      $ref: https://untrusted.invalid/operation\n');
    const result = checkEdgeClasses(kernel);
    expect(result.failures.some(route => route.source === 'api-spec/new.yaml')).toBe(true);
  });
});
