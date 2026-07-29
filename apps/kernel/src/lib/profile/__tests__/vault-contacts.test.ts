import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ─────────────────────────────────────────────────────────────────

const mockInsert = vi.fn();
const mockSelect = vi.fn();
const mockOnConflictDoUpdate = vi.fn();
const mockValues = vi.fn(() => ({ onConflictDoUpdate: mockOnConflictDoUpdate }));
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockLimit = vi.fn();

vi.mock('@/src/db', () => ({
  db: {
    insert: () => ({ values: mockValues }),
    select: () => ({ from: mockFrom }),
  },
  contactHashes: { did: 'did', emailHash: 'emailHash', phoneHash: 'phoneHash' },
  consentGrants: { id: 'id', subject: 'subject', purpose: 'purpose', status: 'status' },
}));

vi.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ eq: args }),
  and: (...args: unknown[]) => ({ and: args }),
}));

const mockSealAndStore = vi.fn();
const mockRotateAndStore = vi.fn();
const mockDeleteFromVault = vi.fn();
const mockVaultServiceGet = vi.fn();

vi.mock('@/src/lib/vault', () => ({
  sealAndStore: (...args: unknown[]) => mockSealAndStore(...args),
  rotateAndStore: (...args: unknown[]) => mockRotateAndStore(...args),
  deleteFromVault: (...args: unknown[]) => mockDeleteFromVault(...args),
  vaultService: { get: (...args: unknown[]) => mockVaultServiceGet(...args) },
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_test123`,
}));

import { hashContactValue, processEmailUpdate, processPhoneUpdate } from '../vault-contacts';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: db.select chain returns empty array
  mockLimit.mockResolvedValue([]);
  mockWhere.mockReturnValue({ limit: mockLimit });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockOnConflictDoUpdate.mockResolvedValue(undefined);
  mockInsert.mockReturnValue({ values: mockValues });
  mockSealAndStore.mockResolvedValue(undefined);
  mockRotateAndStore.mockResolvedValue(undefined);
  mockDeleteFromVault.mockResolvedValue(undefined);
  mockVaultServiceGet.mockResolvedValue(null);
});

describe('hashContactValue', () => {
  it('produces a consistent SHA-256 hex string', () => {
    const h = hashContactValue('test@example.com');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('normalises case and whitespace before hashing', () => {
    expect(hashContactValue('Test@Example.COM')).toBe(hashContactValue('test@example.com'));
    expect(hashContactValue('  test@example.com  ')).toBe(hashContactValue('test@example.com'));
  });
});

describe('processEmailUpdate', () => {
  it('is a no-op when email is undefined', async () => {
    await processEmailUpdate('did:imajin:owner', undefined);
    expect(mockSealAndStore).not.toHaveBeenCalled();
    expect(mockRotateAndStore).not.toHaveBeenCalled();
    expect(mockDeleteFromVault).not.toHaveBeenCalled();
  });

  it('seals new email when vault entry does not exist', async () => {
    mockVaultServiceGet.mockResolvedValue(null);
    await processEmailUpdate('did:imajin:owner', 'new@example.com');
    expect(mockSealAndStore).toHaveBeenCalledWith('contact:email:did:imajin:owner', 'new@example.com');
    expect(mockRotateAndStore).not.toHaveBeenCalled();
  });

  it('rotates existing vault entry when email already stored', async () => {
    mockVaultServiceGet.mockResolvedValue('existing-ciphertext');
    await processEmailUpdate('did:imajin:owner', 'updated@example.com');
    expect(mockRotateAndStore).toHaveBeenCalledWith('contact:email:did:imajin:owner', 'updated@example.com');
    expect(mockSealAndStore).not.toHaveBeenCalled();
  });

  it('deletes vault entry when email is cleared (falsy)', async () => {
    await processEmailUpdate('did:imajin:owner', '');
    expect(mockDeleteFromVault).toHaveBeenCalledWith('contact:email:did:imajin:owner');
    expect(mockSealAndStore).not.toHaveBeenCalled();
  });
});

describe('processPhoneUpdate', () => {
  it('is a no-op when phone is undefined', async () => {
    await processPhoneUpdate('did:imajin:owner', undefined);
    expect(mockSealAndStore).not.toHaveBeenCalled();
    expect(mockDeleteFromVault).not.toHaveBeenCalled();
  });

  it('seals new phone when vault entry does not exist', async () => {
    mockVaultServiceGet.mockResolvedValue(null);
    await processPhoneUpdate('did:imajin:owner', '+1-555-0100');
    expect(mockSealAndStore).toHaveBeenCalledWith('contact:phone:did:imajin:owner', '+1-555-0100');
  });

  it('rotates existing vault entry when phone already stored', async () => {
    mockVaultServiceGet.mockResolvedValue('existing-ciphertext');
    await processPhoneUpdate('did:imajin:owner', '+1-555-0200');
    expect(mockRotateAndStore).toHaveBeenCalledWith('contact:phone:did:imajin:owner', '+1-555-0200');
  });

  it('deletes vault entry when phone is cleared (falsy)', async () => {
    await processPhoneUpdate('did:imajin:owner', '');
    expect(mockDeleteFromVault).toHaveBeenCalledWith('contact:phone:did:imajin:owner');
  });
});
