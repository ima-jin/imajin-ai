/**
 * `POST /usage/api/receipts/extract` — Qwen-assist draft (#1951 D4).
 *
 * LLM-extracts structured line items from an already-uploaded receipt
 * asset and returns them as an UNCONFIRMED draft. This module NEVER writes
 * to `usage.billed`, NEVER mints an attestation, and NEVER touches the
 * write path in `lib/usage/billed/receipt.ts` — the human confirms/edits
 * the draft and `POST /usage/api/receipts` (`confirmReceiptLines`) is the
 * only call that ever attests. "Never auto-attest" is enforced structurally
 * here: this function has no access to anything that writes.
 *
 * Uses the existing ML-node inference path (#1621 "brain" resolution),
 * narrowed to the `local` connector — the owner's own sealed Ollama/vLLM
 * endpoint (imajin-ml runs Qwen there). No new provider, no new env-var
 * scheme: `resolveBrain` + `getModel` are the same primitives
 * `resolvePresenceBrain` (`lib/inference/presence-brain.ts`) already uses.
 */
import { readFile } from 'node:fs/promises';
import { generateText } from 'ai';
import { getModel } from '@imajin/llm';
import { getActiveAsset } from '@/src/lib/media/queries';
import { resolveBrain, NoBrainSealedError, NoModelSelectedError } from '@/src/lib/inference/brain';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export interface ExtractReceiptInput {
  ownerDid: string;
  assetId: string;
}

export interface DraftReceiptLine {
  description: string;
  category: string | null;
  /** Decimal string, e.g. "19.99" — the model's raw guess, never a float. */
  amount: string;
  currency: string;
  date: string | null;
  vendor: string | null;
}

export interface ExtractReceiptDraft {
  status: 'unconfirmed';
  assetId: string;
  connector: string;
  modelId: string;
  lines: DraftReceiptLine[];
}

export type ExtractReceiptError =
  | { error: 'asset_not_found' }
  | { error: 'asset_not_owned' }
  | { error: 'unsupported_mime_type'; mimeType: string }
  | { error: 'no_local_brain'; cause: string }
  | { error: 'extraction_failed'; cause: string };

const ALLOWED_EXTRACT_MIME_PREFIX = 'image/';

const EXTRACTION_SYSTEM_PROMPT = `You are a receipt line-item extractor. Given a photo of a receipt, invoice, \
or statement, respond with ONLY a JSON array (no markdown fences, no prose) of line items. \
Each item must be an object with exactly these fields:
- "description": string, what was purchased/billed
- "category": string or null, a short cost category (e.g. "infra", "hardware")
- "amount": string, the line's decimal amount as it appears on the receipt (e.g. "19.99") — never a rounded float
- "currency": string, the 3-letter ISO 4217 currency code the receipt is denominated in
- "date": string or null, the transaction date in YYYY-MM-DD format if legible
- "vendor": string or null, the merchant/vendor name

This is a DRAFT for a human to review and correct — extract your best reading even if uncertain. \
Never invent line items that are not visibly present on the receipt.`;

const CODE_FENCE = '```';

/**
 * Strip a ```json ... ``` fence a model may add despite instructions not
 * to. Plain string slicing rather than a single combined regex: a pattern
 * like /^```(?:json)?\s*([\s\S]*?)\s*```$/ has overlapping quantifiers
 * (`\s*` next to a lazy `[\s\S]*?`) that Sonar flags as super-linear/
 * backtracking-prone (S8786) on adversarial input.
 */
function stripCodeFence(text: string): string {
  let trimmed = text.trim();
  if (!trimmed.startsWith(CODE_FENCE)) return trimmed;

  trimmed = trimmed.slice(CODE_FENCE.length);
  if (trimmed.toLowerCase().startsWith('json')) trimmed = trimmed.slice(4);
  trimmed = trimmed.trimStart();

  if (trimmed.endsWith(CODE_FENCE)) {
    trimmed = trimmed.slice(0, -CODE_FENCE.length).trimEnd();
  }
  return trimmed;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate + normalize one parsed candidate line, dropping fields that don't type-check rather than throwing. */
function toDraftLine(candidate: unknown): DraftReceiptLine | null {
  if (!isPlainObject(candidate)) return null;
  const { description, category, amount, currency, date, vendor } = candidate;
  if (typeof description !== 'string' || !description.trim()) return null;
  if (typeof amount !== 'string' || !amount.trim()) return null;
  if (typeof currency !== 'string' || !currency.trim()) return null;

  return {
    description: description.trim(),
    category: typeof category === 'string' && category.trim() ? category.trim() : null,
    amount: amount.trim(),
    currency: currency.trim().toUpperCase(),
    date: typeof date === 'string' && date.trim() ? date.trim() : null,
    vendor: typeof vendor === 'string' && vendor.trim() ? vendor.trim() : null,
  };
}

function parseDraftLines(rawText: string): DraftReceiptLine[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(rawText));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const lines = parsed.map(toDraftLine).filter((line): line is DraftReceiptLine => line !== null);
  return lines.length > 0 ? lines : null;
}

/**
 * Extract an unconfirmed draft of receipt line items from an uploaded
 * asset. Read-only against the write path: nothing here is ever persisted
 * or attested — the caller must POST the (possibly edited) result to
 * `POST /usage/api/receipts` to confirm it.
 */
export async function extractReceiptDraft(
  input: ExtractReceiptInput,
): Promise<ExtractReceiptDraft | ExtractReceiptError> {
  const asset = await getActiveAsset(input.assetId);
  if (!asset) return { error: 'asset_not_found' };
  if (asset.ownerDid !== input.ownerDid) return { error: 'asset_not_owned' };
  if (!asset.mimeType.startsWith(ALLOWED_EXTRACT_MIME_PREFIX)) {
    return { error: 'unsupported_mime_type', mimeType: asset.mimeType };
  }

  let brain;
  try {
    brain = await resolveBrain(input.ownerDid, { connectors: ['local'] });
  } catch (err) {
    if (err instanceof NoBrainSealedError || err instanceof NoModelSelectedError) {
      return { error: 'no_local_brain', cause: String(err) };
    }
    return { error: 'extraction_failed', cause: String(err) };
  }

  let imageBuffer: Buffer;
  try {
    imageBuffer = await readFile(asset.storagePath);
  } catch (err) {
    return { error: 'extraction_failed', cause: String(err) };
  }

  const model = getModel('openai', brain.modelId, {
    apiKey: brain.apiKey,
    ...(brain.baseURL === undefined ? {} : { baseURL: brain.baseURL }),
  });

  let resultText: string;
  try {
    const result = await generateText({
      model,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Extract the line items from this receipt.' },
            { type: 'image', image: imageBuffer, mimeType: asset.mimeType },
          ],
        },
      ],
    });
    resultText = result.text;
  } catch (err) {
    log.error({ err: String(err), assetId: input.assetId }, 'receipt extraction generateText failed');
    return { error: 'extraction_failed', cause: String(err) };
  }

  const lines = parseDraftLines(resultText);
  if (!lines) {
    return { error: 'extraction_failed', cause: 'model output was not a parseable line-item array' };
  }

  return {
    status: 'unconfirmed',
    assetId: input.assetId,
    connector: brain.connector,
    modelId: brain.modelId,
    lines,
  };
}
