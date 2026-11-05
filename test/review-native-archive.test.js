import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createStore } from '../lib/store.js';
import { createService } from '../lib/service.js';
import { createCommunicationPolicy } from '../lib/communication-policy.js';
import { createSessionArchiver } from '../lib/session-archive.js';
import { TOOLS, concurrencySafe } from '../lib/tool-schema.js';

const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function archiveFixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'session-link-review-archive-'));
  const cwd = join(directory, 'same'); const outside = join(directory, 'outside');
  await mkdir(cwd); await mkdir(outside);
  const store = await createStore(join(directory, 'ledger'));
  const registry = new Map(); const headers = new Map(); const titles = new Map();
  const archived = []; const calls = []; const hooks = {}; const active = new Map();
  const add = (id, options = {}) => {
    const header = { id, cwd: options.cwd ?? cwd, ...(options.parent ? { origin: 'subagent', parentSession: options.parent } : {}) };
    headers.set(id, header); titles.set(id, options.title ?? `Fixture ${id}`);
    if (options.cold) return { id, header };
    const agent = { id, status: options.status ?? 'idle', session: { header, currentCwd: header.cwd } };
    registry.set(id, agent); return agent;
  };
  const caller = add('caller'); const target = add('target'); add('ancestor');
  const ctx = {
    agents: { get: id => registry.get(id), list: () => [...registry.values()], roots: () => [...registry.values()].filter(a => !a.session.header.origin), resume() { assert.fail('no resume'); } },
    sessions: { get: id => registry.get(id)?.session },
    workingDirectory: { get: session => hooks.cwd ? hooks.cwd(session) : session.currentCwd },
    sessionQuery: { async listSessions() { return [...headers.values()].map(header => ({ header })); }, readEvent() { assert.fail('no transcript query'); }, readSession() { assert.fail('no transcript read'); } },
    sessionController: { async list() { return { items: [...headers.values()].map(header => ({ sessionId: header.id, projections: { values: { title: titles.get(header.id), privatePrompt: 'PRIVATE_PROJECTION_MUST_NOT_LEAK' } } })) }; } },
    sessionProjections: { cachedSnapshot: session => ({ values: { title: titles.get(session.header.id) } }) },
    workspaceRegistry: {
      archivedSessionIds: archived,
      async archiveSession(targetId, options) {
        calls.push({ targetId, options, target: registry.get(targetId) });
        await hooks.before?.(targetId, options);
        if (!options.stopActivity && active.has(targetId)) throw Object.assign(new Error('PRIVATE_NATIVE_DIAGNOSTIC'), { name: 'WorkspaceActiveSessionError', sessionId: targetId, activity: active.get(targetId) });
        if (hooks.failureBefore) throw hooks.failureBefore;
        if (!archived.includes(targetId)) archived.push(targetId);
        await hooks.after?.(targetId, options);
      },
    },
  };
  const options = { ctx, store, config, now: () => 1000 };
  let archiver = createSessionArchiver(options);
  t.after(async () => { await archiver.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, cwd, outside, ctx, store, registry, headers, titles, archived, calls, hooks, active, add, caller, target, options,
    get archiver() { return archiver; },
    run: (args = {}, agent = caller, signal) => archiver.execute({ action: 'archive', targetId: 'target', requestId: 'request', ...args }, { agent, signal }),
    async restart() { await archiver.close(); archiver = createSessionArchiver(options); },
  };
}

function policyFixture() {
  const brand = Symbol('fixture native adjacent identity');
  const field = () => ({ type: 'string', required: true });
  const parent = { id: 'parent', status: 'running', session: { header: { id: 'parent' } } };
  const child = { id: 'child', status: 'idle', session: { header: { id: 'child', origin: 'subagent', parentSession: 'parent' }, isOwnSeq: seq => seq === 1 } };
  const registry = new Map([[parent.id, parent], [child.id, child]]);
  const native = { name: 'send_message', [brand]: true, parameters: { agent_id: field(), message: field() }, execute() { assert.fail('routing advice may not call native'); } };
  let visible = native; let ptc = false;
  const calls = [];
  const ctx = {
    agents: { get: id => registry.get(id), roots: () => [parent], list: () => [...registry.values()] },
    workspaceRegistry: { archivedSessionIds: [] },
    tools: {
      get(name, agent) { assert.equal(name, 'send_message'); calls.push(['get', agent]); return visible; },
      resolveExecution(name, agent, sdk) { calls.push(['resolve', agent, sdk]); return ptc && !sdk ? undefined : visible; },
      execute() { assert.fail('must not dispatch tools'); }, policy() { assert.fail('candidate is not a policy probe'); },
    },
    sessionProjections: { stateOf: () => ({ identity: { seq: 1 } }) },
    sessionQuery: { async readEvent() { return { inheritedEventCount: 0, target: { type: 'subagent/descriptor', seq: 1, data: { version: 3, mode: 'continuable', provider: 'spawn' } } }; } },
  };
  const policy = createCommunicationPolicy(ctx, { isAdjacentAgentSendMessageTool: tool => tool?.[brand] === true });
  const summary = agent => ({ id: agent.id, live: true, kind: agent === parent ? 'session' : 'subagent', status: agent.status, canReceive: true, cwd: '/fixture' });
  return { ctx, policy, parent, child, native, registry, calls, summary,
    setTool: tool => { visible = tool; }, setPtc: value => { ptc = value; },
    inspect: (overrides = {}) => policy.inspect({ agent: parent, targetId: child.id, self: summary(parent), target: summary(child), ...overrides }),
  };
}

test('review archive: sameDirectoryOnly rejects replacement target during final cwd validation', async t => {
  const f = await archiveFixture(t, { sameDirectoryOnly: true });
  let targetReads = 0;
  f.hooks.cwd = session => {
    const value = session.currentCwd;
    if (session.header.id === 'target' && ++targetReads === 2) f.add('target', { cwd: f.outside });
    return value;
  };
  await assert.rejects(f.run(), error => ['ACCESS_DENIED', 'ARCHIVE_SCOPE_CHANGED', 'TARGET_IDENTITY_CHANGED'].includes(error.code));
  assert.equal(f.calls.length, 0, 'native archive must not see a replacement outside the authorized directory');
  assert.equal(f.archived.includes('target'), false);
});

test('review archive: cwd mutation on either side during realpath authorization rejects native submission', async t => {
  for (const side of ['caller', 'target']) await t.test(side, async t => {
    const f = await archiveFixture(t, { sameDirectoryOnly: true });
    let changed = false;
    f.hooks.cwd = session => {
      const value = session.currentCwd;
      if (!changed && session.header.id === side) { changed = true; session.currentCwd = f.outside; }
      return value;
    };
    await assert.rejects(f.run(), { code: 'ACCESS_DENIED' });
    assert.equal(f.calls.length, 0);
  });
});

test('review archive: concurrent archiver instance never replays a still-inflight native archive', async t => {
  const f = await archiveFixture(t); const entered = gate(); const release = gate();
  const second = createSessionArchiver(f.options); t.after(() => second.close());
  f.hooks.before = async () => { entered.resolve(); await release.promise; };
  const first = f.run(); await entered.promise;
  try {
    await assert.rejects(second.execute({ action: 'archive', targetId: 'target', requestId: 'request' }, { agent: f.caller }), error => error.replayed === true && error.archiveState === 'unknown');
    assert.equal(f.calls.length, 1);
  } finally { release.resolve(); }
  assert.equal((await first).archived, true);
  assert.equal((await f.store.read()).archives.length, 1);
});

test('review archive: fixed ledger capacity never evicts a retained uncertain operation', async t => {
  const f = await archiveFixture(t, { maxArchives: 1 });
  f.hooks.failureBefore = new Error('uncertain native failure');
  await assert.rejects(f.run(), { code: 'ARCHIVE_UNCERTAIN' });
  delete f.hooks.failureBefore;
  await assert.rejects(f.run({ requestId: 'new-operation' }), { code: 'ARCHIVE_PRIOR_UNKNOWN' });
  f.add('capacity-other');
  await assert.rejects(f.run({ targetId: 'capacity-other', requestId: 'other-operation' }), { code: 'ARCHIVE_CAPACITY' });
  await assert.rejects(f.run(), error => error.replayed === true && error.archiveState === 'unknown');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.store.read()).archives.length, 1);
});

test('review archive: idle status cannot hide native jobs, schedules or descendant activity', async t => {
  for (const kind of ['job', 'schedule', 'descendant', 'cold-job']) await t.test(kind, async t => {
    const f = await archiveFixture(t);
    if (kind === 'cold-job') f.registry.delete('target');
    f.active.set('target', [{ kind, items: [{ id: 'work-1', label: `Fixture active ${kind}`, args: 'PRIVATE_ARGUMENTS', output: 'PRIVATE_OUTPUT' }], secret: 'PRIVATE_STATE' }]);
    assert.equal(f.target.status, 'idle');
    await assert.rejects(f.run(), error => error.code === 'ACTIVITY_REQUIRES_CONFIRMATION' && error.archived === false && !/PRIVATE/.test(error.activitySummary));
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.calls[0].options, { stopActivity: false });
    assert.equal(f.archived.length, 0);
    await assert.rejects(f.run({ stopActivity: true }), { code: 'IDEMPOTENCY_CONFLICT' });
    assert.equal(f.calls.length, 1, 'same request must not silently escalate stopActivity');
    const confirmed = await f.run({ requestId: `explicit-stop-${kind}`, stopActivity: true });
    assert.equal(confirmed.archived, true);
    assert.equal(confirmed.stopActivityRequested, true);
    assert.equal(confirmed.allStopped, undefined);
  });
});

test('review archive: unrelated native active errors never justify stop escalation or leak raw diagnostics', async t => {
  const f = await archiveFixture(t);
  f.hooks.failureBefore = Object.assign(new Error('PRIVATE_NATIVE_DIAGNOSTIC'), { name: 'WorkspaceActiveSessionError', sessionId: 'someone-else', activity: [{ kind: 'PRIVATE_GROUP' }] });
  await assert.rejects(f.run(), error => {
    assert.equal(error.code, 'ARCHIVE_UNCERTAIN');
    assert.equal(error.archiveState, 'unknown');
    assert.equal(error.activitySummary, undefined);
    assert.doesNotMatch(error.message, /PRIVATE/);
    return true;
  });
  await assert.rejects(f.run(), { code: 'ARCHIVE_UNCERTAIN', replayed: true });
  assert.equal(f.calls.length, 1);
});

test('review archive: exact caller and durable subagent ancestors fail closed even for a runtime-root sidechat', async t => {
  const f = await archiveFixture(t);
  const middle = f.add('middle', { parent: 'ancestor', cold: true });
  const sidechat = f.add('sidechat', { parent: middle.id });
  sidechat.session.header.isSeeded = true;
  f.ctx.agents.roots = () => [f.caller, sidechat];
  for (const targetId of ['middle', 'ancestor']) await assert.rejects(f.run({ targetId, requestId: targetId }, sidechat), { code: 'ARCHIVE_SELF_OR_ANCESTOR' });
  await assert.rejects(f.run({}, { ...f.caller }), { code: 'SENDER_NOT_LIVE' });
  f.archived.push('ancestor');
  await assert.rejects(f.archiver.execute({ action: 'list' }, { agent: sidechat }), { code: 'SENDER_ARCHIVED' });
  assert.equal(f.calls.length, 0);
});

test('review archive: exact caller may explicitly archive self without granting durable ancestor authority', async t => {
  const f = await archiveFixture(t);
  const result = await f.run({ targetId: 'caller', archiveScope: 'single', requestId: 'self-single' });
  assert.equal(result.archived, true);
  assert.deepEqual(f.calls.map(call => call.targetId), ['caller']);
  assert.deepEqual(f.calls[0].options, { stopActivity: false });
  assert.equal(f.archived.includes('ancestor'), false);
});

test('review archive: filtered discovery returns no global archive collection or private projections and never fuzzy-selects a mutation', async t => {
  const f = await archiveFixture(t);
  f.add('cold-match', { cold: true, title: 'Quarterly exact fixture' });
  f.archived.push('hidden-archive-not-in-directory');
  const result = await f.archiver.execute({ action: 'list', query: 'quarterly', limit: 1, includeArchived: true }, { agent: f.caller });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].id, 'cold-match');
  assert.equal(result.sessions[0].live, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|archivedSessionIds|hidden-archive-not-in-directory/);
  await assert.rejects(f.archiver.execute({ action: 'archive', query: 'Quarterly', requestId: 'no-exact-id' }, { agent: f.caller }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.calls.length, 0);
});

test('review archive: unknown and partial requests remain pinned across restart and never resubmit', async t => {
  for (const partial of [false, true]) await t.test(String(partial), async t => {
    const f = await archiveFixture(t);
    if (partial) f.hooks.after = () => { throw new Error('PRIVATE_POSTCOMMIT_ERROR'); };
    else f.hooks.failureBefore = new Error('PRIVATE_PRECOMMIT_ERROR');
    await assert.rejects(f.run(), { code: partial ? 'ARCHIVE_PARTIAL' : 'ARCHIVE_UNCERTAIN', archiveState: partial ? 'partial' : 'unknown' });
    await f.restart();
    delete f.hooks.after; delete f.hooks.failureBefore;
    await assert.rejects(f.run(), error => error.replayed === true && error.archiveState === (partial ? 'partial' : 'unknown'));
    assert.equal(f.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(await f.store.read()), /PRIVATE_/);
  });
});

test('review archive: interrupted persisted intent does not get replayed even when the target is not archived', async t => {
  const f = await archiveFixture(t);
  await f.store.mutate(state => { state.archives = [{ senderId: 'caller', targetId: 'target', requestId: 'request', fingerprint: createHash('sha256').update(JSON.stringify({ targetId: 'target', stopActivity: false })).digest('hex'), state: 'archiving', stage: 'archive' }]; });
  await assert.rejects(f.run(), { code: 'ARCHIVE_RESTART_UNKNOWN', replayed: true });
  assert.equal(f.calls.length, 0);
});

test('review archive: abort and close after native submission drain the side effect and retain its actual readback', async t => {
  const f = await archiveFixture(t);
  const entered = gate(); const release = gate(); const controller = new AbortController();
  f.hooks.before = async () => { entered.resolve(); await release.promise; };
  const pending = f.run({}, f.caller, controller.signal);
  await entered.promise;
  controller.abort();
  let closed = false; const closing = f.archiver.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false, 'no timeout/abort race may abandon a submitted mutation');
  release.resolve();
  const result = await pending; await closing;
  assert.equal(result.archived, true);
  assert.equal(result.cancelledAfterSubmission, true);
  assert.equal((await f.store.read()).archives[0].state, 'succeeded');
});

test('review policy: scoped PTC candidate is advice only and cannot execute/probe native tools', async () => {
  const f = policyFixture(); f.setPtc(true);
  const result = await f.inspect();
  assert.equal(result.nativeTool.directCallable, false);
  assert.equal(result.nativeTool.sdkCallable, true);
  assert.equal(result.nativeEligibility, 'candidate');
  assert.equal(result.admission, 'not-probed');
  assert.equal(result.automaticDispatch, false);
  assert.equal(result.automaticFallback, false);
  assert.deepEqual(result.nativeTarget, { agent_id: 'child' });
  assert.ok(f.calls.every(call => call[1] === f.parent));
});

test('review policy: scoped shadow or identity replacement during async metadata revokes the candidate', async () => {
  for (const mutation of ['tool', 'caller', 'target']) {
    const f = policyFixture();
    f.ctx.sessionQuery.readEvent = async () => {
      if (mutation === 'tool') f.setTool({ name: 'send_message', parameters: f.native.parameters });
      if (mutation === 'caller') f.registry.set(f.parent.id, { ...f.parent });
      if (mutation === 'target') f.registry.set(f.child.id, { ...f.child });
      return { inheritedEventCount: 0, target: { type: 'subagent/descriptor', seq: 1, data: { version: 3, mode: 'continuable', provider: 'spawn' } } };
    };
    const result = await f.inspect();
    assert.notEqual(result.nativeEligibility, 'candidate');
    assert.equal(result.nativeTarget, null);
    assert.equal(result.admission, 'not-probed');
  }
});

test('review policy: independent rooted sidechat and inherited parentId do not prove native adjacency', async () => {
  const f = policyFixture();
  f.ctx.agents.roots = () => [f.parent, f.child];
  const result = await f.inspect();
  assert.equal(result.nativeEligibility, 'unavailable');
  assert.equal(result.nativeTarget, null);
  assert.equal(result.recommendedChannel, 'session-link');
});

test('review service: Link modes never dispatch native or create an implicit native/Link second task', async t => {
  const f = await archiveFixture(t);
  const remote = [];
  const host = {
    async describe(id) { const agent = f.registry.get(id); return { id, live: true, kind: 'session', status: agent.status, canReceive: true, cwd: f.cwd }; },
    async list() { return { sessions: [...f.registry.values()].map(agent => ({ id: agent.id, live: true, kind: 'session', status: agent.status, canReceive: true, cwd: f.cwd })), truncated: false }; },
    async deliver(input) { remote.push(input); return { messageId: `link-${remote.length}`, mode: input.mode }; },
  };
  let inspections = 0;
  const policy = { async inspect() { inspections++; return { nativeEligibility: 'candidate', recommendedChannel: 'native-if-host-admits', admission: 'not-probed', automaticDispatch: false }; } };
  const service = createService({ host, store: f.store, communicationPolicy: policy });
  t.after(() => service.close());
  for (const mode of ['auto', 'followup', 'inject', 'steer']) {
    const result = await service.execute('link_send', { targetId: 'target', message: `fixture ${mode}`, mode, requestId: mode === 'auto' ? 'request' : mode }, { agent: f.caller });
    assert.equal(result.channel, 'session-link');
    assert.equal(remote.at(-1).mode, mode);
    const envelope = JSON.parse(remote.at(-1).text);
    assert.equal(envelope.channel, 'session-link');
    assert.equal(envelope.lifecycleOwnerChanged, false);
  }
  assert.equal(inspections, 0, 'advice is not an alternate send dispatcher');
  assert.equal((await f.store.read()).tasks.length, 0);
  await assert.rejects(service.execute('link_send', { targetId: 'target', message: 'not supported', mode: 'native' }, { agent: f.caller }), { code: 'INVALID_ARGUMENT' });
  assert.equal(remote.length, 4);
  assert.equal((await f.run()).archived, true, 'archive and send requestId namespaces must not collide');
  assert.equal((await f.store.read()).deliveries.length, 4);
});

test('review declarations: archive remains mutating by action and modes are never native-routing selectors', () => {
  const tool = TOOLS.find(item => item.name === 'link_session_archive');
  assert.ok(tool);
  assert.equal(concurrencySafe(tool.name, { action: 'archive' }), false);
  assert.equal(concurrencySafe(tool.name, { action: 'list' }), true);
  assert.match(tool.description, /Default stopActivity=false/);
  assert.match(tool.description, /NEVER automatically retry with true/);
  const send = TOOLS.find(item => item.name === 'link_send');
  assert.deepEqual(send.parameters.properties.mode.enum, ['auto', 'followup', 'inject', 'steer']);
  assert.match(send.description, /ALWAYS uses Session Link/);
  assert.match(send.description, /never silently dispatches native/);
});
