import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createWorkspaceLink } from '../lib/workspace-link.js';
import { createRelations } from '../lib/relations.js';
import { createPanelHandler, mountPanelRoute, PANEL_PATH } from '../lib/panel-route.js';
import { createStore } from '../lib/store.js';
import { createResultDelivery } from '../lib/result-delivery.js';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'session-link-expand-review-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return realpath(dir);
}
function workspace(id, path, sessionIds = []) {
  return { id, path, sessionIds: [...sessionIds], attachSession(sessionId) { if (!this.sessionIds.includes(sessionId)) this.sessionIds.push(sessionId); } };
}
function workspaceRegistry(entries = []) {
  const values = new Map(entries.map(item => [item.id, item]));
  let creates = 0;
  return { values, get creates() { return creates; }, registry: {
    list: () => [...values.values()], get: id => values.get(id),
    async create(path) { const value = workspace(`new-${++creates}`, path); values.set(value.id, value); return value; },
  } };
}

// These tests exercise only metadata and fixtures. The real authenticated
// Connection gate is covered by the owner's DSH_RUNTIME-enabled contract test.
function relationFixture(config = {}) {
  const metadata = new Map(['root', 'child', 'grandchild', 'sibling', 'unrelated'].map(id => [id, { id, title: `Fixture ${id}`, kind: 'session', cwd: '/fixture/a', status: 'idle', live: true, canReceive: true }]));
  const state = { version: 1, deliveries: [], reception: {}, creations: [
    { senderId: 'root', sessionId: 'child', state: 'ready', handoff: { task: 't'.repeat(300), context: 'c'.repeat(400), decisions: 'SECRET_DECISIONS', constraints: 'SECRET_CONSTRAINTS' } },
    { senderId: 'child', sessionId: 'grandchild', state: 'partial' },
    { senderId: 'root', sessionId: 'sibling', state: 'ready' },
  ], tasks: [
    { id: 'fixture-task', ownerId: 'root', assigneeId: 'child', status: 'completed', result: 'SECRET_RESULT_BODY', instructions: 'SECRET_TASK_INSTRUCTIONS' },
    { id: 'other-task', ownerId: 'unrelated', assigneeId: 'grandchild', status: 'failed', result: 'SECRET_UNRELATED_RESULT' },
  ] };
  const calls = [];
  const host = { async describe(id) {
    calls.push(id);
    if (!metadata.has(id)) throw Object.assign(new Error('fixture missing'), { code: 'SESSION_NOT_FOUND' });
    return structuredClone(metadata.get(id));
  } };
  const store = { async read() { return structuredClone(state); }, mutate() { throw new Error('Read-only panel must not mutate'); } };
  const relations = createRelations({ host, store, config });
  return { metadata, state, calls, host, relations };
}
const request = payload => new Request(`http://fixture.invalid${PANEL_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

test('review expansion: explicit workspace lookup never silently substitutes another workspace identity', async t => {
  const dir = await directory(t);
  const registry = workspaceRegistry([workspace('other', dir, ['source'])]);
  registry.registry.get = () => registry.values.get('other');
  const link = createWorkspaceLink({ workspaceRegistry: registry.registry });
  await assert.rejects(link.plan({ sourceId: 'source', sourceCwd: dir, targetCwd: dir, workspaceId: 'requested' }), { code: 'WORKSPACE_CONTRACT_INVALID' });
  assert.equal(registry.creates, 0);
});

test('review expansion: planning is read-only, ensure reuses a concurrent registration, attach rejects cross-membership', async t => {
  const dir = await directory(t); const targetDir = join(dir, 'target'); await mkdir(targetDir);
  const registry = workspaceRegistry([workspace('source-workspace', dir, ['source'])]);
  const link = createWorkspaceLink({ workspaceRegistry: registry.registry });
  const plan = await link.plan({ sourceId: 'source', sourceCwd: dir, targetCwd: targetDir });
  assert.equal(plan.selection, 'new-directory');
  assert.equal(registry.creates, 0);
  registry.values.set('concurrently-registered', workspace('concurrently-registered', targetDir));
  const ensured = await link.ensure(plan);
  assert.equal(ensured.workspaceId, 'concurrently-registered');
  assert.equal(registry.creates, 0);
  registry.values.get('source-workspace').sessionIds.push('new-root');
  await assert.rejects(link.attach(ensured, 'new-root'), { code: 'WORKSPACE_MEMBERSHIP_CONFLICT' });
  assert.deepEqual(registry.values.get('concurrently-registered').sessionIds, []);
});

test('review expansion: workspace mutation identity is returned even when cancellation arrives after mutation', async t => {
  const dir = await directory(t);
  const registry = workspaceRegistry(); const controller = new AbortController();
  registry.registry.create = async path => {
    const value = workspace('created-before-abort', path); registry.values.set(value.id, value);
    controller.abort(); return value;
  };
  const link = createWorkspaceLink({ workspaceRegistry: registry.registry });
  const ensured = await link.ensure({ path: dir, selection: 'new-directory' }, { signal: controller.signal });
  assert.equal(ensured.workspaceId, 'created-before-abort');
  assert.equal(registry.values.size, 1);
  await assert.rejects(link.attach(ensured, 'new-root', { signal: controller.signal }), { code: 'ABORTED' });
});

test('review expansion: panel composition returns only bounded ancestry summaries and canonical references', async t => {
  const f = relationFixture(); t.after(() => f.relations.close());
  const handler = createPanelHandler({ relations: f.relations }); t.after(() => handler.close());
  const response = await handler.fetch(request({ action: 'relations', sessionId: 'child' }));
  assert.equal(response.status, 200);
  const value = (await response.json()).value;
  assert.deepEqual(new Set(value.nodes.map(node => node.id)), new Set(['child', 'root', 'grandchild']));
  assert.ok(!f.calls.includes('sibling'));
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /SECRET/);
  assert.equal(value.self.taskStatus, 'completed');
  assert.equal(value.self.hasResult, true);
  const incoming = value.edges.find(edge => edge.targetId === 'child');
  assert.equal(incoming.task.length, 200);
  assert.equal(incoming.contextPreview.length, 240);
  for (const node of value.nodes) {
    const encoded = node.sessionRef.match(/dsh-session:([^)]*)/)[1];
    assert.equal(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')), node.id);
  }
});

test('review expansion: directory and archive restrictions remain enforced on exact navigation outside the graph', async t => {
  const f = relationFixture({ sameDirectoryOnly: true }); t.after(() => f.relations.close());
  const handler = createPanelHandler({ relations: f.relations }); t.after(() => handler.close());
  f.metadata.get('grandchild').cwd = '/fixture/elsewhere';
  f.metadata.get('root').live = false;
  const value = (await (await handler.fetch(request({ action: 'relations', sessionId: 'child' }))).json()).value;
  assert.deepEqual(value.nodes.map(node => node.id), ['child']);
  f.metadata.get('unrelated').cwd = '/fixture/elsewhere';
  const denied = await handler.fetch(request({ action: 'resolve', sessionId: 'child', targetId: 'unrelated' }));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'ACCESS_DENIED');
  f.metadata.get('unrelated').cwd = '/fixture/a';
  f.metadata.get('unrelated').archived = true;
  const archived = await handler.fetch(request({ action: 'resolve', sessionId: 'child', targetId: 'unrelated' }));
  assert.equal(archived.status, 403);
  assert.equal((await archived.json()).error.code, 'TARGET_ARCHIVED');
});

test('review expansion: corrupt cycles and duplicate edges cannot cause unbounded graph traversal', async t => {
  const f = relationFixture({ maxRelationNodes: 2 }); t.after(() => f.relations.close());
  f.state.creations.push({ senderId: 'grandchild', sessionId: 'root', state: 'ready' }, { senderId: 'unrelated', sessionId: 'child', state: 'ready' });
  const value = await f.relations.view('child');
  assert.ok(value.nodes.length <= 2);
  assert.equal(value.truncated, true);
  assert.equal(new Set(value.nodes.map(node => node.id)).size, value.nodes.length);
  assert.ok(f.calls.length <= 2);
});

test('review expansion: malformed authentication claims and missing authenticated route cannot reach relations', async t => {
  const f = relationFixture(); t.after(() => f.relations.close());
  const handler = createPanelHandler({ relations: f.relations }); t.after(() => handler.close());
  const response = await handler.fetch(request({ action: 'relations', sessionId: 'child', principal: 'owner', authenticated: true }));
  assert.equal(response.status, 400);
  assert.equal(f.calls.length, 0);
  assert.throws(() => mountPanelRoute({ webServer: { register() { throw new Error('raw route forbidden'); } } }, { relations: f.relations }), { code: 'PANEL_AUTH_UNAVAILABLE' });
});

function clientHarness(source) {
  const slots = new Map(); const definitions = [];
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } }; },
    useState(value) { return [typeof value === 'function' ? value() : value, () => {}]; },
    useEffect() {}, useMemo(fn) { return fn(); }, useRef(value) { return { current: value }; },
  };
  const MarkdownText = function FixtureMarkdown() {};
  const ctx = {
    effect(fn) { return fn(); },
    uiConversation: { events: { register(definition) { definitions.push(definition); return () => {}; } } },
    slots: { inject(_name, fn) { return fn(); }, register(definition, Component) { slots.set(`${definition.name}:${definition.key}`, Component); return () => {}; } },
    sidebarRightTabs: { register() { return () => {}; } }, uiWorkspace: { openSession() { throw new Error('No navigation was requested'); } },
  };
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load(module) { module.factory(name => name === 'react' ? React : { MarkdownText, writeClipboard: async () => true }).apply(ctx); } } },
    TextEncoder, AbortController, setTimeout, clearTimeout,
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
  });
  return { slots, definitions, MarkdownText };
}
function visit(element, fn) {
  if (!element || typeof element !== 'object') return;
  if (Array.isArray(element)) { element.forEach(item => visit(item, fn)); return; }
  fn(element); visit(element.props?.children, fn);
}

test('review expansion: actual result producer output becomes a visible exclusive client node with full Markdown and no assistant impersonation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'session-link-producer-renderer-')); const store = await createStore(join(dir, 'ledger'));
  const events = [];
  const session = { header: { id: 'fixture-executor' }, get seq() { return events.length; }, append(type, data, options) {
    const event = { seq: events.length, time: 1000, type, data: structuredClone(data), ...options }; events.push(event); return event;
  } };
  const agent = { id: session.header.id, session, status: 'running' };
  const ctx = { agents: { get: id => id === agent.id ? agent : undefined },
    sessions: { async flush() { await writeFile(join(dir, 'surface.json'), JSON.stringify(events)); return true; } },
    sessionQuery: { async readEvent({ seq }) { return { target: events[seq], inheritedEventCount: 0 }; } },
  };
  const recorder = createResultDelivery({ ctx, store, createUserMessage: input => ({ ...input, id: 'fixture-result-message', role: 'user' }) });
  t.after(async () => { await recorder.close(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  await recorder.record({ agent, recordId: 'task:fixture:2', title: '任务结果', text: '**Actual full fixture result**\n\nFollow-up questions can refer to this result.', kind: 'task-result', relatedIds: { taskId: 'fixture', revision: 2 } });
  const event = JSON.parse(await readFile(join(dir, 'surface.json'), 'utf8'))[0];
  const client = clientHarness(await readFile(new URL('../client.js', import.meta.url), 'utf8'));
  const definition = client.definitions.find(item => item.kind === 'dsh-session-link-result');
  assert.ok(definition);
  const match = definition.match(event);
  assert.equal(match.exclusive, true);
  const location = { kind: 'event', seq: event.seq };
  const state = definition.start({}, { ...match, event, location });
  const node = definition.buildViewNode({ key: 'fixture-node', id: match.id, state, start: { location }, matches: [] });
  assert.equal(node.visibility, 'visible');
  assert.equal(node.target, 'chat');
  assert.equal(node.data.message.role, 'user');
  assert.equal(node.data.message.source.kind, 'dsh-session-link-result');
  const renderer = client.slots.get('conversation.chat.node:dsh-session-link-result');
  assert.equal(typeof renderer, 'function');
  const rendered = renderer({ sessionId: agent.id, node });
  const markdown = []; const text = [];
  visit(rendered, element => { if (element.type === client.MarkdownText) markdown.push(element.props.text); for (const child of element.props?.children ?? []) if (typeof child === 'string') text.push(child); });
  assert.equal(markdown.length, 1);
  assert.match(markdown[0], /\*\*Actual full fixture result\*\*/);
  assert.match(text.join(' '), /插件记录.*未独立验证/);
  assert.match(text.join(' '), /不是模型助手回答/);
  for (const changed of [
    { ...event, type: 'assistant/message' },
    { ...event, surfaceOp: { replace: true } },
    { ...event, data: { ...event.data, role: 'assistant' } },
    { ...event, data: { ...event.data, source: { ...event.data.source, kind: 'user' } } },
    { ...event, data: { ...event.data, source: { ...event.data.source, version: 999 } } },
  ]) assert.equal(definition.match(changed), null);
});
