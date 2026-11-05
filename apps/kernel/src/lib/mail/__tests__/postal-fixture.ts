import type { MailDomainStatus, PostalDomain } from '../postal-contract';

/** Public DNS data only. No credential or private key belongs in fixtures. */
export function postalFixture(verified = false): PostalDomain {
  return {
    organization: 'node-org', name: 'example.org', id: '90acf8ac-d062-4a77-975a-30ff94210a82',
    state: verified ? 'verified' : 'pending', ownership_verified: verified, dns_ok: verified,
    verified_at: verified ? '2026-11-04T21:00:00Z' : null,
    dns_checked_at: verified ? '2026-11-04T21:00:00Z' : null,
    records: [
      { kind: 'ownership', type: 'TXT', name: 'example.org', value: 'postal-verification public DNS proof', required: true, status: verified ? 'OK' : 'Pending', error: null },
      { kind: 'spf', type: 'TXT', name: 'example.org', value: 'v=spf1 include:spf.postal.example ~all', include: 'include:spf.postal.example', required: true, status: verified ? 'OK' : 'Unchecked', error: null },
      { kind: 'dkim', type: 'TXT', name: 'postal._domainkey.example.org', value: 'v=DKIM1; k=rsa; p=public-dns-key', required: true, status: verified ? 'OK' : 'Unchecked', error: null },
      { kind: 'return_path', type: 'CNAME', name: 'rp.example.org', value: 'rp.postal.example', required: false, status: 'Missing', error: null },
      { kind: 'mx', type: 'MX', name: 'example.org', value: 'inbound.postal.example', required: false, status: 'Missing', error: null, priority: 10 },
    ],
  };
}

export function statusFixture(verified = false): MailDomainStatus {
  const postal = postalFixture(verified);
  return {
    ownerDid: 'did:owner', domain: postal.name, state: postal.state,
    ownershipVerified: postal.ownership_verified, dnsOk: postal.dns_ok,
    records: postal.records, checkedAt: postal.dns_checked_at,
  };
}
