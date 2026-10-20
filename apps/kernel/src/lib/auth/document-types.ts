/** Shared by document SQL filters and server-rendered document cards. */
export const DOCUMENT_REQUEST_TYPES = ['document.created', 'document.amended'] as const;
export const DOCUMENT_TYPES = [...DOCUMENT_REQUEST_TYPES, 'agreement'] as const;
const documentTypeSet = new Set<string>(DOCUMENT_TYPES);

export function isDocumentType(type: string): boolean {
  return documentTypeSet.has(type);
}

/** Only business-DID authors create org agreements; personal/group documents retain their type. */
export function completedDocumentType(type: string, issuerScope?: string): string {
  return issuerScope === 'business' ? 'agreement' : type;
}
