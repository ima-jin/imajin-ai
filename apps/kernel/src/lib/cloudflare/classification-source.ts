import ts from 'typescript';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export type EdgeClass = 'cacheable' | 'proxy-bypass' | 'proxy-unsafe' | 'never-proxied' | 'unclassified';
export interface ClassifiedRoute {
  path: string;
  method: string;
  class: EdgeClass;
  reason: string;
  source: string;
  /** Internal derivation evidence: only unresolved bounds/loaders may be overridden. */
  overrideAllowed?: boolean;
}
export interface HostManifest {
  hostname: string;
  routes: ClassifiedRoute[];
}
export const EDGE_DOCS = {
  sockets: 'https://developers.cloudflare.com/network/websockets/',
  read: 'https://developers.cloudflare.com/fundamentals/reference/connection-limits/',
  upload: 'https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/',
  streaming: 'https://developers.cloudflare.com/rules/configuration-rules/response-body-inspection/',
} as const;
export const READ_LIMIT_REASON = `Conservative 100s issue threshold (Cloudflare documents a 125s proxy read timeout): ${EDGE_DOCS.read}`;
export const UPLOAD_REASON = `Upload body must fit the plan envelope: Free/Pro 100MB, Business 200MB, Enterprise up to 5GB; multipart overhead also counts. ${EDGE_DOCS.upload}`;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const CLASSES = new Set<EdgeClass>(['cacheable', 'proxy-bypass', 'proxy-unsafe', 'never-proxied', 'unclassified']);

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

function exported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
}


export function scanKernelRoutes(kernel: string): ClassifiedRoute[] {
  const graph = new SourceGraph(kernel);
  const routes = filesBelow(join(kernel, 'app')).filter(path => /(?:^|[/\\])(?:route\.ts|page\.tsx)$/.test(path))
    .flatMap(filename => classifyRouteFile(kernel, filename, graph));
  if (!routes.length) routes.push({ path: '/', method: '*', class: 'unclassified', reason: 'No route/page source inventory is available', source: 'app/' });
  routes.push(...customServerRoutes(kernel, graph));
  return deduplicateRoutes(routes);
}

function specTraits(op: Record<string, unknown>): Pick<ClassifiedRoute, 'class' | 'reason'> {
  const encoded = JSON.stringify(op);
  if (typeof op['x-max-duration'] === 'number' && op['x-max-duration'] > 100) return { class: 'proxy-unsafe', reason: READ_LIMIT_REASON };
  if (op['x-websocket'] === true || op['x-long-lived'] === true || op['x-edge-websocket'] === true) {
    return { class: 'proxy-unsafe', reason: `WebSocket requires observed heartbeat/reconnect evidence. ${EDGE_DOCS.sockets}` };
  }
  if (encoded.includes('multipart/form-data') || encoded.includes('"format":"binary"')) return { class: 'proxy-unsafe', reason: UPLOAD_REASON };
  if (encoded.includes('text/event-stream')) return { class: 'proxy-unsafe', reason: `SSE requires verified heartbeat and buffering configuration; unknown lifetime stays DNS-only. ${EDGE_DOCS.streaming} ${READ_LIMIT_REASON}` };
  if (encoded.includes('"$ref"')) return { class: 'unclassified', reason: 'OpenAPI reference needs source or an explicit class and reason' };
  return { class: 'proxy-bypass', reason: 'All public or authenticated API operations bypass cache' };
}

function applySpecOverride(op: Record<string, unknown>, result: Pick<ClassifiedRoute, 'class' | 'reason'>): typeof result {
  if (op['x-edge-class'] === undefined) return result;
  const override = op['x-edge-class'] as EdgeClass;
  const reason = op['x-edge-reason'];
  if (!CLASSES.has(override) || typeof reason !== 'string' || !reason.trim() || override === 'cacheable') {
    return { class: 'unclassified', reason: 'Invalid x-edge-class override: API cannot be cacheable and a reason is required' };
  }
  const restrictive = override === 'proxy-unsafe' || override === 'never-proxied' || override === 'unclassified';
  return result.class === 'unclassified' || restrictive ? { class: override, reason } : result;
}

interface Facts {
  reasons: Set<string>;
  missing: Set<string>;
  calls: boolean;
  session: boolean;
}
function facts(): Facts { return { reasons: new Set(), missing: new Set(), calls: false, session: false }; }
function merge(target: Facts, other: Facts): void {
  other.reasons.forEach(value => target.reasons.add(value));
  other.missing.forEach(value => target.missing.add(value));
  target.calls ||= other.calls;
  target.session ||= other.session;
}

/** Do not mistake string-comparison vocabulary in tooling for real headers. */
function transportStrings(file: ts.SourceFile): Set<string> {
  const result = new Set<string>();
  walk(file, node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ['get', 'set', 'append', 'getHeader', 'setHeader', 'on', 'once'].includes(node.expression.name.text)) {
      for (const argument of node.arguments.slice(0, 2)) {
        if (ts.isStringLiteralLike(argument)) result.add(argument.text.toLowerCase());
      }
    }
    if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText(file).replaceAll('"', '').replaceAll("'", '').toLowerCase();
      if (key === 'content-type' && ts.isStringLiteralLike(node.initializer)) result.add(node.initializer.text.toLowerCase());
    }
  });
  return result;
}

/** Syntax, not comments or filename guesses, is the source of transport traits. */
export function inspectSource(text: string, filename = 'route.ts'): Facts {
  const file = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, filename.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const result = facts();
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (diagnostics.length) result.missing.add('Source contains syntax errors');
  const strings = transportStrings(file);
  const names = new Set<string>();
  const declared = new Set<string>();
  walk(file, node => {
    if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isParameter(node)
      || ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)
      || ts.isBindingElement(node) || ts.isClassDeclaration(node)) {
      if (node.name && ts.isIdentifier(node.name)) declared.add(node.name.text);
    }
  });
  const globals = new Set(['fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'clearImmediate',
    'require', 'String', 'Number', 'Boolean', 'BigInt', 'Symbol', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
    'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'atob', 'btoa', 'queueMicrotask',
    'structuredClone', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'alert', 'confirm']);
  walk(file, node => {
    if (ts.isIdentifier(node)) names.add(node.text);
    if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isAwaitExpression(node)) result.calls = true;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
      && !declared.has(node.expression.text) && !globals.has(node.expression.text)) {
      result.missing.add(`Unresolved executable helper: ${node.expression.text}`);
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'maxDuration') {
      if (!node.initializer || !ts.isNumericLiteral(node.initializer)) result.missing.add('Non-literal maxDuration requires an x-edge-class override with reason');
      else if (Number(node.initializer.text) > 100) result.reasons.add(READ_LIMIT_REASON);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'setTimeout') {
      const delay = node.arguments[1];
      if (delay && ts.isNumericLiteral(delay) && Number(delay.text) > 100_000) result.reasons.add(READ_LIMIT_REASON);
    }
  });
  // Provider support alone is not an origin liveness/reconnect implementation.
  const socketCompatible = names.has('ping') && names.has('setInterval')
    && strings.has('pong') && strings.has('close') && names.has('reconnect');
  if (!socketCompatible && (names.has('WebSocket') || names.has('WebSocketServer') || names.has('handleUpgrade') || strings.has('upgrade'))) {
    result.reasons.add(`WebSockets are supported on all Cloudflare plans, but observed heartbeat AND reconnect evidence is required before proxying; source alone is not evidence. ${EDGE_DOCS.sockets}`);
  }
  if (strings.has('text/event-stream') || names.has('ReadableStream') || names.has('TransformStream')) {
    result.reasons.add(`SSE/streaming connection needs verified heartbeat and buffering configuration. ${EDGE_DOCS.streaming} ${READ_LIMIT_REASON}`);
  }
  if (names.has('arrayBuffer') || strings.has('multipart/form-data') || (names.has('formData') && (names.has('Blob') || names.has('File')))) {
    result.reasons.add(`Body-consuming upload requires a verified complete request-size bound before proxying. ${UPLOAD_REASON}`);
  }
  if ((strings.has('x-forwarded-for') || strings.has('x-real-ip') || names.has('remoteAddress')) && !strings.has('cf-connecting-ip')) {
    result.reasons.add('Real client IP is consumed without proven CF-Connecting-IP handling');
  }
  if (names.has('fetch') || names.has('exec') || names.has('execFile') || names.has('spawn')) {
    result.reasons.add(`Outbound I/O or subprocess has no proven end-to-end deadline. ${READ_LIMIT_REASON}`);
  }
  if (strings.has('acme-tls/1')) result.reasons.add('TLS-ALPN certificate validation requires direct origin TLS; never proxy this host');
  result.session = ['cookies', 'headers', 'requireAuth', 'optionalAuth', 'getSession', 'useSession'].some(n => names.has(n))
    || ['authorization', 'cookie', 'set-cookie'].some(n => strings.has(n));
  return result;
}

function filesBelow(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    if (['.git', '.next', 'node_modules', '__tests__'].includes(entry.name)) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  }).sort();
}

function routePath(app: string, filename: string): string {
  const segments = relative(app, dirname(filename)).split(/[\\/]/).filter(s => s !== '.' && s && !s.startsWith('(') && !s.startsWith('@'));
  return '/' + segments.map(s => s.replace(/^\[\[\.\.\.(.+)\]\]$/, '{$1*}').replace(/^\[\.\.\.(.+)\]$/, '{$1*}').replace(/^\[(.+)\]$/, '{$1}')).join('/');
}

function resolveImport(specifier: string, filename: string, kernel: string): string | undefined {
  let base: string;
  if (specifier.startsWith('.')) base = resolve(dirname(filename), specifier);
  else if (specifier.startsWith('@/')) base = join(kernel, specifier.slice(2));
  else if (specifier.startsWith('@imajin/')) {
    const [pkg, ...parts] = specifier.slice('@imajin/'.length).split('/');
    base = join(kernel, '../../packages', pkg, 'src', parts.join('/') || 'index');
  } else return undefined;
  return [base, base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), `${base}.ts`, `${base}.tsx`, `${base}.js`, join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js')]
    .find(path => existsSync(path) && statSync(path).isFile());
}

/**
 * Follow local/workspace import graphs. Opaque third-party execution is kept
 * DNS-only rather than being mistaken for a harmless public API wrapper.
 * No source is executed while deriving a manifest.
 */
interface SourceEntry { file: ts.SourceFile; facts: Facts; imports: string[] }

function moduleSpecifier(node: ts.Node, result: Facts): string | undefined {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && !node.importClause?.isTypeOnly) return node.moduleSpecifier.text;
  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) return node.moduleSpecifier.text;
  if (!ts.isCallExpression(node)) return undefined;
  const loading = node.expression.kind === ts.SyntaxKind.ImportKeyword
    || (ts.isIdentifier(node.expression) && node.expression.text === 'require');
  if (!loading) return undefined;
  if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) return node.arguments[0].text;
  result.missing.add('Computed module loading cannot establish transport behavior');
  return undefined;
}

class SourceGraph {
  private readonly own = new Map<string, SourceEntry>();
  constructor(private readonly kernel: string) {}

  load(filename: string): SourceEntry {
    const cached = this.own.get(filename);
    if (cached) return cached;
    if (/\.(?:css|json|svg|png|jpe?g|webp|gif|ico|woff2?)$/.test(filename)) {
      const value = { file: ts.createSourceFile(filename, '', ts.ScriptTarget.Latest, true), facts: facts(), imports: [] as string[] };
      this.own.set(filename, value);
      return value;
    }
    const text = readFileSync(filename, 'utf8');
    const file = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
    const value = { file, facts: inspectSource(text, filename), imports: [] as string[] };
    this.own.set(filename, value);
    walk(file, node => {
      const specifier = moduleSpecifier(node, value.facts);
      if (!specifier) return;
      const resolved = resolveImport(specifier, filename, this.kernel);
      if (resolved) value.imports.push(resolved);
      else if (specifier.startsWith('.') || specifier.startsWith('@/')) value.facts.missing.add(`Unresolved source import: ${specifier}`);
      else if (!specifier.startsWith('node:') && !['next/server', 'next/headers', 'next/navigation', 'react', 'react/jsx-runtime', 'typescript', 'ws'].includes(specifier)) {
        value.facts.reasons.add(`Opaque dependency ${specifier}: end-to-end transport/deadline cannot be proven; retain DNS-only`);
      }
    });
    return value;
  }
  inspect(filename: string, seen = new Set<string>()): Facts {
    if (seen.has(filename)) return facts();
    seen.add(filename);
    const result = facts();
    if (seen.size > 600) { result.missing.add('Source dependency graph exceeds inspection bound'); return result; }
    const entry = this.load(filename);
    merge(result, entry.facts);
    entry.imports.forEach(path => merge(result, this.inspect(path, seen)));
    return result;
  }
}

function variableMethods(node: ts.VariableDeclaration, names: Set<string>, result: Facts): string[] {
  if (ts.isObjectBindingPattern(node.name)) {
    return node.name.elements.flatMap(element => ts.isIdentifier(element.name) && METHODS.has(element.name.text) ? [element.name.text] : []);
  }
  if (!ts.isIdentifier(node.name) || !METHODS.has(node.name.text)) return [];
  const value = node.initializer;
  const valid = value && (ts.isFunctionExpression(value) || ts.isArrowFunction(value) || ts.isCallExpression(value)
    || ts.isPropertyAccessExpression(value) || (ts.isIdentifier(value) && names.has(value.text)));
  if (!valid) result.missing.add(`Handler ${node.name.text} has no resolvable implementation`);
  return [node.name.text];
}

function exportedMethods(entry: SourceEntry): Set<string> {
  const names = new Set<string>();
  walk(entry.file, node => {
    if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)
      || ts.isFunctionDeclaration(node) || ts.isVariableDeclaration(node)) {
      if (node.name && ts.isIdentifier(node.name)) names.add(node.name.text);
    }
  });
  const methods = new Set<string>();
  for (const node of entry.file.statements) {
    if (ts.isFunctionDeclaration(node) && exported(node) && node.name && METHODS.has(node.name.text)) {
      methods.add(node.name.text);
      if (!node.body) entry.facts.missing.add(`Handler ${node.name.text} has no implementation body`);
    }
    if (ts.isVariableStatement(node) && exported(node)) {
      node.declarationList.declarations.flatMap(declaration => variableMethods(declaration, names, entry.facts)).forEach(method => methods.add(method));
    }
    if (ts.isExportDeclaration(node)) addReexportMethods(node, names, methods, entry.facts);
  }
  return methods;
}

function addReexportMethods(node: ts.ExportDeclaration, names: Set<string>, methods: Set<string>, result: Facts): void {
  if (!node.exportClause || !ts.isNamedExports(node.exportClause)) return;
  for (const element of node.exportClause.elements) {
    if (!METHODS.has(element.name.text)) continue;
    methods.add(element.name.text);
    if (!node.moduleSpecifier && !names.has((element.propertyName ?? element.name).text)) result.missing.add(`Unresolved handler export: ${element.name.text}`);
  }
}

function classifyTraits(traits: Facts, entry: SourceEntry, page: boolean): Pick<ClassifiedRoute, 'class' | 'reason'> {
  if (traits.missing.size) return { class: 'unclassified', reason: [...traits.missing].sort().join('; ') };
  if ([...traits.reasons].some(reason => reason.startsWith('TLS-ALPN'))) return { class: 'never-proxied', reason: [...traits.reasons].sort().join('; ') };
  if (traits.reasons.size) return { class: 'proxy-unsafe', reason: [...traits.reasons].sort().join('; ') };
  if (!page) return { class: 'proxy-bypass', reason: 'All API operations bypass cache, including unauthenticated/public APIs' };
  if (traits.calls || traits.session || entry.imports.length) return { class: 'proxy-bypass', reason: 'Page may inherit session/layout/client state; bypass cache' };
  return { class: 'cacheable', reason: 'Literal public page without session or executable dependencies' };
}


function inheritedTraits(app: string, filename: string, graph: SourceGraph): Facts {
  const result = graph.inspect(filename);
  if (!filename.endsWith('page.tsx')) return result;
  for (let directory = dirname(filename); directory.startsWith(app); directory = dirname(directory)) {
    for (const name of ['layout.tsx', 'layout.ts', 'template.tsx', 'template.ts']) {
      const inherited = join(directory, name);
      if (existsSync(inherited)) merge(result, graph.inspect(inherited));
    }
  }
  return result;
}

function classifyRouteFile(kernel: string, filename: string, graph: SourceGraph): ClassifiedRoute[] {
  const app = join(kernel, 'app');
  const entry = graph.load(filename);
  const methods = exportedMethods(entry);
  const page = filename.endsWith('page.tsx');
  if (page) methods.add('GET');
  if (!methods.size) return [{ path: routePath(app, filename), method: '*', class: 'unclassified', reason: 'No statically enumerable HTTP exports', source: relative(kernel, filename) }];
  const traits = inheritedTraits(app, filename, graph);
  const result = classifyTraits(traits, entry, page);
  const overrideAllowed = result.class === 'unclassified' && !traits.reasons.size
    && [...traits.missing].every(reason => reason.startsWith('Non-literal maxDuration') || reason.startsWith('Computed module loading'));
  return [...methods].sort().map(method => ({ path: routePath(app, filename), method, ...result,
    ...(overrideAllowed ? { overrideAllowed: true } : {}), source: relative(kernel, filename) }));
}

function upgradePaths(file: ts.SourceFile): string[] {
  const paths: string[] = [];
  walk(file, node => {
    if (!ts.isBinaryExpression(node)) return;
    for (const [left, right] of [[node.left, node.right], [node.right, node.left]]) {
      if (!ts.isStringLiteral(right) || !right.text.startsWith('/')) continue;
      const pathname = (ts.isIdentifier(left) && left.text === 'pathname')
        || (ts.isPropertyAccessExpression(left) && left.name.text === 'pathname');
      if (pathname) paths.push(right.text);
    }
  });
  return paths;
}

function customServerRoutes(kernel: string, graph: SourceGraph): ClassifiedRoute[] {
  const routes: ClassifiedRoute[] = [];
  // The custom server owns upgrade routes outside Next's app directory. Derive
  // literal pathname comparisons rather than maintaining a socket path list.
  for (const filename of ['server.js', 'ws-server.js'].map(name => join(kernel, name)).filter(existsSync)) {
    const entry = graph.load(filename);
    const traits = graph.inspect(filename);
    if (!traits.reasons.size && !traits.missing.size) continue;
    routes.push(...upgradePaths(entry.file).map(path => ({ path, method: 'UPGRADE',
      class: traits.missing.size ? 'unclassified' as const : 'proxy-unsafe' as const,
      reason: [...traits.missing, ...traits.reasons].sort().join('; '), source: relative(kernel, filename) })));
  }
  for (const filename of filesBelow(join(kernel, 'public'))) {
    routes.push({ path: '/' + relative(join(kernel, 'public'), filename).replaceAll('\\', '/'), method: 'GET', class: 'cacheable',
      reason: 'Public static asset; cache eligibility still excludes authenticated/cookie requests', source: relative(kernel, filename) });
  }
  return deduplicateRoutes(routes);
}

/** Local references only: external $refs are never fetched from a document. */
function resolveSpecReferences(value: unknown, document: object, seen = new Set<string>(), depth = 0): unknown {
  if (depth > 40 || !value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => resolveSpecReferences(item, document, seen, depth + 1));
  const object = value as Record<string, unknown>;
  if (typeof object.$ref === 'string') {
    if (!object.$ref.startsWith('#/') || seen.has(object.$ref)) return value;
    let target: unknown = document;
    for (const segment of object.$ref.slice(2).split('/')) {
      if (!target || typeof target !== 'object') return value;
      target = (target as Record<string, unknown>)[segment.replaceAll('~1', '/').replaceAll('~0', '~')];
    }
    if (target === undefined) return value;
    return resolveSpecReferences(target, document, new Set([...seen, object.$ref]), depth + 1);
  }
  return Object.fromEntries(Object.entries(object).map(([key, item]) => [key, resolveSpecReferences(item, document, seen, depth + 1)]));
}

export function deduplicateRoutes(routes: ClassifiedRoute[]): ClassifiedRoute[] {
  const rank: Record<EdgeClass, number> = { cacheable: 0, 'proxy-bypass': 1, 'proxy-unsafe': 2, 'never-proxied': 3, unclassified: 4 };
  const grouped = new Map<string, ClassifiedRoute>();
  for (const route of routes) {
    const key = `${route.path}\0${route.method}`;
    const before = grouped.get(key);
    if (!before || rank[route.class] > rank[before.class]
      || (rank[route.class] === rank[before.class] && `${route.source}\0${route.reason}` < `${before.source}\0${before.reason}`)) grouped.set(key, route);
  }
  return [...grouped.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

/** OpenAPI overrides resolve ambiguity only; they cannot hide a proven hazard. */
export function classifySpec(spec: unknown, source: string, prefix = ''): ClassifiedRoute[] {
  if (!spec || typeof spec !== 'object' || !('paths' in spec) || !spec.paths || typeof spec.paths !== 'object') {
    return [{ path: prefix || '/', method: '*', class: 'unclassified', reason: 'Missing/invalid OpenAPI paths', source }];
  }
  const routes: ClassifiedRoute[] = [];
  for (const [path, rawItem] of Object.entries(spec.paths)) {
    const item = resolveSpecReferences(rawItem, spec);
    if (!item || typeof item !== 'object' || '$ref' in item || !Object.keys(item).some(method => METHODS.has(method.toUpperCase()))) {
      routes.push({ path: prefix + path, method: '*', class: 'unclassified', reason: 'Unresolved OpenAPI path item or no enumerable operations', source });
      continue;
    }
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.has(method.toUpperCase())) continue;
      if (!operation || typeof operation !== 'object') {
        routes.push({ path: prefix + path, method: method.toUpperCase(), class: 'unclassified', reason: 'Unresolved OpenAPI operation', source });
        continue;
      }
      const op = resolveSpecReferences(operation, spec) as Record<string, unknown>;
      const result = applySpecOverride(op, specTraits(op));
      routes.push({ path: prefix + path, method: method.toUpperCase(), ...result, source });
    }
  }
  return deduplicateRoutes(routes);
}

export interface EdgeSpecDocument { document: unknown; source: string; prefix: string }

/** Server paths are topology; no server or external reference is fetched here. */
export function specRoutePrefix(document: unknown, fallback = ''): string {
  const server = (document as { servers?: { url?: string }[] } | null)?.servers?.[0]?.url;
  return server ? new URL(server, 'https://spec.invalid').pathname.replace(/\/$/, '') : fallback;
}

function explicitOverrides(spec: EdgeSpecDocument): Map<string, ClassifiedRoute> {
  const overrides = new Map<string, ClassifiedRoute>();
  const paths = (spec.document as { paths?: Record<string, unknown> } | null)?.paths ?? {};
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue;
    for (const [method, value] of Object.entries(item)) {
      if (!METHODS.has(method.toUpperCase()) || !value || typeof value !== 'object') continue;
      const op = value as Record<string, unknown>;
      if (op['x-edge-class'] === undefined) continue;
      const classified = classifySpec({ paths: { [path]: { [method]: op } } }, spec.source, spec.prefix)[0];
      if (classified && classified.class !== 'unclassified') overrides.set(`${method.toUpperCase()} ${spec.prefix}${path}`, classified);
    }
  }
  return overrides;
}

/** Only operation-level explicit overrides resolve source ambiguity, never hazards. */
export function mergeSourceAndSpecs(source: ClassifiedRoute[], specs: EdgeSpecDocument[]): ClassifiedRoute[] {
  const overrides = new Map(specs.flatMap(spec => [...explicitOverrides(spec)]));
  const resolved = source.map(route => {
    const override = route.overrideAllowed ? overrides.get(`${route.method} ${route.path}`) : undefined;
    return override ? { ...override, reason: `Explicit OpenAPI ambiguity override: ${override.reason}` } : route;
  });
  return deduplicateRoutes([...resolved, ...specs.flatMap(spec => classifySpec(spec.document, spec.source, spec.prefix))]);
}
