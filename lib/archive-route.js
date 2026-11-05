import { createReadScope } from './async-control.js';
import { archiveDetails } from './archive-public.js';

export const ARCHIVE_PATH = '/api/session-link/archive';
const MAX_BODY = 4096;
const fail = (code, message) => Object.assign(new Error(message), { code });
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const statuses = { INVALID_ARGUMENT: 400, INVALID_JSON: 400, UNSUPPORTED_MEDIA_TYPE: 415, BODY_TOO_LARGE: 413, ABORTED: 499, METADATA_TIMEOUT: 504, ARCHIVE_ROUTE_CLOSED: 503, READ_SCOPE_CLOSED: 503,
  ACCESS_DENIED: 403, ARCHIVE_SELF_OR_ANCESTOR: 403, ARCHIVE_HOST_UNAVAILABLE: 503, ARCHIVE_PLAN_NOT_FOUND: 404, ARCHIVE_PLAN_CHANGED: 409, ACTIVITY_REQUIRES_CONFIRMATION: 409 };
function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}
async function readBody(request, signal) {
  if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw fail('UNSUPPORTED_MEDIA_TYPE');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BODY)) throw fail('BODY_TOO_LARGE');
  if (!request.body) throw fail('INVALID_JSON');
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  const cancel = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw fail('ABORTED');
      const item = await reader.read();
      if (signal.aborted) throw fail('ABORTED');
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_BODY) { cancel(); throw fail('BODY_TOO_LARGE'); }
      chunks.push(item.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let value;
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw fail('INVALID_JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('INVALID_JSON');
    const fields = value.action === 'plan' ? ['action', 'targetId', 'workspaceId', 'requestId', 'archiveScope'] : ['action', 'planId', 'requestId', 'stopActivity', 'archiveScope'];
    if (!['plan', 'commit'].includes(value.action) || Object.keys(value).some(key => !fields.includes(key)) || !validId(value.requestId) || value.requestId.length > 128) throw fail('INVALID_ARGUMENT');
    if (value.archiveScope !== undefined && !['single', 'related'].includes(value.archiveScope)) throw fail('INVALID_ARGUMENT');
    if (value.action === 'plan') {
      if (!validId(value.targetId) || (value.workspaceId !== undefined && !validId(value.workspaceId))) throw fail('INVALID_ARGUMENT');
    } else if (!validId(value.planId) || !['single', 'related'].includes(value.archiveScope) || (value.stopActivity !== undefined && typeof value.stopActivity !== 'boolean')) throw fail('INVALID_ARGUMENT');
    return value;
  } finally { signal.removeEventListener('abort', cancel); try { reader.releaseLock(); } catch { /* cancelled outstanding read */ } }
}

// Only declared archive metadata crosses this error boundary. Never serialize
// arbitrary Error properties, native stack traces, a Request, or an Agent.
function publicError(error) {
  const code = typeof error?.code === 'string' && /^ARCHIVE_[A-Z_]+$|^ACTIVITY_REQUIRES_CONFIRMATION$|^ACCESS_DENIED$|^ABORTED$|^METADATA_TIMEOUT$/u.test(error.code) ? error.code : Object.hasOwn(statuses, error?.code) ? error.code : 'ARCHIVE_UNAVAILABLE';
  return { code, message: 'The archive request could not be completed. No automatic retry was performed.', ...archiveDetails(error) };
}

/** INTERNAL WHATWG handler. Authentication is exclusively the audited owner-only
 * Connection Fetch admission in mountArchiveRoute, never body-provided identity.
 * Body reads are bounded. Once admitted, plan persistence and archive commits
 * drain without an outer timeout race, including close and disconnected clients.
 */
export function createArchiveHandler({ archiver, timeoutMs = 15000 } = {}) {
  if (typeof archiver?.planForOwner !== 'function' || typeof archiver?.commitForOwner !== 'function') throw fail('ARCHIVE_HOST_UNAVAILABLE');
  const bodies = createReadScope({ timeoutMs }), pending = new Set();
  let closing = false, closed;
  return {
    async fetch(request) {
      if (new URL(request.url).pathname !== ARCHIVE_PATH) return response({ ok: false, error: { code: 'NOT_FOUND' } }, 404);
      if (request.method !== 'POST') return response({ ok: false, error: { code: 'METHOD_NOT_ALLOWED' } }, 405);
      if (closing) return response({ ok: false, error: { code: 'ARCHIVE_ROUTE_CLOSED' } }, 503);
      try {
        const args = await bodies.run(signal => readBody(request, signal), { signal: request.signal });
        if (closing) throw fail('ARCHIVE_ROUTE_CLOSED');
        const { action, ...input } = args;
        const work = Promise.resolve().then(() => action === 'plan' ? archiver.planForOwner(input, { signal: request.signal }) : archiver.commitForOwner(input, { signal: request.signal }));
        pending.add(work);
        try { return response({ ok: true, value: await work }); }
        finally { pending.delete(work); }
      } catch (error) {
        const value = publicError(error);
        return response({ ok: false, error: value }, statuses[value.code] ?? 409);
      }
    },
    close() { return closed ??= (async () => { closing = true; await bodies.close(); await Promise.allSettled([...pending]); })(); },
  };
}

/** Register only through public Connection Fetch. Its Host/Origin, credentials
 * and owner-principal checks run BEFORE this handler. No raw server fallback.
 * Route disposal does not close the shared archiver or its store.
 */
export function mountArchiveRoute(ctx, { archiver, timeoutMs = 15000 } = {}) {
  const connection = typeof ctx?.get === 'function' ? ctx.get('connection') : ctx?.connection;
  if (typeof connection?.fetch?.register !== 'function') throw fail('ARCHIVE_AUTH_UNAVAILABLE');
  const handler = createArchiveHandler({ archiver, timeoutMs });
  let remove;
  try {
    remove = connection.fetch.register({ path: ARCHIVE_PATH, methods: ['POST'], requestBody: 'streaming', fetch: request => handler.fetch(request) });
    if (typeof remove !== 'function') throw fail('ARCHIVE_AUTH_UNAVAILABLE');
  } catch (error) { void handler.close(); throw error; }
  let closed;
  return { path: ARCHIVE_PATH, close() { return closed ??= (async () => { try { await remove(); } finally { await handler.close(); } })(); } };
}
