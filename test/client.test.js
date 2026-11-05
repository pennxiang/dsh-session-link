import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Contract/lifecycle tests only: this small hook renderer is not a browser or a visual/skin verification.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const uri = id => `dsh-session:${Buffer.from(JSON.stringify(id)).toString('base64url')}`;
const ref = (id, title = id) => ({ id, title, uri: uri(id) });
const node = (id, state = 'idle', title = id) => ({ id, title, state, sessionRef: `@[${title}](${uri(id)})` });
const view = (nodes, edges = [], self = nodes[0]) => ({ self, nodes, edges, truncated: false });
const edge = (sourceId, targetId) => ({ sourceId, targetId, kind: 'created-session' });
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
function elements(root, predicate) {
  const found = [];
  function walk(value) {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    if (predicate(value)) found.push(value);
    walk(value.children);
  }
  walk(root); return found;
}
const text = root => !root || typeof root === 'boolean' ? '' : Array.isArray(root) ? root.map(text).join('') : typeof root === 'object' ? text(root.children) : String(root);
const button = (root, title) => elements(root, e => e.type === 'button' && text(e) === title)[0];
const treeItems = root => elements(root, e => e.props.role === 'treeitem');
function fixture({ data = view([node('self')]), handler, storage, nativeVersion, nativeRegister = true, archiveVersion, archiveRegister = true, archiveHandler, workspaceState, sessionState, sessionListAvailable = sessionState !== undefined, initiallyHidden = false } = {}) {
  let rendering;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x !== null && x !== undefined && x !== false) }),
    useState(initial) {
      const r = rendering, index = r.cursor++;
      if (!r.hooks[index]) r.hooks[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [r.hooks[index].value, value => {
        if (!r.mounted) r.lateWrites++;
        const old = r.hooks[index].value, next = typeof value === 'function' ? value(old) : value;
        if (!Object.is(old, next)) { r.hooks[index].value = next; r.dirty = true; }
      }];
    },
    useRef(value) { const r = rendering, index = r.cursor++; return r.hooks[index] ||= { current: value }; },
    useMemo(factory, deps) {
      const r = rendering, index = r.cursor++, old = r.hooks[index];
      if (!old || !sameDeps(old.deps, deps)) r.hooks[index] = { value: factory(), deps };
      return r.hooks[index].value;
    },
    useEffect(factory, deps) {
      const r = rendering, index = r.cursor++, old = r.hooks[index];
      if (!old || !sameDeps(old.deps, deps)) r.effects.push(() => {
        old?.cleanup?.(); r.hooks[index] = { deps, cleanup: factory() };
      });
    }
  };
  let loaded, serial = 0, uuid = 0;
  const archiveRegistrations = [];
  const timers = new Map(), listeners = new Map(), calls = [], opened = [], copied = [], registrations = [], definitions = [], eventDefinitions = [], disposers = [];
  const values = storage || new Map();
  const workspaceListeners = new Set(), nativeRegistrations = [], serviceReads = [];
  let workspaceSnapshot = workspaceState, workspaceReads = 0;
  let sessionSnapshot = sessionState, sessionReads = 0;
  const sessionListeners = new Set(), forbiddenSessionCalls = [];
  const sessionList = {
    getSnapshot() { sessionReads++; return sessionSnapshot; },
    subscribe(listener) { sessionListeners.add(listener); return () => sessionListeners.delete(listener); }
  };
  const workspaceList = {
    getSnapshot() { workspaceReads++; return workspaceSnapshot; },
    subscribe(listener) { workspaceListeners.add(listener); return () => workspaceListeners.delete(listener); }
  };
  const document = {
    visibilityState: initiallyHidden ? 'hidden' : 'visible',
    addEventListener(name, callback) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); }
  };
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { loaded = value; } } },
    document, AbortController, TextEncoder, crypto: { randomUUID: () => `mock-${++uuid}` }, btoa: input => Buffer.from(input, 'binary').toString('base64'),
    localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    setTimeout: (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay, kind: 'timeout' }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { const id = ++serial; timers.set(id, { fn, delay, kind: 'interval' }); return id; },
    clearInterval: id => timers.delete(id),
    fetch: async (url, options) => {
      const body = JSON.parse(options.body); calls.push({ url, options, body });
      if (url === '/api/session-link/archive') return archiveHandler(body, options.signal);
      const value = handler ? await handler(body, options.signal) : body.action === 'relations' ? data : { targetId: body.targetId, node: node(body.targetId) };
      return { ok: true, status: 200, json: async () => ({ ok: true, value }) };
    }
  };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  const plugin = loaded.factory(name => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText: 'MarkdownText', writeClipboard: async value => { copied.push(value); return true; } };
    throw new Error(`Unexpected dependency ${name}`);
  });
  plugin.apply({
    effect(factory) { const dispose = factory(); disposers.push(dispose); return dispose; },
    sidebarRightTabs: { register(definition) { definitions.push(definition); return () => definitions.splice(definitions.indexOf(definition), 1); } },
    slots: {
      inject(_name, factory) { return factory(); },
      register(definition, Component) { const value = { ...definition, Component }; registrations.push(value); return () => registrations.splice(registrations.indexOf(value), 1); }
    },
    get(name) {
      serviceReads.push(name);
      if (name === 'workspaces') return { list: workspaceList };
      assert.equal(name, 'sessions');
      if (!sessionListAvailable) return undefined;
      return { list: sessionList, ...Object.fromEntries(['retain', 'using', 'peek', 'resolveScope', 'resume', 'search'].map(method => [method, () => { forbiddenSessionCalls.push(method); throw new Error(`Forbidden title lookup ${method}`); }])) };
    },
    uiWorkspace: {
      openSession(id) { opened.push(id); },
      sessionArchiveProvidersVersion: archiveVersion,
      ...(archiveRegister ? { registerSessionArchiveProvider(provider) {
        archiveRegistrations.push(provider);
        return () => archiveRegistrations.splice(archiveRegistrations.indexOf(provider), 1);
      } } : {}),
      sessionRelationsVersion: nativeVersion,
      ...(nativeRegister ? { registerSessionRelations(registration) {
        nativeRegistrations.push(registration);
        return () => nativeRegistrations.splice(nativeRegistrations.indexOf(registration), 1);
      } } : {})
    },
    uiConversation: { events: { register(definition) { eventDefinitions.push(definition); return () => eventDefinitions.splice(eventDefinitions.indexOf(definition), 1); } } }
  });
  function mount(Component, props) {
    const r = { hooks: [], effects: [], cursor: 0, mounted: true, dirty: true, props, lateWrites: 0 };
    r.render = () => {
      rendering = r; r.cursor = 0; r.effects = []; r.dirty = false;
      r.tree = Component(r.props); rendering = null;
      for (const effect of r.effects) effect();
      for (const element of elements(r.tree, e => typeof e.props.ref === 'function')) element.props.ref({ focus: () => { r.focused = element.props['aria-label']; } });
    };
    r.update = next => { r.props = { ...r.props, ...next }; r.render(); };
    r.flush = async () => { for (let i = 0; i < 20; i++) { await Promise.resolve(); if (r.dirty && r.mounted) r.render(); } };
    r.unmount = () => { for (const hook of r.hooks) hook?.cleanup?.(); r.mounted = false; };
    r.render(); return r;
  }
  function panel(sessionId = 'self', visible = true) {
    const registration = registrations.find(r => r.name === 'sidebar.right.pane.tab');
    const controller = new AbortController();
    const commands = { bound: null, released: 0 };
    const tab = { visible, signal: controller.signal, actions: { bindCommands(value) { commands.bound = value; return () => { commands.bound = null; commands.released++; }; } } };
    const r = mount(registration.Component, { ...registration.inject(sessionId), useTabInfo: () => ({ tab }) });
    r.show = visible => { tab.visible = visible; r.render(); };
    r.abort = () => controller.abort(); r.commands = commands;
    return r;
  }
  function tool(toolName, value, extra = {}) {
    const registration = registrations.find(r => r.name === 'tool.call.toolview' && r.key === toolName);
    return mount(registration.Component, { ...registration.inject('self'), toolName, phase: 'result', block: { kind: 'result', content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }], ...extra } });
  }
  return {
    loaded, plugin, panel, tool, calls, opened, copied, definitions, eventDefinitions, registrations, values, timers, listeners, document,
    nativeRegistrations, archiveRegistrations, workspaceListeners, serviceReads, sessionListeners, forbiddenSessionCalls,
    get workspaceReads() { return workspaceReads; },
    get sessionReads() { return sessionReads; },
    setSessions(value) { sessionSnapshot = value; for (const callback of [...sessionListeners]) callback(); },
    setWorkspaces(value, notify = true) { workspaceSnapshot = value; if (notify) for (const callback of [...workspaceListeners]) callback(); },
    async settle() { for (let i = 0; i < 600; i++) await Promise.resolve(); },
    resultNode(node) { const registration = registrations.find(r => r.name === 'conversation.chat.node'); return mount(registration.Component, { ...registration.inject('self'), node }); },
    async visibility(value, r) { document.visibilityState = value; for (const callback of [...listeners.get('visibilitychange') || []]) callback(); if (r) await r.flush(); else await this.settle(); },
    async tick(r) { for (const timer of [...timers.values()]) if (timer.kind === 'interval') timer.fn(); await r.flush(); },
    dispose() { for (const dispose of disposers.reverse()) dispose?.(); }
  };
}
function key(item, value) {
  let prevented = false;
  item.props.onKeyDown({ key: value, target: item, currentTarget: item, preventDefault() { prevented = true; }, stopPropagation() {} });
  return prevented;
}

const archiveReply = value => ({ ok: true, status: 200, json: async () => ({ ok: true, value }) });
const archiveError = error => ({ ok: false, status: 409, json: async () => ({ ok: false, error }) });
const archiveChoiceError = () => ({ code: 'ARCHIVE_SCOPE_REQUIRED', targetId: 'root', allowedScopes: ['single', 'related'] });
function archivePlan(archiveScope, patch = {}) {
  return { handled: true, planId: 'plan-1', targetId: 'root', archiveScope, total: archiveScope === 'single' ? 1 : 2,
    targets: [...(archiveScope === 'related' ? [{ id: 'child', alreadyArchived: false, title: '子标题' }] : []), { id: 'root', alreadyArchived: false, title: '主标题' }], activity: [], requiresConfirmation: false, ...patch };
}
function archiveOutcome(archiveScope, patch = {}) {
  return { archiveScope, archiveState: 'succeeded', archivedIds: archiveScope === 'single' ? ['root'] : ['child', 'root'], remaining: [], failed: [], stopActivityRequested: false, ...patch };
}
const providerOf = f => f.archiveRegistrations[0];

test('archive scope protocol registers only version two without acquiring metadata or making requests', () => {
  for (const archiveVersion of [undefined, 0, 1, 3, '2']) {
    const f = fixture({ archiveVersion }); assert.equal(f.archiveRegistrations.length, 0);
    assert.equal(f.calls.length, 0); assert.deepEqual(f.serviceReads, []); f.dispose();
  }
  const missing = fixture({ archiveVersion: 2, archiveRegister: false }); assert.equal(missing.archiveRegistrations.length, 0); missing.dispose();
  const f = fixture({ archiveVersion: 2 }); assert.equal(providerOf(f).version, 2); assert.equal(f.calls.length, 0); assert.deepEqual(f.serviceReads, []);
  f.dispose(); assert.equal(f.archiveRegistrations.length, 0);
});

test('no-scope archive response becomes a pure immutable choice; explicit selection makes a fresh scoped plan, never an implicit commit', async () => {
  const f = fixture({ archiveVersion: 2, archiveHandler: body => body.archiveScope ? archiveReply(archivePlan(body.archiveScope)) : archiveError(archiveChoiceError()) });
  const p = providerOf(f), choice = await p.prepare('root');
  assert.deepEqual(JSON.parse(JSON.stringify(choice)), { kind: 'scope-choice', targetId: 'root', allowedScopes: ['single', 'related'] });
  assert.ok(Object.isFrozen(choice)); assert.ok(Object.isFrozen(choice.allowedScopes));
  assert.equal(Object.hasOwn(choice, 'planId'), false); assert.equal(Object.hasOwn(choice, 'targets'), false);
  assert.equal(f.calls.length, 1); assert.equal(Object.hasOwn(f.calls[0].body, 'archiveScope'), false);
  await assert.rejects(p.commit(choice, { archiveScope: 'related', stopActivity: true })); assert.equal(f.calls.length, 1);
  const plan = await p.prepare('root', { archiveScope: 'related' });
  assert.equal(plan.archiveScope, 'related'); assert.deepEqual([...plan.targets].map(x => x.id), ['child', 'root']);
  assert.ok(Object.isFrozen(plan)); assert.ok(Object.isFrozen(plan.targets[0]));
  assert.notEqual(f.calls[0].body.requestId, f.calls[1].body.requestId);
  assert.deepEqual(f.calls.map(x => x.body.action), ['plan', 'plan']); assert.equal(f.timers.size, 0); f.dispose();
});

test('only exact scope-required diagnostics become a choice; malformed, selected, unrelated or stale diagnostics fail closed', async () => {
  const attacks = [
    { targetId: 'other' }, { allowedScopes: ['single'] }, { allowedScopes: ['single', 'single'] }, { allowedScopes: ['single', 'all'] },
    { allowedScopes: ['single', 'related', 'other'] }, { planId: 'forged' }, { targets: [] }, { outcome: {} }, { code: 'ACCESS_DENIED' }
  ];
  for (const patch of attacks) {
    const f = fixture({ archiveVersion: 2, archiveHandler: () => archiveError({ ...archiveChoiceError(), ...patch }) });
    await assert.rejects(providerOf(f).prepare('root')); assert.equal(f.calls.length, 1); assert.equal(f.timers.size, 0); f.dispose();
  }
  const f = fixture({ archiveVersion: 2, archiveHandler: () => archiveError(archiveChoiceError()) });
  await assert.rejects(providerOf(f).prepare('root', { archiveScope: 'single' })); assert.equal(f.calls.length, 1); f.dispose();
});

test('only unscoped unhandled responses permit legacy fallback; explicit scope and silent plans cannot fall through', async () => {
  const f = fixture({ archiveVersion: 2, archiveHandler: () => archiveReply({ targetId: 'root', handled: false }) });
  assert.equal(await providerOf(f).prepare('root'), undefined);
  await assert.rejects(providerOf(f).prepare('root', { archiveScope: 'single' }));
  await assert.rejects(providerOf(f).prepare('root', { archiveScope: 'related' })); f.dispose();
  const g = fixture({ archiveVersion: 2, archiveHandler: () => archiveReply(archivePlan('related')) });
  await assert.rejects(providerOf(g).prepare('root')); assert.equal(g.calls.length, 1); g.dispose();
});

test('scoped plan validation binds target, scope and exact membership without expanding single or shrinking related', async () => {
  const malformed = [
    ['single', archivePlan('related')], ['related', archivePlan('single')], ['related', archivePlan('related', { archiveScope: undefined })],
    ['single', archivePlan('single', { targets: [{ id: 'other', alreadyArchived: false }] })],
    ['related', archivePlan('related', { targets: [{ id: 'root', alreadyArchived: false }, { id: 'child', alreadyArchived: false }] })],
    ['related', archivePlan('related', { targets: [{ id: 'root', alreadyArchived: false }, { id: 'root', alreadyArchived: false }] })],
    ['related', archivePlan('related', { total: 3 })]
  ];
  for (const [archiveScope, value] of malformed) {
    const f = fixture({ archiveVersion: 2, archiveHandler: () => archiveReply(value) });
    await assert.rejects(providerOf(f).prepare('root', { archiveScope })); assert.equal(f.calls.length, 1); f.dispose();
  }
  const f = fixture({ archiveVersion: 2, archiveHandler: () => assert.fail('bad scope must not read') });
  for (const archiveScope of [null, '', 'all', 1]) await assert.rejects(providerOf(f).prepare('root', { archiveScope }));
  assert.equal(f.calls.length, 0); f.dispose();
});

test('scope consent and activity consent remain independent; exact immutable plan and chosen scope are required for one commit', async () => {
  for (const archiveScope of ['single', 'related']) {
    const f = fixture({ archiveVersion: 2, archiveHandler: body => archiveReply(body.action === 'plan' ? archivePlan(archiveScope) : archiveOutcome(archiveScope)) });
    const p = providerOf(f), plan = await p.prepare('root', { archiveScope });
    await assert.rejects(p.commit({ ...plan }, { archiveScope, stopActivity: false }));
    await assert.rejects(p.commit(plan, { stopActivity: false }));
    await assert.rejects(p.commit(plan, { archiveScope: archiveScope === 'single' ? 'related' : 'single', stopActivity: true }));
    await assert.rejects(p.commit(plan, { archiveScope, stopActivity: 'true' })); assert.equal(f.calls.length, 1);
    const result = await p.commit(plan, { archiveScope, stopActivity: false });
    assert.equal(result.archiveScope, archiveScope); assert.equal(result.stopActivityRequested, false);
    assert.deepEqual(f.calls[1].body, { action: 'commit', planId: plan.planId, archiveScope, requestId: f.calls[1].body.requestId, stopActivity: false });
    assert.notEqual(f.calls[0].body.requestId, f.calls[1].body.requestId); assert.equal(f.calls[1].options.signal, undefined);
    await assert.rejects(p.commit(plan, { archiveScope, stopActivity: false })); assert.equal(f.calls.length, 2); f.dispose();
  }
  const active = archivePlan('single', { requiresConfirmation: true, activity: [{ sessionId: 'root', totalGroups: 1, groups: [{ kind: 'job', items: [], totalItems: 1 }] }] });
  const f = fixture({ archiveVersion: 2, archiveHandler: body => archiveReply(body.action === 'plan' ? active : archiveOutcome('single', { stopActivityRequested: true })) });
  const p = providerOf(f), plan = await p.prepare('root', { archiveScope: 'single' });
  await assert.rejects(p.commit(plan, { archiveScope: 'single', stopActivity: false })); assert.equal(f.calls.length, 1);
  assert.equal((await p.commit(plan, { archiveScope: 'single', stopActivity: true })).stopActivityRequested, true); f.dispose();
});

test('partial, unknown, failed, malformed and thrown archive results consume the plan and never retry or report singleton success', async () => {
  const partial = archiveOutcome('related', { archiveState: 'partial', archivedIds: ['child'], remaining: ['root'], failed: [{ id: 'root', state: 'failed' }] });
  const unknown = archiveOutcome('related', { archiveState: 'unknown', archivedIds: [], remaining: ['child', 'root'], failed: [{ id: 'child', state: 'unknown' }] });
  const cases = [
    [() => archiveReply(partial), 'partial'], [() => archiveError({ code: 'ARCHIVE_UNCERTAIN', outcome: unknown }), 'unknown'],
    [() => archiveReply({ ...unknown, archiveState: 'failed' }), 'failed'],
    [() => { throw new Error('network uncertain'); }, undefined],
    [() => archiveReply({ ...partial, archiveScope: 'single' }), undefined],
    [() => archiveReply({ ...partial, stopActivityRequested: true }), undefined],
    [() => archiveReply({ ...partial, archivedIds: ['child', 'root'], remaining: ['root'] }), undefined]
  ];
  for (const [reply, expected] of cases) {
    const f = fixture({ archiveVersion: 2, archiveHandler: body => body.action === 'plan' ? archiveReply(archivePlan('related')) : reply() });
    const p = providerOf(f), plan = await p.prepare('root', { archiveScope: 'related' });
    const first = p.commit(plan, { archiveScope: 'related', stopActivity: false });
    if (expected) assert.equal((await first).archiveState, expected); else await assert.rejects(first);
    await assert.rejects(p.commit(plan, { archiveScope: 'related', stopActivity: false })); assert.equal(f.calls.length, 2); f.dispose();
  }
});

test('concurrent commits are one-shot and an admitted mutation drains on unload without timeout or abort', async () => {
  let release;
  const f = fixture({ archiveVersion: 2, archiveHandler: body => body.action === 'plan' ? archiveReply(archivePlan('single')) : new Promise(resolve => { release = resolve; }) });
  const p = providerOf(f), plan = await p.prepare('root', { archiveScope: 'single' });
  const admitted = p.commit(plan, { archiveScope: 'single', stopActivity: false });
  await assert.rejects(p.commit(plan, { archiveScope: 'single', stopActivity: false })); assert.equal(f.calls.length, 2);
  assert.equal(f.timers.size, 0); assert.equal(f.calls[1].options.signal, undefined);
  f.dispose(); release(archiveReply(archiveOutcome('single'))); assert.equal((await admitted).archiveState, 'succeeded');
  await assert.rejects(p.commit(plan, { archiveScope: 'single', stopActivity: false })); await assert.rejects(p.prepare('root')); assert.equal(f.calls.length, 2);
});

test('identical plan ids from another provider instance cannot transplant scope consent across lifetimes', async () => {
  const setup = () => fixture({ archiveVersion: 2, archiveHandler: body => archiveReply(body.action === 'plan' ? archivePlan('single') : archiveOutcome('single')) });
  const first = setup(), second = setup(), a = providerOf(first), b = providerOf(second);
  const oldPlan = await a.prepare('root', { archiveScope: 'single' }), currentPlan = await b.prepare('root', { archiveScope: 'single' });
  assert.equal(oldPlan.planId, currentPlan.planId);
  await assert.rejects(b.commit(oldPlan, { archiveScope: 'single', stopActivity: false })); assert.equal(second.calls.length, 1);
  first.dispose(); await assert.rejects(a.commit(oldPlan, { archiveScope: 'single', stopActivity: false })); assert.equal(first.calls.length, 1);
  assert.equal((await b.commit(currentPlan, { archiveScope: 'single', stopActivity: false })).archiveState, 'succeeded'); second.dispose();
});

test('provider lifetime owns reads and invalidates late plans or scope choices without starting a mutation', async () => {
  for (const response of [archiveReply(archivePlan('single')), archiveError(archiveChoiceError())]) {
    let release;
    const f = fixture({ archiveVersion: 2, archiveHandler: () => new Promise(resolve => { release = resolve; }) });
    const p = providerOf(f), preparing = p.prepare('root', response.ok ? { archiveScope: 'single' } : undefined);
    f.dispose(); assert.equal(f.calls[0].options.signal.aborted, true); release(response);
    await assert.rejects(preparing); assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 1);
  }
});

test('registers native page and official own-tool slots with native Session scope, no global click hack', () => {
  const f = fixture();
  assert.equal(f.loaded.id, 'dsh-session-link');
  assert.deepEqual([...f.plugin.inject], ['slots', 'sidebarRightTabs', 'uiWorkspace', 'uiConversation', 'workspaces']);
  assert.equal(f.definitions.length, 1);
  const definition = f.definitions[0];
  assert.equal(definition.kind, 'session-link');
  assert.equal(definition.title(), '关联会话');
  assert.equal(definition.guide[0].title(), '关联会话');
  assert.match(definition.guide[0].description(), /只读/);
  assert.equal(definition.keepMounted, true);
  assert.deepEqual(JSON.parse(JSON.stringify(f.registrations.find(r => r.name === 'sidebar.right.pane.tab').inject('exact-id'))), { sessionId: 'exact-id' });
  assert.ok(f.registrations.some(r => r.name === 'tool.call.toolview' && r.key === 'link_session_create'));
  assert.ok(f.registrations.some(r => r.name === 'tool.call.toolview' && r.key === 'link_session_archive'));
  assert.ok(f.registrations.every(r => r.name !== 'markdown.link'));
  assert.equal(f.calls.length, 0);
  assert.equal(f.listeners.size, 0);
  assert.doesNotMatch(source, /BetterSidebar|querySelector|window\.location|document\.addEventListener\(['"]click/);
  f.dispose(); assert.equal(f.registrations.length, 0); assert.equal(f.definitions.length, 0); assert.equal(f.eventDefinitions.length, 0);
});

test('visible reads use scope exact id and only relations; hidden tab has no timer or pending request', async () => {
  const f = fixture(), r = f.panel('native-scope', false);
  await r.flush(); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  r.show(true); await r.flush();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].body, { action: 'relations', sessionId: 'native-scope' });
  assert.equal(f.calls[0].url, '/api/session-link/view');
  assert.equal(f.calls[0].options.credentials, 'same-origin');
  assert.equal([...f.timers.values()][0].delay, 60000);
  await f.tick(r); assert.equal(f.calls.length, 2);
  r.show(false); await r.flush(); assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.get('visibilitychange').size, 0);
  await f.tick(r); assert.equal(f.calls.length, 2);
  r.show(true); await r.flush(); assert.equal(f.calls.length, 3);
  r.unmount(); assert.equal(f.timers.size, 0); assert.equal(f.listeners.get('visibilitychange').size, 0);
  assert.equal(r.commands.bound, null); assert.equal(r.lateWrites, 0);
});

test('background browser document suspends polling; foreground refreshes; tab abort releases timers', async () => {
  const f = fixture(), r = f.panel(); await r.flush();
  await f.visibility('hidden', r); assert.equal(f.timers.size, 0);
  await f.tick(r); assert.equal(f.calls.length, 1);
  await f.visibility('visible', r); assert.equal(f.calls.length, 2);
  r.abort(); await r.flush(); assert.equal(f.timers.size, 0);
  await f.tick(r); assert.equal(f.calls.length, 2); r.unmount();
});

test('in-flight view read aborts on hide; stale response cannot replace the current scope', async () => {
  let resolve;
  const f = fixture({ handler: () => new Promise(done => { resolve = done; }) });
  const r = f.panel(); const signal = f.calls[0].options.signal;
  r.show(false); assert.equal(signal.aborted, true); assert.equal(f.timers.size, 0);
  resolve(view([node('stale')])); await r.flush();
  assert.equal(treeItems(r.tree).length, 0); assert.equal(f.opened.length, 0);
  r.unmount(); assert.equal(r.lateWrites, 0); assert.equal(f.timers.size, 0);
});

test('tree uses actual independent runtime/task state and accessible parent-owned groups', async () => {
  const nodes = [node('self', 'running', '主项'), node('A'), { ...node('B', 'offline'), taskStatus: 'completed', hasResult: true }, node('C', 'archived')];
  const f = fixture({ data: view(nodes, [edge('self', 'A'), edge('self', 'B'), edge('self', 'C')]) });
  const r = f.panel(); await r.flush();
  const items = treeItems(r.tree); assert.equal(items.length, 4);
  assert.equal(items[0].props['aria-expanded'], true); assert.equal(items[0].props['aria-selected'], true);
  assert.ok(elements(items[0], e => e.props.role === 'group').length);
  assert.match(text(r.tree), /running.*idle.*offline.*任务 completed.*archived/);
  assert.match(text(r.tree), /idle 不代表任务完成/);
  assert.match(text(r.tree), /关联创建不等于原生父子/);
  assert.match(text(r.tree), /原生通信可用时优先使用原生通道，Session Link 作为跨会话补充/);
  assert.equal(elements(r.tree, e => e.type === 'button' && /归档/.test(text(e))).length, 0);
  assert.equal(button(r.tree, 'C').props.disabled, true);
  assert.match(source, /\.sl-group>\.sl-item:before\{[^}]*border-left/);
  assert.match(source, /last-child:before\{[^}]*border-bottom-left-radius:7px/);
  assert.doesNotMatch(source, /├|└/);
  assert.doesNotMatch(source, /#[\da-f]{3,8}\b|rgba?\(/i);
  r.unmount();
});

test('collapse/expand keyboard roving navigation works and bounded local state survives remount', async () => {
  const storage = new Map([['dsh.session-link.collapsed.v1', JSON.stringify(Array.from({ length: 250 }, (_, i) => `old${i}`))]]);
  const f = fixture({ storage, data: view([node('self'), node('child')], [edge('self', 'child')]) });
  const r = f.panel(); await r.flush();
  assert.equal(key(treeItems(r.tree)[0], 'ArrowLeft'), true); await r.flush();
  assert.equal(treeItems(r.tree).length, 1);
  assert.equal(JSON.parse(storage.get('dsh.session-link.collapsed.v1')).length, 200);
  r.unmount();
  const second = f.panel(); await second.flush(); assert.equal(treeItems(second.tree).length, 1);
  key(treeItems(second.tree)[0], 'ArrowRight'); await second.flush(); assert.equal(treeItems(second.tree).length, 2);
  key(treeItems(second.tree)[0], 'ArrowDown'); await second.flush(); assert.match(second.focused, /^child/);
  assert.equal(treeItems(second.tree)[1].props.tabIndex, 0);
  key(treeItems(second.tree)[1], 'ArrowLeft'); await second.flush(); assert.match(second.focused, /^self/);
  key(treeItems(second.tree)[0], 'End'); await second.flush(); assert.match(second.focused, /^child/);
  second.unmount();
});

test('malformed/cyclic/duplicate edges never duplicate nodes; non-creation peer edges do not invent lineage', async () => {
  const f = fixture({ data: view([node('self'), node('A'), node('B'), node('A')], [edge('self', 'A'), edge('A', 'B'), edge('B', 'self'), edge('self', 'A'), { sourceId: 'self', targetId: 'B', kind: 'peer' }]) });
  const r = f.panel(); await r.flush();
  assert.equal(treeItems(r.tree).length, 3);
  assert.deepEqual(treeItems(r.tree).map(e => e.props['aria-level']), [1, 2, 3]); r.unmount();
});

test('explicit click resolves exact target then calls formal openSession; copy never opens or wakes', async () => {
  const target = 'exact-id:/not-a-title';
  const nodes = [node('self'), node(target, 'idle', 'duplicate title')];
  const f = fixture({ data: view(nodes, [edge('self', target)]) }), r = f.panel(); await r.flush();
  assert.deepEqual(f.opened, []);
  await button(r.tree, 'duplicate title').props.onClick(); await r.flush();
  assert.deepEqual(f.calls[1].body, { action: 'resolve', sessionId: 'self', targetId: target });
  assert.deepEqual(f.opened, [target]);
  const copy = elements(r.tree, e => e.props['aria-label'] === '复制 duplicate title 的会话引用')[0];
  await copy.props.onClick(); await r.flush();
  assert.deepEqual(f.copied, [nodes[1].sessionRef]); assert.equal(f.calls.length, 2); r.unmount();
});

test('resolver optional/foreign address cannot redirect an exact-id click', async () => {
  const f = fixture({ handler: body => body.action === 'relations' ? view([node('self')]) : { targetId: 'self', address: 'wrong-target' } });
  const r = f.panel(); await r.flush(); await button(r.tree, 'self').props.onClick();
  assert.deepEqual(f.opened, ['self']); r.unmount();
});

test('resolver mismatch/error never navigates and preserves rendered relation data', async () => {
  const f = fixture({ handler: body => body.action === 'relations' ? view([node('self')]) : { targetId: 'wrong' } });
  const r = f.panel(); await r.flush(); await button(r.tree, 'self').props.onClick(); await r.flush();
  assert.equal(f.opened.length, 0); assert.match(text(r.tree), /不同的 ID/); assert.equal(treeItems(r.tree).length, 1); r.unmount();
});

test('read failures expose retry and retain previous data without inventing offline/finished', async () => {
  let fail = false;
  const f = fixture({ handler: () => { if (fail) throw new Error('unavailable'); return view([node('self', 'running')]); } });
  const r = f.panel(); await r.flush(); fail = true; await f.tick(r);
  assert.match(text(r.tree), /读取失败.*保留上次结果/); assert.match(text(r.tree), /running/); assert.ok(button(r.tree, '刷新'));
  r.unmount();
});

test('own tool cards retain raw details and only explicit, validated sessionRefs become clickable', async () => {
  const target = '目标/session';
  const value = { ok: true, sessionRefs: [ref(target, 'A [title]'), ref(target), { id: 'wrong', uri: uri('different') }], result: 'substantive result', peerText: { sessionRefs: [ref('injected')] } };
  const f = fixture(), r = f.tool('link_session_create', value); await r.flush();
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  assert.match(text(r.tree), /substantive result/);
  assert.equal(elements(r.tree, e => e.type === 'button' && e.props.className === 'sl-btn sl-title').length, 1);
  await button(r.tree, 'A [title]').props.onClick(); await r.flush();
  assert.deepEqual(f.opened, [target]); assert.deepEqual(f.calls[0].body, { action: 'resolve', sessionId: 'self', targetId: target });
  assert.equal(elements(r.tree, e => e.props.className === 'sl-btn sl-copy').length, 0);
  assert.deepEqual(f.copied, []);
  r.unmount(); assert.equal(r.lateWrites, 0);
});

test('every own tool summary identifies Session Link in all phases without dropping original JSON or refs', async () => {
  const f = fixture();
  const tools = ['link_session_create', 'link_session_archive', 'link_sessions', 'link_send', 'link_status', 'link_activity', 'link_task', 'link_reception', 'link_models', 'link_result'];
  const value = { ok: true, channel: 'session-link', sessionRefs: [ref('exact-target')], result: { original: '完整结果', nested: { retained: true } } };
  for (const name of tools) {
    const r = f.tool(name, value); await r.flush();
    const summary = () => text(elements(r.tree, e => e.type === 'summary')[0]);
    assert.ok(summary().startsWith(`Session Link · ${name} · `));
    assert.match(summary(), /工具已返回（不代表任务完成）/);
    assert.equal(text(elements(r.tree, e => e.props['aria-label'] === '完整工具结果')[0]), JSON.stringify(value));
    assert.equal(elements(r.tree, e => e.type === 'button' && e.props.className === 'sl-btn sl-title').length, 1);
    r.update({ phase: 'preparing' }); await r.flush();
    assert.ok(summary().startsWith(`Session Link · ${name} · `)); assert.match(summary(), /准备中/);
    r.update({ phase: 'start' }); await r.flush();
    assert.ok(summary().startsWith(`Session Link · ${name} · `)); assert.match(summary(), /工具执行中/);
    r.update({ phase: 'result', block: { ...r.props.block, isError: true } }); await r.flush();
    assert.ok(summary().startsWith(`Session Link · ${name} · `)); assert.match(summary(), /工具失败/);
    assert.equal(text(elements(r.tree, e => e.props['aria-label'] === '完整工具结果')[0]), JSON.stringify(value));
    r.unmount();
  }
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
});

test('route labels use only explicit returned channel metadata and never infer native admission', async () => {
  const f = fixture();
  const cases = [
    [{ channel: 'session-link' }, /通道：Session Link（session-link）/],
    [{ delivery: { channel: 'session-link' } }, /通道：Session Link（session-link）/],
    [{ channel: 'session-link-control' }, /控制路线：Session Link（session-link-control）/],
    [{ session: { communication: { recommendedChannel: 'native-if-host-admits', nativeEligibility: 'candidate', nativeTool: { visible: true, directCallable: true } } } }, null],
    [{ channel: 'native', admitted: true }, null],
    [{ session: { channel: 'session-link' } }, null]
  ];
  for (const [value, route] of cases) {
    const r = f.tool('link_task', value); await r.flush();
    const summary = text(elements(r.tree, e => e.type === 'summary')[0]);
    if (route) assert.match(summary, route); else assert.doesNotMatch(summary, /通道：|控制路线：/);
    assert.doesNotMatch(summary, /已批准|已准许|已送达|已阅读|admitted|guaranteed|原生已/);
    assert.equal(text(elements(r.tree, e => e.props['aria-label'] === '完整工具结果')[0]), JSON.stringify(value));
    r.unmount();
  }
  assert.equal(f.calls.length, 0);
});

test('archive tool distinguishes control operations and read-only discovery without an archive button or automatic action', async () => {
  const f = fixture();
  for (const [operation, label] of [['archive', '归档操作（不是通信投递）'], ['archive-discovery', '可归档会话查询（只读）']]) {
    const value = { ok: true, channel: 'session-link-control', operation, sessionId: 'self', targetId: 'exact-target', archiveState: 'archived', archived: true, stopActivityRequested: false, activityStopped: false, sessionRefs: [ref('exact-target', '目标会话')] };
    const r = f.tool('link_session_archive', value); await r.flush();
    const summary = text(elements(r.tree, e => e.type === 'summary')[0]);
    assert.ok(summary.includes(label)); assert.match(summary, /控制路线：Session Link（session-link-control）/);
    assert.doesNotMatch(summary, /通道：|消息已发送|已送达|已完成/);
    assert.equal(text(elements(r.tree, e => e.props['aria-label'] === '完整工具结果')[0]), JSON.stringify(value));
    assert.deepEqual(elements(r.tree, e => e.type === 'button').map(text), ['目标会话']);
    assert.equal(f.calls.length, 0); assert.equal(f.opened.length, 0);
    await button(r.tree, '目标会话').props.onClick(); await r.flush();
    assert.equal(f.calls.at(-1).body.action, 'resolve'); assert.equal(f.opened.at(-1), 'exact-target');
    f.calls.length = 0; f.opened.length = 0;
    r.unmount();
  }
  const unknown = f.tool('link_session_archive', { ok: true, channel: 'session-link-control' }); await unknown.flush();
  assert.doesNotMatch(text(elements(unknown.tree, e => e.type === 'summary')[0]), /归档操作|可归档会话查询/);
  assert.equal(f.calls.length, 0); unknown.unmount();
});

test('legacy/non-JSON/failure tool results remain inspectable and never create title-guessed navigation', async () => {
  const f = fixture(), r = f.tool('link_send', 'plain text mentions self @self and dsh-session:bad', { isError: true, error: { code: 'FAILED' } });
  await r.flush(); assert.match(text(r.tree), /工具失败/); assert.match(text(r.tree), /plain text/);
  assert.equal(elements(r.tree, e => e.type === 'button' && e.props.className === 'sl-btn sl-title').length, 0);
  assert.equal(f.calls.length, 0); r.unmount();
});

test('official codec is JSON-string base64url, never base64 of the raw id', async () => {
  const f = fixture(), r = f.tool('link_send', { sessionRefs: [{ id: 'target', title: 'invalid raw codec', uri: `dsh-session:${Buffer.from('target').toString('base64url')}` }, ref('target', 'valid canonical')] });
  await r.flush();
  assert.deepEqual(elements(r.tree, e => e.type === 'button' && e.props.className === 'sl-btn sl-title').map(text), ['valid canonical']);
  await button(r.tree, 'valid canonical').props.onClick(); await r.flush();
  assert.deepEqual(f.opened, ['target']); assert.deepEqual(f.copied, []); r.unmount();
});

const catalog = entries => ({ phase: 'ready', ids: Object.keys(entries), byId: Object.fromEntries(Object.entries(entries).map(([id, title]) => [id, { id, title, displayTitle: title || id }])), projectionsBySession: {} });
const chatTitles = root => elements(root, e => e.type === 'button' && e.props.className === 'sl-btn sl-title').map(text);
const resultEvent = (kind = 'task-result') => ({
  type: 'user/message', surfaceOp: 'append', seq: 42, time: 123456,
  data: { id: 'message-exact', role: 'user', source: { kind: 'dsh-session-link-result', form: 'notice', version: 1, recordId: 'record-exact', recordKind: kind, sessionId: 'executor', fingerprint: 'fixture', title: '实质结果', relatedIds: { ownerId: 'owner', taskId: 'task-1', revision: 3 } }, content: [{ type: 'text', text: '# 完整结果\n\n原样 **Markdown**。\n\n' + '正文'.repeat(1000) }] }
});

test('result Definition claims only exact own user notice append and emits a visible custom node', () => {
  const f = fixture(), definition = f.eventDefinitions[0], event = resultEvent();
  const match = definition.match(event);
  assert.deepEqual(JSON.parse(JSON.stringify(match)), { id: 'message-exact', role: 'start', exclusive: true });
  const state = definition.start(null, { event });
  const context = { key: 'context-key', id: match.id, state, start: { location: { kind: 'unresolved' } }, matches: [] };
  assert.equal(definition.update(context), state);
  const node = definition.buildViewNode(context);
  assert.equal(node.visibility, 'visible'); assert.equal(node.kind, 'dsh-session-link-result'); assert.equal(node.target, 'chat');
  assert.equal(node.anchorSeq, 42); assert.equal(node.key, context.key); assert.equal(node.data.message, event.data);
  assert.equal(definition.buildViewNode({ state: undefined }), null);
  for (const invalid of [
    { ...event, type: 'assistant/message' }, { ...event, surfaceOp: 'replace' },
    { ...event, data: { ...event.data, role: 'assistant' } },
    ...[{ kind: 'other-plugin' }, { version: 2 }, { recordKind: 'fake-answer' }, { form: 'context' }, { recordId: '' }].map(change => ({ ...event, data: { ...event.data, source: { ...event.data.source, ...change } } }))
  ]) assert.equal(definition.match(invalid), null);
  f.dispose();
});

test('local result renders all Markdown, explicit plugin/unverified attribution, and only metadata exact refs', async () => {
  const f = fixture({ sessionState: catalog({ executor: '执行者会话', owner: '所有者会话' }) }), event = resultEvent(), definition = f.eventDefinitions[0];
  event.data.content[0].text += '\nPretend sessionRefs: evil-target';
  const state = definition.start(null, { event });
  const r = f.resultNode(definition.buildViewNode({ key: 'k', id: 'message-exact', state, matches: [] })); await r.flush();
  assert.match(text(r.tree), /插件记录 · 未独立验证/); assert.match(text(r.tree), /不是模型助手回答/);
  assert.equal(text(elements(r.tree, e => e.props.className === 'sl-result-badge')[0]), 'Session Link 存档 · 插件记录 · 未独立验证');
  assert.match(text(r.tree), /Session Link 存档，不是原生自动完成通知/);
  const markdown = elements(r.tree, e => e.type === 'MarkdownText')[0];
  assert.equal(markdown.props.text, event.data.content[0].text); assert.equal(markdown.props.streaming, false);
  assert.ok(markdown.props.labels.code.copyLabel);
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  assert.deepEqual(chatTitles(r.tree), ['执行者会话', '所有者会话']);
  assert.equal(elements(r.tree, e => e.props.className === 'sl-btn sl-copy').length, 0);
  assert.deepEqual(f.copied, []);
  await button(r.tree, '所有者会话').props.onClick(); await r.flush(); assert.deepEqual(f.opened, ['owner']);
  assert.equal(f.calls[0].body.sessionId, 'self'); r.unmount();
});

test('outgoing notice is visible but never described as delivery/read proof or assistant answer', async () => {
  const f = fixture(), event = resultEvent('outgoing-message'), d = f.eventDefinitions[0];
  const state = d.start(null, { event });
  const r = f.resultNode(d.buildViewNode({ key: 'k', id: 'i', state, matches: [] })); await r.flush();
  assert.match(text(r.tree), /发送内容存档；不是送达、阅读或完成证明/);
  assert.match(text(r.tree), /Session Link 存档，不是原生自动完成通知/);
  assert.match(text(r.tree), /不是模型助手回答/);
  assert.equal(f.calls.length, 0); r.unmount();
  const invalid = f.resultNode({ data: { message: { ...event.data, source: { ...event.data.source, version: 2 } } } });
  await invalid.flush(); assert.equal(invalid.tree, null); invalid.unmount();
});

test('chat references use semantic blue tinted chips with a single navigation control and no copy affordance', async () => {
  assert.match(source, /--sl-link-blue:var\(--dsw-static-blue-600\)/);
  assert.match(source, /\[data-ds-dark-theme\] \.sl-tool-ref\{--sl-link-blue:var\(--dsw-static-blue-300\)/);
  assert.match(source, /background:color-mix\(in srgb,var\(--sl-link-blue\) 12%,transparent\)/);
  const f = fixture(), r = f.tool('link_task', { sessionRefs: [ref('target', '会话标题')] }); await r.flush();
  const chips = elements(r.tree, e => e.props.className === 'sl-tool-ref');
  assert.equal(chips.length, 1);
  assert.equal(elements(chips[0], e => e.type === 'button').length, 1);
  assert.equal(elements(chips[0], e => /复制/.test(e.props['aria-label'] || '')).length, 0);
  assert.deepEqual(f.opened, []); assert.deepEqual(f.copied, []);
  await button(r.tree, '会话标题').props.onClick(); await r.flush();
  assert.deepEqual(f.opened, ['target']); r.unmount();
});

test('historical typed records with only related ids render current catalog titles and react to rename without changing identities', async () => {
  const f = fixture({ sessionState: catalog({ owner: '所有者当前标题', target: '子会话标题' }) });
  const event = resultEvent(), message = event.data;
  delete message.source.sessionId;
  message.source.relatedIds = { ownerId: 'owner', targetId: 'target', taskId: 'task-1' };
  const original = JSON.stringify(message), r = f.resultNode({ data: { message } }); await r.flush();
  assert.deepEqual(chatTitles(r.tree), ['所有者当前标题', '子会话标题']);
  assert.equal(f.sessionListeners.size, 1); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  f.setSessions(catalog({ owner: '所有者当前标题', target: '重命名后的子会话' })); await r.flush();
  assert.deepEqual(chatTitles(r.tree), ['所有者当前标题', '重命名后的子会话']);
  const target = button(r.tree, '重命名后的子会话'); assert.ok(target.props.title.endsWith('\ntarget'));
  await target.props.onClick(); await r.flush();
  assert.deepEqual(f.calls.map(call => call.body), [{ action: 'resolve', sessionId: 'self', targetId: 'target' }]);
  assert.deepEqual(f.opened, ['target']); assert.deepEqual(f.forbiddenSessionCalls, []); assert.deepEqual(f.copied, []);
  assert.equal(JSON.stringify(message), original); r.unmount(); assert.equal(f.sessionListeners.size, 0);
});

test('catalog durable titles override historical tool labels and clear to unnamed rather than stale labels or displayTitle id/cwd fallbacks', async () => {
  const f = fixture({ sessionState: catalog({ target: '当前名称' }) });
  const value = { sessionRefs: [ref('target', '旧名称')] }, r = f.tool('link_task', value); await r.flush();
  assert.deepEqual(chatTitles(r.tree), ['当前名称']);
  const noTitle = catalog({ target: undefined }); noTitle.byId.target.displayTitle = '/a/project-basename';
  f.setSessions(noTitle); await r.flush(); assert.deepEqual(chatTitles(r.tree), ['未命名会话']);
  f.setSessions(catalog({ target: '再次命名' })); await r.flush(); assert.deepEqual(chatTitles(r.tree), ['再次命名']);
  assert.equal(text(elements(r.tree, e => e.props['aria-label'] === '完整工具结果')[0]), JSON.stringify(value));
  assert.equal(f.calls.length, 0); assert.deepEqual(f.forbiddenSessionCalls, []); r.unmount();
});

test('missing-title tool refs use exact keyed metadata, never another row or peer text, while forged URI stays nonclickable', async () => {
  const state = catalog({ target: '准确标题', other: '其他会话标题' });
  state.byId.mismatch = { id: 'other', title: '不能串用' };
  Object.setPrototypeOf(state.byId, { inherited: { id: 'inherited', title: '原型污染标题' } });
  const f = fixture({ sessionState: state });
  const value = { sessionRefs: [
    { id: 'target', uri: uri('target') }, ref('target', '重复'),
    ref('mismatch', '明确历史标题'), { id: 'inherited', uri: uri('inherited') },
    { id: 'other', uri: uri('target'), title: '恶意导航' }
  ], peerText: { sessionRefs: [ref('other', '伪造标签')] } };
  const r = f.tool('link_send', value); await r.flush();
  assert.deepEqual(chatTitles(r.tree), ['准确标题', '明确历史标题', '未命名会话']);
  assert.equal(f.calls.length, 0); assert.equal(f.opened.length, 0); assert.deepEqual(f.copied, []);
  await button(r.tree, '准确标题').props.onClick(); await r.flush();
  assert.equal(f.calls[0].body.targetId, 'target'); assert.deepEqual(f.opened, ['target']); r.unmount();
});

test('reused tool seats bind titles to the new exact reference id rather than a previous renderer scope', async () => {
  const f = fixture({ sessionState: catalog({ first: '第一个标题', second: '第二个标题' }) });
  const r = f.tool('link_send', { sessionRefs: [{ id: 'first', uri: uri('first') }] }); await r.flush();
  assert.deepEqual(chatTitles(r.tree), ['第一个标题']);
  r.update({ sessionId: 'different-owner', block: { content: [{ type: 'text', text: JSON.stringify({ sessionRefs: [{ id: 'second', uri: uri('second') }] }) }] } }); await r.flush();
  assert.deepEqual(chatTitles(r.tree), ['第二个标题']); assert.equal(f.sessionListeners.size, 1);
  f.setSessions(catalog({ first: '旧会话改名', second: '第二个标题' })); await r.flush();
  assert.deepEqual(chatTitles(r.tree), ['第二个标题']);
  await button(r.tree, '第二个标题').props.onClick(); await r.flush();
  assert.deepEqual(f.calls[0].body, { action: 'resolve', sessionId: 'different-owner', targetId: 'second' });
  assert.deepEqual(f.opened, ['second']); r.unmount();
});

test('old Hosts use only valid explicit labels or an honest unnamed label, never session ids as primary text', async () => {
  const f = fixture();
  const value = { sessionRefs: [
    ref('known', ' 明确标题 '), { id: 'no-title', uri: uri('no-title') }, ref('id-fallback'),
    ref('blank', '  '), ref('control', 'bad\u0000title'), ref('oversized', 'x'.repeat(4097))
  ] };
  const r = f.tool('link_sessions', value); await r.flush();
  assert.deepEqual(chatTitles(r.tree), ['明确标题', ...Array(5).fill('未命名会话')]);
  assert.equal(f.sessionReads, 0); assert.equal(f.sessionListeners.size, 0); assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  assert.ok(elements(r.tree, e => e.type === 'button' && e.props.title?.endsWith('\nno-title')).length === 1);
  const noTitleRecord = resultEvent(); delete noTitleRecord.data.source.sessionId;
  noTitleRecord.data.source.relatedIds = { targetId: 'historical-target' };
  const old = f.resultNode({ data: { message: noTitleRecord.data } }); await old.flush();
  assert.deepEqual(chatTitles(old.tree), ['未命名会话']);
  old.unmount(); r.unmount(); assert.equal(f.listeners.get('visibilitychange').size, 0);
});

test('all chat title seats share one metadata observer; hidden and disposed seats release resources and ignore queued notifications', async () => {
  const f = fixture({ sessionState: catalog({ target: '可见标题' }), initiallyHidden: true });
  assert.equal(f.sessionReads, 0); assert.equal(f.serviceReads.length, 0);
  const first = f.tool('link_task', { sessionRefs: [{ id: 'target', uri: uri('target') }] });
  const second = f.tool('link_send', { sessionRefs: [ref('target', '历史标题')] }); await first.flush(); await second.flush();
  assert.equal(f.sessionReads, 0); assert.equal(f.sessionListeners.size, 0); assert.deepEqual(chatTitles(first.tree), ['未命名会话']);
  await f.visibility('visible'); await first.flush(); await second.flush();
  assert.equal(f.sessionListeners.size, 1); assert.equal(f.sessionReads, 1);
  assert.deepEqual(chatTitles(first.tree), ['可见标题']); assert.deepEqual(chatTitles(second.tree), ['可见标题']);
  const queued = [...f.sessionListeners][0];
  await f.visibility('hidden'); await first.flush(); await second.flush();
  assert.equal(f.sessionListeners.size, 0); assert.equal(f.timers.size, 0);
  const reads = f.sessionReads; f.setSessions(catalog({ target: '后台重命名' })); queued();
  await first.flush(); await second.flush(); assert.equal(f.sessionReads, reads);
  await f.visibility('visible'); await first.flush(); await second.flush();
  assert.deepEqual(chatTitles(first.tree), ['后台重命名']);
  first.unmount(); assert.equal(f.sessionListeners.size, 1);
  const afterUnmount = [...f.sessionListeners][0]; second.unmount();
  assert.equal(f.sessionListeners.size, 0); assert.equal(f.listeners.get('visibilitychange').size, 0);
  afterUnmount(); assert.equal(first.lateWrites, 0); assert.equal(second.lateWrites, 0);
  const third = f.tool('link_task', { sessionRefs: [ref('target', '历史标题')] }); await third.flush();
  assert.equal(f.sessionListeners.size, 1); const afterDispose = [...f.sessionListeners][0];
  f.dispose(); assert.equal(f.sessionListeners.size, 0); afterDispose(); await third.flush(); third.unmount();
  assert.equal(third.lateWrites, 0); assert.equal(f.calls.length, 0); assert.deepEqual(f.forbiddenSessionCalls, []);
});

test('invalid identities and non-own records never start metadata observation or manufacture clickable refs', async () => {
  const f = fixture({ sessionState: catalog({ target: '标题' }) });
  const bad = f.tool('link_task', { sessionRefs: [
    { id: 'target', uri: uri('different') }, { id: 'control\u0000id', uri: uri('control\u0000id') },
    { id: 'x'.repeat(257), uri: uri('x'.repeat(257)) }, { uri: uri('target'), title: '标题' }
  ] }); await bad.flush();
  const event = resultEvent(); event.data.source.version = 2;
  const other = f.resultNode({ data: { message: event.data } }); await other.flush();
  assert.deepEqual(chatTitles(bad.tree), []); assert.equal(other.tree, null);
  assert.equal(f.sessionReads, 0); assert.equal(f.serviceReads.length, 0); assert.equal(f.sessionListeners.size, 0); assert.equal(f.calls.length, 0);
  bad.unmount(); other.unmount(); f.dispose();
});

const workspace = (workspaceId, sessionIds) => ({ workspaceId, sessionIds });
const workspaces = items => ({ phase: 'ready', state: 'idle', items, archivedSessionIds: [], pinnedSessionIds: [], error: null });
const workspaceReply = (workspaceId, edges = [], truncated = false) => ({ schemaVersion: 1, workspaceId, edges, truncated });
const readNative = f => f.nativeRegistrations[0].source;
const nativeEdges = source => JSON.parse(JSON.stringify(source.getSnapshot().edges));

test('old Hosts fail feature detection without acquiring any metadata resources or replacing native rows', () => {
  for (const options of [{}, { nativeVersion: 0 }, { nativeVersion: 2 }, { nativeVersion: 1, nativeRegister: false }]) {
    const f = fixture(options);
    assert.equal(f.nativeRegistrations.length, 0); assert.equal(f.serviceReads.length, 0);
    assert.equal(f.workspaceReads, 0); assert.equal(f.workspaceListeners.size, 0);
    assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0); assert.equal(f.listeners.size, 0);
    assert.ok(f.registrations.some(r => r.name === 'sidebar.right.pane.tab'));
    assert.ok(f.registrations.every(r => !r.name.startsWith('sidebar.workspaces')));
    f.dispose();
  }
  assert.doesNotMatch(source, /appendChild|insertBefore|replaceChildren|createPortal|MutationObserver|\.retain\(|\.activate\(/);
});

test('one registered root source has identity-stable snapshots and shares reads across native subscribers', async () => {
  const f = fixture({ nativeVersion: 1, workspaceState: workspaces([workspace('ws', ['A', 'B'])]), handler: body => workspaceReply(body.workspaceId, [edge('A', 'B')]) });
  assert.equal(f.nativeRegistrations.length, 1);
  assert.equal(f.nativeRegistrations[0].id, 'dsh-session-link'); assert.equal(f.nativeRegistrations[0].version, 1);
  const source = readNative(f), before = source.getSnapshot();
  assert.equal(source.getSnapshot(), before); assert.equal(f.workspaceReads, 0);
  assert.equal(f.calls.length, 0); assert.equal(f.workspaceListeners.size, 0); assert.equal(f.listeners.size, 0);
  let notified = 0;
  const first = source.subscribe(() => notified++), second = source.subscribe(() => notified++);
  await f.settle();
  assert.equal(f.calls.length, 1); assert.equal(f.workspaceListeners.size, 1);
  assert.deepEqual(f.calls[0].body, { action: 'workspace-relations', workspaceId: 'ws' });
  assert.deepEqual(nativeEdges(source), [{ ...edge('A', 'B'), workspaceId: 'ws' }]);
  assert.equal(source.getSnapshot().loading, false); assert.equal(source.getSnapshot().truncated, false);
  const settled = source.getSnapshot(); assert.equal(source.getSnapshot(), settled);
  assert.equal(Object.isFrozen(settled), true); assert.equal(Object.isFrozen(settled.edges), true); assert.equal(Object.isFrozen(settled.edges[0]), true);
  assert.throws(() => { settled.edges[0].targetId = 'redirect'; }, TypeError);
  assert.ok(notified >= 2); assert.deepEqual(f.opened, []); assert.deepEqual(f.copied, []);
  assert.equal([...f.timers.values()].filter(t => t.kind === 'interval').length, 1);
  first(); assert.equal(f.workspaceListeners.size, 1);
  const notices = notified; second(); second();
  assert.equal(f.workspaceListeners.size, 0); assert.equal(f.listeners.get('visibilitychange').size, 0); assert.equal(f.timers.size, 0);
  await f.tick({ flush: () => f.settle() }); assert.equal(f.calls.length, 1); assert.equal(notified, notices);
  assert.deepEqual(nativeEdges(source), []);
  const resumed = source.subscribe(() => {}); await f.settle(); assert.equal(f.calls.length, 2);
  f.dispose(); assert.equal(f.nativeRegistrations.length, 0); assert.equal(f.workspaceListeners.size, 0); assert.equal(f.timers.size, 0);
  resumed(); source.subscribe(() => {}); assert.equal(f.timers.size, 0);
});

test('membership changes abort old workspace reads; removed sessions/workspaces cannot reappear from late responses', async () => {
  const pending = [];
  const f = fixture({ nativeVersion: 1, workspaceState: workspaces([workspace('old', ['A', 'B'])]), handler: body => new Promise(resolve => pending.push({ body, resolve })) });
  const source = readNative(f), unsubscribe = source.subscribe(() => {});
  assert.equal(f.calls.length, 1);
  f.setWorkspaces(workspaces([workspace('new', ['C', 'D'])]));
  assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.calls.length, 2);
  assert.deepEqual(nativeEdges(source), []);
  pending[0].resolve(workspaceReply('old', [edge('A', 'B')])); await f.settle();
  assert.deepEqual(nativeEdges(source), []); assert.equal(source.getSnapshot().loading, true);
  pending[1].resolve(workspaceReply('new', [edge('C', 'D')])); await f.settle();
  assert.deepEqual(nativeEdges(source), [{ ...edge('C', 'D'), workspaceId: 'new' }]);
  const snapshot = source.getSnapshot();
  f.setWorkspaces({ ...workspaces([{ ...workspace('new', ['D', 'C']), title: 'renamed' }]), pinnedSessionIds: ['D'] });
  assert.equal(f.calls.length, 2); assert.equal(source.getSnapshot(), snapshot);
  f.setWorkspaces(workspaces([workspace('new', ['C'])])); assert.deepEqual(nativeEdges(source), []);
  pending[2].resolve(workspaceReply('new', [edge('C', 'D')])); await f.settle();
  assert.deepEqual(nativeEdges(source), []); assert.equal(source.getSnapshot().truncated, true);
  f.setWorkspaces(workspaces([])); await f.settle();
  assert.deepEqual(nativeEdges(source), []); assert.equal(source.getSnapshot().loading, false);
  assert.equal(f.calls.length, 3); unsubscribe(); f.dispose();
});

test('source rechecks current membership at commit before batched controller notifications arrive', async () => {
  const pending = [];
  const f = fixture({ nativeVersion: 1, workspaceState: workspaces([workspace('ws', ['A', 'B'])]), handler: () => new Promise(resolve => pending.push(resolve)) });
  const source = readNative(f), unsubscribe = source.subscribe(() => {});
  f.setWorkspaces(workspaces([]), false);
  pending[0](workspaceReply('ws', [edge('A', 'B')])); await f.settle();
  assert.deepEqual(nativeEdges(source), []); assert.equal(source.getSnapshot().loading, false);
  assert.equal(f.calls.length, 1); unsubscribe(); f.dispose();
});

test('source periodically refreshes only one readonly batch and clears stale edges on unavailable reads', async () => {
  let fail = false;
  const f = fixture({ nativeVersion: 1, workspaceState: workspaces([workspace('ws', ['A', 'B'])]), handler: body => {
    if (fail) throw new Error('unavailable');
    return workspaceReply(body.workspaceId, [edge('A', 'B')]);
  } });
  const source = readNative(f), unsubscribe = source.subscribe(() => {}); await f.settle();
  assert.equal(nativeEdges(source).length, 1);
  const intervals = [...f.timers.values()].filter(timer => timer.kind === 'interval');
  assert.equal(intervals.length, 1); assert.equal(intervals[0].delay, 60000);
  fail = true; await f.tick({ flush: () => f.settle() });
  assert.equal(f.calls.length, 2); assert.deepEqual(nativeEdges(source), []); assert.equal(source.getSnapshot().truncated, true);
  unsubscribe(); await f.tick({ flush: () => f.settle() }); assert.equal(f.calls.length, 2);
  f.dispose(); assert.deepEqual(f.opened, []);
});

test('source visibility and disposal cancel timers, membership subscriptions and requests without late publication', async () => {
  const pending = [];
  const f = fixture({ nativeVersion: 1, initiallyHidden: true, workspaceState: workspaces([workspace('ws', ['A', 'B'])]), handler: () => new Promise(resolve => pending.push(resolve)) });
  const source = readNative(f); let notifications = 0;
  const unsubscribe = source.subscribe(() => notifications++);
  assert.equal(f.calls.length, 0); assert.equal(f.workspaceReads, 0); assert.equal(f.workspaceListeners.size, 0); assert.equal(f.timers.size, 0);
  await f.visibility('visible'); assert.equal(f.calls.length, 1); assert.equal(f.workspaceListeners.size, 1);
  await f.visibility('hidden'); assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.workspaceListeners.size, 0); assert.equal(f.timers.size, 0); assert.equal(source.getSnapshot().loading, false);
  const hidden = source.getSnapshot(), count = notifications;
  pending[0](workspaceReply('ws', [edge('A', 'B')])); await f.settle();
  assert.equal(source.getSnapshot(), hidden); assert.equal(notifications, count);
  await f.visibility('visible'); assert.equal(f.calls.length, 2);
  f.dispose(); assert.equal(f.calls[1].options.signal.aborted, true);
  assert.equal(f.workspaceListeners.size, 0); assert.equal(f.listeners.get('visibilitychange').size, 0); assert.equal(f.timers.size, 0);
  const disposed = source.getSnapshot(), finalCount = notifications;
  pending[1](workspaceReply('ws', [edge('A', 'B')])); await f.settle();
  assert.equal(source.getSnapshot(), disposed); assert.equal(notifications, finalCount);
  unsubscribe(); await f.visibility('visible'); assert.equal(f.calls.length, 2);
});

test('only complete ready and idle workspace membership authorizes source reads; transient lists clear old edges', async () => {
  const ready = workspaces([workspace('ws', ['A', 'B'])]);
  const f = fixture({ nativeVersion: 1, workspaceState: { ...ready, phase: 'pending', state: 'loading' }, handler: body => workspaceReply(body.workspaceId, [edge('A', 'B')]) });
  const source = readNative(f), unsubscribe = source.subscribe(() => {}); await f.settle();
  assert.equal(f.calls.length, 0); assert.equal(source.getSnapshot().loading, true); assert.equal(source.getSnapshot().truncated, true);
  f.setWorkspaces(ready); await f.settle(); assert.equal(f.calls.length, 1); assert.equal(nativeEdges(source).length, 1);
  for (const incomplete of [{ ...ready, state: 'loading' }, { ...ready, state: 'error' }, { ...ready, items: undefined }]) {
    f.setWorkspaces(incomplete); await f.settle(); assert.deepEqual(nativeEdges(source), []); assert.equal(source.getSnapshot().truncated, true);
  }
  assert.equal(f.calls.length, 1); f.setWorkspaces(ready); await f.settle(); assert.equal(f.calls.length, 2);
  unsubscribe(); f.dispose();
});

test('wire parsing fails closed for wrong versions/workspaces, incomplete envelopes, oversized arrays and read errors', async () => {
  const badReplies = [
    { schemaVersion: 2, workspaceId: 'bad', edges: [], truncated: false },
    workspaceReply('different', [edge('A', 'B')]),
    { schemaVersion: 1, workspaceId: 'bad', edges: null, truncated: false },
    { schemaVersion: 1, workspaceId: 'bad', edges: [] },
    workspaceReply('bad', Array.from({ length: 1001 }, () => edge('A', 'B'))),
    new Error('denied')
  ];
  for (const reply of badReplies) {
    const f = fixture({ nativeVersion: 1, workspaceState: workspaces([workspace('bad', ['A', 'B']), workspace('good', ['C', 'D'])]), handler: body => {
      if (body.workspaceId === 'good') return workspaceReply('good', [edge('C', 'D')]);
      if (reply instanceof Error) throw reply;
      return reply;
    } });
    const source = readNative(f), unsubscribe = source.subscribe(() => {}); await f.settle();
    assert.deepEqual(nativeEdges(source), [{ ...edge('C', 'D'), workspaceId: 'good' }]);
    assert.equal(source.getSnapshot().truncated, true); assert.equal(source.getSnapshot().loading, false);
    unsubscribe(); f.dispose();
  }
});

test('source accepts only exact creation ids in the same current workspace; malformed and cross-workspace edges are omitted', async () => {
  const f = fixture({ nativeVersion: 1, workspaceState: workspaces([workspace('ws', ['A', 'B']), workspace('other', ['C'])]), handler: body => workspaceReply(body.workspaceId, body.workspaceId === 'ws' ? [
    edge('A', 'B'), edge('A', 'B'), edge('A', 'C'), edge('missing', 'B'), edge('A', 'A'),
    { ...edge('A', 'B'), kind: 'parent' }, { ...edge('A', 'B'), workspaceId: 'other' },
    edge('', 'B'), edge('x'.repeat(257), 'B'), edge('bad\u0000id', 'B'), null
  ] : []) });
  const source = readNative(f), unsubscribe = source.subscribe(() => {}); await f.settle();
  assert.deepEqual(nativeEdges(source), [{ ...edge('A', 'B'), workspaceId: 'ws' }]); assert.equal(source.getSnapshot().truncated, true);
  assert.deepEqual(f.opened, []); assert.deepEqual(f.copied, []);
  assert.ok(f.calls.every(call => call.body.action === 'workspace-relations' && !Object.hasOwn(call.body, 'sessionId')));
  unsubscribe(); f.dispose();
});

test('source batches at most four workspace reads and bounds the complete workspace list to one hundred', async () => {
  const pending = []; let inflight = 0, peak = 0;
  const f = fixture({ nativeVersion: 1, workspaceState: workspaces(Array.from({ length: 101 }, (_, i) => workspace(`ws-${String(i).padStart(3, '0')}`, ['A', 'B']))), handler: body => {
    inflight++; peak = Math.max(peak, inflight);
    return new Promise(resolve => pending.push(() => { inflight--; resolve(workspaceReply(body.workspaceId, [edge('A', 'B')])); }));
  } });
  const source = readNative(f), unsubscribe = source.subscribe(() => {});
  assert.equal(f.calls.length, 4);
  while (pending.length) { for (const resolve of pending.splice(0)) resolve(); await f.settle(); }
  assert.equal(peak, 4); assert.equal(f.calls.length, 100); assert.equal(nativeEdges(source).length, 100);
  assert.equal(source.getSnapshot().truncated, true); assert.equal(source.getSnapshot().loading, false);
  unsubscribe(); f.dispose();
});

test('complete published edge count is bounded at one thousand, with explicit truncation and bounded membership', async () => {
  const members = ['root', ...Array.from({ length: 700 }, (_, i) => `n${i}`)];
  const f = fixture({ nativeVersion: 1, workspaceState: workspaces(['one', 'two'].map(id => workspace(id, members))), handler: body => workspaceReply(body.workspaceId, members.slice(1).map(id => edge('root', id))) });
  const source = readNative(f), unsubscribe = source.subscribe(() => {}); await f.settle();
  assert.equal(nativeEdges(source).length, 1000); assert.equal(source.getSnapshot().truncated, true);
  unsubscribe(); f.dispose();
  const invalid = fixture({ nativeVersion: 1, workspaceState: workspaces([
    workspace('too-many', Array(50001).fill('member')), workspace('invalid', ['A', null]),
    workspace('duplicate', ['A', 'B']), workspace('duplicate', ['C', 'D'])
  ]) });
  const rejected = readNative(invalid), stop = rejected.subscribe(() => {}); await invalid.settle();
  assert.equal(invalid.calls.length, 0); assert.equal(rejected.getSnapshot().truncated, true); assert.deepEqual(nativeEdges(rejected), []);
  stop(); invalid.dispose();
});

test('unmount aborts tool resolution and late response cannot navigate', async () => {
  let resolve;
  const f = fixture({ handler: () => new Promise(done => { resolve = done; }) });
  const r = f.tool('link_task', { sessionRefs: [ref('target', '目标会话')] }); await r.flush();
  const task = button(r.tree, '目标会话').props.onClick();
  r.unmount(); assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.timers.size, 0);
  resolve({ targetId: 'target' }); await task; await r.flush();
  assert.deepEqual(f.opened, []); assert.equal(r.lateWrites, 0); assert.equal(f.timers.size, 0);
});
