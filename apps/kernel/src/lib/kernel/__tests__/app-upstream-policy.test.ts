import { expect, it } from 'vitest';
import {
  assertDeclaredCall, parseUpstream, upstreamBinding, upstreamCallInput, upstreamConnectionInput,
  upstreamDeclarations, upstreamPermissions, UPSTREAM_READ_SCOPE, UPSTREAM_WRITE_SCOPE,
} from '../app-upstream-policy';
import { isServiceEligibleScope, scopeEntry } from '@imajin/auth/scope-vocabulary';

const input = () => ({ id: 'catalog', origin: 'https://api.example', paths: [{ path: '/items', methods: ['GET'] }] });
const call = () => ({ memberDid: 'did:imajin:fixture', upstreamId: 'catalog', path: '/items', method: 'GET' });
it('defaults injection shape, not writes, and never self-grants service scopes', () => {
  const target = parseUpstream(upstreamDeclarations, { upstreams: [input()] }).upstreams[0];
  expect(target).toMatchObject({ credentialHeader: 'Authorization', credentialPrefix: 'Bearer ' });
  expect(() => assertDeclaredCall(target, parseUpstream(upstreamCallInput, call()))).not.toThrow();
  for (const scope of [UPSTREAM_READ_SCOPE, UPSTREAM_WRITE_SCOPE]) {
    expect(scopeEntry(scope)?.connector).toBeNull();
    expect(isServiceEligibleScope(scope)).toBe(false);
  }
  expect(upstreamBinding('did:imajin:app', target)).not.toBe(upstreamBinding('did:imajin:other', target));
});
it.each([
  { id: '' }, { id: '../bad' }, { origin: 'http://api.example' }, { origin: 'not-url' },
  { origin: 'https://api.example/' }, { origin: 'https://user:pass@api.example' },
  { origin: 'https://api.example?x=1' }, { origin: 'https://api.example#x' },
  { credentialHeader: 'Host' }, { credentialHeader: 'Cookie' }, { credentialPrefix: '\r\ninjection' },
  { paths: [] }, { paths: [{ path: '/items', methods: [] }] },
  { paths: [{ path: '/items', methods: ['TRACE'] }] }, { unknown: true },
])('refuses invalid declaration %#', extra => {
  expect(() => parseUpstream(upstreamDeclarations, { upstreams: [{ ...input(), ...extra }] })).toThrow('Invalid upstream input');
});
it.each(['/../secret', '//evil.test', '/items?url=evil', '/items#fragment', '/%2fsecret', '/a\\b', '/items/./hidden', '', 'https://evil.test'])(
  'refuses noncanonical path %s in declaration and invocation', path => {
    expect(upstreamDeclarations.safeParse({ upstreams: [{ ...input(), paths: [{ path, methods: ['GET'] }] }] }).success).toBe(false);
    expect(upstreamCallInput.safeParse({ ...call(), path }).success).toBe(false);
  });
it('refuses duplicate IDs and oversized declaration sets', () => {
  expect(upstreamDeclarations.safeParse({ upstreams: [input(), input()] }).success).toBe(false);
  expect(upstreamDeclarations.safeParse({ upstreams: Array.from({ length: 17 }, (_, i) => ({ ...input(), id: `target-${i}` })) }).success).toBe(false);
  expect(upstreamDeclarations.safeParse({ upstreams: [{ ...input(), paths: Array.from({ length: 65 }, () => input().paths[0]) }] }).success).toBe(false);
});
it.each([
  { memberDid: 'invalid' }, { upstreamId: '' }, { method: 'get' }, { method: 'TRACE' },
  { body: 'read-body' }, { method: 'HEAD', body: '' }, { path: '/x'.repeat(1025) },
  { method: 'POST', body: 'x'.repeat(12001) }, { reason: 'free-text-is-not-a-reason-code' },
  { url: 'https://other.example' }, { headers: { Authorization: 'FAKE_NOT_VALID' } },
  { appDid: 'did:imajin:other' },
])('refuses invalid call %#', extra => {
  expect(upstreamCallInput.safeParse({ ...call(), ...extra }).success).toBe(false);
});
it.each([
  { secret: '' }, { secret: 'x'.repeat(4097) }, { secret: 'bad\nheader' },
  { appDid: 'invalid' }, { upstreamId: '' }, { orgContextDid: 'invalid' }, { unknown: true },
])('refuses invalid member connection %#', extra => {
  expect(upstreamConnectionInput.safeParse({
    appDid: 'did:imajin:app', upstreamId: 'catalog', origin: 'https://api.example', secret: 'FAKE_NOT_VALID', ...extra,
  }).success).toBe(false);
});

const approvedPaths = [
  { path: '/items', methods: ['GET', 'HEAD'] }, { path: '/me', methods: ['GET'] },
];
function boundTarget(paths = approvedPaths) {
  return parseUpstream(upstreamDeclarations, { upstreams: [{ ...input(), paths }] }).upstreams[0];
}
it.each([
  { paths: [{ path: '/other', methods: ['GET', 'HEAD'] }, approvedPaths[1]] },
  { paths: [{ path: '/items', methods: ['GET', 'HEAD', 'DELETE'] }, approvedPaths[1]] },
  { paths: [...approvedPaths, { path: '/other', methods: ['GET'] }] },
  { paths: [approvedPaths[0]] },
  { paths: [{ path: '/items', methods: ['GET'] }, approvedPaths[1]] },
])('invalidates path or method additions, changes and removals %#', ({ paths }) => {
  expect(upstreamBinding('did:imajin:app', boundTarget(paths)))
    .not.toBe(upstreamBinding('did:imajin:app', boundTarget()));
});
it('canonicalizes path/method ordering, repeated pairs and grouping without mutating declarations', () => {
  const original = boundTarget();
  const before = structuredClone(original);
  const reordered = boundTarget([
    approvedPaths[1], { path: '/items', methods: ['HEAD', 'GET'] },
  ]);
  const regrouped = boundTarget([
    { path: '/items', methods: ['HEAD', 'HEAD'] }, approvedPaths[1], { path: '/items', methods: ['GET'] },
  ]);
  expect(upstreamPermissions(original)).toEqual(['GET /items', 'GET /me', 'HEAD /items']);
  for (const equivalent of [original, reordered, regrouped]) {
    expect(upstreamBinding('did:imajin:app', equivalent)).toBe(upstreamBinding('did:imajin:app', original));
  }
  expect(original).toEqual(before);
});
