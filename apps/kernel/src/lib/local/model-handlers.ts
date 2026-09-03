/**
 * `listModels`/`probeModel` for the `local` connector's model picker (#1957).
 *
 * Ollama and vLLM both serve the OpenAI-compatible `/v1/models` shape, the
 * same one `createOpenAiCompatibleModelHandlers` (`../kernel/openai-compatible-model-picker.ts`)
 * already speaks for xAI/OpenAI/Moonshot — but that helper calls bare
 * `fetch()`, which is fine for a hardcoded trusted provider host and wrong
 * for `local`'s owner-supplied `baseUrl`. This module is the same two
 * functions, routed through `egressSafeFetch` and the connector's pinned IP
 * instead.
 */
import type { ModelListResult, ModelProbeResult } from '@/src/lib/kernel/connector-model-picker-route';
import { egressSafeFetch } from '@/src/lib/kernel/egress-fetch';
import type { LocalCredentials } from './connector';

/** Generous for a LAN box that may be busy serving a completion; short enough not to hang the picker UI. */
const MODELS_TIMEOUT_MS = 15_000;

interface RawModel {
  id?: string;
}

function authHeaders(creds: LocalCredentials): Record<string, string> {
  return creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {};
}

/** Trim trailing slashes without a regex — avoids a backtracking-sensitive `/+$/` pattern for a one-line job. */
function trimTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

async function fetchModels(creds: LocalCredentials, path = ''): Promise<Response> {
  const baseUrl = trimTrailingSlashes(creds.baseUrl ?? '');
  return egressSafeFetch(
    `${baseUrl}/v1/models${path}`,
    { method: 'GET', headers: { ...authHeaders(creds), Accept: 'application/json' } },
    { connector: 'local', timeoutMs: MODELS_TIMEOUT_MS, pinnedIp: creds.pinnedIp },
  );
}

export async function listModels(creds: LocalCredentials): Promise<ModelListResult> {
  const res = await fetchModels(creds);
  if (!res.ok) {
    return { ok: false, status: res.status, statusText: res.statusText };
  }
  const raw = (await res.json()) as { data?: RawModel[] };
  const models = (raw.data ?? [])
    .filter((model): model is { id: string } => typeof model.id === 'string' && model.id.length > 0)
    .map((model) => ({ id: model.id, name: model.id }));
  return { ok: true, models };
}

/** Validation is a retrieve of that exact model id: a 404 means it is not servable by this endpoint. */
export async function probeModel(creds: LocalCredentials, modelId: string): Promise<ModelProbeResult> {
  const res = await fetchModels(creds, `/${encodeURIComponent(modelId)}`);
  if (res.ok) {
    return { ok: true };
  }
  if (res.status === 404) {
    return { ok: false, deprecated: true };
  }
  return { ok: false, deprecated: false, status: res.status, statusText: res.statusText };
}
