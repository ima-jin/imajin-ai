/**
 * Cloudflare DNS provisioning for node subdomains
 * 
 * Provisions {hostname}.imajin.ai pointing to the node's origin
 */

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';

interface CloudflareConfig {
  apiToken: string;
  zoneId: string;
  baseDomain: string;
}

interface DNSRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
  ttl: number;
}

function getConfig(): CloudflareConfig {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const zoneId = process.env.CLOUDFLARE_ZONE_ID;
  const baseDomain = process.env.CLOUDFLARE_BASE_DOMAIN || 'imajin.ai';

  if (!apiToken || !zoneId) {
    throw new Error('Missing Cloudflare configuration');
  }

  return { apiToken, zoneId, baseDomain };
}

async function cfFetch(
  path: string,
  options: RequestInit = {}
): Promise<any> {
  const config = getConfig();
  
  const response = await fetch(`${CLOUDFLARE_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${config.apiToken}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const data = await response.json();
  
  if (!data.success) {
    const errors = data.errors?.map((e: any) => e.message).join(', ') || 'Unknown error';
    throw new Error(`Cloudflare API error: ${errors}`);
  }

  return data.result;
}

/**
 * Check if a hostname is available
 */
export async function isHostnameAvailable(hostname: string): Promise<boolean> {
  const config = getConfig();
  const fqdn = `${hostname}.${config.baseDomain}`;
  
  try {
    const records = await cfFetch(
      `/zones/${config.zoneId}/dns_records?name=${encodeURIComponent(fqdn)}`
    );
    return records.length === 0;
  } catch (error) {
    console.error('Error checking hostname availability:', error);
    return false;
  }
}

/**
 * Provision a subdomain for a node
 * 
 * Creates a CNAME or A record pointing to the node's origin.
 * For now, we use a wildcard approach where all subdomains
 * point to a load balancer that routes based on hostname.
 */
export async function provisionSubdomain(
  hostname: string,
  nodeId: string,
  options: {
    type?: 'CNAME' | 'A';
    target?: string;
    proxied?: boolean;
  } = {}
): Promise<{ subdomain: string; recordId: string }> {
  const config = getConfig();
  const fqdn = `${hostname}.${config.baseDomain}`;
  
  // Default to CNAME pointing to a gateway that routes by hostname
  // In production, this could point directly to the node's IP
  const recordType = options.type || 'CNAME';
  const target = options.target || `gateway.${config.baseDomain}`;
  const proxied = options.proxied ?? true; // Cloudflare proxy for SSL

  const record = await cfFetch(
    `/zones/${config.zoneId}/dns_records`,
    {
      method: 'POST',
      body: JSON.stringify({
        type: recordType,
        name: fqdn,
        content: target,
        ttl: 1, // Auto TTL when proxied
        proxied,
        comment: `Node: ${nodeId}`,
      }),
    }
  );

  return {
    subdomain: fqdn,
    recordId: record.id,
  };
}

/**
 * Remove a subdomain
 */
export async function removeSubdomain(hostname: string): Promise<void> {
  const config = getConfig();
  const fqdn = `${hostname}.${config.baseDomain}`;

  // Find the record
  const records = await cfFetch(
    `/zones/${config.zoneId}/dns_records?name=${encodeURIComponent(fqdn)}`
  );

  if (records.length === 0) {
    return; // Already gone
  }

  // Delete each matching record
  for (const record of records) {
    await cfFetch(
      `/zones/${config.zoneId}/dns_records/${record.id}`,
      { method: 'DELETE' }
    );
  }
}

/**
 * Update a subdomain's target
 */
export async function updateSubdomain(
  hostname: string,
  target: string
): Promise<void> {
  const config = getConfig();
  const fqdn = `${hostname}.${config.baseDomain}`;

  // Find the record
  const records = await cfFetch(
    `/zones/${config.zoneId}/dns_records?name=${encodeURIComponent(fqdn)}`
  );

  if (records.length === 0) {
    throw new Error(`Subdomain ${fqdn} not found`);
  }

  const record = records[0];

  await cfFetch(
    `/zones/${config.zoneId}/dns_records/${record.id}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        content: target,
      }),
    }
  );
}

/**
 * List all node subdomains
 */
export async function listSubdomains(): Promise<DNSRecord[]> {
  const config = getConfig();
  
  const records = await cfFetch(
    `/zones/${config.zoneId}/dns_records?per_page=1000`
  );

  // Filter to only node subdomains (have comment starting with "Node:")
  return records.filter((r: any) => r.comment?.startsWith('Node:'));
}
