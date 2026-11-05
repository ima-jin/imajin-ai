import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ROUTE_BLOCK_THRESHOLD = 6;
export const CONSUMER_FILES = [
  'README.md',
  'apps/kernel/public/llms.txt',
  'apps/kernel/public/llms-full.txt',
  'apps/kernel/README.md',
  'docs/ops/DEPLOY-POSTURE.md',
  'docs/developer-guide.md',
  'docs/REGISTRATION.md',
  'migrations/BASELINE.md',
  'deploy/README.md',
  'migrations/OWNERSHIP.md',
  'packages/openclaw-infer-passthrough/README.md',
  'docs/ENVIRONMENTS.md',
  'docs/notify-operator-approvals-contract.md',
  'docs/warp-notification-chain.md',
  'deploy/infer-passthrough/README.md',
  'docs/npm-publishing.md',
  'docs/mjn-whitepaper.md',
  'docs/loops-rail-contract.md',
  'docs/security/node-key-roles-and-rotation.md',
  'docs/agents/nanoclaw-first-boot.md',
  'docs/DEVELOPER.md',
  'CLAUDE.md',
];

// Records are history by design. Exact paths only: a sibling consumer guide is
// not exempt just because it lives beside an RFC or an audit.
export const HISTORY_RECORDS = new Set([
  'apps/kernel/content/process-log.md',
  'apps/kernel/content/build-log.md',
  'docs/audits/dykil-entanglements.md',
  'docs/canon/rfcs/RFC-16-jin-workspace-agent.md',
  'docs/canon/rfcs/RFC-12-mjn-token-economics.md',
  'docs/canon/rfcs/RFC-39-verifiable-skills-invokable-agent.md',
  'docs/audits/dykil-primitive-mapping.md',
  'docs/canon/dfos-chain-strategy.md',
  'docs/canon/rfcs/INDEX.md',
  'docs/canon/verifiable-skills-invokable-agent.md',
]);

const DOC_EXTENSIONS = new Set(['.md', '.txt']);
const HISTORY_HEADING = /\bv\d+\.\d+\.\d+\b|\b(?:addendum|delta)\b/i;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const POLICY_CLASSES = ['**irreversible**', '**value-moving**', '**reversible**'];
const PATH_ROUTE = /^\/\S+(?:\s+[—–-]|\s*\||\s*$)/;

function routeLine(line) {
  // Delegation policy matrices classify mutations, not generated catalogues.
  // A wide table alone is not an exemption: require an explicit policy class.
  if (line.trim().startsWith('|') && line.split('|').filter(cell => cell.trim()).length > 3
    && POLICY_CLASSES.some(kind => line.includes(kind))) return false;
  const text = line.trim().replaceAll('`', '')
    .replaceAll(/^(?:[-*+]|\d+\.)\s+|\|\s*/g, '');
  const tokens = text.replaceAll(/[,|]/g, ' ').split(/\s+/);
  let index = 0;
  while (METHODS.has(tokens[index])) index += 1;
  const path = tokens[index] ?? '';
  return (index > 0 && (path.startsWith('/') || path.startsWith('https://') || path.startsWith('http://')))
    || PATH_ROUTE.test(text);
}

function advanceFence(fence, marker, line) {
  if (!fence) return marker;
  return marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker
    ? null : fence;
}

function headingAt(lines, index) {
  const atx = /^ {0,3}#{1,6}\s+(.+)/.exec(lines[index])?.[1];
  if (atx) return { text: atx, line: index + 1 };
  if (index > 0 && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index])) {
    return { text: lines[index - 1].trim(), line: index };
  }
  return { text: '', line: index + 1 };
}

/** Six consecutive route-shaped lines are an inventory, even inside a fence.
 * A single route in prose, an integration example, or a link to a spec passes.
 * Blank lines and prose break a run. Report its start once, not every suffix.
 */
export function scanDocument(source, file = 'README.md') {
  const hits = [];
  const lines = source.split(/\r?\n/);
  let routeCount = 0;
  let fence = null;
  for (const [index, line] of lines.entries()) {
    routeCount = routeLine(line) ? routeCount + 1 : 0;
    if (routeCount === ROUTE_BLOCK_THRESHOLD) {
      hits.push({ file, line: index + 2 - ROUTE_BLOCK_THRESHOLD, rule: 'route inventory' });
    }
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      fence = advanceFence(fence, marker, line);
      continue;
    }
    if (fence) continue;
    const heading = headingAt(lines, index);
    if (HISTORY_HEADING.test(heading.text)) {
      hits.push({ file, line: heading.line, rule: 'history heading' });
    }
  }
  return hits;
}

function collectDocs(root, dir = 'docs') {
  if (!existsSync(join(root, dir))) return [];
  const files = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const name = `${dir}/${entry.name}`;
    if (entry.isDirectory()) files.push(...collectDocs(root, name));
    else if (entry.isFile() && DOC_EXTENSIONS.has(extname(entry.name))) files.push(name);
  }
  return files;
}

export function scanRepo(root = ROOT) {
  const files = new Set([...CONSUMER_FILES, ...collectDocs(root)]);
  return [...files].sort((a, b) => a.localeCompare(b))
    .filter(file => !HISTORY_RECORDS.has(file) && existsSync(join(root, file)))
    .flatMap(file => scanDocument(readFileSync(join(root, file), 'utf8'), file));
}

export function main(root = process.env.CI_GUARD_WORKDIR ?? ROOT) {
  const hits = scanRepo(resolve(root));
  for (const hit of hits) console.error(`${hit.file}:${hit.line}: ${hit.rule}; rewrite concepts in place and link the service spec.`);
  console.log(hits.length
    ? `FAIL: ${hits.length} consumer-doc violations.`
    : 'PASS: consumer docs have no history headings or generated route blocks.');
  return hits.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`ci-guard-current-state-docs: ${error.message}`);
    process.exitCode = 1;
  }
}
