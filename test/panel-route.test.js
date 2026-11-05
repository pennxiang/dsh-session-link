import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPanelHandler, mountPanelRoute, PANEL_PATH } from '../lib/panel-route.js';

const request = (value, options = {}) => new Request(`http://dsh.internal${PANEL_PATH}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), ...options,
});
function fixture() {
  const calls = [];
  let closed = 0;
  const relations = {
    async view(id, { signal }) { calls.push(['view', id, signal]); return { self: { id }, nodes: [{ id }], edges: [], truncated: false }; },
    async resolve(id, targetId, { signal }) { calls.push(['resolve', id, targetId, signal]); return { targetId, node: { id: targetId } }; },
    async workspace(workspaceId, { signal }) { calls.push(['workspace', workspaceId, signal]); return { schemaVersion: 1, workspaceId, edges: [{ sourceId: 'a', targetId: 'b', kind: 'created-session' }], truncated: false }; },
    async close() { closed++; },
  };
  return { relations, calls, get closed() { return closed; } };
}

test('owner-admitted internal handler returns locked view/resolve shapes with no-store responses', async () => {
  const f = fixture(); const handler = createPanelHandler({ relations: f.relations });
  const result = await handler.fetch(request({ action: 'relations', sessionId: 'self' }));
  assert.equal(result.status, 200); assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await result.json(), { ok: true, value: { self: { id: 'self' }, nodes: [{ id: 'self' }], edges: [], truncated: false } });
  const exact = await handler.fetch(request({ action: 'resolve', sessionId: 'self', targetId: 'not-in-graph' }));
  assert.deepEqual(await exact.json(), { ok: true, value: { targetId: 'not-in-graph', node: { id: 'not-in-graph' } } });
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls[0][2] instanceof AbortSignal);
  await handler.close();
});

test('owner-admitted Workspace action has only Workspace identity, minimal output and no-store', async () => {
  const f = fixture(); const handler = createPanelHandler({ relations: f.relations });
  const result = await handler.fetch(request({ action: 'workspace-relations', workspaceId: 'workspace-1' }));
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await result.json(), { ok: true, value: { schemaVersion: 1, workspaceId: 'workspace-1', edges: [{ sourceId: 'a', targetId: 'b', kind: 'created-session' }], truncated: false } });
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0].slice(0, 2), ['workspace', 'workspace-1']);
  assert.ok(f.calls[0][2] instanceof AbortSignal);
  await handler.close();
});

test('Workspace and Session action identities are mutually exclusive and cannot assert owner or path', async () => {
  const f = fixture(); const handler = createPanelHandler({ relations: f.relations });
  for (const args of [
    { action: 'workspace-relations' },
    { action: 'workspace-relations', workspaceId: '' },
    { action: 'workspace-relations', workspaceId: 'x'.repeat(257) },
    { action: 'workspace-relations', workspaceId: 'bad\nidentity' },
    { action: 'workspace-relations', workspaceId: 'w', sessionId: 'a' },
    { action: 'workspace-relations', workspaceId: 'w', sessionId: null },
    { action: 'workspace-relations', workspaceId: 'w', targetId: 'b' },
    { action: 'workspace-relations', workspaceId: 'w', principal: { kind: 'owner' } },
    { action: 'workspace-relations', workspaceId: 'w', path: '/same' },
    { action: 'relations', sessionId: 'a', workspaceId: 'w' },
    { action: 'resolve', sessionId: 'a', targetId: 'b', workspaceId: 'w' },
  ]) {
    const result = await handler.fetch(request(args));
    assert.equal(result.status, 400); assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  assert.equal(f.calls.length, 0); await handler.close();
});

test('missing Workspace capability and unknown Workspace fail closed without changing legacy actions', async () => {
  const f = fixture(); delete f.relations.workspace;
  const handler = createPanelHandler({ relations: f.relations });
  const missing = await handler.fetch(request({ action: 'workspace-relations', workspaceId: 'w' }));
  assert.equal(missing.status, 503); assert.equal((await missing.json()).error.code, 'RELATIONS_UNAVAILABLE');
  assert.equal((await handler.fetch(request({ action: 'relations', sessionId: 'a' }))).status, 200);
  assert.equal((await handler.fetch(request({ action: 'resolve', sessionId: 'a', targetId: 'b' }))).status, 200);
  f.relations.workspace = () => { throw Object.assign(new Error('PRIVATE_WORKSPACE_PATH'), { code: 'WORKSPACE_NOT_FOUND' }); };
  const unknown = await handler.fetch(request({ action: 'workspace-relations', workspaceId: 'w' }));
  assert.equal(unknown.status, 404); assert.equal((await unknown.text()).includes('PRIVATE'), false);
  await handler.close();
});

test('Workspace bodies retain 4KiB byte bounds before invoking read service', async () => {
  const f = fixture(); const handler = createPanelHandler({ relations: f.relations });
  const body = JSON.stringify({ action: 'workspace-relations', workspaceId: 'w' }) + ' '.repeat(4096);
  assert.equal((await handler.fetch(request({}, { body }))).status, 413);
  assert.equal((await handler.fetch(request({}, { body: new Uint8Array([0xff, 0xfe]) }))).status, 400);
  assert.equal(f.calls.length, 0); await handler.close();
});

test('Workspace read cancellation and timeout do not weaken owner route shutdown', async () => {
  const f = fixture(); let enter;
  const started = new Promise(resolve => { enter = resolve; });
  f.relations.workspace = () => { enter(); return new Promise(() => {}); };
  const handler = createPanelHandler({ relations: f.relations });
  const controller = new AbortController();
  const pending = handler.fetch(request({ action: 'workspace-relations', workspaceId: 'w' }, { signal: controller.signal }));
  await started; controller.abort(); assert.equal((await pending).status, 499);
  await handler.close();
  const deadline = createPanelHandler({ relations: f.relations, timeoutMs: 10 });
  const keeper = setTimeout(() => {}, 1000);
  try { assert.equal((await deadline.fetch(request({ action: 'workspace-relations', workspaceId: 'w' }))).status, 504); }
  finally { clearTimeout(keeper); await deadline.close(); }
});

test('body cannot assert principal, alternate target, or an unsupported action', async () => {
  const f = fixture(); const handler = createPanelHandler({ relations: f.relations });
  for (const args of [
    { action: 'relations', sessionId: 'self', principal: { kind: 'owner' } },
    { action: 'resolve', sessionId: 'self' },
    { action: 'relations', sessionId: 'self', targetId: 'other' },
    { action: 'deliver', sessionId: 'self' },
    { action: 'relations', sessionId: '' },
  ]) assert.equal((await handler.fetch(request(args))).status, 400);
  assert.equal(f.calls.length, 0);
  await handler.close();
});

test('invalid JSON, content type, method, pathname and oversized bytes never invoke metadata', async () => {
  const f = fixture(); const handler = createPanelHandler({ relations: f.relations });
  assert.equal((await handler.fetch(request({}, { body: '{' }))).status, 400);
  assert.equal((await handler.fetch(request({}, { headers: { 'content-type': 'text/plain' } }))).status, 415);
  assert.equal((await handler.fetch(new Request(`http://dsh.internal${PANEL_PATH}`))).status, 405);
  assert.equal((await handler.fetch(new Request('http://dsh.internal/wrong'))).status, 404);
  assert.equal((await handler.fetch(request({ text: 'x'.repeat(4096) }))).status, 413);
  assert.equal((await handler.fetch(request({}, { headers: { 'content-type': 'application/json', 'content-length': '5000' } }))).status, 413);
  assert.equal(f.calls.length, 0);
  await handler.close();
});

test('error responses expose a bounded safe taxonomy, never backend diagnostics', async () => {
  const f = fixture();
  f.relations.view = async () => { throw Object.assign(new Error('PRIVATE_HOST_PATH_AND_TOKEN'), { code: 'BACKEND_FAILURE' }); };
  const handler = createPanelHandler({ relations: f.relations });
  const result = await handler.fetch(request({ action: 'relations', sessionId: 'self' }));
  assert.equal(result.status, 503); assert.equal((await result.text()).includes('PRIVATE'), false);
  f.relations.resolve = async () => { throw Object.assign(new Error('private archive detail'), { code: 'TARGET_ARCHIVED' }); };
  const archived = await handler.fetch(request({ action: 'resolve', sessionId: 'self', targetId: 'archived' }));
  assert.equal(archived.status, 403); assert.equal((await archived.json()).error.code, 'TARGET_ARCHIVED');
  await handler.close();
});

test('slow streaming bodies are cancelled by bounded handler shutdown', async () => {
  const f = fixture(); let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const handler = createPanelHandler({ relations: f.relations });
  const pending = handler.fetch(request({}, { body: stream, duplex: 'half' }));
  await Promise.resolve();
  await handler.close();
  assert.equal((await pending).status, 503);
  assert.equal(cancelled, true); assert.equal(f.calls.length, 0);
});

test('hung metadata is bounded and late errors do not prevent close', async () => {
  const f = fixture(); f.relations.view = () => new Promise(() => {});
  const handler = createPanelHandler({ relations: f.relations, timeoutMs: 10 });
  const keeper = setTimeout(() => {}, 1000);
  try { assert.equal((await handler.fetch(request({ action: 'relations', sessionId: 'self' }))).status, 504); }
  finally { clearTimeout(keeper); await handler.close(); }
});

test('mount uses only authenticated Connection exact registration; absent auth transport fails closed', async () => {
  const f = fixture(); let route; let removes = 0;
  const mounted = mountPanelRoute({ connection: { fetch: { register(value) { route = value; return () => { removes++; }; } } } }, { relations: f.relations });
  assert.equal(route.path, PANEL_PATH); assert.deepEqual(route.methods, ['POST']); assert.equal(route.requestBody, 'streaming');
  assert.equal(mounted.path, PANEL_PATH);
  await mounted.close(); await mounted.close();
  assert.equal(removes, 1); assert.equal(f.closed, 1);
  assert.equal((await route.fetch(request({ action: 'relations', sessionId: 'self' }))).status, 503);
  assert.throws(() => mountPanelRoute({ webServer: { register() { throw new Error('NEVER USE RAW SERVER'); } } }, { relations: f.relations }), { code: 'PANEL_AUTH_UNAVAILABLE' });
});

// Optional real-runtime integration: no server/socket, no credentials or user
// configuration. This exercises the actual HostConnectionService owner gate,
// not a simulated owner check in our own handler.
test('real rc.5 Connection admits owner only and blocks non-owner exact-route requests', { skip: !process.env.DSH_RUNTIME }, async () => {
  const runtime = createRequire(resolve(process.env.DSH_RUNTIME, 'package.json'));
  const load = name => import(pathToFileURL(runtime.resolve(`@deepseek-ai/${name}`)).href);
  assert.equal(runtime('@deepseek-ai/dsh-client-connection/package.json').version, '0.2.1-rc.5');
  const { Context } = await load('cordis');
  const { HostConnectionService } = await load('dsh-client-connection');
  const root = new Context();
  const auth = { isAuthenticated: req => req.headers.cookie === 'fixture-owner=1', authenticateApi: () => undefined };
  const connection = new HostConnectionService(root, ['fixture.test'], auth);
  const f = fixture(); const mounted = mountPanelRoute(root, { relations: f.relations });
  try {
    const unauthenticated = connection.admit({ headers: { host: 'fixture.test' } });
    assert.equal(unauthenticated.rejection, 401);
    const deniedOrigin = connection.admit({ headers: { host: 'attacker.test', cookie: 'fixture-owner=1' } });
    assert.equal(deniedOrigin.rejection, 403);
    const admitted = connection.admit({ headers: { host: 'fixture.test', cookie: 'fixture-owner=1' } });
    assert.equal(admitted.peer.principal.kind, 'owner');
    const carrier = connection.createSharedFetchHandler('/api');
    const forbidden = await carrier.fetch(request({ action: 'relations', sessionId: 'self' }), { principal: { kind: 'non-owner' } });
    assert.equal(forbidden.status, 403); assert.equal(f.calls.length, 0);
    const allowed = await carrier.fetch(request({ action: 'relations', sessionId: 'self' }), admitted.peer);
    assert.equal(allowed.status, 200); assert.equal(f.calls.length, 1);
    const workspaceRequest = () => request({ action: 'workspace-relations', workspaceId: 'workspace-1' });
    const deniedWorkspace = await carrier.fetch(workspaceRequest(), { principal: { kind: 'non-owner' } });
    assert.equal(deniedWorkspace.status, 403); assert.equal(f.calls.length, 1);
    const allowedWorkspace = await carrier.fetch(workspaceRequest(), admitted.peer);
    assert.equal(allowedWorkspace.status, 200); assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[1].slice(0, 2), ['workspace', 'workspace-1']);
    const spoofedWorkspace = await carrier.fetch(request({ action: 'workspace-relations', workspaceId: 'workspace-1', principal: { kind: 'owner' } }), { principal: { kind: 'non-owner' } });
    assert.equal(spoofedWorkspace.status, 403); assert.equal(f.calls.length, 2);
    await mounted.close();
    assert.equal((await carrier.fetch(request({ action: 'relations', sessionId: 'self' }), admitted.peer)).status, 404);
  } finally { await mounted.close(); await root.fiber.dispose(); }
});
