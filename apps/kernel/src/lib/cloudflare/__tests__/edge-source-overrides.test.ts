import { describe, expect, it } from 'vitest';
import { inspectSource, mergeSourceAndSpecs, specRoutePrefix, type ClassifiedRoute } from '../classification-source';

const ambiguous: ClassifiedRoute = {
  path: '/api/work', method: 'POST', class: 'unclassified', reason: 'Non-literal maxDuration',
  source: 'app/api/work/route.ts', overrideAllowed: true,
};
const spec = (op: unknown) => [{ document: { paths: { '/api/work': { post: op } } }, prefix: '', source: 'api-spec/work.yaml' }];

describe('shared source/spec ambiguity resolution', () => {
  it('resolves only an explicit, reasoned operation override', () => {
    expect(mergeSourceAndSpecs([ambiguous], spec({}))[0].class).toBe('unclassified');
    expect(mergeSourceAndSpecs([ambiguous], spec({ 'x-edge-class': 'proxy-unsafe', 'x-edge-reason': 'Unknown deadline; retain DNS-only' }))[0].class).toBe('proxy-unsafe');
    expect(mergeSourceAndSpecs([ambiguous], spec({ 'x-edge-class': 'proxy-bypass' }))[0].class).toBe('unclassified');
    expect(mergeSourceAndSpecs([ambiguous], spec({ 'x-edge-class': 'cacheable', 'x-edge-reason': 'public' }))[0].class).toBe('unclassified');
  });
  it('never lets an override hide known streaming or malformed implementation', () => {
    const bypass = spec({ 'x-edge-class': 'proxy-bypass', 'x-edge-reason': 'claim' });
    expect(mergeSourceAndSpecs([{ ...ambiguous, class: 'proxy-unsafe', overrideAllowed: false }], bypass)[0].class).toBe('proxy-unsafe');
    expect(mergeSourceAndSpecs([{ ...ambiguous, overrideAllowed: false }], bypass)[0].class).toBe('unclassified');
  });
  it('does not turn classifier vocabulary or comments into transport evidence', () => {
    const code = 'const words = new Set(["upgrade","text/event-stream","x-forwarded-for"]); words.has("upgrade"); // WebSocket';
    expect([...inspectSource(code).reasons]).toEqual([]);
    expect([...inspectSource('headers.set("Content-Type", "text/event-stream")').reasons].join(' ')).toContain('response-body-inspection');
    expect([...inspectSource('server.on("upgrade", handler)').reasons].join(' ')).toContain('supported on all');
    const compatible = 'const server = new WebSocketServer({}); function reconnect(){}; setInterval(()=>socket.ping(),30000); socket.on("pong",()=>{}); socket.on("close", reconnect);';
    expect([...inspectSource(compatible).reasons]).toEqual([]);
  });
  it('reads relative, absolute and absent server prefixes without fetching them', () => {
    expect(specRoutePrefix({ servers: [{ url: '/cloudflare' }] })).toBe('/cloudflare');
    expect(specRoutePrefix({ servers: [{ url: 'https://{node}.example.test/auth' }] })).toBe('/auth');
    expect(specRoutePrefix(null, '/fallback')).toBe('/fallback');
  });
});
