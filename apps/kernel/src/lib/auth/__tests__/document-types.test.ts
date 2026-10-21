import { describe, expect, it } from 'vitest';
import { completedDocumentType, DOCUMENT_REQUEST_TYPES, DOCUMENT_TYPES, isDocumentType } from '../document-types';

describe('document vocabulary', () => {
  it('keeps SQL filters and card membership on a single source', () => {
    expect(DOCUMENT_TYPES).toEqual([...DOCUMENT_REQUEST_TYPES, 'agreement']);
    for (const type of DOCUMENT_TYPES) expect(isDocumentType(type)).toBe(true);
    expect(isDocumentType('vouch')).toBe(false);
    expect(isDocumentType('agreement.revoked')).toBe(false);
  });
  it.each(['actor', 'family', 'community', undefined])('preserves non-business document types (%s)', (scope) => {
    for (const type of DOCUMENT_REQUEST_TYPES) expect(completedDocumentType(type, scope)).toBe(type);
  });
  it('classifies only business-authored documents and amendments as agreements', () => {
    for (const type of DOCUMENT_REQUEST_TYPES) expect(completedDocumentType(type, 'business')).toBe('agreement');
  });
});
