import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createSessionArchiver } from '../lib/session-archive.js';
import { createArchiveHandler, mountArchiveRoute, ARCHIVE_PATH } from '../lib/archive-route.js';
import { TOOLS } from '../lib/tool-schema.js';
import { createService } from '../lib/service.js';
import vm from 'node:vm';

// Independently render the production plugin's registered seats. No browser, Host profile or network.
const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const uri = id => `dsh-session:${Buffer.from(JSON.stringify(id)).toString('base64url')}`;
const ref = (id, title) => ({ id, uri: uri(id), ...(title === undefined ? {} : { title }) });
const catalog = entries => ({ phase: 'ready', byId: Object.fromEntries(Object.entries(entries).map(([id, title]) => [id, { id, title }])) });
const text = value => Array.isArray(value) ? value.map(text).join('') : value && typeof value === 'object' ? text(value.children) : value == null || value === false ? '' : String(value);
function findNodes(tree, predicate) {
  const found = [];
  function visit(value) {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    if (predicate(value)) found.push(value);
    visit(value.children);
  }
  visit(tree); return found;
}
const titles = tree => findNodes(tree, node => node.type === 'button' && node.props.className === 'sl-btn sl-title');
function titleFixture(t, { state = catalog({ target: 'Current' }), available = true, hidden = false, archiveVersion, archiveFetch } = {}) {
  let active, moduleDefinition, snapshot = state, reads = 0, serviceReads = 0, nextTimer = 0, nextRequest = 0, archiveProvider, archiveRemoves = 0;
  const catalogListeners = new Set(), visibilityListeners = new Set(), cleanups = [], mounted = new Set();
  const registrations = [], requests = [], opened = [], forbidden = [], timers = new Map();
  const depsEqual = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
    useState(initial) {
      const seat = active, index = seat.cursor++;
      seat.hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial };
      return [seat.hooks[index].value, value => {
        if (!seat.mounted) seat.lateWrites++;
        const old = seat.hooks[index].value;
        const next = typeof value === 'function' ? value(old) : value;
        if (!Object.is(old, next)) { seat.hooks[index].value = next; seat.dirty = true; }
      }];
    },
    useRef(value) { return active.hooks[active.cursor++] ||= { current: value }; },
    useMemo(factory, deps) {
      const index = active.cursor++, old = active.hooks[index];
      if (!old || !depsEqual(old.deps, deps)) active.hooks[index] = { value: factory(), deps };
      return active.hooks[index].value;
    },
    useEffect(factory, deps) {
      const seat = active, index = seat.cursor++, old = seat.hooks[index];
      if (!old || !depsEqual(old.deps, deps)) seat.effects.push(() => {
        old?.cleanup?.(); seat.hooks[index] = { deps, cleanup: factory() };
      });
    }
  };
  const document = {
    visibilityState: hidden ? 'hidden' : 'visible',
    addEventListener(name, callback) { assert.equal(name, 'visibilitychange'); visibilityListeners.add(callback); },
    removeEventListener(name, callback) { assert.equal(name, 'visibilitychange'); visibilityListeners.delete(callback); }
  };
  const sandbox = {
    window: { __ModuleLoader__: { load(definition) { moduleDefinition = definition; } } }, document,
    TextEncoder, AbortController, crypto: { randomUUID: () => `review-${++nextRequest}` }, btoa: value => Buffer.from(value, 'binary').toString('base64'),
    localStorage: { getItem: () => null, setItem() { forbidden.push('localStorage'); throw Error('No persistence in title observer'); } },
    setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { forbidden.push('interval'); throw Error('No title polling'); }, clearInterval() {},
    async fetch(url, options) {
      const body = JSON.parse(options.body); requests.push({ url, body, signal: options.signal, options });
      if (url === '/api/session-link/archive' && archiveFetch) return archiveFetch(url, options);
      return { ok: true, json: async () => ({ ok: true, value: { targetId: body.targetId } }) };
    }
  };
  vm.runInNewContext(clientSource, sandbox, { filename: 'client.js' });
  const plugin = moduleDefinition.factory(name => {
    if (name === 'react') return React;
    assert.equal(name, '@deepseek-ai/dsh-client-ui-primitives');
    return { MarkdownText: 'MarkdownText', writeClipboard() { forbidden.push('clipboard'); throw Error('No title clipboard reads'); } };
  });
  const list = {
    getSnapshot() { reads++; return snapshot; },
    subscribe(listener) { catalogListeners.add(listener); return () => catalogListeners.delete(listener); }
  };
  const services = new Proxy({ list }, { get(target, name) {
    if (name === 'list') return target.list;
    forbidden.push(String(name)); throw Error(`Forbidden sessions API: ${String(name)}`);
  } });
  plugin.apply({
    effect(factory) { const cleanup = factory(); cleanups.push(cleanup); return cleanup; },
    get(name) { assert.equal(name, 'sessions'); serviceReads++; return available ? services : undefined; },
    uiWorkspace: { openSession(id) { opened.push(id); }, sessionArchiveProvidersVersion: archiveVersion,
      registerSessionArchiveProvider(provider) { assert.equal(archiveProvider, undefined); archiveProvider = provider; return () => { archiveRemoves++; }; } },
    uiConversation: { events: { register: () => () => {} } },
    sidebarRightTabs: { register: () => () => {} },
    slots: {
      inject(_name, factory) { return factory(); },
      register(definition, Component) { registrations.push({ ...definition, Component }); return () => {}; }
    }
  });
  function mount(key, props) {
    const registration = registrations.find(item => item.key === key);
    assert.ok(registration, key);
    const seat = { cursor: 0, hooks: [], effects: [], dirty: true, mounted: true, lateWrites: 0, props };
    seat.render = () => {
      assert.ok(seat.mounted); active = seat; seat.cursor = 0; seat.effects = []; seat.dirty = false;
      seat.tree = registration.Component(seat.props); active = undefined;
      for (const effect of seat.effects) effect();
    };
    seat.flush = async () => { for (let count = 0; count < 20; count++) { await Promise.resolve(); if (seat.mounted && seat.dirty) seat.render(); } };
    seat.update = props => { seat.props = { ...seat.props, ...props }; seat.render(); };
    seat.unmount = () => {
      if (!seat.mounted) return;
      for (const hook of seat.hooks) hook?.cleanup?.();
      seat.mounted = false; mounted.delete(seat);
    };
    mounted.add(seat); seat.render(); return seat;
  }
  let disposed = false;
  const dispose = () => {
    if (disposed) return; disposed = true;
    for (const cleanup of cleanups.reverse()) cleanup?.();
  };
  t.after(() => { for (const seat of [...mounted]) seat.unmount(); dispose(); assert.deepEqual(forbidden, []); });
  return {
    tool(refs, sessionId = 'executor') { return mount('link_send', { sessionId, toolName: 'link_send', phase: 'result', block: { content: [{ type: 'text', text: JSON.stringify({ sessionRefs: refs }) }] } }); },
    result(message) { return mount('dsh-session-link-result', { sessionId: 'executor', node: { data: { message } } }); },
    set(value) { snapshot = value; for (const listener of [...catalogListeners]) listener(); },
    visibility(value) { document.visibilityState = value; for (const listener of [...visibilityListeners]) listener(); },
    get reads() { return reads; }, get serviceReads() { return serviceReads; },
    get archiveProvider() { return archiveProvider; }, get archiveRemoves() { return archiveRemoves; },
    catalogListeners, visibilityListeners, requests, opened, timers, dispose
  };
}

test('review titles: current exact id overrides historic labels; identity and navigation never follow the title', async t => {
  const f = titleFixture(t, { state: catalog({ target: 'Target title', other: 'Other title' }) });
  const refs = [ref('target', 'Stale title')];
  const original = JSON.stringify(refs), seat = f.tool(refs);
  await seat.flush(); assert.deepEqual(titles(seat.tree).map(text), ['Target title']);
  f.set(catalog({ target: '<img src=x onerror=attack()>', other: 'Target title' }));
  await seat.flush(); assert.deepEqual(titles(seat.tree).map(text), ['<img src=x onerror=attack()>']);
  assert.equal(findNodes(seat.tree, node => node.type === 'img' || node.props.dangerouslySetInnerHTML).length, 0);
  assert.equal(f.requests.length, 0); assert.equal(f.timers.size, 0);
  await titles(seat.tree)[0].props.onClick(); await seat.flush();
  assert.deepEqual(f.requests.map(item => item.body), [{ action: 'resolve', sessionId: 'executor', targetId: 'target' }]);
  assert.deepEqual(f.opened, ['target']); assert.equal(JSON.stringify(refs), original);
  const cleared = catalog({ target: undefined }); cleared.byId.target.displayTitle = '/private/cwd-or-id-fallback';
  f.set(cleared); await seat.flush(); assert.deepEqual(titles(seat.tree).map(text), ['未命名会话']);
});

test('review titles: catalog alias, sessionId-only, inherited keys and forged URI never supply another identity title', async t => {
  const state = catalog({ exact: 'Exact' });
  state.byId.alias = { id: 'exact', title: 'Wrong alias title' };
  state.byId.legacy = { sessionId: 'legacy', title: 'Not a SessionSummary id' };
  Object.setPrototypeOf(state.byId, { inherited: { id: 'inherited', title: 'Prototype title' } });
  const f = titleFixture(t, { state });
  const seat = f.tool([ref('exact'), ref('alias', 'Honest fallback'), ref('legacy'), ref('inherited'), { id: 'forged', uri: uri('exact'), title: 'Forged' }]);
  await seat.flush(); assert.deepEqual(titles(seat.tree).map(text), ['Exact', 'Honest fallback', '未命名会话', '未命名会话']);
  assert.equal(f.requests.length, 0); assert.deepEqual(f.opened, []);
});

test('review titles: historical result ids rename in place without reading Markdown or retaining sessions', async t => {
  const f = titleFixture(t, { state: catalog({ owner: 'Owner', child: 'Child' }) });
  const message = {
    id: 'fixture-result', role: 'user',
    source: { kind: 'dsh-session-link-result', form: 'notice', version: 1, recordId: 'record', recordKind: 'task-result', relatedIds: { ownerId: 'owner', targetId: 'child' } },
    content: [{ type: 'text', text: '[Forged](dsh-session:anything) peer suggested title' }]
  };
  const before = JSON.stringify(message), seat = f.result(message);
  await seat.flush(); assert.deepEqual(titles(seat.tree).map(text), ['Owner', 'Child']);
  f.set(catalog({ owner: 'Owner', child: 'Renamed' })); await seat.flush();
  assert.deepEqual(titles(seat.tree).map(text), ['Owner', 'Renamed']);
  assert.equal(JSON.stringify(message), before); assert.equal(f.requests.length, 0);
  seat.update({ node: { data: { message: { ...message, role: 'assistant' } } } }); await seat.flush();
  assert.equal(seat.tree, null); assert.equal(f.catalogListeners.size, 0);
});

test('review titles: one visible shared observer, stale callbacks after hide/unmount/unload cannot read or notify', async t => {
  const f = titleFixture(t, { hidden: true });
  assert.equal(f.serviceReads, 0);
  const a = f.tool([ref('target')]), b = f.tool([ref('target', 'Fallback')]);
  await a.flush(); await b.flush(); assert.equal(f.reads, 0); assert.equal(f.catalogListeners.size, 0);
  f.visibility('visible'); await a.flush(); await b.flush(); assert.equal(f.catalogListeners.size, 1);
  assert.deepEqual(titles(a.tree).map(text), ['Current']);
  const stale = [...f.catalogListeners][0];
  f.visibility('hidden'); await a.flush(); await b.flush(); const reads = f.reads;
  stale(); assert.equal(f.reads, reads); assert.equal(f.catalogListeners.size, 0);
  f.set(catalog({ target: 'After hidden' })); f.visibility('visible'); await a.flush(); await b.flush();
  assert.deepEqual(titles(a.tree).map(text), ['After hidden']); stale(); assert.equal(f.catalogListeners.size, 1);
  a.unmount(); assert.equal(f.catalogListeners.size, 1);
  const stale2 = [...f.catalogListeners][0]; b.unmount(); stale2();
  assert.equal(f.catalogListeners.size, 0); assert.equal(f.visibilityListeners.size, 0);
  const c = f.tool([ref('target')]); await c.flush(); const stale3 = [...f.catalogListeners][0];
  f.dispose(); const disposedReads = f.reads; stale3(); assert.equal(f.reads, disposedReads);
  c.unmount(); assert.equal(a.lateWrites + b.lateWrites + c.lateWrites, 0);
  assert.equal(f.catalogListeners.size, 0); assert.equal(f.visibilityListeners.size, 0); assert.equal(f.requests.length, 0);
});

test('review titles: old Hosts degrade to bounded explicit labels or unnamed, not IDs or displayTitle', async t => {
  const f = titleFixture(t, { available: false });
  const seat = f.tool([ref('fallback', ' Valid title '), ref('id-only', 'id-only'), ref('empty', '  '), ref('control', 'bad\u0001title'), ref('large', 'x'.repeat(4097)), ref('missing')]);
  await seat.flush(); assert.deepEqual(titles(seat.tree).map(text), ['Valid title', ...Array(5).fill('未命名会话')]);
  assert.equal(f.reads, 0); assert.equal(f.catalogListeners.size, 0); assert.equal(f.requests.length, 0);
});

function cascadeFixture(t, config = {}) {
  let state = { creations: [
    { senderId: 'root', sessionId: 'child', state: 'ready', workspaceId: 'obsolete', handoff: 'PRIVATE HANDOFF' },
    { senderId: 'child', sessionId: 'leaf', state: 'partial' }
  ] }, serial = Promise.resolve();
  const headers = new Map(), agents = new Map(), cwd = new Map(), nativeCalls = [], activityReads = [], active = new Map(), archived = [];
  const workspace = { id: 'current', sessionIds: ['root', 'child', 'leaf'] }, outside = { id: 'outside', sessionIds: [] };
  const hooks = {};
  function add(id, fields = {}, live = true) {
    const header = { id, cwd: '/tmp', ...fields }; headers.set(id, header); cwd.set(id, '/tmp');
    if (live) agents.set(id, { id, status: 'idle', session: { header } });
  }
  for (const id of [...workspace.sessionIds, 'caller', 'other-caller']) add(id);
  const forbidden = () => { throw Error('Forbidden transcript, model, resume or Workspace creation operation'); };
  const store = {
    async read() { await serial; return structuredClone(state); },
    mutate(mutator) {
      const operation = serial.then(async () => { const next = structuredClone(state); const result = await mutator(next); await hooks.write?.(next); state = next; return structuredClone(result); });
      serial = operation.catch(() => {}); return operation;
    }
  };
  const ctx = {
    agents: { get: id => agents.get(id), list: () => [...agents.values()], resume: forbidden, create: forbidden },
    sessions: { get: id => agents.get(id)?.session, retain: forbidden },
    sessionQuery: { async listSessions() { await hooks.metadata?.(); return [...headers.values()].map(header => ({ header })); }, readSession: forbidden, readEvent: forbidden },
    workingDirectory: { get(session) { hooks.cwd?.(session.header.id); return cwd.get(session.header.id); } },
    sessionProjections: { cachedSnapshot: session => ({ values: { title: `Title ${session.header.id}`, hidden: 'PRIVATE PROJECTION' } }) },
    async waterfall(name, args) { assert.equal(name, 'workspace/session-activity'); activityReads.push(args.sessionId); await hooks.activity?.(args.sessionId); return active.get(args.sessionId) ?? []; },
    workspaceRegistry: {
      archivedSessionIds: archived,
      list: () => [workspace, outside], get: id => id === workspace.id ? workspace : id === outside.id ? outside : undefined,
      async archiveSession(id, options) {
        nativeCalls.push({ id, options }); await hooks.beforeArchive?.(id, options);
        if (!options.stopActivity && active.get(id)?.length) throw Object.assign(Error('private active data'), { name: 'WorkspaceActiveSessionError', sessionId: id });
        archived.push(id); await hooks.afterArchive?.(id, options);
      }, create: forbidden, attach: forbidden, retain: forbidden
    }
  };
  const archiver = createSessionArchiver({ ctx, store, config, metadataTimeoutMs: 300 }); t.after(() => archiver.close());
  return { archiver, ctx, store, state: () => state, headers, agents, cwd, nativeCalls, activityReads, active, archived, workspace, outside, hooks, add,
    exec: { agent: agents.get('caller') },
    plan: (args = {}, options = {}) => archiver.planForOwner({ targetId: 'root', requestId: 'plan', archiveScope: 'related', ...args }, options),
    commit: (planId, args = {}, options = {}) => archiver.commitForOwner({ planId, requestId: 'commit', archiveScope: 'related', ...args }, options) };
}

test('review cascade: strict Tool cwd cannot drift after an earlier target was authorized', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'review-cascade-cwd-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const inside = join(temp, 'inside'), outside = join(temp, 'outside'); await mkdir(inside); await mkdir(outside);
  const f = cascadeFixture(t, { sameDirectoryOnly: true }); for (const id of f.cwd.keys()) f.cwd.set(id, inside);
  let drifted = false;
  f.hooks.cwd = id => {
    if (!drifted && id === 'root' && f.state().archivePlans?.some(plan => plan.items.find(item => item.id === 'leaf')?.state === 'submitting')) {
      // Grandchild was checked first. Drift its effective cwd during the last
      // target's authorization, not its durable header or Agent identity.
      drifted = true; f.cwd.set('leaf', outside);
    }
  };
  await assert.rejects(f.archiver.execute({ action: 'archive', archiveScope: 'related', targetId: 'root', requestId: 'tool-cwd-race' }, f.exec), error => error.code === 'ACCESS_DENIED' || error.code === 'ARCHIVE_PLAN_CHANGED');
  assert.equal(drifted, true); assert.deepEqual(f.nativeCalls, []);
});

test('review cascade: current membership cannot drift during final whole-group authorization', async t => {
  const f = cascadeFixture(t, { sameDirectoryOnly: true }); let drifted = false;
  f.hooks.cwd = id => {
    if (!drifted && id === 'root' && f.state().archivePlans?.some(plan => plan.items.find(item => item.id === 'leaf')?.state === 'submitting')) {
      drifted = true; f.workspace.sessionIds.splice(f.workspace.sessionIds.indexOf('leaf'), 1); f.outside.sessionIds.push('leaf');
    }
  };
  await assert.rejects(f.archiver.execute({ action: 'archive', archiveScope: 'related', targetId: 'root', requestId: 'tool-membership-race' }, f.exec), { code: 'ARCHIVE_PLAN_CHANGED' });
  assert.equal(drifted, true); assert.deepEqual(f.nativeCalls, []);
});

test('review cascade: complete current ordinary graph, child-first order, minimal plan and idempotent concurrent commit', async t => {
  const f = cascadeFixture(t);
  for (const [id, header] of [['fork', { parentSession: 'root' }], ['btw', { origin: 'subagent', isSeeded: true }], ['child-agent', { origin: 'subagent' }]]) {
    f.add(id, header); f.workspace.sessionIds.push(id);
    await f.store.mutate(draft => draft.creations.push({ senderId: 'root', sessionId: id, state: 'ready' }));
  }
  f.add('cross-workspace'); f.outside.sessionIds.push('cross-workspace');
  await f.store.mutate(draft => draft.creations.push({ senderId: 'root', sessionId: 'cross-workspace', state: 'unknown' }));
  const plan = await f.plan(); assert.deepEqual(plan.targets.map(item => item.id), ['leaf', 'child', 'root']);
  assert.equal(plan.workspaceId, 'current'); assert.equal(f.nativeCalls.length, 0);
  assert.doesNotMatch(JSON.stringify(plan), /PRIVATE|handoff|requestedSessionId|parentSession|cwd|allStopped/);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.commit(plan.planId)));
  assert.deepEqual(f.nativeCalls.map(item => item.id), ['leaf', 'child', 'root']);
  assert.equal(results.filter(item => item.replayed).length, 7);
  assert.equal(results[0].atomic, false); assert.equal(results[0].archiveState, 'succeeded'); assert.deepEqual(results[0].remaining, []);
});

test('review cascade: idle Agent with cold jobs preflights all targets; cancelling or consent escalation never archives', async t => {
  const f = cascadeFixture(t); f.agents.delete('child');
  f.active.set('child', [{ kind: 'jobs', secret: 'PRIVATE JOB', items: [{ id: 'job', label: 'Build', prompt: 'PRIVATE COMMAND' }] }]);
  const plan = await f.plan(); assert.equal(plan.requiresConfirmation, true);
  assert.deepEqual(new Set(f.activityReads), new Set(['leaf', 'child', 'root']));
  assert.equal(plan.activity[0].sessionId, 'child'); assert.doesNotMatch(JSON.stringify(plan), /PRIVATE/);
  await assert.rejects(f.commit(plan.planId), { code: 'ACTIVITY_REQUIRES_CONFIRMATION' });
  await assert.rejects(f.commit(plan.planId, { archiveScope: 'related', stopActivity: true }), { code: 'IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(f.nativeCalls, []);
  const aborter = new AbortController(); aborter.abort();
  await assert.rejects(f.commit(plan.planId, { requestId: 'cancelled', stopActivity: true }, { signal: aborter.signal }), { code: 'ABORTED' });
  assert.deepEqual(f.nativeCalls, []);
  const result = await f.commit(plan.planId, { requestId: 'confirmed', stopActivity: true });
  assert.deepEqual(result.archivedIds, ['leaf', 'child', 'root']); assert.equal(result.stopActivityRequested, true);
  assert.doesNotMatch(JSON.stringify(result), /allStopped|undo|activityStopped/);
});

test('review cascade: a confirmed plan never expands, silently shrinks, changes first parent or crosses Workspace', async t => {
  for (const mutation of ['expand', 'shrink', 'first-parent', 'workspace']) await t.test(mutation, async t => {
    const f = cascadeFixture(t), plan = await f.plan();
    if (mutation === 'expand') { f.add('late'); f.workspace.sessionIds.push('late'); await f.store.mutate(draft => draft.creations.push({ senderId: 'root', sessionId: 'late', state: 'ready' })); }
    if (mutation === 'shrink') await f.store.mutate(draft => { draft.creations.pop(); });
    if (mutation === 'first-parent') await f.store.mutate(draft => draft.creations.unshift({ senderId: 'outside-parent', sessionId: 'child', state: 'ready' }));
    if (mutation === 'workspace') { f.workspace.sessionIds.splice(f.workspace.sessionIds.indexOf('leaf'), 1); f.outside.sessionIds.push('leaf'); }
    await assert.rejects(f.commit(plan.planId, { requestId: 'confirmed', stopActivity: true }), { code: 'ARCHIVE_PLAN_CHANGED' });
    assert.deepEqual(f.nativeCalls, []);
  });
});

test('review cascade: unknown and interrupted intents stay pinned across restart and new plan ids', async t => {
  const f = cascadeFixture(t), plan = await f.plan();
  f.hooks.beforeArchive = id => { if (id === 'child') throw Error('PRIVATE native uncertain'); };
  await assert.rejects(f.commit(plan.planId), error => {
    assert.equal(error.archiveState, 'unknown'); assert.deepEqual(error.archivedIds, ['leaf']);
    assert.ok(error.remaining.includes('root')); return true;
  });
  await f.archiver.close();
  const restarted = createSessionArchiver({ ctx: f.ctx, store: f.store }); t.after(() => restarted.close());
  await assert.rejects(restarted.commitForOwner({ archiveScope: 'related', planId: plan.planId, requestId: 'commit' }), error => error.replayed === true);
  await assert.rejects(restarted.commitForOwner({ archiveScope: 'related', planId: plan.planId, requestId: 'fresh' }), { code: 'ARCHIVE_PLAN_TERMINAL' });
  await assert.rejects(restarted.planForOwner({ archiveScope: 'related', targetId: 'root', requestId: 'new-plan' }), { code: 'ARCHIVE_PRIOR_UNKNOWN' });
  assert.deepEqual(f.nativeCalls.map(item => item.id), ['leaf', 'child']);
  assert.doesNotMatch(JSON.stringify(await f.store.read()), /PRIVATE native/);
});

test('review cascade: a previously prepared overlapping plan cannot retry a later unknown outcome', async t => {
  const f = cascadeFixture(t), first = await f.plan(), second = await f.plan({ requestId: 'second-plan' });
  f.hooks.beforeArchive = id => { if (id === 'child') throw Error('native outcome unknown'); };
  await assert.rejects(f.commit(first.planId), { code: 'ARCHIVE_UNCERTAIN' });
  const before = f.nativeCalls.length;
  await assert.rejects(f.commit(second.planId, { requestId: 'second-commit' }), error => { assert.equal(f.nativeCalls.length, before, 'overlap must refuse before another native submission'); return error.code === 'ARCHIVE_PRIOR_UNKNOWN'; });
  assert.equal(f.nativeCalls.length, before); assert.deepEqual(f.nativeCalls.map(item => item.id), ['leaf', 'child']);
});

test('review cascade: unresolved legacy single-target archive cannot be bypassed by a group or owner entry', async t => {
  for (const timing of ['before-plan', 'after-plan']) await t.test(timing, async t => {
    const f = cascadeFixture(t);
    const plan = timing === 'after-plan' ? await f.plan() : undefined;
    await f.store.mutate(draft => { draft.archives = [{ senderId: 'caller', targetId: 'child', requestId: 'legacy-unknown', fingerprint: 'fixture', state: 'unknown', stage: 'restart', result: { archived: false, readback: false }, error: { code: 'ARCHIVE_RESTART_UNKNOWN' } }]; });
    if (plan) await assert.rejects(f.commit(plan.planId), error => { assert.deepEqual(f.nativeCalls, []); return error.code === 'ARCHIVE_PRIOR_UNKNOWN'; });
    else await assert.rejects(f.plan(), { code: 'ARCHIVE_PRIOR_UNKNOWN' });
    assert.deepEqual(f.nativeCalls, []);
  });
});

test('review cascade: owner plans, another caller and fake exec identity cannot bypass Tool fences', async t => {
  const f = cascadeFixture(t), plan = await f.plan();
  await assert.rejects(f.archiver.execute({ action: 'archive', archiveScope: 'related', targetId: 'root', planId: plan.planId, requestId: 'tool-owner-plan', stopActivity: true }, f.exec), { code: 'ARCHIVE_PLAN_NOT_FOUND' });
  await assert.rejects(f.archiver.execute({ action: 'archive', archiveScope: 'related', targetId: 'root', requestId: 'clone' }, { agent: { ...f.exec.agent } }), { code: 'SENDER_NOT_LIVE' });
  for (const key of ['owner', 'authority', 'principal']) await assert.rejects(f.archiver.execute({ action: 'archive', archiveScope: 'related', targetId: 'root', requestId: 'forged', [key]: true }, f.exec), { code: 'INVALID_ARGUMENT' });
  f.active.set('leaf', [{ kind: 'scheduled', items: [{ id: 'schedule' }] }]);
  let toolPlan;
  await assert.rejects(f.archiver.execute({ action: 'archive', archiveScope: 'related', targetId: 'root', requestId: 'tool-plan' }, f.exec), error => { toolPlan = error.planId; return error.code === 'ACTIVITY_REQUIRES_CONFIRMATION'; });
  await assert.rejects(f.archiver.execute({ action: 'archive', archiveScope: 'related', targetId: 'root', planId: toolPlan, requestId: 'steal', stopActivity: true }, { agent: f.agents.get('other-caller') }), { code: 'ARCHIVE_PLAN_NOT_FOUND' });
  // Self archive is now authorized; preserve the distinct durable-ancestor fence.
  Object.assign(f.exec.agent.session.header, { origin: 'subagent', parentSession: 'root' });
  await assert.rejects(f.archiver.execute({ action: 'archive', archiveScope: 'related', targetId: 'root', requestId: 'ancestor-in-closure' }, f.exec), { code: 'ARCHIVE_SELF_OR_ANCESTOR' });
  assert.deepEqual(f.nativeCalls, []);
});

test('review cascade: full-ledger limit, cycle and missing header fail closed with zero archive submissions', async t => {
  for (const invalid of ['bound', 'cycle', 'missing']) await t.test(invalid, async t => {
    const f = cascadeFixture(t);
    if (invalid === 'bound') await f.store.mutate(draft => { draft.creations = Array.from({ length: 1001 }, () => draft.creations[0]); });
    if (invalid === 'cycle') await f.store.mutate(draft => draft.creations.push({ senderId: 'leaf', sessionId: 'root', state: 'ready' }));
    if (invalid === 'missing') { f.agents.delete('child'); f.headers.delete('child'); }
    await assert.rejects(f.plan(), { code: { bound: 'ARCHIVE_GRAPH_INCOMPLETE', cycle: 'ARCHIVE_GRAPH_CYCLE', missing: 'ARCHIVE_METADATA_INVALID' }[invalid] });
    assert.deepEqual(f.nativeCalls, []);
  });
});

test('review cascade: in-flight creation blocks both singleton fallback and already confirmed group scope', async t => {
  await t.test('root has only a creating child', async t => {
    const f = cascadeFixture(t);
    await f.store.mutate(draft => { draft.creations = [{ senderId: 'root', sessionId: 'child', requestedSessionId: 'child', state: 'creating' }]; });
    await assert.rejects(f.archiver.execute({ action: 'archive', archiveScope: 'related', targetId: 'root', requestId: 'pending-root' }, f.exec), { code: 'ARCHIVE_GRAPH_UNSTABLE' });
    assert.deepEqual(f.nativeCalls, []);
  });
  await t.test('pending descendant appears after plan', async t => {
    const f = cascadeFixture(t), plan = await f.plan();
    await f.store.mutate(draft => { draft.creations.push({ senderId: 'child', requestedSessionId: 'later', state: 'unknown' }); });
    await assert.rejects(f.commit(plan.planId), { code: 'ARCHIVE_GRAPH_UNSTABLE' });
    assert.deepEqual(f.nativeCalls, []);
  });
});

test('review cascade: exactly 1000 provenance edges must not produce silently truncated 1001-target plans', async t => {
  const f = cascadeFixture(t); f.workspace.sessionIds.splice(0, f.workspace.sessionIds.length, 'root');
  const edges = [];
  for (let index = 0; index < 1000; index++) {
    const id = `many-${index}`; f.add(id); f.workspace.sessionIds.push(id); edges.push({ senderId: 'root', sessionId: id, state: 'ready' });
  }
  await f.store.mutate(draft => { draft.creations = edges; });
  await assert.rejects(f.plan(), { code: 'ARCHIVE_GRAPH_INCOMPLETE' });
  assert.deepEqual(f.nativeCalls, []);
});

test('review cascade: abort and close drain accepted native archive but never continue into the parent', async t => {
  const f = cascadeFixture(t), plan = await f.plan(), controller = new AbortController();
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  f.hooks.beforeArchive = async id => { assert.equal(id, 'leaf'); entered(); await blocked; };
  const operation = f.commit(plan.planId, {}, { signal: controller.signal });
  const checked = assert.rejects(operation, error => { assert.equal(error.cancelledAfterSubmission, true); assert.deepEqual(error.archivedIds, ['leaf']); assert.ok(error.remaining.includes('root')); return true; });
  await started; controller.abort(); let closed = false;
  const closing = f.archiver.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false); assert.deepEqual(f.archived, []);
  release(); await checked; await closing;
  assert.deepEqual(f.nativeCalls.map(item => item.id), ['leaf']); assert.deepEqual(f.archived, ['leaf']);
});

test('review archive schema: same-plan confirmation is expressible without authority or arbitrary target batches', () => {
  const schema = TOOLS.find(tool => tool.name === 'link_session_archive').parameters;
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.planId?.type, 'string'); assert.equal(schema.properties.planId?.minLength, 1); assert.equal(schema.properties.planId?.maxLength, 256);
  assert.equal(schema.properties.requestId.maxLength, 128); assert.equal(schema.properties.stopActivity.type, 'boolean');
  assert.deepEqual(schema.properties.archiveScope?.enum, ['single', 'related']);
  for (const forbidden of ['owner', 'principal', 'exec', 'agent', 'targets', 'targetIds']) assert.equal(Object.hasOwn(schema.properties, forbidden), false);
});

const archiveRequest = body => new Request(`http://fixture.test${ARCHIVE_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('review owner route: no raw transport fallback, strict inputs and bounded safe error metadata', async t => {
  const f = cascadeFixture(t);
  assert.throws(() => mountArchiveRoute({ webServer: { register() { assert.fail('raw server fallback'); } } }, { archiver: f.archiver }), { code: 'ARCHIVE_AUTH_UNAVAILABLE' });
  const handler = createArchiveHandler({ archiver: f.archiver }); t.after(() => handler.close());
  for (const body of [
    { action: 'plan', archiveScope: 'related', targetId: 'root', requestId: 'a', owner: true },
    { action: 'plan', archiveScope: 'related', targetId: 'root', requestId: 'a', principal: { kind: 'owner' } },
    { action: 'plan', archiveScope: 'related', targetId: 'root', requestId: 'a', exec: { agent: { id: 'caller' } } },
    { action: 'commit', archiveScope: 'related', planId: 'plan', requestId: 'a', targetId: 'root' },
    { action: 'commit', archiveScope: 'related', planId: 'plan', requestId: 'a', stopActivity: 'true' },
    { action: 'plan', archiveScope: 'related', targetId: 'root', requestId: 'x'.repeat(129) }
  ]) assert.equal((await handler.fetch(archiveRequest(body))).status, 400);
  assert.equal((await handler.fetch(archiveRequest({ action: 'plan', archiveScope: 'related', targetId: 'root', requestId: 'a', payload: 'x'.repeat(4096) }))).status, 413);
  assert.deepEqual(f.nativeCalls, []); assert.equal(f.state().archivePlans, undefined);
  const privateHandler = createArchiveHandler({ archiver: {
    async planForOwner() { throw Object.assign(Error('PRIVATE STACK MESSAGE'), {
      code: 'ARCHIVE_PARTIAL', stack: 'PRIVATE STACK', agent: { secret: 'PRIVATE AGENT' }, outcome: {
        archiveState: 'partial', archivedIds: ['leaf'], remaining: ['root'], failed: [{ id: 'root', state: 'unknown', raw: 'PRIVATE RAW' }],
        stopActivityRequested: true, atomic: true, allStopped: true, planId: 'plan', targetId: 'root'
      }
    }); }, commitForOwner() { assert.fail('not a commit'); }
  } }); t.after(() => privateHandler.close());
  const response = await privateHandler.fetch(archiveRequest({ action: 'plan', archiveScope: 'related', targetId: 'root', requestId: 'safe' })), value = await response.json();
  assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(value.error.outcome.atomic, false); assert.deepEqual(value.error.outcome.archivedIds, ['leaf']);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|allStopped|agent|stack/);
});

test('review owner route: unregister and close drain accepted work without closing the shared archiver', async () => {
  let route, release, entered, removed = 0, sharedClose = 0;
  const started = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const mounted = mountArchiveRoute({ connection: { fetch: { register(value) { route = value; return () => { removed++; }; } } } }, { archiver: {
    async planForOwner() { entered(); await blocked; return { handled: false }; }, commitForOwner() { assert.fail('not commit'); }, close() { sharedClose++; }
  } });
  assert.deepEqual(route.methods, ['POST']); assert.equal(route.requestBody, 'streaming');
  const pending = route.fetch(archiveRequest({ action: 'plan', archiveScope: 'related', targetId: 'root', requestId: 'slow' }));
  await started; let closed = false; const closing = mounted.close().then(() => { closed = true; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(closed, false); assert.equal(removed, 1);
  release(); assert.equal((await pending).status, 200); await closing; await mounted.close();
  assert.equal(sharedClose, 0); assert.equal((await route.fetch(archiveRequest({ action: 'plan', archiveScope: 'related', targetId: 'root', requestId: 'late' }))).status, 503);
});

test('review real Connection: owner-only archive route cannot be admitted by body principal or remote access', { skip: !process.env.DSH_RUNTIME }, async t => {
  const runtime = createRequire(resolve(process.env.DSH_RUNTIME, 'package.json'));
  const load = name => import(pathToFileURL(runtime.resolve(`@deepseek-ai/${name}`)).href);
  assert.equal(runtime('@deepseek-ai/dsh-client-connection/package.json').version, '0.2.1-rc.5');
  const { Context } = await load('cordis'), { HostConnectionService } = await load('dsh-client-connection');
  const root = new Context(), auth = { isAuthenticated: request => request.headers.cookie === 'review-owner=1', authenticateApi: () => undefined };
  const connection = new HostConnectionService(root, ['fixture.test'], auth), f = cascadeFixture(t);
  const mounted = mountArchiveRoute(root, { archiver: f.archiver });
  try {
    assert.equal(connection.admit({ headers: { host: 'fixture.test' } }).rejection, 401);
    assert.equal(connection.admit({ headers: { host: 'wrong.test', cookie: 'review-owner=1' } }).rejection, 403);
    const owner = connection.admit({ headers: { host: 'fixture.test', cookie: 'review-owner=1' } }); assert.equal(owner.peer.principal.kind, 'owner');
    const carrier = connection.createSharedFetchHandler('/api');
    const untrusted = { principal: { kind: 'non-owner' }, remoteAccess: { allowed: true } };
    assert.equal((await carrier.fetch(archiveRequest({ action: 'plan', archiveScope: 'related', targetId: 'root', requestId: 'p', principal: { kind: 'owner' } }), untrusted)).status, 403);
    assert.equal(f.state().archivePlans, undefined); assert.equal(f.nativeCalls.length, 0);
    assert.equal((await carrier.fetch(archiveRequest({ action: 'plan', archiveScope: 'related', targetId: 'root', requestId: 'p', owner: true }), owner.peer)).status, 400);
    const response = await carrier.fetch(archiveRequest({ action: 'plan', archiveScope: 'related', targetId: 'root', requestId: 'p' }), owner.peer);
    assert.equal(response.status, 200); const { value: plan } = await response.json(); assert.equal(plan.total, 3);
    assert.equal((await carrier.fetch(archiveRequest({ action: 'commit', archiveScope: 'related', planId: plan.planId, requestId: 'c' }), untrusted)).status, 403);
    assert.equal(f.nativeCalls.length, 0);
    assert.equal((await carrier.fetch(archiveRequest({ action: 'commit', archiveScope: 'related', planId: plan.planId, requestId: 'c' }), owner.peer)).status, 200);
    assert.deepEqual(f.nativeCalls.map(item => item.id), ['leaf', 'child', 'root']);
    await mounted.close(); assert.equal((await carrier.fetch(archiveRequest({ action: 'plan', archiveScope: 'related', targetId: 'root', requestId: 'gone' }), owner.peer)).status, 404);
  } finally { await mounted.close(); await root.fiber.dispose(); }
});

const wirePlan = () => ({ handled: true, archiveScope: 'related', targetId: 'root', planId: 'plan-1', total: 2, requiresConfirmation: true,
  targets: [{ id: 'child', alreadyArchived: false, title: 'Child' }, { id: 'root', alreadyArchived: false, title: 'Root' }],
  activity: [{ sessionId: 'child', title: 'Child', groups: [{ kind: 'job', totalItems: 1, items: [{ id: 'job-1', label: 'work' }] }], totalGroups: 1 }] });
const wireOutcome = () => ({ archiveScope: 'related', archiveState: 'succeeded', archivedIds: ['child', 'root'], remaining: [], failed: [], stopActivityRequested: true });
const wireResponse = value => ({ ok: true, json: async () => ({ ok: true, value }) });

test('review archive provider: unsupported Hosts do no archive work and exact plans bind one immutable consent', async t => {
  for (const archiveVersion of [undefined, 0, 1, '2']) {
    const old = titleFixture(t, { archiveVersion }); assert.equal(old.archiveProvider, undefined); assert.deepEqual(old.requests, []); old.dispose();
  }
  const f = titleFixture(t, { archiveVersion: 2, archiveFetch: async (_url, options) => wireResponse(JSON.parse(options.body).action === 'plan' ? wirePlan() : wireOutcome()) });
  assert.deepEqual(f.requests, []); const p = f.archiveProvider, plan = await p.prepare('root', { archiveScope: 'related' });
  assert.ok(Object.isFrozen(plan)); assert.ok(Object.isFrozen(plan.targets[0])); assert.ok(Object.isFrozen(plan.activity[0].groups[0].items[0]));
  assert.equal(f.requests[0].options.credentials, 'same-origin'); assert.equal(f.requests[0].body.action, 'plan');
  assert.equal(Object.hasOwn(f.requests[0].body, 'targets'), false); assert.equal(f.timers.size, 0);
  await assert.rejects(p.commit({ ...plan }, { archiveScope: 'related', stopActivity: true })); await assert.rejects(p.commit(plan, { archiveScope: 'related', stopActivity: false }));
  assert.equal(f.requests.length, 1);
  await p.commit(plan, { archiveScope: 'related', stopActivity: true });
  // v2 tightens retained-key replay into one-shot UI submission, never another POST.
  await assert.rejects(p.commit(plan, { archiveScope: 'related', stopActivity: true }));
  assert.equal(f.requests[1].body.planId, plan.planId); assert.equal(f.requests[1].body.archiveScope, 'related');
  assert.notEqual(f.requests[0].body.requestId, f.requests[1].body.requestId); assert.equal(f.requests[1].signal, undefined);
  await assert.rejects(p.commit(plan, { archiveScope: 'related', stopActivity: false })); assert.equal(f.requests.length, 2);
  f.dispose(); assert.equal(f.archiveRemoves, 1); await assert.rejects(p.prepare('root', { archiveScope: 'related' })); await assert.rejects(p.commit(plan, { archiveScope: 'related', stopActivity: true }));
});

test('review archive provider: full-plan shape never silently truncates or aliases another root', async t => {
  const variants = [p => { p.targetId = 'other'; }, p => { p.total++; }, p => { p.targets.reverse(); },
    p => { p.targets[0].id = 'root'; }, p => { p.requiresConfirmation = false; },
    p => { p.activity[0].sessionId = 'outside'; }, p => { p.activity[0].groups[0].totalItems = 0; },
    p => { p.targets = Array.from({ length: 1001 }, (_, i) => ({ id: i === 1000 ? 'root' : `child-${i}`, alreadyArchived: false })); p.total = 1001; }];
  for (const mutate of variants) {
    const value = wirePlan(); mutate(value);
    const f = titleFixture(t, { archiveVersion: 2, archiveFetch: async () => wireResponse(value) });
    await assert.rejects(f.archiveProvider.prepare('root', { archiveScope: 'related' })); assert.equal(f.requests.length, 1); f.dispose();
  }
  const f = titleFixture(t, { archiveVersion: 2, archiveFetch: async () => wireResponse({ handled: false, targetId: 'root' }) });
  assert.equal(await f.archiveProvider.prepare('root'), undefined);
  await assert.rejects(f.archiveProvider.prepare('root', { archiveScope: 'related' }));
});

test('review archive provider: unload cancels late reads but drains an already admitted commit', async t => {
  let release;
  const f = titleFixture(t, { archiveVersion: 2, archiveFetch: () => new Promise(resolve => { release = resolve; }) });
  const preparing = f.archiveProvider.prepare('root', { archiveScope: 'related' }); f.dispose();
  assert.equal(f.requests[0].signal.aborted, true); release(wireResponse(wirePlan())); await assert.rejects(preparing);
  const g = titleFixture(t, { archiveVersion: 2, archiveFetch: (_url, options) => JSON.parse(options.body).action === 'plan' ? wireResponse(wirePlan()) : new Promise(resolve => { release = resolve; }) });
  const plan = await g.archiveProvider.prepare('root', { archiveScope: 'related' }), committing = g.archiveProvider.commit(plan, { archiveScope: 'related', stopActivity: true });
  g.dispose(); assert.equal(g.requests[1].signal, undefined); release(wireResponse(wireOutcome()));
  assert.equal((await committing).archiveState, 'succeeded'); assert.equal(g.requests.length, 2);
});

test('review archive provider: typed partial errors remain visible and never retry or become singleton success', async t => {
  const partial = { archiveScope: 'related', archiveState: 'unknown', archivedIds: ['child'], remaining: ['root'], failed: [{ id: 'root', state: 'unknown', secret: 'hidden' }], stopActivityRequested: true, atomic: true, allStopped: true };
  const f = titleFixture(t, { archiveVersion: 2, archiveFetch: async (_url, options) => JSON.parse(options.body).action === 'plan' ? wireResponse(wirePlan()) : ({ ok: false, json: async () => ({ ok: false, error: { code: 'ARCHIVE_UNCERTAIN', message: 'uncertain', outcome: partial } }) }) });
  const plan = await f.archiveProvider.prepare('root', { archiveScope: 'related' }), result = await f.archiveProvider.commit(plan, { archiveScope: 'related', stopActivity: true });
  assert.equal(result.archiveState, 'unknown'); assert.deepEqual([...result.remaining], ['root']);
  assert.doesNotMatch(JSON.stringify(result), /secret|atomic|allStopped/); assert.equal(f.requests.length, 2);
  const denied = titleFixture(t, { archiveVersion: 2, archiveFetch: async () => ({ ok: false, json: async () => ({ ok: false, error: { code: 'ACCESS_DENIED', message: 'denied' } }) }) });
  await assert.rejects(denied.archiveProvider.prepare('root', { archiveScope: 'related' }), { code: 'ACCESS_DENIED' }); assert.equal(denied.requests.length, 1);
});

test('review archive provider: damaged outcome partitions never masquerade as group success', async t => {
  const variants = [
    { ...wireOutcome(), archivedIds: [] },
    { ...wireOutcome(), remaining: ['root'] },
    { ...wireOutcome(), archivedIds: ['child'], remaining: ['root'] },
    { ...wireOutcome(), archiveState: 'partial', archivedIds: ['child'], remaining: ['root'], failed: [{ id: 'child', state: 'failed' }] },
    { ...wireOutcome(), archiveState: 'unknown', archivedIds: ['child'], remaining: ['root'], failed: [{ id: 'root', state: 'unknown' }, { id: 'root', state: 'unknown' }] },
    { ...wireOutcome(), archiveState: 'failed', archivedIds: [], remaining: ['child'], failed: [] },
    { ...wireOutcome(), archivedIds: ['child', 'outside'] }
  ];
  for (const outcome of variants) {
    const f = titleFixture(t, { archiveVersion: 2, archiveFetch: async (_url, options) => wireResponse(JSON.parse(options.body).action === 'plan' ? wirePlan() : outcome) });
    const plan = await f.archiveProvider.prepare('root', { archiveScope: 'related' }); await assert.rejects(f.archiveProvider.commit(plan, { archiveScope: 'related', stopActivity: true }));
    assert.equal(f.requests.length, 2); f.dispose();
  }
});

test('review archive provider: production route and engine preserve child-first plan without visible tree data', async t => {
  const f = cascadeFixture(t), route = createArchiveHandler({ archiver: f.archiver }); t.after(() => route.close());
  const client = titleFixture(t, { archiveVersion: 2, archiveFetch: (url, options) => route.fetch(new Request(`http://fixture.test${url}`, options)) });
  const plan = await client.archiveProvider.prepare('root', { archiveScope: 'related' }); assert.equal(plan.total, 3); assert.deepEqual([...plan.targets].map(item => item.id), ['leaf', 'child', 'root']);
  const result = await client.archiveProvider.commit(plan, { archiveScope: 'related', stopActivity: false }); assert.equal(result.archiveState, 'succeeded');
  assert.deepEqual(f.nativeCalls.map(item => item.id), ['leaf', 'child', 'root']); assert.equal(client.reads, 0); assert.equal(client.serviceReads, 0);
});

test('review shared mutation tail: an admitted creation settles before owner commit and cannot expand confirmed scope', async t => {
  const f = cascadeFixture(t), plan = await f.plan(); let release, entered, commits = 0;
  const started = new Promise(resolve => { entered = resolve; }), blocked = new Promise(resolve => { release = resolve; });
  const service = createService({
    host: { describe: async id => ({ id, live: true, archived: false }) }, store: { ...f.store, async close() {} },
    sessionCreator: { async create() {
      await f.store.mutate(draft => { draft.creations.push({ senderId: 'child', requestedSessionId: 'new-child', state: 'creating' }); });
      entered(); await blocked; f.add('new-child'); f.workspace.sessionIds.push('new-child');
      await f.store.mutate(draft => { const row = draft.creations.at(-1); row.state = 'ready'; row.sessionId = 'new-child'; });
      return { sessionId: 'new-child' };
    }, async close() {} },
    sessionArchiver: { ...f.archiver, commitForOwner(args, options) { commits++; return f.archiver.commitForOwner(args, options); } }
  }); t.after(() => service.close());
  const creating = service.execute('link_session_create', { requestId: 'new' }, f.exec); await started;
  const committing = service.commitArchiveForOwner({ archiveScope: 'related', planId: plan.planId, requestId: 'owner' });
  const rejected = assert.rejects(committing, { code: 'ARCHIVE_PLAN_CHANGED' });
  await Promise.resolve(); await Promise.resolve(); assert.equal(commits, 0); assert.deepEqual(f.nativeCalls, []);
  release(); await creating; await rejected; assert.equal(commits, 1); assert.deepEqual(f.nativeCalls, []);
  await service.close(); await assert.rejects(service.commitArchiveForOwner({ archiveScope: 'related', planId: plan.planId, requestId: 'late' }), { code: 'SERVICE_CLOSED' });
});
