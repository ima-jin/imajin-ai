import { describe, it, expect, vi } from 'vitest';
import { validateConfirmedMetadata } from '../metadata-validation';
import { agrifortressVocabulary } from '../vocabulary/agrifortress';
import type { IntentVocabulary } from '../types';

describe('validateConfirmedMetadata', () => {
  describe('generic fallback (no vocab.validateMetadata implemented)', () => {
    const genericVocab: IntentVocabulary = {
      name: 'imajin',
      systemPrompt: '',
      resolveConsentTier: () => 'deliberate',
      resolve: vi.fn(),
    };

    it('accepts a plain JSON object', () => {
      const result = validateConfirmedMetadata(genericVocab, 'note.self', { text: 'hello' });
      expect(result).toEqual({ ok: true, metadata: { text: 'hello' } });
    });

    it('rejects a JSON array', () => {
      const result = validateConfirmedMetadata(genericVocab, 'note.self', ['a', 'b']);
      expect(result.ok).toBe(false);
    });

    it('rejects a null payload', () => {
      const result = validateConfirmedMetadata(genericVocab, 'note.self', null);
      expect(result.ok).toBe(false);
    });

    it('rejects a scalar payload', () => {
      const result = validateConfirmedMetadata(genericVocab, 'note.self', 'just a string');
      expect(result.ok).toBe(false);
    });
  });

  describe('vocab-specific hook delegation', () => {
    it('delegates to vocab.validateMetadata when implemented', () => {
      const vocab: IntentVocabulary = {
        name: 'custom',
        systemPrompt: '',
        resolveConsentTier: () => 'deliberate',
        resolve: vi.fn(),
        validateMetadata: vi.fn().mockReturnValue({ ok: true, metadata: { custom: true } }),
      };

      const result = validateConfirmedMetadata(vocab, 'custom.intent', { anything: 1 });

      expect(vocab.validateMetadata).toHaveBeenCalledWith('custom.intent', { anything: 1 });
      expect(result).toEqual({ ok: true, metadata: { custom: true } });
    });

    it('fails closed when vocab.validateMetadata throws', () => {
      const vocab: IntentVocabulary = {
        name: 'custom',
        systemPrompt: '',
        resolveConsentTier: () => 'deliberate',
        resolve: vi.fn(),
        validateMetadata: vi.fn().mockImplementation(() => {
          throw new Error('boom');
        }),
      };

      const result = validateConfirmedMetadata(vocab, 'custom.intent', {});

      expect(result.ok).toBe(false);
    });
  });

  describe('agrifortress vocabulary (concrete tenant example)', () => {
    it('accepts a fully edited delivery-shaped payload with lines[]', () => {
      const result = validateConfirmedMetadata(agrifortressVocabulary, 'delivery.noted', {
        recipient: 'did:imajin:farmer',
        lot: 'LOT-42',
        notes: 'corrected on card',
        lines: [{ product: 'seed', qty: 10 }],
      });
      expect(result.ok).toBe(true);
    });

    it('allows forward-compatible extra fields the vocabulary does not read yet', () => {
      const result = validateConfirmedMetadata(agrifortressVocabulary, 'supply.received', {
        product: 'maize',
        futureField: 'from a newer client',
      });
      expect(result.ok).toBe(true);
    });

    it('fails closed when qty is the wrong type', () => {
      const result = validateConfirmedMetadata(agrifortressVocabulary, 'supply.received', {
        qty: 'fifty',
      });
      expect(result).toEqual({ ok: false, error: 'metadata.qty must be a number' });
    });

    it('fails closed when a known string field has the wrong type', () => {
      const result = validateConfirmedMetadata(agrifortressVocabulary, 'supply.received', {
        recipient: 12345,
      });
      expect(result).toEqual({ ok: false, error: 'metadata.recipient must be a string' });
    });

    it('fails closed when lines is not an array', () => {
      const result = validateConfirmedMetadata(agrifortressVocabulary, 'delivery.noted', {
        lines: 'not an array',
      });
      expect(result).toEqual({ ok: false, error: 'metadata.lines must be an array' });
    });

    it('fails closed when a lines entry is not an object', () => {
      const result = validateConfirmedMetadata(agrifortressVocabulary, 'delivery.noted', {
        lines: ['not an object'],
      });
      expect(result).toEqual({ ok: false, error: 'metadata.lines entries must be objects' });
    });

    it('fails closed on a non-object payload', () => {
      const result = validateConfirmedMetadata(agrifortressVocabulary, 'supply.received', null);
      expect(result.ok).toBe(false);
    });
  });
});
