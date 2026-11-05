import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../lib/store.js';
import { createSessionCreator } from '../lib/session-create.js';

async function fixture(t, config = {}) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'session-link-create-')));
  const cwd = join(dir, 'cwd');
  await mkdir(cwd);
  const store = await createStore(join(dir, 'ledger'));
  const events = [];
  const roots = [];
  const registry = new Map();
  const caller = { id: 'caller', status: 'running', session: { header: { id: 'caller', origin: 'user' }, cwd, preset: 'standard', permission: 'read-only' }, selection: { provider: 'old', model: 'old', reasoningEffort: 'incompatible-parent' } };
  roots.push(caller);
  registry.set(caller.id, caller);
  let counter = 0;
  let clock = 100000;
  let createHook;
  let renameHook;
  let factoryHook;
  let followupHook;
  const workspaceRecords = new Map();
  const addWorkspace = (id, path, sessionIds = []) => {
    const workspace = { id, path, sessionIds: [...sessionIds], async attachSession(sessionId) {
      events.push(['workspace-attach', id, sessionId]);
      if (registry.get(sessionId)?.session.cwd !== path) throw new Error('workspace path mismatch');
      if (!workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId);
    } };
    workspaceRecords.set(id, workspace);
    return workspace;
  };
  addWorkspace('source-workspace', cwd, ['caller']);
  const ctx = {
    agents: { get: id => registry.get(id), roots: () => roots },
    workspaceRegistry: { archivedSessionIds: [], list: () => [...workspaceRecords.values()], get: id => workspaceRecords.get(id),
      async create(path) {
        events.push(['workspace-create', path]);
        return [...workspaceRecords.values()].find(workspace => workspace.path === path) ?? addWorkspace(`workspace-${workspaceRecords.size + 1}`, path);
      },
    },
    workingDirectory: { get: session => session.cwd },
    sessionProjections: { stateOf: (session, key) => key === 'agentPreset' ? session.preset : key === 'modelSelection' ? { pending: session.pending ?? null, lastUsed: null } : undefined },
    agentPresets: { async resolve(id) { return { id }; } },
    permissionPresets: {
      current: session => session.permission,
      resolve: name => ({ name, sandbox: name === 'read-only' ? 'read-only' : 'danger-full-access', approval: 'never' }),
      set(session, name) { events.push(['permission', session.header.id, name]); session.permission = name; },
    },
    llm: {
      listProviders() { events.push(['providers']); return [{ id: 'p', name: 'Provider', apiKey: 'SECRET-CREDENTIAL' }, { id: 'q', name: 'Other' }]; },
      async listModels(provider) { events.push(['models', provider]); return [{ id: 'm', name: 'Model', secret: 'SECRET-MODEL' }, { id: 'plain', name: 'Plain' }]; },
      async resolveModelInfo(provider, model) { events.push(['modelInfo', provider, model]); return { provider, id: model, name: model, ...(model === 'plain' ? {} : { reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } }), secret: 'SECRET-INFO' }; },
      async resolveCallConfig(selection) { events.push(['callConfig', selection]); return { ...selection, ...(selection.model === 'plain' ? {} : { reasoningEffort: selection.reasoningEffort ?? 'low' }), apiKey: 'SECRET-CALL' }; },
    },
    sessionTitle: { rename() {} },
    sessionController: {
      agents: {
        selectForNextRequest(agent, selection) { events.push(['selection', agent.id, selection]); agent.selection = { ...selection }; agent.session.pending = { ...selection }; },
        selectionFor: agent => ({ current: agent.selection }),
      },
      async selectModel() { throw new Error('GLOBAL MODEL MUTATION MUST NEVER BE CALLED'); },
      async create(request) {
        events.push(['create', request]);
        const workspace = workspaceRecords.get(request.workspaceId);
        assert.ok(workspace, 'create must select a registered workspace');
        assert.equal(request.cwd, undefined, 'native workspaceId and cwd must never be combined');
        const target = { id: request.sessionId, status: 'idle', session: { header: { id: request.sessionId, origin: 'user' }, cwd: workspace.path, preset: request.agentPreset, permission: 'danger-full-access' },
          followup(message) { events.push(['followup', target.id, message, { ...target.selection }, target.session.permission]); return followupHook?.(target, message); },
        };
        registry.set(target.id, target);
        roots.push(target);
        if (createHook) return createHook(request, target);
        await workspace.attachSession(target.id);
        return { sessionId: request.sessionId, agentPreset: request.agentPreset };
      },
      async rename(request) { events.push(['rename', request]); if (renameHook) return renameHook(request); return { title: request.title.trim(), seq: 1 }; },
    },
  };
  const factory = input => { events.push(['factory', input]); factoryHook?.(input); return { id: `message-${++counter}`, ...input }; };
  const options = { ctx, store, createUserMessage: factory, controllerVersion: '0.2.1-rc.5', now: () => clock, uuid: () => `root-${++counter}`, config };
  const creator = createSessionCreator(options);
  t.after(async () => { await creator.close(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  const create = async args => {
    const result = await creator.create({ provider: 'p', model: 'm', requestId: `key-${counter + 1}`, ...args }, { agent: caller });
    assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
    return result;
  };
  return { dir, cwd, store, ctx, events, caller, roots, registry, workspaceRecords, addWorkspace, options, creator, create, tick: n => { clock += n; }, onCreate: fn => { createHook = fn; }, onRename: fn => { renameHook = fn; }, onFactory: fn => { factoryHook = fn; }, onFollowup: fn => { followupHook = fn; } };
}

test('creates ordinary host-owned root with exact local route and copied named permissions, no message means no LLM', async t => {
  const f = await fixture(t);
  const result = await f.create({ title: 'Independent', reasoningEffort: 'high' });
  assert.equal(result.state, 'ready');
  assert.deepEqual(result.selected, { provider: 'p', model: 'm', reasoningEffort: 'high' });
  assert.equal(result.permissionPreset, 'read-only');
  assert.equal(result.cwd, f.cwd);
  assert.equal(result.initialMessage, undefined);
  assert.equal(f.events.filter(item => item[0] === 'followup').length, 0);
  const request = f.events.find(item => item[0] === 'create')[1];
  assert.deepEqual(Object.keys(request).sort(), ['agentPreset', 'sessionId', 'workspaceId']);
  assert.equal(result.workspaceId, 'source-workspace');
  assert.equal(f.workspaceRecords.get(result.workspaceId).sessionIds.includes(result.sessionId), true);
  const target = f.registry.get(result.sessionId);
  assert.equal(target.session.header.parentSession, undefined);
  assert.equal(target.session.permission, 'read-only');
  assert.deepEqual(target.selection, result.selected);
  assert.ok(f.events.findIndex(item => item[0] === 'permission') < f.events.findIndex(item => item[0] === 'selection'));
  await f.creator.close();
  assert.equal(f.registry.get(result.sessionId), target, 'Host-owned root survives creator disposal');
  assert.ok(await f.store.read(), 'creator does not own shared store');
});

test('optional first task is typed peer relay after configuration, accepted is not receipt or completion', async t => {
  const f = await fixture(t);
  const result = await f.create({ title: 'Task root', initialMessage: 'PRIVATE-TASK-CONTENT', senderId: 'spoof' });
  const followup = f.events.find(item => item[0] === 'followup');
  assert.deepEqual(followup[2].source, { kind: 'agent-message', form: 'relay', senderSessionId: f.caller.id });
  const envelope = JSON.parse(followup[2].content[0].text);
  assert.equal(envelope.senderId, f.caller.id);
  assert.match(envelope.trust, /UNTRUSTED PEER/);
  assert.equal(envelope.message, 'PRIVATE-TASK-CONTENT');
  assert.equal(followup[4], 'read-only');
  assert.deepEqual(followup[3], result.selected);
  assert.equal(result.initialMessage.transport, 'accepted');
  assert.equal(result.initialMessage.receipt, 'unknown');
  assert.ok(f.events.findIndex(item => item[0] === 'rename') < f.events.findIndex(item => item[0] === 'followup'));
  assert.doesNotMatch(JSON.stringify(await f.store.read()), /PRIVATE-TASK-CONTENT|SECRET/);
});

test('omitted effort uses validated model default and never inherits caller incompatible effort', async t => {
  const f = await fixture(t);
  assert.equal((await f.create({})).selected.reasoningEffort, 'low');
  const plain = await f.create({ model: 'plain' });
  assert.deepEqual(plain.selected, { provider: 'p', model: 'plain' });
});

test('models is bounded and credential-free; no provider lists providers without model network fanout', async t => {
  const f = await fixture(t);
  const providers = await f.creator.models({}, { agent: f.caller });
  assert.equal(providers.providers.length, 2);
  assert.equal(f.events.filter(item => item[0] === 'models').length, 0);
  const models = await f.creator.models({ provider: 'p', limit: 1 }, { agent: f.caller });
  assert.equal(models.models.length, 1);
  assert.equal(models.truncated, true);
  assert.equal(models.models[0].defaultEffort, 'low');
  assert.deepEqual(models.models[0].efforts.map(item => item.id), ['low', 'high']);
  assert.doesNotMatch(JSON.stringify({ providers, models }), /SECRET|apiKey/);
  f.caller.session.header.origin = 'subagent';
  assert.equal((await f.creator.models({}, { agent: f.caller })).providers.length, 2, 'read-only catalog is available to live children');
});

test('strict catalog membership and exact resolver identity fail before any root is created', async t => {
  const f = await fixture(t);
  await assert.rejects(f.create({ provider: 'missing' }), { code: 'PROVIDER_NOT_FOUND' });
  await assert.rejects(f.create({ model: 'missing' }), { code: 'MODEL_NOT_FOUND' });
  await assert.rejects(f.create({ reasoningEffort: 'max' }), cause => cause.code === 'UNSUPPORTED_REASONING_EFFORT' && cause.options.join(',') === 'low,high');
  f.ctx.llm.resolveCallConfig = async selection => ({ ...selection, model: 'silent-fallback' });
  await assert.rejects(f.create({}), { code: 'MODEL_SELECTION_CHANGED' });
  assert.equal(f.events.filter(item => item[0] === 'create').length, 0);
});

test('unsupported host version, absent local setter or absent permission capability reject before create', async t => {
  const f = await fixture(t);
  const incompatible = createSessionCreator({ ...f.options, controllerVersion: '0.2.2' });
  await assert.rejects(incompatible.create({ provider: 'p', model: 'm', requestId: 'new' }, { agent: f.caller }), { code: 'CREATE_HOST_UNSUPPORTED' });
  await incompatible.close();
  delete f.ctx.sessionController.agents.selectForNextRequest;
  await assert.rejects(f.create({}), { code: 'CREATE_HOST_UNSUPPORTED' });
  assert.equal(f.events.filter(item => item[0] === 'create').length, 0);
  assert.doesNotThrow(() => createSessionCreator({ ctx: {}, store: {} }), 'constructor is lazy for older deployments');
});

test('root eligibility rejects child, sidechat, fork lineage, delegation depth and stale execution instances', async t => {
  const f = await fixture(t);
  const request = { provider: 'p', model: 'm', requestId: 'x' };
  await assert.rejects(f.creator.create(request, { agent: { ...f.caller } }), { code: 'SENDER_NOT_LIVE' });
  for (const patch of [{ origin: 'subagent' }, { parentSession: 'parent' }, { delegationDepth: 1 }]) {
    const before = { ...f.caller.session.header };
    Object.assign(f.caller.session.header, patch);
    await assert.rejects(f.create({}), { code: 'CALLER_NOT_ORDINARY_ROOT' });
    f.caller.session.header = before;
  }
  f.roots.splice(0, 1);
  await assert.rejects(f.create({}), { code: 'CALLER_NOT_ORDINARY_ROOT' });
  assert.equal(f.events.filter(item => item[0] === 'create').length, 0);
});

test('custom permissions, missing presets and broken presets fail closed before create', async t => {
  const f = await fixture(t);
  f.caller.session.permission = 'custom';
  await assert.rejects(f.create({}), { code: 'PERMISSION_INHERITANCE_UNAVAILABLE' });
  f.caller.session.permission = 'read-only';
  f.caller.session.preset = undefined;
  await assert.rejects(f.create({}), { code: 'AGENT_PRESET_UNAVAILABLE' });
  f.caller.session.preset = 'standard';
  f.ctx.agentPresets.resolve = async id => ({ id, broken: 'missing plugin' });
  await assert.rejects(f.create({}), { code: 'AGENT_PRESET_UNAVAILABLE' });
  assert.equal(f.events.filter(item => item[0] === 'create').length, 0);
});

test('cwd must already exist and be absolute; same-directory compares real paths', async t => {
  const f = await fixture(t, { sameDirectoryOnly: true });
  const other = join(f.dir, 'other');
  await mkdir(other);
  const file = join(f.dir, 'not-directory');
  await writeFile(file, 'file');
  for (const cwd of ['relative', join(f.dir, 'missing'), file]) await assert.rejects(f.create({ cwd }), { code: 'INVALID_CWD' });
  await assert.rejects(f.create({ cwd: other }), { code: 'ACCESS_DENIED' });
  const alias = join(f.dir, 'same-link');
  await symlink(f.cwd, alias);
  assert.equal((await f.create({ cwd: alias })).state, 'ready');
});

test('concurrent same key creates and admits first message exactly once, changed arguments conflict', async t => {
  const f = await fixture(t);
  const args = { requestId: 'once', initialMessage: 'work' };
  const results = await Promise.all(Array.from({ length: 8 }, () => f.create(args)));
  assert.equal(new Set(results.map(item => item.sessionId)).size, 1);
  assert.equal(f.events.filter(item => item[0] === 'create').length, 1);
  assert.equal(f.events.filter(item => item[0] === 'followup').length, 1);
  await assert.rejects(f.create({ ...args, model: 'plain' }), { code: 'IDEMPOTENCY_CONFLICT' });
  f.ctx.llm.resolveCallConfig = async () => { throw new Error('catalog later unavailable'); };
  assert.equal((await f.create(args)).replayed, true, 'replay never consults dynamic model defaults');
});

test('failed setup retains partial root and same key never rebuilds or sends', async t => {
  const f = await fixture(t);
  f.onRename(() => { throw new Error('rename failed'); });
  const args = { requestId: 'partial', title: 'title', initialMessage: 'work' };
  let id;
  await assert.rejects(f.create(args), cause => { id = cause.sessionId; return cause.state === 'partial' && cause.stage === 'title' && Boolean(id); });
  await assert.rejects(f.create(args), cause => cause.replayed === true && cause.sessionId === id);
  assert.equal(f.events.filter(item => item[0] === 'create').length, 1);
  assert.equal(f.events.filter(item => item[0] === 'followup').length, 0);
  assert.equal((await f.store.read()).creations[0].state, 'partial');
});

test('host creation failure is unknown; different returned id is recorded partial without task delivery', async t => {
  const f = await fixture(t);
  f.onCreate(() => { throw new Error('accepted but disconnected'); });
  await assert.rejects(f.create({ requestId: 'unknown' }), { state: 'unknown', stage: 'create' });
  await assert.rejects(f.create({ requestId: 'unknown' }), { state: 'unknown', replayed: true });
  f.onCreate(() => ({ sessionId: 'different-root' }));
  await assert.rejects(f.create({ requestId: 'mismatch', initialMessage: 'work' }), cause => cause.code === 'CREATE_ID_MISMATCH' && cause.sessionId === 'different-root' && Boolean(cause.requestedSessionId) && cause.state === 'partial');
  assert.equal(f.events.filter(item => item[0] === 'followup').length, 0);
});

test('restart converts interrupted creation intent to unknown and never calls create again', async t => {
  const f = await fixture(t);
  f.onCreate(() => { throw new Error('simulated crash'); });
  const args = { provider: 'p', model: 'm', requestId: 'restart' };
  await assert.rejects(f.creator.create(args, { agent: f.caller }));
  await f.store.mutate(state => { state.creations[0].state = 'creating'; state.creations[0].initialMessage = { messageId: 'old-message', transport: 'sending', receipt: 'unknown' }; });
  await f.creator.close();
  const restarted = createSessionCreator(f.options);
  await assert.rejects(restarted.create(args, { agent: f.caller }), { code: 'CREATION_RESTART_UNKNOWN', state: 'unknown', replayed: true });
  await restarted.close();
  assert.equal(f.events.filter(item => item[0] === 'create').length, 1);
  assert.equal((await f.store.read()).creations[0].initialMessage.transport, 'unknown');
});

test('persistent rate quota counts only new keys and no completed creation record is evicted', async t => {
  const f = await fixture(t, { maxCreationsPerMinute: 1, maxCreations: 2 });
  await f.create({ requestId: 'first' });
  assert.equal((await f.create({ requestId: 'first' })).replayed, true);
  await assert.rejects(f.create({ requestId: 'second' }), { code: 'CREATION_RATE_LIMITED' });
  f.tick(60001);
  await f.create({ requestId: 'second' });
  f.tick(60001);
  await assert.rejects(f.create({ requestId: 'third' }), { code: 'CREATION_CAPACITY' });
  assert.equal((await f.store.read()).creations.length, 2);
});

test('pre-abort creates nothing; abort after creation reports partial id but still applies permission ceiling', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.creator.create({ provider: 'p', model: 'm', requestId: 'cancelled' }, { agent: f.caller, signal: controller.signal }), { code: 'ABORTED' });
  const after = new AbortController();
  f.onCreate((request) => { after.abort(); return { sessionId: request.sessionId }; });
  let id;
  await assert.rejects(f.creator.create({ provider: 'p', model: 'm', requestId: 'partial-abort', initialMessage: 'work' }, { agent: f.caller, signal: after.signal }), cause => { id = cause.sessionId; return cause.code === 'ABORTED' && cause.state === 'partial'; });
  assert.equal(f.registry.get(id).session.permission, 'read-only');
  assert.equal(f.events.filter(item => item[0] === 'followup').length, 0);
});

test('selection, permission, and agent preset races after rename/factory cannot admit an initial task', async t => {
  for (const mutate of [
    target => { target.selection = { provider: 'wrong', model: 'wrong' }; },
    target => { target.session.pending = { provider: 'wrong', model: 'wrong' }; },
    target => { target.session.permission = 'danger-full-access'; },
    target => { target.session.preset = 'other'; },
  ]) {
    const f = await fixture(t);
    f.onFactory(() => mutate(f.roots.at(-1)));
    await assert.rejects(f.create({ initialMessage: 'work' }), cause => cause.state === 'partial');
    assert.equal(f.events.filter(item => item[0] === 'followup').length, 0);
  }
});

test('native followup uncertainty records message id, never retries same request', async t => {
  const f = await fixture(t);
  f.onFollowup(() => { throw new Error('queue accepted then failed'); });
  const args = { requestId: 'message-unknown', initialMessage: 'work' };
  await assert.rejects(f.create(args), { state: 'partial', stage: 'initial-message' });
  const record = (await f.store.read()).creations[0];
  assert.equal(record.initialMessage.transport, 'unknown');
  assert.ok(record.initialMessage.messageId);
  await assert.rejects(f.create(args), { replayed: true });
  assert.equal(f.events.filter(item => item[0] === 'followup').length, 1);
});

test('intent quarantines plugin reception and only fully ready setup releases its owned marker', async t => {
  const f = await fixture(t);
  f.onCreate(async request => {
    const setting = (await f.store.read()).reception[request.sessionId];
    assert.equal(setting.enabled, false);
    assert.deepEqual(setting.creationOwner, { senderId: 'caller', requestId: 'quarantine' });
    return { sessionId: request.sessionId };
  });
  const ready = await f.create({ requestId: 'quarantine' });
  assert.equal((await f.store.read()).reception[ready.sessionId], undefined);
  f.onCreate(undefined);
  f.ctx.permissionPresets.set = () => {};
  let partial;
  await assert.rejects(f.create({ requestId: 'permission-failed' }), cause => { partial = cause.sessionId; return cause.code === 'PERMISSION_INHERITANCE_FAILED'; });
  assert.equal((await f.store.read()).reception[partial].enabled, false);
});

test('explicit pause replacing quarantine is retained and blocks optional first message', async t => {
  for (const initialMessage of [undefined, 'must not be sent']) {
    const f = await fixture(t);
    f.onRename(async request => {
      await f.store.mutate(state => { state.reception[request.sessionId] = { enabled: false, updatedAt: 100000 }; });
      return { title: request.title };
    });
    let id;
    if (initialMessage === undefined) id = (await f.create({ title: 'paused' })).sessionId;
    else await assert.rejects(f.create({ title: 'paused', initialMessage }), cause => { id = cause.sessionId; return cause.code === 'RECEPTION_PAUSED' && cause.state === 'partial'; });
    assert.equal((await f.store.read()).reception[id].enabled, false);
    assert.equal((await f.store.read()).reception[id].creationOwner, undefined);
    assert.equal(f.events.filter(event => event[0] === 'followup').length, 0);
  }
});

test('post-create ledger failure occurs only after synchronous permission ceiling and retains quarantine', async t => {
  const f = await fixture(t);
  let failed = false;
  const store = { read: () => f.store.read(), mutate: fn => {
    if (!failed && f.events.some(event => event[0] === 'create')) { failed = true; return Promise.reject(new Error('disk failure')); }
    return f.store.mutate(fn);
  } };
  const creator = createSessionCreator({ ...f.options, store });
  let id;
  await assert.rejects(creator.create({ provider: 'p', model: 'm', requestId: 'disk-failure' }, { agent: f.caller }), cause => { id = cause.sessionId; return cause.state === 'partial'; });
  assert.equal(f.registry.get(id).session.permission, 'read-only');
  assert.equal((await f.store.read()).reception[id].enabled, false);
  await creator.close();
});

test('different valid resolver default and absent title service reject before allocation', async t => {
  const f = await fixture(t);
  f.ctx.llm.resolveCallConfig = async selection => ({ ...selection, reasoningEffort: 'high' });
  await assert.rejects(f.create({}), { code: 'MODEL_SELECTION_CHANGED' });
  delete f.ctx.sessionTitle;
  await assert.rejects(f.create({ title: 'title', reasoningEffort: 'high' }), { code: 'TITLE_UNAVAILABLE' });
  assert.equal(f.events.filter(event => event[0] === 'create').length, 0);
});

test('host post-allocation error reports and quarantines only a newly observed ordinary root', async t => {
  const f = await fixture(t);
  f.onCreate((request, target) => {
    const actual = { ...target, id: 'new-actual-id', session: { ...target.session, header: { id: 'new-actual-id', origin: 'user' } } };
    f.registry.set(actual.id, actual);
    f.roots.push(actual);
    throw Object.assign(new Error('workspace attach error'), { data: { sessionId: actual.id } });
  });
  await assert.rejects(f.create({ requestId: 'error-id' }), cause => cause.sessionId === 'new-actual-id' && Boolean(cause.requestedSessionId) && cause.state === 'partial');
  assert.equal((await f.store.read()).reception['new-actual-id'].enabled, false);
  assert.equal((await f.store.read()).reception.caller, undefined);
});

test('structured task/context handoff is explicit peer data, durable relation, and replay-safe', async t => {
  const f = await fixture(t);
  const args = { requestId: 'handoff', task: 'Implement parser', context: 'User supplied summary', decisions: 'Use ESM', constraints: 'Do not access secrets' };
  const result = await f.create(args);
  const sent = f.events.find(event => event[0] === 'followup')[2];
  const envelope = JSON.parse(sent.content[0].text);
  const body = JSON.parse(envelope.message);
  assert.equal(body.Task, args.task); assert.equal(body.Context, args.context);
  assert.equal(body['Decisions (reference)'], args.decisions); assert.equal(body.Constraints, args.constraints);
  assert.match(body.provenance, /not copied conversation history/);
  assert.equal(sent.source.senderSessionId, f.caller.id);
  const row = (await f.store.read()).creations[0];
  assert.deepEqual(row.handoff, { task: args.task, context: args.context, decisions: args.decisions, constraints: args.constraints });
  assert.equal(row.senderId, f.caller.id); assert.equal(row.sessionId, result.sessionId);
  assert.equal(row.workspaceId, result.workspaceId);
  assert.equal(f.registry.get(result.sessionId).session.header.parentSession, undefined);
  assert.equal((await f.create(args)).replayed, true);
  const restarted = createSessionCreator(f.options);
  assert.equal((await restarted.create({ provider: 'p', model: 'm', ...args }, { agent: f.caller })).sessionId, result.sessionId);
  await restarted.close();
  assert.equal(f.events.filter(event => event[0] === 'create').length, 1);
  assert.equal(f.events.filter(event => event[0] === 'followup').length, 1);
  await assert.rejects(f.create({ ...args, context: 'changed summary' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('structured handoff rejects contradictory, orphaned, oversized and JSON-escaped input', async t => {
  const f = await fixture(t);
  for (const args of [{ context: 'orphan' }, { decisions: 'orphan' }, { constraints: 'orphan' }, { task: 'x', initialMessage: 'y' },
    { task: 'x'.repeat(4000), context: 'y'.repeat(4000), decisions: 'z'.repeat(4000) },
    { task: '"'.repeat(4000), context: '"'.repeat(4000) }]) await assert.rejects(f.create(args), { code: 'INVALID_HANDOFF' });
  for (const key of ['task', 'context', 'decisions', 'constraints']) {
    await assert.rejects(f.create({ task: 'valid', [key]: 'x'.repeat(4001) }), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(f.events.filter(event => event[0] === 'create').length, 0);
});

test('cross-directory and explicit workspace selections preserve actual membership', async t => {
  const f = await fixture(t); const other = join(f.dir, 'other'); await mkdir(other);
  f.addWorkspace('other-workspace', other);
  const first = await f.create({ cwd: other });
  assert.equal(first.workspaceId, 'other-workspace'); assert.equal(first.cwd, other);
  assert.equal(f.workspaceRecords.get('source-workspace').sessionIds.includes(first.sessionId), false);
  assert.equal(f.workspaceRecords.get('other-workspace').sessionIds.includes(first.sessionId), true);
  const explicit = await f.create({ workspaceId: 'other-workspace' });
  assert.equal(explicit.cwd, other);
  await assert.rejects(f.create({ workspaceId: 'other-workspace', cwd: f.cwd }), { code: 'WORKSPACE_CWD_MISMATCH' });
  await assert.rejects(f.create({ workspaceId: 'missing' }), { code: 'WORKSPACE_NOT_FOUND' });
  assert.equal(f.events.filter(event => event[0] === 'create').length, 2);
});

test('new workspace identity persists before root creation and failed setup never repeats registration', async t => {
  const f = await fixture(t); const other = join(f.dir, 'new-workspace'); await mkdir(other);
  f.onCreate(() => { throw new Error('allocation uncertainty'); });
  let id;
  await assert.rejects(f.create({ requestId: 'new-workspace-once', cwd: other }), cause => { id = cause.sessionId; return cause.state === 'unknown'; });
  const row = (await f.store.read()).creations.find(entry => entry.sessionId === id);
  assert.equal(f.workspaceRecords.get(row.workspaceId).path, other);
  await assert.rejects(f.create({ requestId: 'new-workspace-once', cwd: other }), cause => cause.replayed === true);
  assert.equal(f.events.filter(event => event[0] === 'workspace-create').length, 1);
  assert.equal(f.events.filter(event => event[0] === 'create').length, 1);
});

test('public create attachment error preserves partial root and applies its permission ceiling', async t => {
  const f = await fixture(t);
  f.onCreate((_request, target) => { throw Object.assign(new Error('attach failed after allocation'), { data: { sessionId: target.id } }); });
  let id;
  await assert.rejects(f.create({ requestId: 'attach-failed', task: 'never start' }), cause => { id = cause.sessionId; return cause.state === 'partial'; });
  assert.equal(f.registry.get(id).session.permission, 'read-only');
  assert.equal((await f.store.read()).reception[id].enabled, false);
  assert.equal(f.events.filter(event => event[0] === 'followup').length, 0);
});

test('missing workspace capability and changed membership fail closed', async t => {
  const f = await fixture(t);
  const original = f.ctx.workspaceRegistry.list;
  delete f.ctx.workspaceRegistry.list;
  await assert.rejects(f.create({}), { code: 'WORKSPACE_UNAVAILABLE' });
  assert.equal(f.events.filter(event => event[0] === 'create').length, 0);
  f.ctx.workspaceRegistry.list = original;
  f.onFactory(() => { f.workspaceRecords.get('source-workspace').sessionIds = ['caller']; });
  await assert.rejects(f.create({ task: 'must not send' }), { code: 'WORKSPACE_ATTACH_FAILED', state: 'partial' });
  assert.equal(f.events.filter(event => event[0] === 'followup').length, 0);
});

test('hanging catalog read does not own the create queue and respects caller cancellation', async t => {
  const f = await fixture(t); const original = f.ctx.llm.listModels;
  f.ctx.llm.listModels = provider => provider === 'q' ? new Promise(() => {}) : original(provider);
  const controller = new AbortController();
  const read = assert.rejects(f.creator.models({ provider: 'q' }, { agent: f.caller, signal: controller.signal }), { code: 'ABORTED' });
  const result = await f.create({ requestId: 'independent-of-catalog' });
  assert.equal(result.state, 'ready');
  controller.abort(); await read;
});

test('metadata timeout releases read scope and pending create validation without allocating a root', async t => {
  const f = await fixture(t);
  f.ctx.agentPresets.resolve = () => new Promise(() => {});
  const creator = createSessionCreator({ ...f.options, metadataTimeoutMs: 20 });
  // The library intentionally unrefs metadata timers; keep this isolated test
  // alive until its deadline instead of depending on incidental filesystem I/O.
  const keeper = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(creator.create({ provider: 'p', model: 'm', requestId: 'metadata-timeout' }, { agent: f.caller }), { code: 'METADATA_TIMEOUT' });
    assert.equal(f.events.filter(event => event[0] === 'create').length, 0);
    assert.equal((await f.store.read()).creations.length, 0);
  } finally { clearTimeout(keeper); await creator.close(); }
});

test('Host creation side effects are not raced against the metadata deadline', async t => {
  const f = await fixture(t);
  let entered; const didEnter = new Promise(resolve => { entered = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  f.onCreate(async request => { entered(); await gate; return { sessionId: request.sessionId }; });
  const creator = createSessionCreator({ ...f.options, metadataTimeoutMs: 20 });
  let settled = false;
  const creation = creator.create({ provider: 'p', model: 'm', requestId: 'slow-side-effect' }, { agent: f.caller });
  creation.then(() => { settled = true; }, () => { settled = true; });
  await Promise.race([didEnter, creation]);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(settled, false, 'creation must retain ownership of an in-flight mutation after metadata deadline');
  assert.equal((await creator.models({}, { agent: f.caller })).providers.length, 2, 'metadata reads remain independent of mutation tail');
  release();
  assert.equal((await creation).state, 'ready');
  await creator.close();
});

test('late cancellation after workspace registration persists its identity without creating a root', async t => {
  const f = await fixture(t); const other = join(f.dir, 'late-workspace'); await mkdir(other);
  const controller = new AbortController();
  const original = f.ctx.workspaceRegistry.create;
  f.ctx.workspaceRegistry.create = async path => { const workspace = await original(path); controller.abort(); return workspace; };
  await assert.rejects(f.creator.create({ provider: 'p', model: 'm', requestId: 'late-registration', cwd: other }, { agent: f.caller, signal: controller.signal }), { code: 'ABORTED', state: 'unknown' });
  const entry = (await f.store.read()).creations[0];
  assert.equal(f.workspaceRecords.get(entry.workspaceId).path, other);
  assert.equal(f.events.filter(event => event[0] === 'create').length, 0);
  await assert.rejects(f.create({ requestId: 'late-registration', cwd: other }), cause => cause.replayed === true);
  assert.equal(f.events.filter(event => event[0] === 'workspace-create').length, 1);
});

test('creator close aborts stalled catalog wrappers instead of waiting for providers forever', async t => {
  const f = await fixture(t);
  f.ctx.llm.listProviders = () => new Promise(() => {});
  const read = assert.rejects(f.creator.models({}, { agent: f.caller }), { code: 'READ_SCOPE_CLOSED' });
  await f.creator.close(); await read;
});

test('lossless output, input bounds, and creator close reject future calls', async t => {
  const f = await fixture(t);
  for (const args of [{ provider: 'p'.repeat(201) }, { model: 'm'.repeat(201) }, { requestId: undefined }, { title: '\u001b[31m' }, { initialMessage: 'x'.repeat(8001) }]) await assert.rejects(f.create(args), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.creator.models({ limit: 101 }, { agent: f.caller }), { code: 'INVALID_ARGUMENT' });
  const result = await f.create({});
  assert.deepEqual(result, JSON.parse(JSON.stringify(result)));
  await f.creator.close();
  await assert.rejects(f.create({}), { code: 'CREATOR_CLOSED' });
});
