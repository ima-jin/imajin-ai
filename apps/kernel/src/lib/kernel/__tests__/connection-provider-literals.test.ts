import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

function violations(source: string, filename: string) {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const text = node.text;
      const encoded = text.startsWith('org-held-') || text.endsWith('-billing') || text.startsWith('app-upstream:');
      if (encoded) {
        const property = ts.isPropertyAssignment(node.parent) ? node.parent : undefined;
        const key = property?.name.getText(tree);
        // Vault namespaces remain stable; they are never registry providers.
        const vaultId = key === 'id' && property && ts.isObjectLiteralExpression(property.parent)
          && property.parent.properties.some(item => ts.isPropertyAssignment(item) && item.name.getText(tree) === 'provider');
        // Existing advisory-lock names and attestation context types are protocol identifiers, not providers.
        const protocol = text === 'org-held-connection:' || (key === 'contextType' && text === 'org-held-connection');
        if (!vaultId && !protocol) found.push(`${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name === '__tests__' || entry.name === 'node_modules') return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe('vendor-only provider strings', () => {
  it('rejects legacy literal and template encodings without treating imports, UI copy or vault fields as providers', () => {
    expect(violations("const row = {provider: 'org-held-anthropic'}", 'sample.ts')).toHaveLength(1);
    expect(violations("eq(connectors.provider, 'anthropic-billing')", 'sample.ts')).toHaveLength(1);
    expect(violations('const provider = `org-held-${vendor}`', 'sample.ts')).toHaveLength(1);
    expect(violations('const provider = `${vendor}-billing`', 'sample.ts')).toHaveLength(1);
    expect(violations('const provider = `app-upstream:${appDid}:${id}`', 'sample.ts')).toHaveLength(1);
    expect(violations("import './org-held-connection'; const copy = 'Renew org-held key'; const field = 'anthropic-billing-api-key';", 'sample.ts')).toEqual([]);
  });

  it('allows billing vault ids only when the vendor is explicit and never allows encoded provider values', () => {
    expect(violations("const options = {id: 'anthropic-billing', provider: 'anthropic', purpose: 'billing'}", 'sample.ts')).toEqual([]);
    expect(violations("const row = {id: 'connection', provider: 'anthropic-billing'}", 'sample.ts')).toHaveLength(1);
  });

  it('finds no provider encodings in kernel source or app routes outside tests', () => {
    const files = [...sourceFiles('apps/kernel/src'), ...sourceFiles('apps/kernel/app')];
    const found = files.flatMap(path => violations(readFileSync(path, 'utf8'), path)
      .map(message => `${relative('apps/kernel', path)}:${message}`));
    expect(found).toEqual([]);
  });
});
