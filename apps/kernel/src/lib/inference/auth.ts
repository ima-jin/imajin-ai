import { requireAppAuth, requireAuth, resolveActingDid } from '@imajin/auth';

export interface InferenceAuthContext {
  ownerDid: string;
  appDid?: string;
}

export type InferenceAuthResult =
  | { ok: true; context: InferenceAuthContext }
  | { ok: false; error: string; status: number };

/**
 * Resolve the authenticated caller for the intention-inference pipeline.
 *
 * Shared by both `POST /api/inference/capture` and
 * `POST /api/inference/confirm/:sessionId` (#1782). The confirm click is the
 * consent/signing event for the whole flow, so whichever authenticated
 * caller capture accepted for a session must also be accepted by confirm for
 * that same session — otherwise the human who captured a gesture can never
 * sign it.
 *
 * Before #1782 the two routes validated auth differently: capture tried app
 * auth first (Bearer app token, or legacy X-App-DID + X-App-Authorization
 * headers) and fell back to plain session/bearer auth, while confirm only
 * ever called `requireAuth`. An app-authenticated capture handed confirm the
 * same app token, which `requireAuth`'s bearer path forwarded to the
 * session/user token validator — a validator that was never going to
 * recognise an app token — producing the `401 Invalid token` from #1782.
 *
 * Extracting this single resolution path guarantees both routes derive the
 * exact same `ownerDid` for the exact same request shape, rather than merely
 * happening to agree today.
 */
export async function resolveInferenceAuth(request: Request): Promise<InferenceAuthResult> {
  const appResult = await requireAppAuth(request, { scope: 'infer:provide' });
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
