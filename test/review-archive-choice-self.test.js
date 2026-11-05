import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createSessionArchiver } from '../lib/session-archive.js';

// Isolated public-API fixture only. Never mounts a Host profile or performs live archives.
function fixture(t, config = {}) {
  let state = { creations: [{ senderId: 'root', sessionId: 'child', state: 'ready' }, { senderId: 'child', sessionId: 'leaf', state: 'ready' }] }, serial = Promise.resolve();
  const headers = new Map(), agents = new Map(), cwd = new Map(), archived = [], calls = [], activities = [], active = new Map(), hooks = {};
  const workspace = { id: 'workspace', sessionIds: ['root', 'child', 'leaf', 'caller', 'ancestor'] };
  function add(id, fields = {}) { const header = { id, cwd: '/tmp', ...fields }; headers.set(id, header); agents.set(id, { id, status: 'idle', session: { header } }); cwd.set(id, '/tmp'); }
  workspace.sessionIds.forEach(id => add(id));
  const forbidden = () => assert.fail('No transcripts, model calls, resume, profile or Workspace mutation in this fixture');
  const store = {
    async read() {
      await serial; const snapshot = structuredClone(state);
      if (hooks.forbidCreations) Object.defineProperty(snapshot, 'creations', { get() { assert.fail('Explicit single must not inspect descendant provenance'); } });
      return snapshot;
    },
    mutate(mutator) {
      const operation = serial.then(async () => { const draft = structuredClone(state), result = await mutator(draft); await hooks.write?.(draft); state = draft; return structuredClone(result); });
      serial = operation.catch(() => {}); return operation;
    }
  };
  const ctx = {
    agents: { get: id => agents.get(id), list: () => [...agents.values()], create: forbidden, resume: forbidden },
    sessions: { get: id => agents.get(id)?.session, retain: forbidden },
    sessionQuery: { async listSessions() { return [...headers.values()].map(header => ({ header })); }, readEvent: forbidden, readSession: forbidden },
    workingDirectory: { get(session) { hooks.cwd?.(session.header.id); return cwd.get(session.header.id); } },
    sessionProjections: { cachedSnapshot: session => ({ values: { title: `Title ${session.header.id}` } }) },
    async waterfall(name, args) { assert.equal(name, 'workspace/session-activity'); activities.push(args.sessionId); return active.get(args.sessionId) ?? []; },
    workspaceRegistry: { archivedSessionIds: archived, list: () => [workspace], get: id => id === workspace.id ? workspace : undefined,
      async archiveSession(id, options) {
        calls.push({ id, options }); await hooks.before?.(id, options);
        if (!options.stopActivity && active.get(id)?.length) throw Object.assign(Error('Activity'), { name: 'WorkspaceActiveSessionError', sessionId: id });
        archived.push(id); await hooks.after?.(id, options);
      }, attach: forbidden, create: forbidden }
  };
  const archiver = createSessionArchiver({ ctx, store, config, metadataTimeoutMs: 300 }); t.after(() => archiver.close());
  const tool = (args = {}, exec = { agent: agents.get('caller') }) => archiver.execute({ action: 'archive', targetId: 'root', requestId: 'tool', ...args }, exec);
  const plan = (args = {}) => archiver.planForOwner({ targetId: 'root', requestId: 'prepare', ...args });
  const commit = (planId, args = {}) => archiver.commitForOwner({ planId, requestId: 'commit', ...args });
  return { archiver, ctx, store, state: () => state, agents, headers, cwd, archived, calls, activities, active, workspace, hooks, add, tool, plan, commit };
}

test('review choice: absent scope with provenance or pending creation is a question, never a committable plan', async t => {
  for (const pending of [false, true]) await t.test(pending ? 'pending creation' : 'ordinary provenance', async t => {
    const f = fixture(t);
    if (pending) await f.store.mutate(draft => { draft.creations = [{ senderId: 'root', requestedSessionId: 'future', state: 'creating' }]; });
    for (const entry of [() => f.tool(), () => f.plan()]) await assert.rejects(entry(), error => {
      assert.equal(error.code, 'ARCHIVE_SCOPE_REQUIRED'); assert.equal(error.targetId, 'root');
      assert.deepEqual(error.allowedScopes, ['single', 'related']); assert.equal(error.planId, undefined); return true;
    });
    assert.deepEqual(f.calls, []); assert.equal((f.state().archivePlans ?? []).length, 0);
  });
});

test('review choice: target authorization precedes even minimal associated-scope discovery', async t => {
  await t.test('cross-directory target exposes no choice metadata', async t => {
    const f = fixture(t, { sameDirectoryOnly: true }), other = await mkdtemp(path.join(tmpdir(), 'review-choice-cwd-'));
    t.after(() => rm(other, { recursive: true, force: true })); f.cwd.set('root', other);
    await assert.rejects(f.tool(), error => { assert.equal(error.allowedScopes, undefined); return error.code === 'ACCESS_DENIED'; });
    assert.deepEqual(f.calls, []); assert.equal((f.state().archivePlans ?? []).length, 0);
  });
  await t.test('durable ancestor exposes no choice metadata', async t => {
    const f = fixture(t); f.add('caller', { origin: 'subagent', parentSession: 'root' });
    await assert.rejects(f.tool(), error => { assert.equal(error.allowedScopes, undefined); return error.code === 'ARCHIVE_SELF_OR_ANCESTOR'; });
    assert.deepEqual(f.calls, []); assert.equal((f.state().archivePlans ?? []).length, 0);
  });
});

test('review single: explicit target-only plan and Tool path do not inspect, authorize or preflight descendants', async t => {
  for (const entry of ['owner', 'tool']) await t.test(entry, async t => {
    const f = fixture(t, { sameDirectoryOnly: true });
    f.cwd.set('child', '/outside-private-directory'); f.cwd.set('leaf', '/outside-private-directory');
    f.active.set('child', [{ kind: 'job', items: [{ id: 'job', label: 'active descendant' }] }]);
    await f.store.mutate(draft => { draft.creations.push({ senderId: 'root', state: 'creating', requestedSessionId: 'future' }); });
    f.hooks.forbidCreations = true;
    if (entry === 'owner') {
      const p = await f.plan({ archiveScope: 'single' }); assert.deepEqual(p.targets.map(item => item.id), ['root']);
      assert.equal(p.archiveScope, 'single'); assert.equal(p.requiresConfirmation, false);
      await f.commit(p.planId, { archiveScope: 'single', stopActivity: false });
    } else await f.tool({ archiveScope: 'single' });
    assert.deepEqual(f.calls.map(item => item.id), ['root']); assert.ok(f.activities.every(id => id === 'root'));
  });
});

test('review single: prior unknown child does not quarantine an unsubmitted parent, but exact unknown target stays blocked', async t => {
  const f = fixture(t), p = await f.plan({ archiveScope: 'related' });
  f.hooks.before = id => { if (id === 'child') throw Error('Unknown after native admission'); };
  await assert.rejects(f.commit(p.planId, { archiveScope: 'related' }), { code: 'ARCHIVE_UNCERTAIN' });
  assert.deepEqual(f.calls.map(item => item.id), ['leaf', 'child']);
  await assert.rejects(f.plan({ targetId: 'child', archiveScope: 'single', requestId: 'unknown-child' }), { code: 'ARCHIVE_PRIOR_UNKNOWN' });
  await assert.rejects(f.tool({ targetId: 'child', archiveScope: 'single', requestId: 'unknown-child-tool' }), { code: 'ARCHIVE_PRIOR_UNKNOWN' });
  const single = await f.plan({ archiveScope: 'single', requestId: 'safe-parent' });
  await f.commit(single.planId, { archiveScope: 'single', requestId: 'safe-parent-commit' });
  assert.deepEqual(f.calls.map(item => item.id), ['leaf', 'child', 'root']);
});

test('review scope: immutable plans reject missing or changed scope and requestId cannot authorize a different range', async t => {
  const f = fixture(t), p = await f.plan({ archiveScope: 'single' });
  await assert.rejects(f.commit(p.planId));
  await assert.rejects(f.commit(p.planId, { archiveScope: 'related' }));
  await assert.rejects(f.plan({ archiveScope: 'related' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(f.calls, []);
  await f.commit(p.planId, { archiveScope: 'single', requestId: 'valid-single' });
  assert.deepEqual(f.calls.map(item => item.id), ['root']);
  const g = fixture(t);
  await g.tool({ archiveScope: 'single', requestId: 'one-request' });
  await assert.rejects(g.tool({ archiveScope: 'related', requestId: 'one-request' }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(g.calls.map(item => item.id), ['root']);
});

test('review scope: legacy unscoped planned records cannot silently become consent for related archive', async t => {
  const f = fixture(t), p = await f.plan({ archiveScope: 'related' });
  await f.store.mutate(draft => { delete draft.archivePlans.find(item => item.planId === p.planId).archiveScope; });
  await assert.rejects(f.commit(p.planId, { archiveScope: 'related' })); assert.deepEqual(f.calls, []);
  await f.archiver.close();
  const restarted = createSessionArchiver({ ctx: f.ctx, store: f.store }); t.after(() => restarted.close());
  await assert.rejects(restarted.commitForOwner({ planId: p.planId, archiveScope: 'related', requestId: 'after-restart' }));
  assert.deepEqual(f.calls, []);
});

test('review self: caller may archive itself, but durable ancestor, forged identity and strict cwd fences remain', async t => {
  await t.test('self is discoverable and permitted', async t => {
    const f = fixture(t), agent = f.agents.get('caller');
    const listed = await f.archiver.execute({ action: 'list', query: 'caller' }, { agent });
    const self = listed.sessions.find(item => item.id === 'caller'); assert.equal(self?.isSelf, true); assert.equal(self?.canArchive, true);
    await f.tool({ targetId: 'caller', archiveScope: 'single' }, { agent }); assert.deepEqual(f.calls.map(item => item.id), ['caller']);
  });
  await t.test('durable ancestor remains forbidden', async t => {
    const f = fixture(t); f.add('caller', { origin: 'subagent', parentSession: 'ancestor' });
    await assert.rejects(f.tool({ targetId: 'ancestor', archiveScope: 'single' }), error => /ANCESTOR/.test(error.code)); assert.deepEqual(f.calls, []);
  });
  await t.test('replacement Agent is not authenticated by matching id', async t => {
    const f = fixture(t), real = f.agents.get('caller');
    await assert.rejects(f.tool({ targetId: 'caller', archiveScope: 'single' }, { agent: { ...real } }), { code: 'SENDER_NOT_LIVE' }); assert.deepEqual(f.calls, []);
  });
  await t.test('strict target directory still denied', async t => {
    const f = fixture(t, { sameDirectoryOnly: true }), other = await mkdtemp(path.join(tmpdir(), 'review-archive-cwd-'));
    t.after(() => rm(other, { recursive: true, force: true })); f.cwd.set('root', other);
    await assert.rejects(f.tool({ archiveScope: 'single' }), { code: 'ACCESS_DENIED' }); assert.deepEqual(f.calls, []);
  });
});

test('review self: cancellation and disposal caused by self-stop cannot erase durable submitted outcome', async t => {
  const f = fixture(t), agent = f.agents.get('caller'), controller = new AbortController();
  f.hooks.after = id => { if (id === 'caller') { controller.abort(); f.agents.delete(id); agent.status = 'disposed'; } };
  const result = await f.tool({ targetId: 'caller', archiveScope: 'single', stopActivity: true, requestId: 'self-stop' }, { agent, signal: controller.signal }).catch(error => error);
  assert.deepEqual(f.calls.map(item => item.id), ['caller']); assert.deepEqual(f.archived, ['caller']);
  const durable = f.state().archives.find(item => item.targetId === 'caller'); assert.equal(durable.state, 'succeeded');
  assert.notEqual(result.allStopped, true); assert.notEqual(result.definitelyNotArchived, true);
});

const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
function providerFixture(t, respond) {
  let definition, provider, requestNumber = 0, timer = 0, disposed = false;
  const requests = [], cleanups = [], timers = new Map();
  vm.runInNewContext(clientSource, {
    window: { __ModuleLoader__: { load(value) { definition = value; } } }, TextEncoder, AbortController,
    crypto: { randomUUID: () => `review-choice-${++requestNumber}` }, btoa: value => Buffer.from(value, 'binary').toString('base64'),
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    setTimeout(fn) { timers.set(++timer, fn); return timer; }, clearTimeout(id) { timers.delete(id); },
    setInterval() { assert.fail('No background polling in archive-only fixture'); }, clearInterval() {},
    async fetch(url, options) { assert.equal(url, '/api/session-link/archive'); const body = JSON.parse(options.body); requests.push({ body, options }); return respond(body, options); }
  });
  const plugin = definition.factory(name => name === 'react' ? { createElement() {}, useState() {}, useRef() {}, useEffect() {}, useMemo() {} } : { MarkdownText() {}, writeClipboard() {} });
  plugin.apply({ effect(factory) { cleanups.push(factory()); }, get() { assert.fail('Archive provider must not read display catalog'); },
    uiWorkspace: { sessionArchiveProvidersVersion: 2, registerSessionArchiveProvider(value) { provider = value; return () => {}; } },
    uiConversation: { events: { register: () => () => {} } }, sidebarRightTabs: { register: () => () => {} }, slots: { inject: () => () => {} }
  });
  const dispose = () => { if (!disposed) { disposed = true; for (const cleanup of cleanups.reverse()) cleanup?.(); } };
  t.after(dispose); return { get provider() { return provider; }, requests, dispose, timers };
}
const response = value => ({ ok: true, json: async () => ({ ok: true, value }) });
const planResponse = archiveScope => ({ handled: true, archiveScope, targetId: 'root', planId: `plan-${archiveScope}`, total: archiveScope === 'single' ? 1 : 2,
  targets: (archiveScope === 'single' ? ['root'] : ['child', 'root']).map(id => ({ id, alreadyArchived: false })), activity: [], requiresConfirmation: false });

test('review provider choice: choice cannot commit; explicit scope uses a fresh request and cancel means zero mutation', async t => {
  const f = providerFixture(t, async body => body.archiveScope ? response(planResponse(body.archiveScope)) : ({ ok: false, json: async () => ({ ok: false, error: { code: 'ARCHIVE_SCOPE_REQUIRED', targetId: 'root', allowedScopes: ['single', 'related'] } }) }));
  const choice = await f.provider.prepare('root'); assert.equal(choice.kind, 'scope-choice'); assert.equal(choice.planId, undefined);
  await assert.rejects(f.provider.commit(choice, { archiveScope: 'related', stopActivity: true }));
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].body.action, 'plan');
  const plan = await f.provider.prepare('root', { archiveScope: 'single' }); assert.equal(plan.archiveScope, 'single'); assert.equal(plan.total, 1);
  assert.notEqual(f.requests[0].body.requestId, f.requests[1].body.requestId);
  f.dispose(); await assert.rejects(f.provider.commit(plan, { archiveScope: 'single', stopActivity: false }));
  assert.ok(f.requests.every(item => item.body.action === 'plan'));
});

test('review provider choice: malformed or precommittable choice diagnostics cannot acquire scope consent', async t => {
  const valid = { code: 'ARCHIVE_SCOPE_REQUIRED', targetId: 'root', allowedScopes: ['single', 'related'] };
  for (const patch of [{ targetId: 'other' }, { allowedScopes: ['single', 'single'] }, { allowedScopes: ['single'] }, { allowedScopes: ['single', 'related', 'all'] }, { planId: 'forged' }, { targets: [] }, { outcome: {} }]) {
    const f = providerFixture(t, async () => ({ ok: false, json: async () => ({ ok: false, error: { ...valid, ...patch } }) }));
    await assert.rejects(f.provider.prepare('root')); assert.equal(f.requests.length, 1); f.dispose();
  }
  const f = providerFixture(t, async () => response(planResponse('related')));
  await assert.rejects(f.provider.prepare('root'));
  await assert.rejects(f.provider.prepare('root', { archiveScope: 'single' }));
  assert.ok(f.requests.every(item => item.body.action === 'plan'));
});

test('review provider choice: concurrent submission consumes exact binding before network settlement', async t => {
  let release;
  const f = providerFixture(t, body => body.action === 'plan' ? response(planResponse('single')) : new Promise(resolve => { release = resolve; }));
  const plan = await f.provider.prepare('root', { archiveScope: 'single' });
  const pending = f.provider.commit(plan, { archiveScope: 'single', stopActivity: false });
  await assert.rejects(f.provider.commit(plan, { archiveScope: 'single', stopActivity: false })); assert.equal(f.requests.length, 2);
  release(response({ archiveScope: 'single', archiveState: 'succeeded', archivedIds: ['root'], remaining: [], failed: [], stopActivityRequested: false }));
  assert.equal((await pending).archiveState, 'succeeded');
  await assert.rejects(f.provider.commit(plan, { archiveScope: 'single', stopActivity: false })); assert.equal(f.requests.length, 2);
});

test('review provider choice: mismatched returned scope or stop consent never masquerades as accepted success', async t => {
  for (const patch of [{ archiveScope: 'related' }, { stopActivityRequested: true }]) {
    const f = providerFixture(t, async body => response(body.action === 'plan' ? planResponse('single') : { archiveScope: 'single', archiveState: 'succeeded', archivedIds: ['root'], remaining: [], failed: [], stopActivityRequested: false, ...patch }));
    const plan = await f.provider.prepare('root', { archiveScope: 'single' });
    await assert.rejects(f.provider.commit(plan, { archiveScope: 'single', stopActivity: false }));
    await assert.rejects(f.provider.commit(plan, { archiveScope: 'single', stopActivity: false })); assert.equal(f.requests.length, 2); f.dispose();
  }
});

test('review provider choice: scope and stop consent are independent; admitted unknown commit is one-shot', async t => {
  const f = providerFixture(t, async body => {
    if (body.action === 'plan') return response({ ...planResponse('related'), requiresConfirmation: true,
      activity: [{ sessionId: 'child', title: 'Child', totalGroups: 1, groups: [{ kind: 'job', totalItems: 1, items: [{ id: 'job', label: 'work' }] }] }] });
    return { ok: false, json: async () => ({ ok: false, error: { code: 'ARCHIVE_UNCERTAIN', outcome: { archiveScope: 'related', archiveState: 'unknown', archivedIds: [], remaining: ['child', 'root'], failed: [{ id: 'child', state: 'unknown' }], stopActivityRequested: true } } }) };
  });
  const plan = await f.provider.prepare('root', { archiveScope: 'related' });
  await assert.rejects(f.provider.commit(plan, { archiveScope: 'single', stopActivity: true }));
  await assert.rejects(f.provider.commit(plan, { archiveScope: 'related', stopActivity: false })); assert.equal(f.requests.length, 1);
  const result = await f.provider.commit(plan, { archiveScope: 'related', stopActivity: true }); assert.equal(result.archiveState, 'unknown');
  await assert.rejects(f.provider.commit(plan, { archiveScope: 'related', stopActivity: true })); assert.equal(f.requests.length, 2);
});
