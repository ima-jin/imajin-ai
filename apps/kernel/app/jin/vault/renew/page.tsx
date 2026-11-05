import { OrgHeldRenewalForm } from '../../org-held-renewal-form';

export default async function RenewOrgHeldKeyPage({ searchParams }: Readonly<{
  searchParams: Promise<{ orgDid?: string; provider?: string }>;
}>) {
  const { orgDid, provider } = await searchParams;
  return <main className="mx-auto max-w-xl space-y-4 p-6 text-gray-200">
    <h1 className="text-xl font-semibold">Renew org-held key</h1>
    <OrgHeldRenewalForm orgDid={orgDid ?? ''} provider={provider ?? ''} />
  </main>;
}
