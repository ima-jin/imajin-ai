/**
 * Fail closed until domain ownership AND mail verification ship (#2902/#2918).
 * Deliberately has no environment/request override. Tests mock this module.
 */
export async function isDomainMailReady(_ownerDid: string, _domain: string): Promise<boolean> {
  return false;
}
