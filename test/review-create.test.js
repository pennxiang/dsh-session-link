import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionCreator } from '../lib/session-create.js';
import { createStore } from '../lib/store.js';
import { createService } from '../lib/service.js';
import { TOOLS } from '../lib/tool-schema.js';

// Isolated contract fixtures only: no real Host, model request, user session or inbox.
async function fixture(t, config = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'session-link-review-create-')));
  const store = await createStore(join(directory, 'ledger'));
  const agents = new Map(); const roots = new Set(); const selections = new WeakMap();
  const calls = { create: [], local: [], permission: [], rename: [], messages: [], resolve: [], globals: 0 };
  const hooks = {};
  const defaults = Object.freeze({ provider: 'global-provider', model: 'global-model', reasoningEffort: 'low' });
  let serial = 0; let clock = 100000;
  const add = (id, { root = true, origin, parentSession, delegationDepth } = {}) => {
    const session = { header: { id, cwd: directory, ...(origin ? { origin } : {}), ...(parentSession ? { parentSession } : {}), ...(delegationDepth !== undefined ? { delegationDepth } : {}) }, permission: 'read-only', preset: 'guarded', pending: null };
    const agent = { id, session, status: 'idle', followup(message) {
      calls.messages.push({ id, message, permission: session.permission, preset: session.preset, selected: structuredClone(selections.get(agent)?.current) });
      return hooks.followup?.(agent, message);
    } };
    agents.set(id, agent); if (root) roots.add(agent); return agent;
  };
  const caller = add('caller'); const other = add('other');
  const workspaces = new Map();
  const registerWorkspace = path => {
    const found = [...workspaces.values()].find(w => w.path === path);
    if (found) return found;
    const workspace = { id: `workspace-${workspaces.size + 1}`, path, sessionIds: [], async attachSession(id) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id); } };
    workspaces.set(workspace.id, workspace); return workspace;
  };
  const sourceWorkspace = registerWorkspace(directory); sourceWorkspace.sessionIds.push(caller.id, other.id);
  const ctx = {
    agents: { get: id => agents.get(id), list: () => [...agents.values()], roots: () => [...roots] },
    workspaceRegistry: { archivedSessionIds: [], list: () => [...workspaces.values()], get: id => workspaces.get(id), create: async path => registerWorkspace(path) },
    sessionTitle: { rename() {} },
    workingDirectory: { get: session => session.header.cwd },
    sessionProjections: { stateOf: (session, key) => key === 'agentPreset' ? session.preset : key === 'modelSelection' ? { lastUsed: null, pending: session.pending } : undefined },
    agentPresets: { resolve: async id => hooks.presetResolve ? hooks.presetResolve(id) : { id } },
    permissionPresets: {
      current: session => session.permission,
      resolve: name => name === 'read-only' ? { sandbox: 'read-only', approval: 'ask' } : name === 'danger-full-access' ? { sandbox: 'danger-full-access', approval: 'never' } : undefined,
      set(session, name) { calls.permission.push({ session, name }); if (hooks.permissionSet) return hooks.permissionSet(session, name); session.permission = name; },
    },
    llm: {
      listProviders: () => [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }],
      listModels: async provider => provider === 'alpha' ? [{ id: 'reasoner', name: 'Reasoner' }] : [{ id: 'plain', name: 'Plain' }],
      resolveModelInfo: async (provider, model) => hooks.modelInfo ? hooks.modelInfo(provider, model) : ({ provider, id: model, name: model, ...(provider === 'alpha' ? { reasoning: { efforts: [{ id: 'medium' }, { id: 'high' }], defaultEffort: 'medium' } } : {}) }),
      resolveCallConfig: async request => { calls.resolve.push({ ...request }); return hooks.resolveCall ? hooks.resolveCall(request) : { ...request, ...(request.provider === 'alpha' ? { reasoningEffort: request.reasoningEffort ?? 'medium' } : {}), maxTokens: 4096 }; },
    },
    sessionController: {
      async create(input) {
        calls.create.push({ ...input });
        const target = add(input.sessionId);
        const workspace = workspaces.get(input.workspaceId);
        target.session.header.cwd = workspace?.path ?? input.cwd;
        if (workspace) await workspace.attachSession(target.id);
        target.session.preset = input.agentPreset;
        target.session.permission = 'danger-full-access'; // deployment default must be overwritten.
        if (hooks.create) return hooks.create(input, target);
        return { sessionId: input.sessionId, agentPreset: input.agentPreset };
      },
      agents: {
        selectForNextRequest(agent, selected) {
          calls.local.push({ agent, selected: { ...selected } });
          if (hooks.localSet) return hooks.localSet(agent, selected);
          selections.set(agent, { current: { ...selected } });
          agent.session.pending = { ...selected };
        },
        selectionFor: agent => selections.get(agent),
      },
      selectModel() { calls.globals++; throw new Error('Public global-default selection is forbidden'); },
      async rename(input) { calls.rename.push(input); if (hooks.rename) return hooks.rename(input); return { title: input.title }; },
    },
  };
  const createUserMessage = input => {
    const message = { id: `fixture-message-${++serial}`, role: 'user', ...input };
    hooks.factory?.(message); return message;
  };
  const options = { ctx, store, createUserMessage, controllerVersion: '0.2.1-rc.5', config, now: () => clock, uuid: () => `fixture-root-${++serial}` };
  let creator = createSessionCreator(options);
  t.after(async () => { await creator.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { ctx, store, calls, hooks, agents, roots, selections, defaults, caller, other, add, directory, options,
    get creator() { return creator; },
    create: (args = {}, agent = caller, signal) => creator.create({ provider: 'alpha', model: 'reasoner', reasoningEffort: 'high', requestId: 'request', ...args }, { agent, signal }),
    async restart() { await creator.close(); creator = createSessionCreator(options); },
    tick: n => { clock += n; }, now: () => clock,
  };
}

const partial = (error, stage) => typeof error.sessionId === 'string' && error.state === 'partial' && (!stage || error.stage === stage);
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function linkedService(f, t) {
  let serial = 0;
  const host = {
    async describe(id) {
      const agent = f.agents.get(id);
      if (!agent) throw Object.assign(new Error('fixture session missing'), { code: 'SESSION_NOT_FOUND' });
      return { id, title: id, kind: agent.session.header.origin === 'subagent' ? 'subagent' : 'session', cwd: agent.session.header.cwd, status: agent.status, live: true, canReceive: true };
    },
    async deliver({ senderId, senderAgent, targetId, text }) {
      assert.equal(f.agents.get(senderId), senderAgent);
      const message = { id: `service-message-${++serial}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'agent-message', form: 'relay', senderSessionId: senderId } };
      f.agents.get(targetId).followup(message);
      return { messageId: message.id, mode: 'followup' };
    },
    async receipt() { return { state: 'unknown' }; },
  };
  const service = createService({ host, store: f.store, sessionCreator: f.creator, now: f.now });
  t.after(() => service.close());
  return { service, call: (name, args, agent = f.caller) => service.execute(name, args, { agent }) };
}

test('review create: exact advertised route and effort use local setter only, with effective permissions inherited before prompt', async t => {
  const f = await fixture(t);
  const result = await f.create({ title: 'Review fixture', initialMessage: 'fixture work' });
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.selected, { provider: 'alpha', model: 'reasoner', reasoningEffort: 'high' });
  assert.equal(result.permissionPreset, 'read-only');
  assert.equal(result.agentPreset, 'guarded');
  assert.equal(f.calls.globals, 0);
  assert.deepEqual(f.defaults, { provider: 'global-provider', model: 'global-model', reasoningEffort: 'low' });
  assert.equal(f.calls.local.length, 1);
  assert.equal(f.calls.messages.length, 1);
  const accepted = f.calls.messages[0];
  assert.equal(accepted.permission, 'read-only');
  assert.equal(accepted.preset, 'guarded');
  assert.deepEqual(accepted.selected, result.selected);
  assert.deepEqual(accepted.message.source, { kind: 'agent-message', form: 'relay', senderSessionId: 'caller' });
  assert.equal(JSON.parse(accepted.message.content[0].text).senderId, 'caller');
  assert.equal(f.caller.session.permission, 'read-only');
  assert.equal(result.initialMessage.receipt, 'unknown');
});

test('review create: unsupported provider/model/effort and resolver substitutions fail before root allocation', async t => {
  const f = await fixture(t);
  for (const [args, code] of [
    [{ provider: 'unlisted' }, 'PROVIDER_NOT_FOUND'],
    [{ model: 'unlisted' }, 'MODEL_NOT_FOUND'],
    [{ reasoningEffort: 'ultra' }, 'UNSUPPORTED_REASONING_EFFORT'],
    [{ provider: 'beta', model: 'plain', reasoningEffort: 'high' }, 'UNSUPPORTED_REASONING_EFFORT'],
  ]) await assert.rejects(f.create(args), { code });
  for (const replacement of [
    { provider: 'beta', model: 'reasoner', reasoningEffort: 'high' },
    { provider: 'alpha', model: 'other', reasoningEffort: 'high' },
    { provider: 'alpha', model: 'reasoner', reasoningEffort: 'medium' },
  ]) {
    f.hooks.resolveCall = () => replacement;
    await assert.rejects(f.create(), { code: 'MODEL_SELECTION_CHANGED' });
  }
  assert.equal(f.calls.create.length, 0);
  assert.equal(f.calls.local.length, 0);
});

test('review create: omitted effort uses this model default, not caller/global effort', async t => {
  const f = await fixture(t);
  const result = await f.create({ reasoningEffort: undefined });
  assert.equal(result.selected.reasoningEffort, 'medium');
  assert.equal(f.calls.resolve[0].reasoningEffort, undefined);
  assert.equal(f.calls.globals, 0);
});

test('review create: omitted effort cannot silently replace the advertised own-model default', async t => {
  const f = await fixture(t);
  f.hooks.resolveCall = request => ({ ...request, reasoningEffort: 'high' });
  await assert.rejects(f.create({ reasoningEffort: undefined }), { code: 'MODEL_SELECTION_CHANGED' });
  assert.equal(f.calls.create.length, 0);
});

test('review create: unknown ABI or missing local setter fails closed without public setter fallback', async t => {
  const f = await fixture(t);
  const unknown = createSessionCreator({ ...f.options, controllerVersion: '0.2.2' });
  await assert.rejects(unknown.create({ provider: 'alpha', model: 'reasoner', requestId: 'x' }, { agent: f.caller }), { code: 'CREATE_HOST_UNSUPPORTED' });
  await unknown.close();
  delete f.ctx.sessionController.agents.selectForNextRequest;
  await assert.rejects(f.create(), { code: 'CREATE_HOST_UNSUPPORTED' });
  assert.equal(f.calls.create.length, 0);
  assert.equal(f.calls.globals, 0);
});

test('review create: only exact ordinary runtime roots may allocate; all live kinds may read models', async t => {
  const f = await fixture(t);
  const blocked = [
    f.add('managed', { root: false, origin: 'subagent', parentSession: 'caller' }),
    f.add('sidechat', { root: true, origin: 'subagent', parentSession: 'caller' }),
    f.add('delegated-root', { root: true, delegationDepth: 1 }),
    f.add('inherited-root', { root: true, parentSession: 'caller' }),
    f.add('unregistered-root', { root: false }),
  ];
  for (const agent of blocked) {
    await assert.rejects(f.create({}, agent), { code: 'CALLER_NOT_ORDINARY_ROOT' });
    const catalog = await f.creator.models({ provider: 'alpha' }, { agent });
    assert.equal(catalog.models[0].model, 'reasoner');
    assert.deepEqual(catalog.models[0].efforts.map(x => x.id), ['medium', 'high']);
  }
  const stale = { ...f.caller };
  await assert.rejects(f.create({}, stale), { code: 'SENDER_NOT_LIVE' });
  await assert.rejects(f.creator.models({}, { agent: stale }), { code: 'SENDER_NOT_LIVE' });
  assert.equal(f.calls.create.length, 0);
});

test('review create: requestId is mandatory, sender-scoped and concurrent replay allocates/sends once', async t => {
  const f = await fixture(t);
  await assert.rejects(f.create({ requestId: undefined }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.create({ requestId: ' ' }), { code: 'INVALID_ARGUMENT' });
  const results = await Promise.all(Array.from({ length: 16 }, () => f.create({ initialMessage: 'fixture once' })));
  assert.equal(new Set(results.map(x => x.sessionId)).size, 1);
  assert.equal(results.filter(x => x.replayed).length, 15);
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.messages.length, 1);
  const other = await f.create({ initialMessage: 'fixture once' }, f.other);
  assert.notEqual(other.sessionId, results[0].sessionId);
  assert.equal(f.calls.create.length, 2);
  for (const changed of [{ title: 'changed' }, { initialMessage: 'changed' }, { reasoningEffort: 'medium' }]) {
    await assert.rejects(f.create(changed), { code: 'IDEMPOTENCY_CONFLICT' });
  }
});

test('review create: two creator instances racing past empty snapshots still allocate one root atomically', async t => {
  const f = await fixture(t);
  const second = createSessionCreator(f.options);
  t.after(() => second.close());
  const read = f.store.read;
  let count = 0; let release;
  const barrier = new Promise(resolve => { release = resolve; });
  f.store.read = async () => {
    const snapshot = await read();
    if (!snapshot.creations.length && ++count <= 2) {
      if (count === 2) release();
      await barrier;
    }
    return snapshot;
  };
  const args = { provider: 'alpha', model: 'reasoner', reasoningEffort: 'high', requestId: 'request' };
  const outcomes = await Promise.allSettled([f.create(), second.create(args, { agent: f.caller })]);
  f.store.read = read;
  assert.ok(outcomes.some(result => result.status === 'fulfilled' && result.value.state === 'ready'));
  assert.equal(f.calls.create.length, 1);
  assert.equal((await f.store.read()).creations.length, 1);
});

test('review create: partial selection failure exposes sessionId and survives creator restart without recreation', async t => {
  const f = await fixture(t);
  f.hooks.localSet = () => { throw new Error('fixture local setter failure'); };
  let rootId;
  await assert.rejects(f.create({ initialMessage: 'never delivered' }), error => { rootId = error.sessionId; return partial(error, 'selection'); });
  assert.ok(f.agents.has(rootId));
  assert.equal(f.calls.messages.length, 0);
  await f.restart();
  delete f.hooks.localSet;
  await assert.rejects(f.create({ initialMessage: 'never delivered' }), error => partial(error, 'selection') && error.replayed === true && error.sessionId === rootId);
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.local.length, 1);
  assert.equal(f.calls.messages.length, 0);
});

test('review create: deployment-default permission cannot leak into prompt when inheritance silently fails', async t => {
  const f = await fixture(t);
  f.hooks.permissionSet = () => {};
  await assert.rejects(f.create({ initialMessage: 'must not run with elevated default' }), error => error.code === 'PERMISSION_INHERITANCE_FAILED' && partial(error, 'permissions'));
  assert.equal(f.calls.messages.length, 0);
  assert.equal(f.calls.local.length, 0);
});

test('review create: unknown/custom permissions or broken preset reject before creating any root', async t => {
  const f = await fixture(t);
  f.caller.session.permission = 'custom';
  await assert.rejects(f.create(), { code: 'PERMISSION_INHERITANCE_UNAVAILABLE' });
  f.caller.session.permission = 'missing';
  await assert.rejects(f.create(), { code: 'PERMISSION_INHERITANCE_UNAVAILABLE' });
  f.caller.session.permission = 'read-only';
  f.hooks.presetResolve = id => ({ id, broken: 'fixture broken preset' });
  await assert.rejects(f.create(), { code: 'AGENT_PRESET_UNAVAILABLE' });
  assert.equal(f.calls.create.length, 0);
});

test('review create: an initial enqueue that then throws remains uncertain and is never resent', async t => {
  const f = await fixture(t);
  f.hooks.followup = () => { throw new Error('fixture: queued then transport threw'); };
  let rootId;
  await assert.rejects(f.create({ initialMessage: 'possibly delivered' }), error => { rootId = error.sessionId; return partial(error, 'initial-message'); });
  delete f.hooks.followup;
  await assert.rejects(f.create({ initialMessage: 'possibly delivered' }), error => error.sessionId === rootId && error.replayed === true);
  const ledger = (await f.store.read()).creations[0];
  assert.equal(ledger.initialMessage.transport, 'unknown');
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.messages.length, 1);
});

test('review create: abort after Host allocation preserves root identity and prohibits duplicate retry', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.hooks.create = input => { controller.abort(); return { sessionId: input.sessionId }; };
  let rootId;
  await assert.rejects(f.create({}, f.caller, controller.signal), error => { rootId = error.sessionId; return error.code === 'ABORTED' && partial(error); });
  await assert.rejects(f.create(), error => error.sessionId === rootId && error.replayed === true);
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.messages.length, 0);
});

test('review create: rename or message-factory route mutation cannot silently execute a downgraded model', async t => {
  for (const point of ['rename', 'factory']) await t.test(point, async t => {
    const f = await fixture(t);
    const mutate = () => {
      const target = f.agents.get(f.calls.create[0].sessionId);
      const changed = { provider: 'beta', model: 'plain' };
      f.selections.set(target, { current: changed }); target.session.pending = changed;
    };
    if (point === 'rename') f.hooks.rename = input => { mutate(); return { title: input.title }; };
    else f.hooks.factory = mutate;
    await assert.rejects(f.create({ title: 'fixture title', initialMessage: 'strict route work' }), error => partial(error));
    assert.equal(f.calls.messages.length, 0);
    assert.equal(f.calls.create.length, 1);
  });
});

test('review create: create that allocates then throws preserves intent ID and never allocates again', async t => {
  const f = await fixture(t);
  f.hooks.create = () => { throw new Error('fixture host failed after root allocation'); };
  let rootId;
  await assert.rejects(f.create({ initialMessage: 'do not submit' }), error => { rootId = error.sessionId; return error.state === 'unknown' && f.agents.has(rootId); });
  await f.restart();
  delete f.hooks.create;
  await assert.rejects(f.create({ initialMessage: 'do not submit' }), error => error.sessionId === rootId && error.replayed === true);
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.messages.length, 0);
});

test('review create: mismatched Host identity reports both IDs and never configures or prompts the wrong root', async t => {
  const f = await fixture(t);
  f.hooks.create = () => ({ sessionId: 'unexpected-host-root' });
  await assert.rejects(f.create({ initialMessage: 'must not route elsewhere' }), error => error.code === 'CREATE_ID_MISMATCH' && error.sessionId === 'unexpected-host-root' && error.requestedSessionId === f.calls.create[0].sessionId && partial(error, 'create'));
  assert.equal(f.calls.permission.length, 0);
  assert.equal(f.calls.local.length, 0);
  assert.equal(f.calls.messages.length, 0);
});

test('review create: durable selection and both preset snapshots are revalidated before native prompt admission', async t => {
  for (const mutation of ['pending-route', 'caller-preset', 'target-preset', 'target-permission']) await t.test(mutation, async t => {
    const f = await fixture(t);
    f.hooks.factory = () => {
      const target = f.agents.get(f.calls.create[0].sessionId);
      if (mutation === 'pending-route') target.session.pending = { provider: 'alpha', model: 'reasoner', reasoningEffort: 'medium' };
      if (mutation === 'caller-preset') f.caller.session.preset = 'unrestricted';
      if (mutation === 'target-preset') target.session.preset = 'unrestricted';
      if (mutation === 'target-permission') target.session.permission = 'danger-full-access';
    };
    await assert.rejects(f.create({ initialMessage: 'must stay within the inherited policy and exact route' }), error => partial(error));
    assert.equal(f.calls.messages.length, 0);
  });
});

test('review create: no-initial-message setup also rejects a late route downgrade instead of reporting ready', async t => {
  const f = await fixture(t);
  f.hooks.rename = input => {
    const target = f.agents.get(input.sessionId);
    f.selections.set(target, { current: { provider: 'beta', model: 'plain' } });
    return { title: input.title };
  };
  await assert.rejects(f.create({ title: 'idle fixture' }), error => partial(error));
  assert.equal(f.calls.messages.length, 0);
});

test('review create: sameDirectoryOnly canonicalizes existing directories and rejects cross-directory roots', async t => {
  const f = await fixture(t, { sameDirectoryOnly: true });
  const other = join(f.directory, 'other'); await mkdir(other);
  await assert.rejects(f.create({ cwd: other }), { code: 'ACCESS_DENIED' });
  await assert.rejects(f.create({ cwd: 'relative/path' }), { code: 'INVALID_CWD' });
  const result = await f.create({ cwd: join(f.directory, '.', 'other', '..') });
  assert.equal(result.cwd, f.directory);
  assert.equal(f.calls.create.length, 1);
});

test('review create: final state persistence failure still returns sessionId and replay cannot allocate again', async t => {
  const f = await fixture(t);
  const mutate = f.store.mutate;
  let rejectWrites = false;
  f.hooks.rename = input => { rejectWrites = true; return { title: input.title }; };
  f.store.mutate = fn => rejectWrites ? Promise.reject(new Error('fixture disk unavailable')) : mutate(fn);
  let rootId;
  await assert.rejects(f.create({ title: 'fixture title' }), error => { rootId = error.sessionId; return error.code === 'CREATION_PERSISTENCE_UNCERTAIN' && Boolean(rootId); });
  rejectWrites = false;
  await f.restart();
  await assert.rejects(f.create({ title: 'fixture title' }), error => error.sessionId === rootId && error.replayed === true);
  assert.equal(f.calls.create.length, 1);
});

test('review create: close leaves shared store and allocated roots intact while refusing new creation', async t => {
  const f = await fixture(t);
  const result = await f.create();
  await f.creator.close();
  await assert.rejects(f.create({ requestId: 'after-close' }), { code: 'CREATOR_CLOSED' });
  assert.ok(f.agents.has(result.sessionId));
  assert.equal((await f.store.read()).creations.length, 1);
  await f.store.mutate(state => { state.reception.fixture = { enabled: false }; });
});

test('review create integration: allocation is quarantined against link_send/task until ready then released', async t => {
  const f = await fixture(t); const link = linkedService(f, t);
  const entered = gate(); const release = gate();
  f.hooks.create = async input => { entered.resolve(input.sessionId); await release.promise; return { sessionId: input.sessionId }; };
  const pending = f.create();
  const id = await Promise.race([entered.promise, pending.then(() => { throw new Error('creation unexpectedly completed before allocation gate'); })]);
  try {
    assert.equal((await f.store.read()).reception[id].enabled, false);
    await assert.rejects(link.call('link_send', { targetId: id, message: 'must not start before inheritance' }), { code: 'RECEPTION_PAUSED' });
    await assert.rejects(link.call('link_task', { action: 'create', targetId: id, title: 'blocked', instructions: 'must not start' }), { code: 'RECEPTION_PAUSED' });
    assert.equal(f.calls.messages.length, 0);
  } finally { release.resolve(); }
  const result = await pending;
  assert.equal(result.state, 'ready');
  const sent = await link.call('link_send', { targetId: id, message: 'safe after setup' });
  assert.equal(sent.transport, 'accepted');
  assert.equal(f.calls.messages[0].permission, 'read-only');
});

test('review create integration: permission-failed partial root remains quarantined on every later link path', async t => {
  const f = await fixture(t); const link = linkedService(f, t);
  f.hooks.permissionSet = () => {};
  let id;
  await assert.rejects(f.create(), error => { id = error.sessionId; return partial(error, 'permissions'); });
  assert.equal(f.agents.get(id).session.permission, 'danger-full-access', 'reproduces a failed inheritance with the Host default still installed');
  assert.equal((await f.store.read()).reception[id].enabled, false);
  await assert.rejects(link.call('link_send', { targetId: id, message: 'must not escape through the partial root' }), { code: 'RECEPTION_PAUSED' });
  await assert.rejects(link.call('link_task', { action: 'create', targetId: id, title: 'blocked', instructions: 'must not start' }), { code: 'RECEPTION_PAUSED' });
  assert.equal(f.calls.messages.length, 0);
  await f.restart();
  await assert.rejects(f.create(), error => error.sessionId === id && error.replayed === true);
  assert.equal((await f.store.read()).reception[id].enabled, false);
});

test('review create integration: ready does not overwrite a same-millisecond manual reception pause', async t => {
  const f = await fixture(t); const link = linkedService(f, t);
  const entered = gate(); const release = gate();
  f.hooks.create = async input => { entered.resolve(input.sessionId); await release.promise; return { sessionId: input.sessionId }; };
  const pending = f.create();
  const id = await Promise.race([entered.promise, pending.then(() => { throw new Error('creation unexpectedly completed before allocation gate'); })]);
  try {
    const target = f.agents.get(id);
    await link.call('link_reception', { enabled: false }, target);
  } finally { release.resolve(); }
  const result = await pending;
  assert.equal(result.state, 'ready');
  assert.equal((await f.store.read()).reception[id].enabled, false);
  await assert.rejects(link.call('link_send', { targetId: id, message: 'still manually paused' }), { code: 'RECEPTION_PAUSED' });
  assert.equal(f.calls.messages.length, 0);
});

test('review create integration: an explicit pause during allocation also blocks the optional first message', async t => {
  const f = await fixture(t); const link = linkedService(f, t);
  const entered = gate(); const release = gate();
  f.hooks.create = async input => { entered.resolve(input.sessionId); await release.promise; return { sessionId: input.sessionId }; };
  const pending = f.create({ initialMessage: 'must respect the later explicit pause' });
  const id = await Promise.race([entered.promise, pending.then(() => { throw new Error('creation unexpectedly completed before allocation gate'); })]);
  try { await link.call('link_reception', { enabled: false }, f.agents.get(id)); }
  finally { release.resolve(); }
  await assert.rejects(pending, error => error.code === 'RECEPTION_PAUSED' && partial(error, 'initial-message'));
  assert.equal(f.calls.messages.length, 0);
  assert.equal((await f.store.read()).reception[id].enabled, false);
});

test('review create integration: failure after ready persistence re-quarantines the now-partial root', async t => {
  const f = await fixture(t); const link = linkedService(f, t);
  const mutate = f.store.mutate;
  f.store.mutate = async fn => {
    const result = await mutate(fn);
    if (result?.state === 'ready' && result.sessionId) f.agents.get(result.sessionId).session.permission = 'danger-full-access';
    return result;
  };
  let id;
  await assert.rejects(f.create(), error => { id = error.sessionId; return partial(error, 'ready'); });
  assert.equal((await f.store.read()).reception[id]?.enabled, false);
  await assert.rejects(link.call('link_send', { targetId: id, message: 'partial may not execute' }), { code: 'RECEPTION_PAUSED' });
  assert.equal(f.calls.messages.length, 0);
});

test('review create: published required fields and provider/model/requestId bounds agree with implementation', async t => {
  const f = await fixture(t);
  const schema = TOOLS.find(tool => tool.name === 'link_session_create').parameters;
  for (const name of ['provider', 'model', 'requestId']) {
    assert.ok(schema.required.includes(name));
    await assert.rejects(f.create({ [name]: undefined }), { code: 'INVALID_ARGUMENT' });
    await assert.rejects(f.create({ [name]: 'x'.repeat(schema.properties[name].maxLength + 1) }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(f.calls.create.length, 0);
});
