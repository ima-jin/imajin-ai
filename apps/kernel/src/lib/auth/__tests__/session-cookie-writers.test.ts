import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const kernel = resolve('apps/kernel');
const helper = 'src/lib/auth/session-cookie.ts';
const writers = [
  'app/auth/api/identity/present-chain/route.ts',
  'app/auth/api/login/mfa/route.ts',
  'app/auth/api/login/verify/route.ts',
  'app/auth/api/logout/route.ts',
  'app/auth/api/onboard/claim/route.ts',
  'app/auth/api/onboard/generate/route.ts',
  'app/auth/api/onboard/verify/route.ts',
  'app/auth/api/register/route.ts',
  'app/auth/api/session/route.ts',
  'app/connections/api/auth/logout/route.ts',
  'app/profile/api/auth/logout/route.ts',
  'src/lib/auth/onboard.ts',
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.next', '__tests__', 'public'].includes(entry.name)) return [];
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}

describe('kernel cookie writer audit (#1069)', () => {
  it('allows direct cookie mutations only for non-session x-acting-as and the shared helper', () => {
    const bypasses: string[] = [];
    const actualWriters: string[] = [];
    for (const path of sourceFiles(kernel)) {
      const name = relative(kernel, path);
      if (name === helper) continue;
      const content = readFileSync(path, 'utf8');
      const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
      let callsHelper = false;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const callee = node.expression.getText(source);
          if (callee === 'withSessionCookie') {
            callsHelper = true;
            // Finalization must be the return expression, after x-acting-as.
            expect(ts.isReturnStatement(node.parent), name).toBe(true);
          }
          if (/\.(?:set|delete)$/.test(callee) && /cookies|cookieStore/i.test(callee)) {
            const first = node.arguments[0];
            if (!first || !ts.isStringLiteral(first) || first.text !== 'x-acting-as') bypasses.push(name);
          }
          if (/headers\.(?:set|append)$/.test(callee) && node.arguments[0]?.getText(source).toLowerCase().includes('set-cookie')) {
            bypasses.push(name);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (callsHelper) actualWriters.push(name);
    }
    expect(bypasses).toEqual([]);
    expect(actualWriters.toSorted()).toEqual(writers.toSorted());
  });
});
