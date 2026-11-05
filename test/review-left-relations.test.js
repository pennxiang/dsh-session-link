import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRelations } from '../lib/relations.js';
import { createPanelHandler, mountPanelRoute } from '../lib/panel-route.js';

// Independent fixtures only; never use the running Host, user profile or Session logs.
const edge = (sourceId, targetId) => ({ sourceId, targetId, kind: 'created-session' });
const record = (senderId, sessionId, extra = {}) => ({ senderId, sessionId, state: 'ready', ...extra });
const root = id => ({ id, kind: 'session', archived: false, live: true, cwd: '/fixture/workspace', status: 'idle' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t, options = {}) {
  const ids = options.ids ?? ['a', 'b', 'c'];
  const metadata = new Map(ids.map(id => [id, root(id)]));
  const state = { creations: options.creations ?? [record('a', 'b')], tasks: [{ result: 'private task secret' }] };
  let membership = [...ids];
  const reads = [], mutations = [];
  const forbidden = name => () => { mutations.push(name); throw new Error(`Forbidden mutation ${name}`); };
  const host = {
    async describe(id, { signal }) {
      reads.push(['describe', id]);
      await options.describe?.(id, { metadata, signal, setMembers: value => { membership = value; } });
      if (!metadata.has(id)) throw Object.assign(new Error('missing'), { code: 'SESSION_NOT_FOUND' });
      return metadata.get(id);
    },
    resume: forbidden('resume'), activate: forbidden('activate'), readTranscript: forbidden('transcript'),
  };
  const workspaces = {
    async get(id) {
      reads.push(['workspace', id]);
      if (options.workspace) return options.workspace(id, { membership, reads });
      return id === 'w' ? { id, sessionIds: membership, path: '/irrelevant/creation/path' } : undefined;
    },
    ensure: forbidden('ensure'), attach: forbidden('attach'), retain: forbidden('retain'),
  };
  const relations = createRelations({ host, workspaces, store: { async read() { reads.push(['ledger']); return state; }, mutate: forbidden('ledger mutation') }, config: options.config });
  t.after(async () => { await relations.close(); assert.deepEqual(mutations, []); });
  return { relations, metadata, state, reads, setMembers: value => { membership = value; } };
}

test('review left backend: current registry controls both ends, minimal projection never exposes ledger/Host secrets', async t => {
  const f = fixture(t, { ids: ['a', 'b', 'c'], creations: [
    record('a', 'b', { state: 'partial', workspaceId: 'historic-other', handoff: { task: 'secret', context: 'secret' }, requestedSessionId: 'requested-secret' }),
    record('a', 'outside', { workspaceId: 'w' }),
    record('b', 'c', { state: 'unknown', cwd: '/private', model: 'private-model' }),
  ] });
  f.metadata.set('a', { ...root('a'), title: 'secret-title', provider: 'secret-provider', permission: 'private' });
  const value = await f.relations.workspace('w');
  assert.deepEqual(value, { schemaVersion: 1, workspaceId: 'w', edges: [edge('a', 'b'), edge('b', 'c')], truncated: false });
  assert.equal(JSON.stringify(value).includes('secret'), false);
  assert.deepEqual(f.reads.filter(([name]) => name === 'workspace'), [['workspace', 'w'], ['workspace', 'w']]);
  assert.equal(f.reads.some(([, id]) => id === 'outside'), false);
});

test('review left backend: membership shrink while describe awaits retracts the edge and does not reinterpret a later duplicate', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { creations: [record('a', 'b'), record('c', 'b')], describe: async id => { if (id === 'b') { entered.resolve(); await release.promise; } } });
  const pending = f.relations.workspace('w');
  await entered.promise;
  f.setMembers(['b', 'c']);
  release.resolve();
  assert.deepEqual((await pending).edges, []);
});

test('review left backend: identity failure is closed, endpoint masks details, no replacement Workspace accepted', async t => {
  const f = fixture(t, { workspace: () => ({ id: 'wrong-private-workspace', sessionIds: ['a', 'b'] }) });
  await assert.rejects(f.relations.workspace('w'), { code: 'IDENTITY_MISMATCH' });
  const handler = createPanelHandler({ relations: f.relations });
  t.after(() => handler.close());
  const response = await handler.fetch(new Request('http://fixture/api/session-link/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'workspace-relations', workspaceId: 'w' }) }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: { code: 'RELATIONS_UNAVAILABLE', message: 'Session relations are temporarily unavailable.' } });
  assert.equal(f.reads.some(([name]) => name === 'describe'), false);
});

test('review left backend: all rejected metadata categories and synthetic creation states stay out of the display forest', async t => {
  const rejected = ['archived', 'fork', 'child', 'btw', 'unknown-kind', 'archive-unknown', 'missing'];
  const ids = ['a', 'ready', 'partial', 'unknown', 'allocated', 'failed', ...rejected];
  const f = fixture(t, { ids, creations: [
    ...['ready', 'partial', 'unknown'].map(state => record('a', state, { state })),
    record('a', 'allocated', { state: 'creating' }), record('a', 'failed', { state: 'failed' }),
    ...rejected.map(id => record('a', id)),
  ] });
  f.metadata.set('archived', { ...root('archived'), archived: true });
  f.metadata.set('fork', { ...root('fork'), parentId: 'some-parent' });
  f.metadata.set('child', { ...root('child'), kind: 'subagent' });
  f.metadata.set('btw', { ...root('btw'), kind: 'sidechat' });
  f.metadata.set('unknown-kind', { ...root('unknown-kind'), kind: undefined });
  f.metadata.set('archive-unknown', { ...root('archive-unknown'), archived: undefined });
  f.metadata.delete('missing');
  assert.deepEqual((await f.relations.workspace('w')).edges, ['ready', 'partial', 'unknown'].map(id => edge('a', id)));
});

test('review left backend: sameDirectory requires two live absolute effective cwd values, never historical Workspace.path', async t => {
  for (const patch of [{ cwd: '/different' }, { live: false }, { cwd: 'relative' }, { cwd: '/fixture/\nworkspace' }, { cwd: '' }, { cwd: undefined }]) {
    await t.test(JSON.stringify(patch), async t => {
      const f = fixture(t, { config: { sameDirectoryOnly: true } });
      f.metadata.set('b', { ...root('b'), ...patch });
      assert.deepEqual((await f.relations.workspace('w')).edges, []);
    });
  }
  const f = fixture(t, { config: { sameDirectoryOnly: true } });
  f.metadata.set('b', { ...root('b'), cwd: '/fixture/other/../workspace' });
  assert.deepEqual((await f.relations.workspace('w')).edges, [edge('a', 'b')]);
});

test('review left backend: forest keeps first provenance, no cycles or extra parents and explicit bound', async t => {
  const f = fixture(t, { ids: ['a', 'b', 'c', 'd', 'e'], creations: [record('outside', 'b'), record('a', 'b'), record('a', 'c'), record('c', 'd'), record('d', 'a'), record('d', 'e'), record('a', 'a')] });
  assert.deepEqual((await f.relations.workspace('w')).edges, [edge('a', 'c'), edge('c', 'd'), edge('d', 'e')]);
  const limited = fixture(t, { ids: ['a', 'b', 'c', 'd'], creations: [record('a', 'b'), record('b', 'c'), record('c', 'd')], config: { maxRelationNodes: 2 } });
  assert.deepEqual(await limited.relations.workspace('w'), { schemaVersion: 1, workspaceId: 'w', edges: [edge('a', 'b'), edge('b', 'c')], truncated: true });
});

test('review left backend: cancellation during metadata read never publishes a late result or continues reading peers', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { describe: async id => { if (id === 'a') { entered.resolve(); await release.promise; } } });
  const controller = new AbortController();
  const pending = f.relations.workspace('w', { signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.reads.filter(([name]) => name === 'describe'), [['describe', 'a']]);
});

test('review left endpoint: no raw server fallback, strict mutually exclusive fields, bounded body and close removes route', async t => {
  const f = fixture(t);
  let raw = 0;
  assert.throws(() => mountPanelRoute({ webServer: { register() { raw++; } } }, { relations: f.relations }), { code: 'PANEL_AUTH_UNAVAILABLE' });
  assert.equal(raw, 0);
  let registration, removed = 0;
  const mount = mountPanelRoute({ connection: { fetch: { register(value) { registration = value; return () => { removed++; }; } } } }, { relations: f.relations });
  assert.deepEqual({ path: registration.path, methods: registration.methods, requestBody: registration.requestBody }, { path: '/api/session-link/view', methods: ['POST'], requestBody: 'streaming' });
  const call = body => registration.fetch(new Request('http://fixture/api/session-link/view', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  for (const extra of [{ sessionId: 'a' }, { targetId: 'b' }, { principal: { kind: 'owner' } }, { includeArchived: true }, { limit: 100 }, { workspaceId: '\n' }]) {
    assert.equal((await call({ action: 'workspace-relations', workspaceId: 'w', ...extra })).status, 400);
  }
  assert.equal((await call({ action: 'workspace-relations', workspaceId: 'w', bad: 'x'.repeat(4100) })).status, 413);
  assert.equal(f.reads.length, 0);
  const response = await call({ action: 'workspace-relations', workspaceId: 'w' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual((await response.json()).value.edges, [edge('a', 'b')]);
  await mount.close(); await mount.close(); assert.equal(removed, 1);
});

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const plainValue = value => JSON.parse(JSON.stringify(value));
const workspaceList = (items = [{ workspaceId: 'w', sessionIds: ['a', 'b'] }]) => ({ phase: 'ready', state: 'idle', items });
// Only root registration is executed. No React mount, DOM tree, real HTTP or browser.
function clientFixture(t, { version = 1, state = workspaceList(), hidden = false } = {}) {
  let definition, registration, disposed = false, serial = 0, reads = 0, serviceReads = 0;
  const effects = [], subscribers = new Set(), visibility = new Set(), timers = new Map(), calls = [];
  const document = { visibilityState: hidden ? 'hidden' : 'visible', addEventListener(name, fn) { assert.equal(name, 'visibilitychange'); visibility.add(fn); }, removeEventListener(name, fn) { assert.equal(name, 'visibilitychange'); visibility.delete(fn); } };
  const noopRegistration = () => () => {};
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { definition = value; } } }, document, AbortController, TextEncoder, console,
    btoa: input => Buffer.from(input, 'binary').toString('base64'),
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, ms, interval: false }); return id; }, clearTimeout: id => timers.delete(id),
    setInterval(fn, ms) { const id = ++serial; timers.set(id, { fn, ms, interval: true }); return id; }, clearInterval: id => timers.delete(id),
    fetch(url, options) {
      assert.equal(url, '/api/session-link/view'); assert.equal(options.credentials, 'same-origin');
      const pending = deferred();
      const body = JSON.parse(options.body); assert.equal(body.action, 'workspace-relations');
      const call = { body, signal: options.signal, respond(value) { pending.resolve({ ok: true, status: 200, json: async () => ({ ok: true, value }) }); } };
      calls.push(call); return pending.promise;
    },
  };
  vm.runInNewContext(clientSource, sandbox, { filename: 'review-client-root.js' });
  const plugin = definition.factory(name => {
    if (name === 'react') return {};
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {};
    throw new Error(`Unexpected require ${name}`);
  });
  plugin.apply({
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose; },
    get(name) { serviceReads++; assert.equal(name, 'workspaces'); return { list: { getSnapshot() { reads++; return state; }, subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); } } }; },
    uiWorkspace: { sessionRelationsVersion: version, registerSessionRelations(value) { assert.equal(registration, undefined); registration = value; return () => { registration = undefined; }; }, openSession() { assert.fail('Must not open Session'); } },
    slots: { inject(_name, fn) { return fn(); }, register: noopRegistration }, sidebarRightTabs: { register: noopRegistration }, uiConversation: { events: { register: noopRegistration } },
  });
  const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  const dispose = () => { if (disposed) return; disposed = true; for (const cleanup of effects.reverse()) cleanup?.(); };
  t.after(dispose);
  return {
    get source() { return registration?.source; }, get reads() { return reads; }, get serviceReads() { return serviceReads; }, subscribers, visibility, timers, calls, settle, dispose,
    setState(next, notify = true) { state = next; if (notify) for (const fn of [...subscribers]) fn(); },
    async show(show) { document.visibilityState = show ? 'visible' : 'hidden'; for (const fn of [...visibility]) fn(); await settle(); },
    async tick() { for (const timer of [...timers.values()]) if (timer.interval) timer.fn(); await settle(); },
  };
}
const wire = (workspaceId = 'w', edges = [edge('a', 'b')], extra = {}) => ({ schemaVersion: 1, workspaceId, edges, truncated: false, ...extra });

test('review left source: capability gate and subscriber/visibility ownership are side-effect-free on old Hosts', async t => {
  for (const version of [0, 2, '1']) {
    const f = clientFixture(t, { version });
    assert.equal(f.source, undefined); assert.equal(f.serviceReads, 0); assert.equal(f.reads, 0); assert.equal(f.timers.size, 0); assert.equal(f.visibility.size, 0);
  }
  const f = clientFixture(t, { hidden: true });
  assert.equal(f.reads, 0); assert.equal(f.calls.length, 0);
  const remove = f.source.subscribe(() => {});
  assert.equal(f.reads, 0); assert.equal(f.subscribers.size, 0);
  await f.show(true);
  assert.equal(f.calls.length, 1); assert.equal(f.subscribers.size, 1);
  const remove2 = f.source.subscribe(() => {});
  assert.equal(f.calls.length, 1); assert.equal(f.subscribers.size, 1);
  remove(); assert.equal(f.calls[0].signal.aborted, false);
  remove2(); assert.equal(f.calls[0].signal.aborted, true); assert.equal(f.visibility.size, 0); assert.equal(f.subscribers.size, 0); assert.equal(f.timers.size, 0);
  f.calls[0].respond(wire()); await f.settle();
  assert.deepEqual(plainValue(f.source.getSnapshot()), { schemaVersion: 1, edges: [], truncated: false, loading: false });
});

test('review left source: silently changed current membership blocks stale commit, full wire metadata is stripped', async t => {
  const f = clientFixture(t);
  f.source.subscribe(() => {});
  const old = f.calls[0];
  f.setState(workspaceList([{ workspaceId: 'w', sessionIds: ['a', 'c'] }]), false);
  old.respond(wire()); await f.settle();
  // The completed HTTP read has already released its abort listener; only its publication is rejected.
  assert.equal(f.calls.length, 2);
  assert.deepEqual(plainValue(f.source.getSnapshot().edges), []);
  f.calls[1].respond(wire('w', [edge('a', 'b'), { ...edge('a', 'c'), title: 'private title', context: 'private context', parentSession: 'private native parent' }], { handoff: 'private body' }));
  await f.settle();
  assert.deepEqual(plainValue(f.source.getSnapshot()), { schemaVersion: 1, edges: [{ workspaceId: 'w', ...edge('a', 'c') }], truncated: true, loading: false });
  const snapshot = f.source.getSnapshot();
  assert.equal(f.source.getSnapshot(), snapshot); assert.ok(Object.isFrozen(snapshot)); assert.ok(Object.isFrozen(snapshot.edges)); assert.ok(Object.isFrozen(snapshot.edges[0]));
  f.setState({ ...workspaceList([{ workspaceId: 'w', sessionIds: ['a', 'c'], title: 'new title' }]) });
  await f.settle(); assert.equal(f.calls.length, 2); assert.equal(f.source.getSnapshot(), snapshot);
});

test('review left source: bounded four workers, Workspace removal and disposal cancel all requests without late publication', async t => {
  const items = Array.from({ length: 7 }, (_, i) => ({ workspaceId: `w${i}`, sessionIds: ['a', 'b'] }));
  const f = clientFixture(t, { state: workspaceList(items) });
  let notifications = 0;
  f.source.subscribe(() => { notifications++; });
  assert.equal(f.calls.length, 4);
  f.calls[0].respond(wire('w0')); await f.settle(); assert.equal(f.calls.length, 5);
  f.calls[1].respond(wire('w1')); await f.settle(); assert.equal(f.calls.length, 6);
  f.setState(workspaceList([])); await f.settle();
  assert.equal(f.calls.slice(2).every(call => call.signal.aborted), true); // already completed calls released their abort listeners
  assert.deepEqual(plainValue(f.source.getSnapshot().edges), []);
  const source = f.source; f.dispose();
  const before = notifications;
  for (const call of f.calls) call.respond(wire(call.body.workspaceId));
  await f.settle();
  assert.equal(notifications, before); assert.deepEqual(plainValue(source.getSnapshot().edges), []);
  assert.equal(f.timers.size, 0); assert.equal(f.visibility.size, 0); assert.equal(f.subscribers.size, 0);
});

test('review left source: hidden tab and incomplete public list retract previously published relationships', async t => {
  const f = clientFixture(t); f.source.subscribe(() => {});
  f.calls[0].respond(wire()); await f.settle(); assert.equal(f.source.getSnapshot().edges.length, 1);
  await f.show(false);
  assert.equal(f.source.getSnapshot().edges.length, 0); assert.equal(f.source.getSnapshot().truncated, true); assert.equal(f.subscribers.size, 0); assert.equal(f.timers.size, 0);
  await f.show(true); f.calls[1].respond(wire()); await f.settle(); assert.equal(f.source.getSnapshot().edges.length, 1);
  f.setState({ ...workspaceList(), state: 'loading' }); await f.settle();
  assert.deepEqual(plainValue(f.source.getSnapshot()), { schemaVersion: 1, edges: [], truncated: true, loading: true });
  assert.equal(f.calls.length, 2);
});

// Optional patched DSH source checkout. Executes pure module code, never a Host app.
const nativeModuleUrl = process.env.DSH_NATIVE_SOURCE
  ? pathToFileURL(resolve(process.env.DSH_NATIVE_SOURCE, 'packages/client/ui-workspace/src/client/session-relations.ts'))
  : new URL('../../.worktrees/dsh-left-tree-rc5/packages/client/ui-workspace/src/client/session-relations.ts', import.meta.url);
let native;
try {
  const source = await readFile(nativeModuleUrl, 'utf8');
  const javascript = stripTypeScriptTypes(source, { mode: 'transform' });
  native = await import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
} catch (error) {
  if (error.code !== 'ENOENT' || process.env.DSH_NATIVE_SOURCE) throw error;
}
const nativeTest = (name, fn) => test(name, { skip: native === undefined ? 'Optional native owner checkout is not present' : false }, fn);
const nativeEdge = (sourceId, targetId, workspaceId = 'w') => ({ workspaceId, sourceId, targetId, kind: 'created-session' });
const nativeNode = (id, extra = {}) => Object.freeze({ id, blank: false, archived: false, title: id, ...extra });

nativeTest('review native forest: current membership, fork/origin guards, first parent and cycle rejection never mutate inputs', () => {
  const ids = ['a', 'b', 'c', 'd', 'fork', 'child', 'ambiguous'];
  const summaries = Object.freeze(Object.fromEntries(ids.map(id => [id, Object.freeze({ id, ...(id === 'fork' ? { parentId: 'a' } : {}), ...(id === 'child' ? { origin: 'subagent' } : {}) })])));
  const workspaces = Object.freeze([{ workspaceId: 'w', sessionIds: Object.freeze(ids) }, { workspaceId: 'other', sessionIds: Object.freeze(['ambiguous']) }].map(Object.freeze));
  const edges = Object.freeze([
    nativeEdge('a', 'b'), nativeEdge('c', 'b'), nativeEdge('b', 'c'), nativeEdge('c', 'a'),
    nativeEdge('a', 'fork'), nativeEdge('fork', 'd'), nativeEdge('a', 'child'), nativeEdge('child', 'd'),
    nativeEdge('a', 'ambiguous'), nativeEdge('a', 'missing'), nativeEdge('a', 'd', 'other'), nativeEdge('a', 'a'),
  ].map(Object.freeze));
  const before = JSON.stringify({ summaries, workspaces, edges });
  assert.deepEqual([...native.sessionRelationParents(summaries, workspaces, edges)], [['b', 'a'], ['c', 'b']]);
  assert.deepEqual([...native.sessionRelationParents(summaries, [{ workspaceId: 'w', sessionIds: ['b', 'd'] }], edges)], []);
  assert.equal(JSON.stringify({ summaries, workspaces, edges }), before);
});

nativeTest('review native rows: no provider preserves native identity, order and watermark, related component is never split', () => {
  const [u, c, b, a, d, blank] = ['u', 'c', 'b', 'a', 'd', 'blank'].map(id => nativeNode(id, { blank: id === 'blank' }));
  const rows = Object.freeze([u, c, b, a, d, blank]);
  const flat = native.relatedSessionRows(rows, [u, c, blank], new Map(), 'w', {});
  assert.deepEqual(flat.rows.map(row => row.node), [u, c, blank]); assert.equal(flat.hiddenCount, 3);
  for (const row of flat.rows) { assert.equal(row.node, rows.find(item => item.id === row.node.id)); assert.equal(row.displayParentId, undefined); assert.equal(row.hasChildren, false); }
  const parents = new Map([['b', 'a'], ['c', 'b']]);
  const projected = native.relatedSessionRows(rows, [c], parents, 'w', {});
  assert.deepEqual(projected.rows.map(row => [row.node.id, row.displayParentId]), [['a', undefined], ['b', 'a'], ['c', 'a']]);
  assert.equal(projected.hiddenCount, 2); // unrelated u/d count; blank never does
  assert.deepEqual(projected.rows.map(row => row.branches.length), [0, 1, 1]);
  assert.deepEqual(projected.rows.map(row => row.hasChildren), [true, false, false]);
  const childCollapsed = native.relatedSessionRows(rows, [c], parents, 'w', { [native.sessionRelationExpansionKey('w', 'b')]: false });
  assert.deepEqual(childCollapsed, projected); // legacy child expansion preferences cannot hide descendants
  assert.deepEqual([...parents], [['b', 'a'], ['c', 'b']]); // provenance stays multi-hop; only display is flattened
  assert.equal(new Set(projected.rows.map(row => row.node.id)).size, 3);
  for (const row of projected.rows) assert.equal(row.node, rows.find(item => item.id === row.node.id));
  const collapsed = native.relatedSessionRows(rows, [c], parents, 'w', { [native.sessionRelationExpansionKey('w', 'a')]: false });
  assert.deepEqual(collapsed.rows.map(row => row.node.id), ['a']); assert.equal(collapsed.hiddenCount, 2);
  assert.equal(collapsed.rows[0].hasChildren, true); assert.equal(collapsed.rows[0].expanded, false);
  assert.deepEqual(rows.map(row => row.id), ['u', 'c', 'b', 'a', 'd', 'blank']);
});

nativeTest('review native rows: all descendants share one display level, retain DFS order and only roots fold', () => {
  const ids = ['e', 'f', 'b', 'c', 'p', 'r', 'q', 'unrelated'];
  const rows = Object.freeze(ids.map(id => nativeNode(id)));
  const byId = Object.fromEntries(rows.map(row => [row.id, row]));
  const parents = new Map([['b', 'p'], ['e', 'b'], ['c', 'p'], ['f', 'c'], ['r', 'q']]);
  const originalProvenance = [...parents];
  const childPreferences = Object.freeze({
    [native.sessionRelationExpansionKey('w', 'b')]: false,
    [native.sessionRelationExpansionKey('w', 'c')]: false,
    [native.sessionRelationExpansionKey('w', 'e')]: false,
  });
  const projected = native.relatedSessionRows(rows, [byId.e, byId.r], parents, 'w', childPreferences);
  assert.deepEqual(projected.rows.map(row => [row.node.id, row.displayParentId, row.branches.length, row.hasChildren]), [
    ['p', undefined, 0, true], ['b', 'p', 1, false], ['e', 'p', 1, false],
    ['c', 'p', 1, false], ['f', 'p', 1, false], ['q', undefined, 0, true], ['r', 'q', 1, false],
  ]);
  assert.deepEqual(projected.rows.filter(row => row.displayParentId === 'p').map(row => row.branches[0].last), [false, false, false, true]);
  assert.equal(projected.hiddenCount, 1);
  assert.equal(new Set(projected.rows.map(row => row.node.id)).size, 7);
  for (const row of projected.rows) assert.equal(row.node, byId[row.node.id]);
  const folded = native.relatedSessionRows(rows, [byId.e, byId.r], parents, 'w', {
    ...childPreferences, [native.sessionRelationExpansionKey('w', 'p')]: false,
  });
  assert.deepEqual(folded.rows.map(row => row.node.id), ['p', 'q', 'r']);
  assert.equal(folded.hiddenCount, projected.hiddenCount);
  assert.equal(folded.rows[0].expanded, false);
  assert.deepEqual([...parents], originalProvenance);
  assert.deepEqual(rows.map(row => row.id), ids);
});

nativeTest('review native rows: hidden or archived parent detaches children, archive/show and Ungrouped stay native roots', () => {
  const a = nativeNode('a'), b = nativeNode('b'), c = nativeNode('c');
  const parents = new Map([['b', 'a'], ['c', 'b']]);
  const orphan = native.relatedSessionRows([b, c], [c], parents, 'w', {});
  assert.deepEqual(orphan.rows.map(row => [row.node.id, row.displayParentId]), [['b', undefined], ['c', 'b']]);
  const archived = nativeNode('b', { archived: true });
  const shown = native.relatedSessionRows([a, archived, c], [a, archived, c], parents, 'w', {});
  assert.deepEqual(shown.rows.map(row => [row.node.id, row.displayParentId]), [['a', undefined], ['b', undefined], ['c', undefined]]);
  const ungrouped = native.relatedSessionRows([c, b, a], [c, b, a], parents, undefined, {});
  assert.deepEqual(ungrouped.rows.map(row => [row.node.id, row.displayParentId]), [['c', undefined], ['b', undefined], ['a', undefined]]);
  assert.notEqual(native.sessionRelationExpansionKey('w/x', 'y'), native.sessionRelationExpansionKey('w', 'x/y'));
  assert.notEqual(native.sessionRelationExpansionKey('w', 'a'), native.sessionRelationExpansionKey('other', 'a'));
});

nativeTest('review native registry: stable snapshots, lazy subscriptions, provider removal and HMR release every resource', () => {
  const registry = new native.SessionRelationsRegistry();
  let value = { schemaVersion: 1, edges: [nativeEdge('a', 'b')], loading: false, truncated: false };
  let subscriptions = 0, removals = 0, notifications = 0;
  const listeners = new Set();
  const source = { getSnapshot: () => value, subscribe(fn) { subscriptions++; listeners.add(fn); return () => { removals++; listeners.delete(fn); }; } };
  const unregister = registry.register({ id: 'fixture', version: 1, source });
  assert.equal(subscriptions, 0); assert.equal(registry.getSnapshot(), registry.getSnapshot());
  assert.throws(() => registry.register({ id: 'fixture', version: 1, source }), /already registered/);
  const stop = registry.subscribe(() => { notifications++; });
  assert.equal(subscriptions, 1); assert.equal(registry.getSnapshot().edges.length, 1);
  const snapshot = registry.getSnapshot(); assert.equal(registry.getSnapshot(), snapshot);
  value = { schemaVersion: 1, edges: [], loading: true, truncated: true };
  for (const fn of [...listeners]) fn();
  assert.notEqual(registry.getSnapshot(), snapshot); assert.equal(registry.getSnapshot().loading, true); assert.equal(registry.getSnapshot().truncated, true);
  stop(); assert.equal(removals, 1); assert.equal(listeners.size, 0);
  const stop2 = registry.subscribe(() => { notifications++; }); assert.equal(subscriptions, 2);
  unregister(); unregister(); assert.equal(removals, 2); assert.equal(listeners.size, 0); assert.deepEqual(registry.getSnapshot().edges, []);
  assert.equal(registry.getSnapshot().loading, false); assert.equal(registry.getSnapshot().truncated, false);
  registry.register({ id: 'fixture', version: 1, source }); assert.equal(subscriptions, 3);
  registry.dispose(); assert.equal(removals, 3); assert.equal(listeners.size, 0);
  const last = notifications; stop2(); for (const fn of [...listeners]) fn(); assert.equal(notifications, last);
});

nativeTest('review native/provider composition: real plugin source starts only when native aggregate is consumed and removes cleanly', async t => {
  const f = clientFixture(t);
  const registry = new native.SessionRelationsRegistry();
  t.after(() => registry.dispose());
  const unregister = registry.register({ id: 'dsh-session-link', version: 1, source: f.source });
  assert.equal(f.calls.length, 0); assert.equal(f.subscribers.size, 0);
  const stop = registry.subscribe(() => {});
  assert.equal(f.calls.length, 1); assert.equal(f.subscribers.size, 1);
  f.calls[0].respond(wire()); await f.settle();
  assert.deepEqual(plainValue(registry.getSnapshot().edges), [nativeEdge('a', 'b')]);
  unregister(); assert.deepEqual(registry.getSnapshot().edges, []);
  assert.equal(f.subscribers.size, 0); assert.equal(f.timers.size, 0); assert.equal(f.visibility.size, 0);
  stop(); registry.dispose();
});
