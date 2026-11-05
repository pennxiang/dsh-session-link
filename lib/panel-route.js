import { createReadScope } from './async-control.js';

export const PANEL_PATH = '/api/session-link/view';
const MAX_BODY_BYTES = 4096;
const fail = (code, message) => Object.assign(new Error(message), { code });
const service = (ctx, key) => typeof ctx?.get === 'function' ? ctx.get(key) : ctx?.[key];
const errors = {
  INVALID_ARGUMENT: [400, 'Invalid relation-view request.'],
  INVALID_JSON: [400, 'Request body must be a JSON object.'],
  BODY_TOO_LARGE: [413, 'Request body exceeds 4096 bytes.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Use application/json.'],
  TARGET_NOT_RELATED: [403, 'The target is not in this bounded ancestor/descendant view.'],
  ACCESS_DENIED: [403, 'The target is outside the permitted live directory.'],
  TARGET_ARCHIVED: [403, 'The target is archived. This action does not unarchive or activate it.'],
  TARGET_NOT_FOUND: [404, 'The related Session no longer exists.'],
  SESSION_NOT_FOUND: [404, 'The requested Session no longer exists.'],
  WORKSPACE_NOT_FOUND: [404, 'The requested Workspace no longer exists.'],
  TARGET_NOT_LIVE: [404, 'The requested Session is unavailable.'],
  ABORTED: [499, 'The request was cancelled.'],
  READ_SCOPE_CLOSED: [503, 'The relation panel is closing.'],
  METADATA_TIMEOUT: [504, 'Session metadata exceeded its bounded deadline.'],
};
function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
  } });
}
async function body(request, signal) {
  const type = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw fail('UNSUPPORTED_MEDIA_TYPE');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY_BYTES)) throw fail('BODY_TOO_LARGE');
  if (!request.body) throw fail('INVALID_JSON');
  const reader = request.body.getReader();
  const chunks = [];
  let received = 0;
  const cancel = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw fail('ABORTED');
      const result = await reader.read();
      if (signal.aborted) throw fail('ABORTED');
      if (result.done) break;
      received += result.value.byteLength;
      if (received > MAX_BODY_BYTES) { cancel(); throw fail('BODY_TOO_LARGE'); }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let parsed;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw fail('INVALID_JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail('INVALID_JSON');
    const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
    if (parsed.action === 'workspace-relations') {
      if (Object.keys(parsed).some(key => !['action', 'workspaceId'].includes(key)) || !validId(parsed.workspaceId)) throw fail('INVALID_ARGUMENT');
    } else if (Object.keys(parsed).some(key => !['action', 'sessionId', 'targetId'].includes(key)) ||
      !['relations', 'resolve'].includes(parsed.action) || !validId(parsed.sessionId) ||
      (parsed.action === 'resolve' ? !validId(parsed.targetId) : parsed.targetId !== undefined)) throw fail('INVALID_ARGUMENT');
    return parsed;
  } finally {
    signal.removeEventListener('abort', cancel);
    try { reader.releaseLock(); } catch { /* cancellation may still own an outstanding read */ }
  }
}

/** INTERNAL owner-admitted WHATWG handler, not a standalone authenticated route.
 * Production callers MUST use mountPanelRoute: DSH rc.5 Connection admits the
 * Node request and then rejects every exact-route non-owner before calling us.
 * requestRejection/admit accept Node IncomingMessage, NOT this WHATWG Request.
 * Raw remoteAccess.allows() outside a Remote invocation is not authorization.
 */
export function createPanelHandler({ relations, timeoutMs = 15000 } = {}) {
  if (typeof relations?.view !== 'function' || typeof relations?.resolve !== 'function') throw fail('RELATIONS_UNAVAILABLE', 'A read-only relation service is required.');
  const scope = createReadScope({ timeoutMs });
  return {
    async fetch(request) {
      if (new URL(request.url).pathname !== PANEL_PATH) return response({ ok: false, error: { code: 'NOT_FOUND', message: 'Route not found.' } }, 404);
      if (request.method !== 'POST') return response({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }, 405);
      try {
        const value = await scope.run(async signal => {
          const args = await body(request, signal);
          // sessionId is the authenticated OWNER's selected resource, never an
          // assertion that an arbitrary remote caller owns that Session.
          if (args.action === 'workspace-relations') {
            if (typeof relations.workspace !== 'function') throw fail('RELATIONS_UNAVAILABLE');
            return relations.workspace(args.workspaceId, { signal });
          }
          return args.action === 'relations' ? relations.view(args.sessionId, { signal }) : relations.resolve(args.sessionId, args.targetId, { signal });
        }, { signal: request.signal });
        return response({ ok: true, value });
      } catch (error) {
        const code = Object.hasOwn(errors, error?.code) ? error.code : 'RELATIONS_UNAVAILABLE';
        const [status, message] = errors[code] ?? [503, 'Session relations are temporarily unavailable.'];
        return response({ ok: false, error: { code, message } }, status);
      }
    },
    close() { return scope.close(); },
  };
}

/** Register ONLY through audited rc.5 Connection's exact Fetch API. Its Host /
 * Origin fence, cookie/token admission and owner-principal gate are mandatory.
 * No webServer fallback and no body-provided principal/authentication bypass.
 * Missing or conflicting registration fails closed. All data remains read-only.
 */
export function mountPanelRoute(ctx, { relations, timeoutMs = 15000 } = {}) {
  const connection = service(ctx, 'connection');
  if (typeof connection?.fetch?.register !== 'function') throw fail('PANEL_AUTH_UNAVAILABLE', 'Authenticated owner-only Connection Fetch routes are unavailable.');
  const handler = createPanelHandler({ relations, timeoutMs });
  let remove;
  try {
    // streaming avoids Connection's much larger default upload buffer; our
    // handler reads <=4KiB and closes slow/aborted body readers via its scope.
    remove = connection.fetch.register({ path: PANEL_PATH, methods: ['POST'], requestBody: 'streaming', fetch: request => handler.fetch(request) });
    if (typeof remove !== 'function') throw fail('PANEL_AUTH_UNAVAILABLE', 'Connection did not return a route disposer.');
  } catch (error) { void handler.close(); throw error; }
  let closed;
  return {
    path: PANEL_PATH,
    close() {
      return closed ??= (async () => {
        try { await remove(); }
        finally { await handler.close(); await relations.close?.(); }
      })();
    },
  };
}
