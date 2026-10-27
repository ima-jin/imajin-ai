import { readConnectorRegistration } from './connector-registry-store';
import { ConnectionRemovedError } from './connection-slots';

/** Primary is never removable. A missing legacy projection still grants nothing. */
export async function assertConnectionNotRemoved(ownerDid: string, provider: string, slot: string) {
  if (slot === 'primary') return;
  const row = await readConnectorRegistration(ownerDid, provider, slot);
  if (row?.status === 'removed') {
    throw new ConnectionRemovedError();
  }
}
