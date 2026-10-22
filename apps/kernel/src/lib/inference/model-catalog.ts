/** Shared connector-card picker discovery for model listing and resolution (#3027). */
import { createLogger } from '@imajin/logger';
import { listModels as listGeminiModels } from '@/src/lib/gemini/model-handlers';
import { listModels as listAnthropicModels } from '@/src/lib/anthropic/model-handlers';
import { listModels as listLocalModels } from '@/src/lib/local/model-handlers';
import { createOpenAiCompatibleModelHandlers } from '@/src/lib/kernel/openai-compatible-model-picker';
import { createOpenrouterModelHandlers } from '@/src/lib/openrouter/model-handlers';
import type { ModelListResult } from '@/src/lib/kernel/connector-model-picker-route';
import type { ResolvedBrain } from './brain';
import { forEachSequential } from '@/src/lib/async/sequential';

const log = createLogger('kernel:inference:model-catalog');

/** Credentials stay internal; the route returns only explicitly projected fields. */
export interface UsableModel extends ResolvedBrain {
  picked: boolean;
}

/** Called only after the grant-aware brain probe establishes a usable sealed card. */
export async function listBrainPickerModels(brain: ResolvedBrain): Promise<string[]> {
  const creds = { apiKey: brain.apiKey, baseUrl: brain.baseURL, pinnedIp: brain.pinnedIp };
  try {
    let result: ModelListResult;
    switch (brain.connector) {
      case 'gemini':
        result = await listGeminiModels(creds);
        break;
      case 'anthropic':
        result = await listAnthropicModels(creds);
        break;
      case 'local':
        result = await listLocalModels(creds);
        break;
      case 'openrouter':
        result = await createOpenrouterModelHandlers(brain.baseURL!).listModels(creds);
        break;
      default:
        result = await createOpenAiCompatibleModelHandlers(brain.baseURL!).listModels(creds);
    }
    // Preserve the picked model during upstream outages or retirement.
    if (result.ok) return [...new Set([brain.modelId, ...result.models.map((model) => model.id)])];
  } catch {
    // Provider exceptions can carry credentials. Never log or return their contents.
    log.warn({ connector: brain.connector }, 'model picker unavailable — retaining picked model only');
  }
  return [brain.modelId];
}

/**
 * One routing winner per id: exact picked matches win first, otherwise the
 * first picker advertising it wins. This mirrors resolveBrain's priority.
 */
export async function expandUsableModels(brains: readonly ResolvedBrain[]): Promise<UsableModel[]> {
  const picked = new Map<string, ResolvedBrain>();
  for (const brain of brains) {
    if (!picked.has(brain.modelId)) picked.set(brain.modelId, brain);
  }
  const models = new Map<string, UsableModel>();
  await forEachSequential(brains, async (brain) => {
    const pickerModels = await listBrainPickerModels(brain);
    for (const modelId of pickerModels) {
      const winner = picked.get(modelId) ?? brain;
      if (models.has(modelId)) continue;
      models.set(modelId, { ...winner, modelId, picked: winner.modelId === modelId });
    }
  });
  return [...models.values()];
}

/** Picked matches have already been checked before this catalog walk. */
export async function resolvePickerModel(
  brains: readonly ResolvedBrain[],
  modelId: string,
): Promise<ResolvedBrain | undefined> {
  for (const brain of brains) {
    if ((await listBrainPickerModels(brain)).includes(modelId)) return { ...brain, modelId };
  }
  return undefined;
}
