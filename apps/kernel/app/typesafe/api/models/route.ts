/**
 * GET /typesafe/api/models (#2197)
 *
 * Lists the models the owner's sealed TypeSafe key can see, via `GET
 * /v1/models` — TypeSafe's own key-validation probe (401 = bad key,
 * docs.typesafe.ai/api). Doubles as the connector card's status probe: the
 * owner is asking "is my key valid, and what can it run?" before reaching
 * the "grant scopes" step, so this does NOT require an active
 * `typesafe:decide` grant (#1773 precedent — same reasoning as every other
 * token-paste connector's model picker).
 *
 * `model` on `POST /typesafe/api/decide` defaults to `jev-latest` and is
 * never sealed as a per-DID choice (unlike the brain connectors' model
 * picker) — TypeSafe callers choose a model per call, not per connection —
 * so this route is GET-only.
 *
 * Security invariant: the sealed key never leaves the kernel, and upstream
 * response bodies are never surfaced — only a mapped status — since an
 * upstream error page could otherwise echo the query (and the key) back.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { resolveConnectorOwnerDid } from '@/src/lib/kernel/connector-owner-did';
import { loadTypesafeSealedCredentials, typesafeKeyPending } from '@/src/lib/typesafe/connector';
import { getModels, TypesafeUpstreamError } from '@/src/lib/typesafe/client';

const log = createLogger('kernel');

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const auth = await resolveConnectorOwnerDid(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors });
  }
  const { ownerDid } = auth;

  const creds = await loadTypesafeSealedCredentials(ownerDid);
  if (!creds) {
    if (await typesafeKeyPending(ownerDid)) {
      return NextResponse.json(
        { error: 'typesafe_credential_pending: TypeSafe.ai API key is sealed but awaiting owner grant approval' },
        { status: 409, headers: cors },
      );
    }
    return NextResponse.json(
      { error: 'typesafe_no_key: no TypeSafe.ai API key sealed for this identity — seal one on the TypeSafe.ai connector card first' },
      { status: 400, headers: cors },
    );
  }

  try {
    const { data } = await getModels(creds.apiKey);
    return NextResponse.json({ models: data.models }, { headers: cors });
  } catch (err) {
    if (err instanceof TypesafeUpstreamError && err.status === 401) {
      log.warn({ ownerDid }, 'typesafe models: sealed key rejected by upstream (401)');
      return NextResponse.json({ error: 'typesafe_invalid_key: TypeSafe.ai rejected the sealed API key' }, { status: 401, headers: cors });
    }
    if (err instanceof TypesafeUpstreamError) {
      log.warn({ ownerDid, status: err.status }, 'typesafe models: upstream list failed');
      return NextResponse.json({ error: `typesafe_models: upstream ${err.status}` }, { status: 502, headers: cors });
    }
    log.error({ err: String(err), ownerDid }, 'typesafe models: fetch failed');
    return NextResponse.json({ error: 'typesafe_models: failed to reach TypeSafe.ai' }, { status: 502, headers: cors });
  }
}
