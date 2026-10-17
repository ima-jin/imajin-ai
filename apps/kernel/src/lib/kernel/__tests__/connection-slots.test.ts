import { describe, expect, it } from 'vitest';
import { connectionSlot, connectionVaultField } from '../connection-slots';
import { currentConnectionSlot, withConnectorConnection } from '../connector-connection-context';

describe('connection slots', () => {
  it('preserves primary vault grants without re-sealing', () => {
    expect(connectionSlot()).toBe('primary');
    expect(connectionSlot(null)).toBe('primary');
    expect(connectionVaultField('google-oauth', 'did:imajin:alice')).toBe('google-oauth:did:imajin:alice');
    expect(connectionVaultField('google-oauth', 'did:imajin:alice', 'primary')).toBe('google-oauth:did:imajin:alice');
    expect(connectionVaultField('google-oauth', 'did:imajin:alice', 'artifact')).toBe('google-oauth:did:imajin:alice:artifact');
  });

  it.each(['', '../primary', 'org:example', 'Artifact', 'a b', 'x'.repeat(65)])(
    'rejects invalid or unsupported connection selector %s',
    (value) => expect(() => connectionSlot(value)).toThrow('invalid_connection'),
  );

  it('does not coerce malformed runtime payloads to slots', () => {
    expect(() => connectionSlot(42 as unknown as string)).toThrow('invalid_connection');
    expect(() => connectionSlot({} as string)).toThrow('invalid_connection');
  });

  it.each(['primary', 'artifact', 'personal-gmail', 'work_2', 'x'.repeat(64)])(
    'accepts the validated slot %s',
    (value) => expect(connectionSlot(value)).toBe(value),
  );

  it('binds context to both provider and owner and restores outer context', async () => {
    expect(currentConnectionSlot('google', 'alice')).toBe('primary');
    await withConnectorConnection('google', 'alice', 'artifact', async () => {
      expect(currentConnectionSlot('google', 'alice')).toBe('artifact');
      expect(currentConnectionSlot('github', 'alice')).toBe('primary');
      expect(currentConnectionSlot('google', 'bob')).toBe('primary');
      await withConnectorConnection('google', 'alice', 'personal', async () => {
        await Promise.resolve();
        expect(currentConnectionSlot('google', 'alice')).toBe('personal');
      });
      expect(currentConnectionSlot('google', 'alice')).toBe('artifact');
    });
    expect(currentConnectionSlot('google', 'alice')).toBe('primary');
  });

  it('does not leak between concurrent tool invocations or after errors', async () => {
    const results = await Promise.all(['personal', 'artifact'].map((slot) =>
      withConnectorConnection('google', 'alice', slot, async () => {
        await Promise.resolve();
        return currentConnectionSlot('google', 'alice');
      }),
    ));
    expect(results).toEqual(['personal', 'artifact']);
    expect(() => withConnectorConnection('google', 'alice', 'artifact', () => {
      throw new Error('provider unavailable');
    })).toThrow('provider unavailable');
    expect(currentConnectionSlot('google', 'alice')).toBe('primary');
    expect(() => withConnectorConnection('google', 'alice', '../primary', () => undefined))
      .toThrow('invalid_connection');
  });
});
