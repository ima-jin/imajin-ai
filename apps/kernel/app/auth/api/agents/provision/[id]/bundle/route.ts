import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, authErrorResponse } from '@imajin/auth';
import { getProvision, renderEnvelopeForRow, ProvisionError } from '@/src/lib/auth/agent-provisioner';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * GET /auth/api/agents/provision/[id]/bundle
 *
 * `placement: 'local'` only (#1933 deliverable 2): returns the full
 * rendered file tree (file contents included — this is the one place full
 * envelope content is served; the provision record itself only stores a
 * file-name manifest) so the Agent View UI's "Download bundle" action can
 * hand the owner a ready-to-run NanoClaw workspace + `deploy/nanoclaw`
 * compose files + an env template with variable NAMES only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  const { identity } = authResult;
  const callerDid = identity.actingAs ?? identity.id;
  const { id } = await params;

  try {
    const provision = await getProvision(id);
    if (!provision) {
      return NextResponse.json({ error: 'Provision not found' }, { status: 404 });
    }
    if (provision.servingDid !== callerDid) {
      return NextResponse.json({ error: "Not authorized to download this provision's bundle" }, { status: 403 });
    }
    if (provision.placement !== 'local') {
      return NextResponse.json({ error: "Only placement: 'local' provisions have a downloadable bundle - 'hosted' provisions are materialized by the runner" }, { status: 400 });
    }

    const rendered = renderEnvelopeForRow(provision);
    return NextResponse.json({ harness: rendered.harness, files: rendered.files, manualSteps: rendered.manualSteps });
  } catch (error) {
    if (error instanceof ProvisionError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    log.error({ err: String(error) }, '[agents/provision/bundle] Error');
    return NextResponse.json({ error: 'Failed to build bundle' }, { status: 500 });
  }
}
