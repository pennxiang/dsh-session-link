import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelations } from '../lib/relations.js';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const peer = (id, patch = {}) => ({ id, title: `Title ${id}`, kind: 'session', status: 'idle', live: true, archived: false, canReceive: true, cwd: '/fixture', ...patch });
const edge = (source, target, patch = {}) => ({ senderId: source, sessionId: target, state: 'ready', createdAt: 10, ...patch });
function fixture({ creations = [], tasks = [], peers = [], reception = {}, config = {}, workspaces } = {}) {
  const readIds = [];
  const records = new Map(peers.map(item => [item.id, item]));
  const state = { version: 1, creations, tasks, reception };
  const host = {
    async describe(id, { signal }) {
      signal.throwIfAborted(); readIds.push(id);
      if (!records.has(id)) throw Object.assign(new Error('missing'), { code: 'SESSION_NOT_FOUND' });
      return structuredClone(records.get(id));
    },
    deliver() { throw new Error('MUST NOT DELIVER'); },
    activity() { throw new Error('MUST NOT READ TRANSCRIPT'); },
    list() { throw new Error('MUST NOT ENUMERATE HOST'); },
  };
  const store = { read: async () => structuredClone(state), mutate() { throw new Error('MUST NOT MUTATE'); } };
  return { service: createRelations({ host, store, workspaces, config }), host, store, state, records, readIds };
}

function workspaceFixture(options = {}) {
  const workspace = { id: 'workspace-1', path: '/PRIVATE_WORKSPACE_PATH', sessionIds: options.members ?? ['a', 'b', 'c'] };
  const workspaces = { get: id => id === workspace.id ? workspace : undefined };
  for (const method of ['create', 'ensure', 'attach', 'retain', 'resume', 'list']) workspaces[method] = () => assert.fail(`read-only Workspace projection must not call ${method}`);
  const f = fixture({ peers: ['a', 'b', 'c'].map(id => peer(id)), creations: [edge('a', 'b')], ...options, workspaces });
  for (const method of ['create', 'ensure', 'attach', 'retain', 'resume']) f.host[method] = () => assert.fail(`read-only Host projection must not call ${method}`);
  return { ...f, workspace, workspaces };
}

test('persistent ancestry and descendants form a creation tree, never native children or sibling browsing', async () => {
  const f = fixture({ creations: [edge('ancestor', 'self'), edge('ancestor', 'sibling'), edge('self', 'child'), edge('child', 'grandchild'), edge('elsewhere', 'secret')],
    peers: ['ancestor', 'self', 'sibling', 'child', 'grandchild', 'elsewhere', 'secret'].map(id => peer(id)) });
  const view = await f.service.view('self');
  assert.deepEqual(view.nodes.map(item => item.id), ['self', 'ancestor', 'child', 'grandchild']);
  assert.deepEqual(view.edges.map(item => [item.sourceId, item.targetId, item.kind]), [
    ['ancestor', 'self', 'created-session'], ['self', 'child', 'created-session'], ['child', 'grandchild', 'created-session']]);
  assert.equal(view.nodes.some(item => 'parentId' in item || 'unread' in item), false);
  assert.equal(f.readIds.includes('sibling'), false);
  // Owner-authorized exact navigation also supports non-graph peer tool refs.
  assert.equal((await f.service.resolve('self', 'sibling')).targetId, 'sibling');
  assert.equal((await f.service.resolve('self', 'secret')).targetId, 'secret');
  assert.equal((await f.service.resolve('self', 'grandchild')).targetId, 'grandchild');
  assert.equal((await f.service.resolve('self', 'self')).targetId, 'self');
  await f.service.close();
});

test('offline navigation is metadata-only, archived and missing targets explicitly reject', async () => {
  const f = fixture({ creations: [edge('self', 'cold'), edge('self', 'archived'), edge('self', 'gone')],
    peers: [peer('self'), peer('cold', { status: 'persisted', live: false, canReceive: false }), peer('archived', { archived: true })] });
  const view = await f.service.view('self');
  assert.equal(view.nodes.find(item => item.id === 'cold').state, 'offline');
  assert.equal(view.nodes.find(item => item.id === 'cold').canOpen, true);
  const archived = view.nodes.find(item => item.id === 'archived');
  assert.equal(archived.state, 'archived'); assert.equal(archived.canOpen, false); assert.equal(archived.canReceive, false);
  assert.equal(view.nodes.some(item => item.id === 'gone'), false);
  assert.equal((await f.service.resolve('self', 'cold')).targetId, 'cold');
  await assert.rejects(() => f.service.resolve('self', 'archived'), { code: 'TARGET_ARCHIVED' });
  await assert.rejects(() => f.service.resolve('self', 'gone'), { code: 'TARGET_NOT_FOUND' });
});

test('directory fence rejects cold headers and never traverses an inaccessible ancestor', async () => {
  const f = fixture({ config: { sameDirectoryOnly: true }, creations: [edge('hidden', 'self'), edge('outer', 'hidden'), edge('self', 'cold'), edge('self', 'allowed')],
    peers: [peer('self'), peer('hidden', { cwd: '/other' }), peer('outer'), peer('cold', { live: false, status: 'persisted' }), peer('allowed')] });
  assert.deepEqual((await f.service.view('self')).nodes.map(item => item.id), ['self', 'allowed']);
  assert.equal(f.readIds.includes('outer'), false);
  await assert.rejects(() => f.service.resolve('self', 'cold'), { code: 'ACCESS_DENIED' });
});

test('cycles, duplicate parents and malicious metadata cannot create an unbounded graph', async () => {
  const f = fixture({ creations: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('evil', 'b'), edge('a', 'a')],
    peers: [peer('a'), peer('b', { title: 'x'.repeat(10000), systemPrompt: 'PRIVATE', unread: 99, parentId: 'fake-parent' }), peer('c'), peer('evil')] });
  const view = await f.service.view('a');
  assert.equal(new Set(view.nodes.map(item => item.id)).size, view.nodes.length);
  assert.ok(view.edges.length <= view.nodes.length - 1);
  assert.equal(view.nodes.find(item => item.id === 'b').title.length, 256);
  assert.equal(JSON.stringify(view).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(view).includes('fake-parent'), false);
  assert.equal(f.readIds.includes('evil'), false);
});

test('bounds returned nodes after missing metadata, and clips explicit handoff summaries', async () => {
  const f = fixture({ config: { maxRelationNodes: 3 }, creations: [edge('self', 'missing'), edge('self', 'a', { handoff: { task: 't'.repeat(4000), context: 'c'.repeat(4000), decisions: 'SECRET_DECISIONS' } }), edge('self', 'b'), edge('self', 'c')],
    peers: ['self', 'a', 'b', 'c'].map(id => peer(id)) });
  const view = await f.service.view('self');
  assert.deepEqual(view.nodes.map(item => item.id), ['self', 'a', 'b']);
  assert.equal(view.truncated, true);
  assert.equal(view.edges[0].task.length, 200);
  assert.equal(view.edges[0].contextPreview.length, 240);
  assert.equal(JSON.stringify(view).includes('SECRET_DECISIONS'), false);
  assert.equal(f.readIds.includes('c'), false);
});

test('task state/result existence are independent of runtime and no result body escapes', async () => {
  const f = fixture({ creations: [edge('self', 'child')], peers: [peer('self'), peer('child', { status: 'running' })],
    reception: { child: { enabled: false } }, tasks: [
      { ownerId: 'self', assigneeId: 'child', status: 'working', updatedAt: 1 },
      { ownerId: 'self', assigneeId: 'child', status: 'completed', updatedAt: 2, result: 'PRIVATE_RESULT', instructions: 'PRIVATE_TASK' },
      { ownerId: 'stranger', assigneeId: 'child', status: 'failed', updatedAt: 3, result: 'PRIVATE_UNRELATED' },
    ] });
  const child = (await f.service.view('self')).nodes.find(item => item.id === 'child');
  assert.equal(child.state, 'running'); assert.equal(child.taskStatus, 'completed'); assert.equal(child.hasResult, true);
  assert.equal(child.canReceive, false);
  assert.equal(JSON.stringify(child).includes('PRIVATE'), false);
});

test('host identity mismatch and metadata errors fail closed rather than appearing as missing', async () => {
  const f = fixture({ creations: [edge('self', 'bad')], peers: [peer('self')] });
  f.host.describe = async id => id === 'self' ? peer(id) : peer('wrong');
  await assert.rejects(() => f.service.view('self'), { code: 'IDENTITY_MISMATCH' });
  f.host.describe = async () => { throw Object.assign(new Error('provider problem'), { code: 'BROKEN_METADATA' }); };
  await assert.rejects(() => f.service.view('self'), { code: 'BROKEN_METADATA' });
});

test('close and caller cancellation settle ignored-cancellation reads without waiting for provider', async () => {
  const f = fixture({ peers: [peer('self')] });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  f.host.describe = async () => { started(); return new Promise(() => {}); };
  const read = f.service.view('self');
  await entered;
  await f.service.close();
  await assert.rejects(read, { code: 'READ_SCOPE_CLOSED' });
  await assert.rejects(() => f.service.view('self'), { code: 'READ_SCOPE_CLOSED' });
  const other = fixture({ peers: [peer('self')] });
  const cancel = new AbortController(); cancel.abort();
  await assert.rejects(() => other.service.view('self', { signal: cancel.signal }), { code: 'ABORTED' });
  assert.equal(other.readIds.length, 0);
});

test('canonical Session mention preserves an opaque Unicode/quoted identity and safely escaped label', async () => {
  const id = '会话-"opaque"';
  const title = 'label]\\tail';
  const f = fixture({ peers: [peer(id, { title })] });
  const item = (await f.service.view(id)).self;
  const uri = item.sessionRef.slice(item.sessionRef.indexOf('](dsh-session:') + 2, -1);
  assert.equal(JSON.parse(Buffer.from(uri.slice('dsh-session:'.length), 'base64url').toString('utf8')), id);
  assert.equal(item.sessionRef, `@[label\\]\\\\tail](${uri})`);
  if (process.env.DSH_RUNTIME) {
    const runtime = createRequire(resolve(process.env.DSH_RUNTIME, 'package.json'));
    const native = await import(pathToFileURL(runtime.resolve('@deepseek-ai/dsh-session-reference')).href);
    assert.equal(item.sessionRef, native.formatSessionReferenceMention({ sessionId: id, label: title }));
    assert.equal(native.decodeSessionReferenceUri(uri), id);
  }
});

test('default graph limit never exceeds 200 nodes or introduces orphan edges', async () => {
  const ids = Array.from({ length: 220 }, (_, i) => `child-${i}`);
  const f = fixture({ creations: ids.map(id => edge('self', id)), peers: [peer('self'), ...ids.map(id => peer(id))] });
  const view = await f.service.view('self');
  assert.equal(view.nodes.length, 200);
  assert.equal(view.edges.length, 199);
  assert.equal(view.truncated, true);
  const included = new Set(view.nodes.map(item => item.id));
  assert.ok(view.edges.every(item => included.has(item.sourceId) && included.has(item.targetId)));
});

test('Workspace projection returns only minimal schema and real same-Workspace ordinary creation edges', async () => {
  const f = workspaceFixture({ creations: [edge('a', 'b', { handoff: { task: 'SECRET_TASK', context: 'SECRET_CONTEXT' }, provider: 'SECRET_PROVIDER', permission: 'SECRET_PERMISSION' }), edge('b', 'c', { state: 'partial' })],
    tasks: [{ ownerId: 'a', assigneeId: 'b', status: 'completed', result: 'SECRET_RESULT' }] });
  const result = await f.service.workspace('workspace-1');
  assert.deepEqual(result, { schemaVersion: 1, workspaceId: 'workspace-1', edges: [
    { sourceId: 'a', targetId: 'b', kind: 'created-session' }, { sourceId: 'b', targetId: 'c', kind: 'created-session' }], truncated: false });
  assert.equal(/SECRET|PRIVATE|cwd|handoff|context|provider|permission|title|task|createdAt/u.test(JSON.stringify(result)), false);
  assert.deepEqual(f.readIds, ['a', 'b', 'c']);
  assert.deepEqual(f.workspace.sessionIds, ['a', 'b', 'c']);
  assert.equal(f.state.creations.length, 2);
  await f.service.close();
});

test('Workspace projection accepts partial/unknown existing roots, never requested ids or creating/failed intents', async () => {
  const f = workspaceFixture({ members: ['a', 'b', 'c', 'd', 'e'], peers: ['a', 'b', 'c', 'd', 'e'].map(id => peer(id)), creations: [
    edge('a', 'b', { state: 'partial' }), edge('a', 'c', { state: 'unknown' }), edge('a', 'd', { state: 'creating' }), edge('a', 'e', { state: 'failed' }),
    { senderId: 'a', requestedSessionId: 'e', state: 'unknown' },
  ] });
  assert.deepEqual((await f.service.workspace('workspace-1')).edges.map(item => item.targetId), ['b', 'c']);
  assert.deepEqual(f.readIds, ['a', 'b', 'c']);
});

test('cross-Workspace and nonmembers never trigger metadata reads or override first retained provenance', async () => {
  const f = workspaceFixture({ creations: [edge('elsewhere', 'b'), edge('a', 'b'), edge('a', 'outside'), edge('a', 'c')] });
  const result = await f.service.workspace('workspace-1');
  assert.deepEqual(result.edges, [{ sourceId: 'a', targetId: 'c', kind: 'created-session' }]);
  assert.deepEqual(f.readIds, ['a', 'c']);
});

test('Workspace membership is rechecked after metadata reads without moving or retaining members', async () => {
  const f = workspaceFixture(); const describe = f.host.describe;
  f.host.describe = async (...args) => { const result = await describe(...args); f.workspace.sessionIds = ['a']; return result; };
  assert.deepEqual((await f.service.workspace('workspace-1')).edges, []);
  assert.deepEqual(f.workspace.sessionIds, ['a']);
});

test('Workspace cycles, self edges and duplicate parents yield a deterministic acyclic forest', async () => {
  const f = workspaceFixture({ creations: [edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('c', 'b'), edge('a', 'a'), edge('a', 'b')] });
  assert.deepEqual((await f.service.workspace('workspace-1')).edges.map(item => [item.sourceId, item.targetId]), [['a', 'b'], ['b', 'c']]);
});

test('Workspace roots exclude archived, missing, fork, subagent, Sidechat and unclassified peers', async () => {
  const patches = [{ archived: true }, { parentId: 'a' }, { parentId: null }, { kind: 'subagent' }, { kind: 'sidechat' }, { kind: 'unknown' }, { archived: undefined }];
  for (const patch of patches) {
    const f = workspaceFixture({ peers: [peer('a'), peer('b', patch)] });
    assert.deepEqual((await f.service.workspace('workspace-1')).edges, []);
    f.records.set('a', peer('a', patch)); f.records.set('b', peer('b'));
    assert.deepEqual((await f.service.workspace('workspace-1')).edges, []);
  }
  const missing = workspaceFixture({ peers: [peer('a')] });
  assert.deepEqual((await missing.service.workspace('workspace-1')).edges, []);
});

test('cold root metadata is nonactivating; configured directory fence needs both live absolute effective cwd', async () => {
  const cold = workspaceFixture({ peers: [peer('a', { live: false, status: 'persisted' }), peer('b', { live: false, status: 'persisted' })] });
  assert.equal((await cold.service.workspace('workspace-1')).edges.length, 1);
  const f = workspaceFixture({ config: { sameDirectoryOnly: true } });
  assert.equal((await f.service.workspace('workspace-1')).edges.length, 1);
  for (const patch of [{ live: false }, { cwd: '/other' }, { cwd: '' }, { cwd: 'relative' }, { cwd: '/bad\u0000path' }, { cwd: undefined }]) {
    f.records.set('b', peer('b', patch));
    assert.deepEqual((await f.service.workspace('workspace-1')).edges, []);
  }
  f.records.set('b', peer('b')); f.records.set('a', peer('a', { live: false }));
  assert.deepEqual((await f.service.workspace('workspace-1')).edges, []);
});

test('unknown/mismatched Workspace and missing registry fail only the new projection', async () => {
  const f = workspaceFixture();
  await assert.rejects(() => f.service.workspace('unknown'), { code: 'WORKSPACE_NOT_FOUND' });
  assert.deepEqual(f.readIds, []);
  f.workspaces.get = () => ({ id: 'wrong', sessionIds: ['a', 'b'] });
  await assert.rejects(() => f.service.workspace('workspace-1'), { code: 'IDENTITY_MISMATCH' });
  f.workspaces.get = () => ({ id: 'workspace-1', sessionIds: null });
  await assert.rejects(() => f.service.workspace('workspace-1'), { code: 'RELATIONS_UNAVAILABLE' });
  const legacy = fixture({ peers: [peer('a'), peer('b')], creations: [edge('a', 'b')] });
  await assert.rejects(() => legacy.service.workspace('workspace-1'), { code: 'RELATIONS_UNAVAILABLE' });
  assert.equal((await legacy.service.view('a')).edges.length, 1);
  assert.equal((await legacy.service.resolve('a', 'b')).targetId, 'b');
});

test('Workspace identity mismatch and unexpected backend failure do not masquerade as absent membership', async () => {
  const f = workspaceFixture();
  f.host.describe = async () => peer('wrong');
  await assert.rejects(() => f.service.workspace('workspace-1'), { code: 'IDENTITY_MISMATCH' });
  f.host.describe = async () => { throw Object.assign(new Error('PRIVATE_DIAGNOSTIC'), { code: 'BROKEN_METADATA' }); };
  await assert.rejects(() => f.service.workspace('workspace-1'), { code: 'BROKEN_METADATA' });
});

test('Workspace edge cap and ledger scan cap explicitly report truncation', async () => {
  const ids = Array.from({ length: 205 }, (_, i) => `child-${i}`);
  const f = workspaceFixture({ members: ['a', ...ids], peers: ['a', ...ids].map(id => peer(id)), creations: ids.map(id => edge('a', id)) });
  const result = await f.service.workspace('workspace-1');
  assert.equal(result.edges.length, 200); assert.equal(result.truncated, true);
  assert.equal(f.readIds.includes('child-200'), false);
  const small = workspaceFixture({ creations: [edge('a', 'b'), edge('a', 'c')], config: { maxRelationNodes: 1 } });
  assert.equal((await small.service.workspace('workspace-1')).edges.length, 1);
  assert.equal((await small.service.workspace('workspace-1')).truncated, true);
  const ledger = workspaceFixture({ creations: [...Array.from({ length: 1000 }, () => edge('outside', 'absent')), edge('a', 'b')] });
  assert.deepEqual(await ledger.service.workspace('workspace-1'), { schemaVersion: 1, workspaceId: 'workspace-1', edges: [], truncated: true });
  assert.deepEqual(ledger.readIds, []);
});

test('Workspace metadata cancellation, shutdown and deadline settle without activating ignored reads', async () => {
  const f = workspaceFixture(); let enter;
  const started = new Promise(resolve => { enter = resolve; });
  f.host.describe = () => { enter(); return new Promise(() => {}); };
  const controller = new AbortController();
  const pending = f.service.workspace('workspace-1', { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'ABORTED' });
  await started; controller.abort(); await rejected;
  const pendingClose = f.service.workspace('workspace-1');
  const closed = assert.rejects(pendingClose, { code: 'READ_SCOPE_CLOSED' });
  await f.service.close(); await closed;
  const timeout = workspaceFixture({ config: { relationTimeoutMs: 10 } });
  timeout.workspaces.get = () => new Promise(() => {});
  const keeper = setTimeout(() => {}, 1000);
  try { await assert.rejects(() => timeout.service.workspace('workspace-1'), { code: 'METADATA_TIMEOUT' }); }
  finally { clearTimeout(keeper); await timeout.service.close(); }
});

test('read deadline bounds a hung store read and validates configuration', async () => {
  const keeper = setTimeout(() => {}, 1000);
  try {
    const service = createRelations({ host: { describe: async id => peer(id) }, store: { read: () => new Promise(() => {}) }, config: { relationTimeoutMs: 10 } });
    await assert.rejects(() => service.view('self'), { code: 'METADATA_TIMEOUT' });
    await service.close();
    assert.throws(() => fixture({ config: { maxRelationNodes: 201 } }), { code: 'INVALID_CONFIG' });
    await assert.rejects(() => fixture().service.view('bad\nidentity'), { code: 'INVALID_ARGUMENT' });
  } finally { clearTimeout(keeper); }
});
