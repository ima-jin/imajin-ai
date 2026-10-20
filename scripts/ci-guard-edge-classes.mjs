#!/usr/bin/env node
import { createRequire, Module } from 'node:module';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Run the exact runtime classifier, not a permissive regex approximation. */
export function loadClassifier(repository = root) {
  const filename = resolve(repository, 'apps/kernel/src/lib/cloudflare/classification-source.ts');
  const require = createRequire(resolve(repository, 'apps/kernel/package.json'));
  const ts = require('typescript');
  const output = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: filename, reportDiagnostics: true,
  });
  const errors = output.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: name => name, getCurrentDirectory: () => repository, getNewLine: () => '\n',
  }));
  // A distinct virtual filename avoids merging CJS byte offsets with the
  // original TS module's V8 coverage when the guard is exercised by Vitest.
  const compiledFilename = `${filename}.guard.cjs`;
  const module = new Module(compiledFilename);
  module.filename = compiledFilename;
  module.paths = Module._nodeModulePaths(dirname(filename));
  module._compile(output.outputText, compiledFilename);
  return module.exports;
}

export function checkEdgeClasses(kernel = resolve(root, 'apps/kernel'), { proxied = false } = {}) {
  const { scanKernelRoutes, mergeSourceAndSpecs, specRoutePrefix } = loadClassifier();
  const specDir = resolve(kernel, 'api-spec');
  const specs = existsSync(specDir) ? readdirSync(specDir).filter(name => name.endsWith('.yaml')).map(name => {
    let document;
    try { document = parseYaml(readFileSync(resolve(specDir, name), 'utf8')); }
    catch { document = null; }
    return { document, source: `api-spec/${name}`, prefix: specRoutePrefix(document, `/${name.slice(0, -5)}`) };
  }) : [];
  const routes = mergeSourceAndSpecs(scanKernelRoutes(kernel), specs);
  const failures = routes.filter(route => route.class === 'unclassified' || !route.reason.trim()
    || (proxied && ['proxy-unsafe', 'never-proxied'].includes(route.class)));
  return { routes, failures };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { routes, failures } = checkEdgeClasses(process.argv[2] ? resolve(process.argv[2]) : undefined);
  for (const route of failures) console.error(`${route.source}: ${route.method} ${route.path}: ${route.reason}. Fix source evidence or set x-edge-class with x-edge-reason on the matching OpenAPI operation; unsafe hosts must stay DNS-only or be carved out.`);
  console.log(`Edge classification: ${routes.length} derived operations/assets, ${failures.length} unresolved`);
  process.exitCode = failures.length ? 1 : 0;
}
