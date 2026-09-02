import { requireAppAuth, requireAuth, resolveActingDid } from '@imajin/auth';

export interface InferenceAuthContext {
  ownerDid: string;
  appDid?: string;
}

export type InferenceAuthResult =
  | { ok: true; context: InferenceAuthContext }
  | { ok: false; error: string; status: number };

/**
 * Resolve the authenticated caller for an inference-adjacent route.
 *
 * Shared by `POST /api/inference/capture`, `POST /api/inference/confirm/:sessionId`
 * (#1782), `POST /infer/v1/chat/completions` (#1925), and the Anthropic Messages
 * raw passthrough (`POST /infer/v1/messages` + `.../count_tokens`, #1959) —
 * every route where an app may act `onBehalfOf` a delegating principal, or the
 * principal may call directly with their own session. The confirm click is the
 * consent/signing event for the capture flow, so whichever authenticated caller
 * capture accepted for a session must also be accepted by confirm for that same
 * session — otherwise the human who captured a gesture can never sign it.
 *
 * Before #1782 the two routes validated auth differently: capture tried app
 * auth first (Bearer app token, or legacy X-App-DID + X-App-Authorization
 * headers) and fell back to plain session/bearer auth, while confirm only
 * ever called `requireAuth`. An app-authenticated capture handed confirm the
 * same app token, which `requireAuth`'s bearer path forwarded to the
 * session/user token validator — a validator that was never going to
 * recognise an app token — producing the `401 Invalid token` from #1782.
 *
 * Extracting this single resolution path guarantees every caller derives the
 * exact same `ownerDid` for the exact same request shape, rather than merely
 * happening to agree today.
 *
 * @param scope - The app-token scope required for the app-auth path. Callers
 *   name their own scope (`infer:provide` for capture/confirm, `infer:completions`
 *   for the completions passthrough) so a grant for one surface can never be
 *   silently reused to authorize the other.
 */
export async function resolveInferenceAuth(
  request: Request,
  scope: string = 'infer:provide',
): Promise<InferenceAuthResult> {
  const appResult = await requireAppAuth(withApiKeyBearerFallback(request), { scope });
  if ('appAuth' in appResult) {
    const ownerDid = appResult.appAuth.userDid || request.headers.get('x-acting-for') || '';
    if (!ownerDid) {
      return {
        ok: false,
        error: 'App-authenticated inference requires a delegating user DID or X-Acting-For header',
        status: 400,
      };
    }
    return { ok: true, context: { ownerDid, appDid: appResult.appAuth.appDid } };
  }

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    const hasAppAuthHint = Boolean(
      request.headers.get('x-app-did') ||
      request.headers.get('x-app-authorization') ||
      request.headers.get('x-acting-for'),
    );
    if (hasAppAuthHint || appResult.status === 403) {
      return { ok: false, error: appResult.error, status: appResult.status };
    }
    return { ok: false, error: authResult.error, status: authResult.status };
  }

  return { ok: true, context: { ownerDid: resolveActingDid(authResult.identity) } };
}

/**
 * Let an app-token JWT ride in `x-api-key` as an alternative to
 * `Authorization: Bearer` (#1959, Jin's review note 3 on the issue).
 *
 * The Claude Agent SDK and Claude Code CLI authenticate every provider the
 * same way Anthropic's own API does: `x-api-key: <credential>`, never a
 * bearer header — that is not configurable client-side, so the kernel has to
 * meet it there. `requireAppAuth` only ever reads `Authorization`, and it is
 * shared by every app-authenticated route in the kernel, so this rewrites a
 * `x-api-key` value onto a header-only view of the request rather than
 * teaching `requireAppAuth` itself a second header name (which would apply
 * the rewrite to routes that never asked for it).
 *
 * A no-op whenever `Authorization` is already present — that header always
 * wins, matching every other caller's expectation that Bearer is the primary
 * credential channel — or when there is no `x-api-key` to fall back to.
 * Returns a plain `{ headers }` object rather than cloning the full request:
 * `requireAppAuth` reads only `.headers`, and this must never consume or
 * touch the original request's body stream.
 */
function withApiKeyBearerFallback(request: Request): Request {
  if (request.headers.get('authorization')) return request;
  const apiKey = request.headers.get('x-api-key');
  if (!apiKey) return request;

  const headers = new Headers(request.headers);
  headers.set('authorization', `Bearer ${apiKey}`);
  return { headers } as Request;
}
