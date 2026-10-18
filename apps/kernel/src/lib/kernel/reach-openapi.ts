import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { nodeUrl } from '@/src/lib/http/node-url';
import { publishedTopicLabels } from '@/src/lib/jin/front-door';

interface Operation {
  operationId: string;
  parameters?: { name: string; in: string }[];
  servers?: { url: string }[];
  [key: string]: unknown;
}

interface AuthSpec {
  openapi: string;
  info: { version: string };
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
}

/**
 * Project only the three live reach operations from the canonical auth spec.
 * Parse a fresh object so binding one recipient cannot mutate another's spec.
 * Never copy identity metadata or the full auth paths/components to the output.
 */
export function reachOpenApi(handle: string, principal: { id: string; metadata: unknown }) {
  const source = parse(readFileSync(join(process.cwd(), 'api-spec/auth.yaml'), 'utf-8')) as AuthSpec;
  const did = encodeURIComponent(principal.id);
  const bindings = [
    ['/.well-known/agent/{id}', 'get', `/.well-known/agent/${encodeURIComponent(handle)}`, 'id'],
    ['/api/agents/{did}/reach', 'post', `/auth/api/agents/${did}/reach`, 'did'],
    ['/api/agents/{did}/reach/{reachId}/status', 'post', `/auth/api/agents/${did}/reach/{reachId}/status`, 'did'],
  ] as const;
  const paths: Record<string, Record<string, Operation>> = {};
  for (const [path, method, boundPath, boundParameter] of bindings) {
    const operation = source.paths[path][method];
    operation.parameters = operation.parameters?.filter((param) => param.in !== 'path' || param.name !== boundParameter);
    // The projection uses the node root, not auth.yaml's /auth service base.
    delete operation.servers;
    paths[boundPath] = { [method]: operation };
  }
  return {
    openapi: source.openapi,
    info: {
      title: `Reach ${handle}`,
      version: source.info.version,
      description: 'Public card, combined ask/send, and requester-private status for this person. Unpublished topics answer boolean-only; private gate rules are never published.',
    },
    servers: [{ url: nodeUrl() }],
    paths,
    components: {
      securitySchemes: { reachBearer: source.components.securitySchemes.reachBearer },
      schemas: Object.fromEntries(Object.entries(source.components.schemas).filter(([name]) => name.startsWith('Reach'))),
    },
    'x-principal-did': principal.id,
    'x-published-topic-labels': publishedTopicLabels(principal.metadata),
  };
}
