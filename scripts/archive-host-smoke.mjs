#!/usr/bin/env node
/** Isolated rc.5 archive control smoke. Uses the selected runtime's PUBLIC
 * ToolRuntime/WorkspaceRegistry/AgentRegistry APIs, never a production profile.
 * rc.5 here includes local scoped-permission fixes; the tests explicitly prove
 * scoped guard/filter admission rather than claiming an unmodified Host build.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createStore } from '../lib/store.js';
import { createSessionArchiver } from '../lib/session-archive.js';

if (!process.env.DSH_RUNTIME) throw new Error('Set DSH_RUNTIME to the runtime directory containing package.json and node_modules.');
const requireRuntime = createRequire(resolve(process.env.DSH_RUNTIME, 'package.json'));
const load = name => import(pathToFileURL(requireRuntime.resolve(`@deepseek-ai/${name}`)).href);
const loader = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) return { url: pathToFileURL(requireRuntime.resolve(specifier)).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const report = {
  pluginVersion: createRequire(import.meta.url)('../package.json').version,
  runtimeVersion: requireRuntime('@deepseek-ai/dsh-workspace/package.json').version,
  isolation: { freshContext: true, temporaryFilesOnly: true, sessionPersistence: 'temporary-jsonl', workspacePersistence: 'temporary-json', registeredLlmProviders: 0 },
  runtimeCaveat: 'Selected rc.5 may carry local permission fixes; public scoped guards, inherited restrictions and real execution are tested explicitly.',
  real: ['Cordis', 'ToolRuntime', 'WorkspaceRegistry', 'Storage/JSON/Domain', 'AgentRegistry/AgentLoop', 'SessionQuery/Projection/Title/ProjectionCache', 'SessionController metadata list', 'JSONL SessionPersistence', 'SubagentManager/in-process provider', 'Session Link mount/archiver/store'],
  fixtures: ['Typert registrations only; attachments/remote-access/default-model service metadata; minimal test-owned preset composition, no real profile preset loader or external transport',
    'An actual held native turn uses the loaded Agent registry activity/stop provider. Test-only observers forward native cancel and fresh-read workspace state; no synthetic activity/stop driver or job/scheduler plugins'],
  limitations: ['No GUI, production profile, network transport, provider cancellation guarantee, scheduler deletion or native cold-Agent resume coverage.',
    'PTC covers public presentation/candidate/direct/nested admission using a test correlation token, not the full run_code SDK bridge.',
    'An archive requests stopActivity; no result is interpreted as proof that all possible providers stopped.',
    'Official unarchive only restores visibility, not pins, stopped work or discarded inputs.',
    'Self post-submission abort is covered; caller disposal during an executing native tool is not covered.'],
  checks: [],
};
assert.equal(report.pluginVersion, '0.1.0');
assert.equal(report.runtimeVersion, '0.2.1-rc.5');
const tmp = await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-archive-host-')));
const otherCwd = join(tmp, 'other-directory');
const handles = [], activations = [], gates = new Map();
let root, mounted, store, reopenedStore, failure;
let modelCalls = 0, defaultWrites = 0, bodyCalls = 0, archiveCalls = 0, stopCalls = 0, activityCalls = 0, callSerial = 0;
const check = (name, extra = {}) => report.checks.push({ name, passed: true, ...extra });
async function timeout(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10000);
  })]); } finally { clearTimeout(timer); }
}
async function persistence(ctx, workspace = true) {
  await ctx.plugin(await load('dsh-session-persistence-jsonl'), { root: join(tmp, 'sessions'), compression: 'none' });
  if (!workspace) return;
  await ctx.plugin((await load('dsh-storage')).default);
  await ctx.plugin(await load('dsh-storage-json'), { root: join(tmp, 'workspace-storage') });
  await ctx.plugin(await load('dsh-storage-domain'), { backend: 'json', routes: {} });
  await ctx.plugin((await load('dsh-workspace')).default);
}
function hold(id) {
  let release, enter;
  const promise = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  gates.set(id, { promise, enter, release });
  return { entered, release() { gates.delete(id); release(); } };
}
try {
  const { Context } = await load('cordis');
  const llm = await load('dsh-llm');
  await mkdir(otherCwd);
  root = new Context();
  for (const name of ['dsh-session', 'dsh-agent', 'dsh-system-prompt']) await root.plugin((await load(name)).default);
  await persistence(root);
  await root.plugin((await load('dsh-tools')).default, { mode: 'native' });
  await root.plugin(llm.default);
  root.llm.prepareCall = async () => { modelCalls++; throw new Error('FORBIDDEN_LLM_CALL'); };
  root.llm.stream = () => { modelCalls++; throw new Error('FORBIDDEN_LLM_CALL'); };
  await root.plugin((await load('dsh-session-projection')).default);
  await root.plugin((await load('dsh-agent-loop')).default, { agents: [], maxParallelToolCalls: 10 });
  const query = await load('dsh-session-query');
  await root.plugin(query.SessionQueryEngine ?? query.default);
  await root.plugin((await load('dsh-fs-local')).default, { cwd: tmp });
  await root.plugin((await load('dsh-working-directory')).default, { defaultDirectory: tmp });
  await root.plugin((await load('dsh-session-title')).default, { fallbackMaxWords: 8, fallbackMaxBytes: 100, maxTitleBytes: 512 });
  await root.plugin((await load('dsh-session-projection-cache')).default, { writeEveryEvents: 1, writeIntervalMs: 60000 });
  root.provide('shell', { sandboxMode: 'read-only' });
  root.provide('approval', { config: { policy: 'ask' } });
  await root.plugin((await load('dsh-permission-presets')).default, {
    presets: { 'read-only': { sandbox: 'read-only', approval: 'ask' } }, defaultPreset: 'read-only',
  });
  root.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture-provider', model: 'fixture-model' }),
    saveSelection: async () => { defaultWrites++; throw new Error('FORBIDDEN_DEFAULT_WRITE'); } });
  root.provide('attachments', { imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1,
    maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png'] } });
  root.provide('fileUploads', { registerAgentResolver: () => () => {} });
  root.provide('remoteAccess', { allows: () => true });
  const registration = () => () => {};
  root.provide('typert', { resources: { register: registration }, lookups: { register: registration, configure: registration },
    contexts: { registerHost: registration, configureHost: registration } });
  root.sessionProjections.register((await load('dsh-agent-preset-registry')).agentPresetProjectionDefinition);
  root.provide('agentPresets', {
    resolve: async id => ({ id: id ?? 'fixture-preset' }), composedPreset: () => undefined, composeFrom: () => {},
    mount: async (ctx, id) => {
      // Test-owned minimal preset composition, not a real profile preset loader.
      if (id === 'fixture-filtered-preset') ctx.tools.restrict({ deny: ['link_session_archive'] });
      return { id };
    },
  });
  await root.plugin((await load('dsh-api-session-controller')).default, { nativeOpen: false, listWorkSliceMs: 16 });
  await root.plugin((await load('dsh-subagent')).default);
  await root.plugin(await load('dsh-subagent-spawn-in-process'), { providerName: 'spawn' });
  root.on('agent/created', ({ agent }) => {
    assert.ok(agent.id.startsWith('fixture-'));
    assert.ok([tmp, otherCwd].includes(agent.session.header.cwd));
    agent.ctx.on('agent/pre-step', async ({ signal }) => {
      const gate = gates.get(agent.id);
      if (gate) await new Promise(resolve => {
        gate.enter();
        const done = () => { signal.removeEventListener('abort', done); resolve(); };
        if (signal.aborted) return done();
        signal.addEventListener('abort', done, { once: true });
        gate.promise.then(done);
      });
      return { kind: 'reject' };
    });
  });
  const nativeArchiveOrder = [];
  const nativeArchive = root.workspaceRegistry.archiveSession;
  root.workspaceRegistry.archiveSession = function (...args) {
    archiveCalls++;
    nativeArchiveOrder.push(args[0]);
    return nativeArchive.apply(this, args); // Observation only; all archive mutations remain native.
  };
  const workspace = await root.workspaceRegistry.create(tmp, 'Temporary archive fixture');
  const otherWorkspace = await root.workspaceRegistry.create(otherCwd, 'Temporary different directory');
  async function create(id, { cwd = tmp, parent, sidechat = false } = {}) {
    const handle = await root.agents.create({ sessionId: id, ...(parent && !sidechat ? { parentAgent: parent } : {}),
      meta: { cwd, ...(parent ? { origin: 'subagent', parentSession: parent.id } : {}) },
      ...(sidechat ? { setup: (_ctx, agent) => { agent.session.append('subagent/descriptor', {
        version: 3, mode: 'continuable', provider: 'sidechat', label: 'fixture sidechat',
      }); } } : {}),
    });
    handles.push(handle);
    const agent = handle.agent;
    await (cwd === tmp ? workspace : otherWorkspace).attachSession(id);
    root.sessionTitle.rename(agent.session, `Title ${id}`);
    assert.equal(await root.sessions.flush(agent.session), true);
    await root.sessionProjectionCache.write(agent.session);
    return { agent, handle };
  }
  const { agent: caller } = await create('fixture-caller');
  const { agent: idle } = await create('fixture-idle');
  const { agent: active } = await create('fixture-active');
  const { agent: sidechat } = await create('fixture-sidechat', { parent: caller, sidechat: true });
  const { agent: cross } = await create('fixture-cross', { cwd: otherCwd });
  const { agent: cold, handle: coldHandle } = await create('fixture-cold');
  await coldHandle.dispose();
  assert.equal(root.agents.get(cold.id), undefined);
  assert.equal(root.sessions.get(cold.id), undefined);
  assert.ok((await root.sessionPersistence.stat(cold.id)).header);

  async function freshWorkspaceRead() {
    const fresh = new Context();
    try {
      await fresh.plugin((await load('dsh-session')).default);
      await persistence(fresh);
      return { archived: [...fresh.workspaceRegistry.archivedSessionIds], pinned: [...fresh.workspaceRegistry.pinnedSessionIds],
        owners: fresh.workspaceRegistry.list().map(w => ({ id: w.id, sessionIds: [...w.sessionIds] })) };
    } finally { await fresh.fiber.dispose(); }
  }
  const stopObservations = [];
  root.on('workspace/session-activity', async (_request, next) => {
    activityCalls++;
    return next(); // Observation only: the real Agent registry reports the `turn` family.
  });
  root.on('workspace/session-stop', async ({ sessionId }) => {
    stopCalls++;
    const persisted = await freshWorkspaceRead();
    assert.ok(persisted.archived.includes(sessionId), 'Archive must be durably readable by a new Host scope before stop callback.');
    assert.ok(!persisted.pinned.includes(sessionId), 'Unpin must be durable before stop callback.');
    const agent = root.agents.get(sessionId);
    stopObservations.push({ sessionId, archivedBeforeStop: true, unpinnedBeforeStop: true });
    // Native providers run in parallel; they may have canceled before this async observer resumes.
    if (agent) await agent.whenIdle();
  });
  async function mount(config = {}) {
    const plugin = await import('../index.js');
    mounted = await plugin.mount(root, config, { directory: join(tmp, 'link-store'),
      createStore: async directory => { store = await createStore(directory); return store; },
      createSessionArchiver: options => {
        const actual = createSessionArchiver(options);
        return { execute(args, exec) { bodyCalls++; return actual.execute(args, exec); }, close: () => actual.close() };
      },
    });
    assert.equal(mounted.toolNames.length, 9);
    assert.equal(root.tools.schemas(caller).filter(row => row.name.startsWith('link_')).length, 9);
  }
  await mount();
  const tool = 'link_session_archive';
  async function run(agent, args, extra = {}) {
    return timeout(root.tools.execute({ name: tool, arguments: args, agent, callId: `fixture-archive-${++callSerial}`,
      signal: new AbortController().signal, ...extra }), `${agent.id}:${args.action}`);
  }
  async function success(agent, args) {
    const outcome = await run(agent, args);
    assert.equal(outcome.isError, false, JSON.stringify(outcome));
    assert.equal(outcome.value?.ok, true, JSON.stringify(outcome));
    return outcome.value;
  }
  async function rejected(agent, args, code) {
    const outcome = await run(agent, args);
    assert.equal(outcome.value?.ok, false, JSON.stringify(outcome));
    assert.equal(outcome.value.error.code, code, JSON.stringify(outcome));
    return outcome.value.error;
  }
  check('nine-global-tools-real-mount-no-child-shadow');
  assert.deepEqual(root.tools.executionMode({ name: tool, arguments: { action: 'list' }, agent: caller }), { kind: 'parallel' });
  assert.deepEqual(root.tools.executionMode({ name: tool, arguments: { action: 'archive', archiveScope: 'single', targetId: idle.id, requestId: 'check' }, agent: caller }), { kind: 'exclusive' });
  check('discovery-readonly-archive-exclusive-runtime-classification');
  const ledgerBeforeList = await store.read();
  const seqBeforeList = caller.session.seq;
  const listed = await success(caller, { action: 'list', includeArchived: true, query: 'Title fixture-cold' });
  assert.equal(listed.operation, 'archive-discovery');
  assert.equal(listed.channel, 'session-link-control');
  assert.equal(listed.sessions.length, 1);
  assert.equal(listed.sessions[0].id, cold.id);
  assert.equal(listed.sessions[0].title, 'Title fixture-cold');
  assert.equal(listed.sessions[0].status, 'persisted');
  assert.equal(root.agents.get(cold.id), undefined, 'Metadata discovery must not resume cold Agent.');
  assert.deepEqual(await store.read(), ledgerBeforeList, 'Discovery cannot write plugin ledger.');
  assert.equal(caller.session.seq, seqBeforeList);
  check('public-controller-cached-cold-title-discovery-no-resume-or-ledger-write');

  const idleBefore = await root.sessionPersistence.open(idle.id, 'read');
  let idleEvents;
  try { idleEvents = (await idleBefore.read()).events; } finally { await idleBefore.close(); }
  await root.workspaceRegistry.pinSession(idle.id);
  const membershipBefore = [...workspace.sessionIds];
  const idleResult = await success(caller, { action: 'archive', archiveScope: 'single', targetId: idle.id, requestId: 'idle-archive' });
  assert.equal(idleResult.archived, true);
  assert.equal(idleResult.readback, true);
  assert.equal(idleResult.stopActivityRequested, false);
  assert.equal(idleResult.channel, 'session-link-control');
  assert.equal(idleResult.operation, 'archive');
  assert.deepEqual(workspace.sessionIds, membershipBefore);
  assert.ok(!root.workspaceRegistry.pinnedSessionIds.includes(idle.id));
  assert.equal(root.agents.get(idle.id), idle, 'Archiving must not dispose or delete target.');
  assert.equal(stopCalls, 0);
  const idleAfter = await root.sessionPersistence.open(idle.id, 'read');
  try { assert.deepEqual((await idleAfter.read()).events, idleEvents, 'Archive preserves exact JSONL transcript.'); } finally { await idleAfter.close(); }
  const durable = await freshWorkspaceRead();
  assert.ok(durable.archived.includes(idle.id));
  assert.ok(durable.owners.find(w => w.id === workspace.id).sessionIds.includes(idle.id));
  check('idle-archive-persists-unpins-retains-log-membership-and-live-agent');

  const sameReplay = await success(caller, { action: 'archive', archiveScope: 'single', targetId: idle.id, requestId: 'idle-archive' });
  assert.equal(sameReplay.replayed, true);
  const checksBeforeRepeat = activityCalls;
  const repeated = await success(caller, { action: 'archive', archiveScope: 'single', targetId: idle.id, requestId: 'idle-already-with-stop', stopActivity: true });
  assert.equal(repeated.alreadyArchived, true);
  assert.equal(repeated.stopActivityRequested, false);
  assert.equal(stopCalls, 0); assert.equal(activityCalls, checksBeforeRepeat);
  await rejected(caller, { action: 'archive', archiveScope: 'single', targetId: active.id, requestId: 'idle-archive' }, 'IDEMPOTENCY_CONFLICT');
  check('same-request-replay-conflict-and-already-archived-stop-true-noop');

  const activeGate = hold(active.id);
  active.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Fixture held native turn; model call forbidden' }], source: { kind: 'user' } }));
  await timeout(activeGate.entered, 'real active native turn');
  assert.equal(active.status, 'running');
  await root.workspaceRegistry.pinSession(active.id);
  const archiveBeforeActive = [...root.workspaceRegistry.archivedSessionIds];
  const pinsBeforeActive = [...root.workspaceRegistry.pinnedSessionIds];
  const activeSeq = active.session.seq;
  const activeError = await rejected(caller, { action: 'archive', archiveScope: 'single', targetId: active.id, requestId: 'active-default' }, 'ACTIVITY_REQUIRES_CONFIRMATION');
  assert.match(activeError.activitySummary, /turn/);
  assert.equal(activeError.archived, false);
  assert.deepEqual(root.workspaceRegistry.archivedSessionIds, archiveBeforeActive);
  assert.deepEqual(root.workspaceRegistry.pinnedSessionIds, pinsBeforeActive);
  assert.equal(active.session.seq, activeSeq);
  assert.equal(active.status, 'running'); assert.equal(stopCalls, 0);
  assert.equal((await store.read()).archives.find(e => e.requestId === 'active-default').state, 'failed');
  await rejected(caller, { action: 'archive', archiveScope: 'single', targetId: active.id, requestId: 'active-default', stopActivity: true }, 'IDEMPOTENCY_CONFLICT');
  check('active-default-refused-no-host-state-change-failed-intent-retained');
  const nativeCancelSnapshots = [];
  const nativeCancel = active.cancel;
  active.cancel = function (...args) {
    nativeCancelSnapshots.push({ archived: root.workspaceRegistry.archivedSessionIds.includes(active.id),
      unpinned: !root.workspaceRegistry.pinnedSessionIds.includes(active.id), status: active.status, reason: args[0] });
    return nativeCancel.apply(this, args); // Observe then forward: never replace the native stop behavior.
  };
  let stopped;
  try { stopped = await success(caller, { action: 'archive', archiveScope: 'single', targetId: active.id, requestId: 'active-explicit-stop', stopActivity: true }); }
  finally { active.cancel = nativeCancel; }
  assert.deepEqual(nativeCancelSnapshots, [{ archived: true, unpinned: true, status: 'running', reason: { kind: 'user' } }]);
  assert.equal(stopped.stopActivityRequested, true);
  assert.equal(stopped.archived, true);
  assert.equal(active.status, 'idle'); assert.equal(stopCalls, 1);
  assert.deepEqual(stopObservations[0], { sessionId: active.id, archivedBeforeStop: true, unpinnedBeforeStop: true });
  for (const forbiddenClaim of ['allStopped', 'activityStopped', 'allActivityStopped']) assert.equal(Object.hasOwn(stopped, forbiddenClaim), false);
  activeGate.release();
  check('explicit-stop-real-turn-durable-archive-unpin-before-stop-no-all-stopped-claim');

  const archiveBeforeSelf = [...root.workspaceRegistry.archivedSessionIds];
  const selfListed = await success(caller, { action: 'list', query: caller.id });
  assert.equal(selfListed.sessions.length, 1);
  assert.equal(selfListed.sessions[0].id, caller.id);
  assert.equal(selfListed.sessions[0].isSelf, true);
  assert.equal(selfListed.sessions[0].canArchive, true);
  const ancestorListed = await success(sidechat, { action: 'list', query: caller.id });
  assert.equal(ancestorListed.sessions[0].isSelf, false);
  assert.equal(ancestorListed.sessions[0].canArchive, false);
  assert.equal(ancestorListed.sessions[0].reason, 'ARCHIVE_SELF_OR_ANCESTOR');
  await rejected(sidechat, { action: 'archive', archiveScope: 'single', targetId: caller.id, requestId: 'sidechat-ancestor-denied' }, 'ARCHIVE_SELF_OR_ANCESTOR');
  assert.deepEqual(root.workspaceRegistry.archivedSessionIds, archiveBeforeSelf);
  const { agent: sidechatTarget } = await create('fixture-sidechat-target');
  const sidechatResult = await success(sidechat, { action: 'archive', archiveScope: 'single', targetId: sidechatTarget.id, requestId: 'sidechat-allowed' });
  assert.equal(sidechatResult.archived, true);
  check('self-discovery-allowed-durable-ancestor-rejected-sidechat-caller-not-blanket-banned');

  const childGate = hold('fixture-managed-child');
  const activation = await root.subagents.startActivation({ provider: 'spawn', childId: 'fixture-managed-child', label: 'fixture managed child',
    request: { parent: caller, prompt: [{ type: 'text', text: 'Fixture child gate' }] }, signal: new AbortController().signal, delivery: 'caller' });
  activations.push(activation); activation.result.catch(() => {});
  await timeout(childGate.entered, 'managed child pre-step');
  const child = root.agents.get('fixture-managed-child');
  assert.ok(child); assert.equal(child.session.header.origin, 'subagent');
  assert.equal(child.session.header.parentSession, caller.id);
  const { agent: childTarget } = await create('fixture-child-target');
  await rejected(child, { action: 'archive', archiveScope: 'single', targetId: caller.id, requestId: 'managed-ancestor-denied' }, 'ARCHIVE_SELF_OR_ANCESTOR');
  assert.equal((await success(child, { action: 'archive', archiveScope: 'single', targetId: childTarget.id, requestId: 'managed-allowed' })).archived, true);
  check('real-managed-caller-allowed-unrelated-target-ancestor-denied');

  const { agent: guardedTarget } = await create('fixture-guard-target');
  const beforeGuardBody = bodyCalls, beforeGuardArchive = archiveCalls;
  const beforeGuardLedger = await store.read();
  let guardSeen;
  const removeGuard = child.ctx.tools.guard(exec => {
    if (exec.name !== tool) return;
    guardSeen = exec.agent;
    return 'FIXTURE_SCOPED_ARCHIVE_DENIED';
  });
  const guardOutcome = await run(child, { action: 'archive', archiveScope: 'single', targetId: guardedTarget.id, requestId: 'guard-denied' });
  assert.equal(guardOutcome.isError, true); assert.match(guardOutcome.error.message, /FIXTURE_SCOPED_ARCHIVE_DENIED/);
  assert.equal(guardSeen, child, 'Real execution retains child identity; no root代发.');
  assert.equal(bodyCalls, beforeGuardBody, 'Scoped guard blocks plugin body.');
  assert.equal(archiveCalls, beforeGuardArchive, 'Scoped guard must not reach the native archive mutation.');
  const guardedList = await run(child, { action: 'list' });
  assert.equal(guardedList.isError, true); assert.match(guardedList.error.message, /FIXTURE_SCOPED_ARCHIVE_DENIED/);
  assert.equal(bodyCalls, beforeGuardBody); assert.equal(archiveCalls, beforeGuardArchive);
  assert.deepEqual(await store.read(), beforeGuardLedger);
  assert.ok(!root.workspaceRegistry.archivedSessionIds.includes(guardedTarget.id));
  assert.ok(root.tools.get(tool, caller), 'Child guard must not hide/deny root surface.');
  check('public-scoped-tool-guard-denies-real-child-before-body-no-root-borrow');
  const restorePresentation = child.ctx.tools.presentAs('ptc');
  try {
    assert.ok(root.tools.get(tool, child), 'A visible PTC candidate is not model-direct admission.');
    assert.equal(root.tools.resolveExecution(tool, child, false), undefined);
    assert.ok(root.tools.resolveExecution(tool, child, true), 'Nested candidate resolution does not itself apply scoped guards.');
    const collapsed = await run(child, { action: 'archive', archiveScope: 'single', targetId: guardedTarget.id, requestId: 'ptc-direct-denied' });
    assert.equal(collapsed.isError, true); assert.equal(collapsed.error.info.code, 'UNKNOWN_TOOL');
    // Public same-process nested dispatch with a test correlation token, not a full run_code SDK invocation.
    const nested = await run(child, { action: 'archive', archiveScope: 'single', targetId: guardedTarget.id, requestId: 'ptc-nested-guard-denied' }, { parent: Symbol('fixture-ptc-parent') });
    assert.equal(nested.isError, true); assert.match(nested.error.message, /FIXTURE_SCOPED_ARCHIVE_DENIED/);
    assert.equal(bodyCalls, beforeGuardBody); assert.equal(archiveCalls, beforeGuardArchive);
    assert.deepEqual(await store.read(), beforeGuardLedger);
  } finally { restorePresentation(); }
  removeGuard();
  check('public-ptc-visible-candidate-not-direct-admission-nested-still-guarded');

  const removeRestriction = child.ctx.tools.restrict({ deny: [tool] });
  const beforeRestrictedBody = bodyCalls, beforeRestrictedArchive = archiveCalls;
  assert.equal(root.tools.get(tool, child), undefined);
  assert.ok(!root.tools.schemas(child).some(row => row.name === tool));
  assert.ok(root.tools.get(tool, caller));
  const restricted = await run(child, { action: 'archive', archiveScope: 'single', targetId: guardedTarget.id, requestId: 'restricted-denied' });
  assert.equal(restricted.isError, true); assert.equal(restricted.error.info.code, 'UNKNOWN_TOOL');
  assert.equal(bodyCalls, beforeRestrictedBody); assert.equal(archiveCalls, beforeRestrictedArchive);
  assert.ok(!root.workspaceRegistry.archivedSessionIds.includes(guardedTarget.id));
  removeRestriction();
  assert.ok(root.tools.get(tool, child));
  check('public-child-restrict-hides-schema-and-execution-unknown-tool-no-shadow');

  const filteredGate = hold('fixture-filtered-child');
  const filteredActivation = await root.subagents.startActivation({ provider: 'spawn', childId: 'fixture-filtered-child', label: 'fixture filtered child',
    request: { parent: caller, prompt: [{ type: 'text', text: 'Fixture filtered child gate' }], agentPreset: 'fixture-filtered-preset' },
    signal: new AbortController().signal, delivery: 'caller' });
  activations.push(filteredActivation); filteredActivation.result.catch(() => {});
  await timeout(filteredGate.entered, 'filtered child pre-step');
  const filteredChild = root.agents.get('fixture-filtered-child');
  assert.ok(filteredChild);
  assert.equal(root.tools.get(tool, filteredChild), undefined, 'Test-owned preset toolFilter removes inherited archive in actual Subagent scope.');
  const filteredBeforeBody = bodyCalls, filteredBeforeArchive = archiveCalls;
  const filteredOutcome = await run(filteredChild, { action: 'archive', archiveScope: 'single', targetId: guardedTarget.id, requestId: 'composition-filter-denied' });
  assert.equal(filteredOutcome.isError, true); assert.equal(filteredOutcome.error.info.code, 'UNKNOWN_TOOL');
  assert.equal(bodyCalls, filteredBeforeBody); assert.equal(archiveCalls, filteredBeforeArchive);
  assert.ok(!root.workspaceRegistry.archivedSessionIds.includes(guardedTarget.id));
  filteredGate.release(); childGate.release();
  await timeout(Promise.all([filteredChild.whenIdle(), child.whenIdle()]), 'children settle');
  check('actual-subagent-with-test-preset-public-toolFilter-cannot-execute-archive');

  const coldResult = await success(caller, { action: 'archive', targetId: cold.id, requestId: 'cold-archive' });
  assert.equal(coldResult.archiveScope, 'single', 'No-scope target without candidates retains legacy single behavior.');
  assert.equal(coldResult.archived, true); assert.equal(root.agents.get(cold.id), undefined);
  assert.ok((await root.sessionPersistence.stat(cold.id)).header);
  const withoutArchived = await success(caller, { action: 'list', query: cold.id });
  assert.equal(withoutArchived.sessions.length, 0);
  const withArchived = await success(caller, { action: 'list', query: cold.id, includeArchived: true });
  assert.equal(withArchived.sessions[0].archived, true);
  check('cold-archive-preserves-jsonl-no-resume-discovery-respects-includeArchived');
  await rejected(caller, { action: 'archive', archiveScope: 'single', targetId: 'fixture-missing', requestId: 'missing-denied' }, 'SESSION_NOT_FOUND');
  check('unknown-exact-target-no-archive');

  await root.workspaceRegistry.unarchiveSession(idle.id);
  assert.ok(!root.workspaceRegistry.archivedSessionIds.includes(idle.id));
  assert.ok(!root.workspaceRegistry.pinnedSessionIds.includes(idle.id), 'Official unarchive does not restore a pin.');
  assert.deepEqual(workspace.sessionIds, [guardedTarget.id, childTarget.id, sidechatTarget.id, ...membershipBefore]);
  check('official-unarchive-restores-visibility-not-pin-or-work');

  // Explicit scope and stop authorization are separate. All Agents below belong
  // only to this fresh Host; provenance entries model persisted creator records.
  const { agent: groupRoot } = await create('fixture-group-root');
  const { agent: groupChild } = await create('fixture-group-child');
  const { agent: groupLeaf } = await create('fixture-group-leaf');
  await store.mutate(draft => {
    draft.creations ??= [];
    draft.creations.push(
      { senderId: groupRoot.id, sessionId: groupChild.id, state: 'ready' },
      { senderId: groupChild.id, sessionId: groupLeaf.id, state: 'ready' },
    );
  });
  const groupGate = hold(groupChild.id);
  groupChild.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Fixture scope consent held turn' }], source: { kind: 'user' } }));
  await timeout(groupGate.entered, 'scope group held turn');
  const beforeChoice = await store.read();
  const beforeChoiceCalls = archiveCalls, beforeChoiceStops = stopCalls;
  const beforeChoiceBits = [...root.workspaceRegistry.archivedSessionIds];
  for (const stopActivity of [false, true]) {
    const choice = await rejected(caller, { action: 'archive', targetId: groupRoot.id,
      requestId: `scope-choice-${stopActivity}`, stopActivity }, 'ARCHIVE_SCOPE_REQUIRED');
    assert.deepEqual(choice.allowedScopes, ['single', 'related']);
    assert.equal(choice.targetId, groupRoot.id);
    for (const forbidden of ['planId', 'targets', 'outcome']) assert.equal(Object.hasOwn(choice, forbidden), false);
  }
  assert.deepEqual(await store.read(), beforeChoice, 'Scope choice cannot create a committable plan or intent.');
  assert.equal(archiveCalls, beforeChoiceCalls); assert.equal(stopCalls, beforeChoiceStops);
  assert.deepEqual(root.workspaceRegistry.archivedSessionIds, beforeChoiceBits);
  assert.equal(groupChild.status, 'running');
  check('missing-scope-with-related-candidates-zero-plan-native-mutation-and-stop');

  const onlyRoot = await success(caller, { action: 'archive', archiveScope: 'single', targetId: groupRoot.id, requestId: 'scope-single-root' });
  assert.equal(onlyRoot.archiveScope, 'single'); assert.equal(onlyRoot.archived, true);
  assert.deepEqual(nativeArchiveOrder.slice(beforeChoiceCalls), [groupRoot.id]);
  assert.ok(!root.workspaceRegistry.archivedSessionIds.includes(groupChild.id));
  assert.ok(!root.workspaceRegistry.archivedSessionIds.includes(groupLeaf.id));
  assert.equal(groupChild.status, 'running'); assert.equal(stopCalls, beforeChoiceStops);
  await root.workspaceRegistry.unarchiveSession(groupRoot.id);
  check('explicit-single-archives-only-target-ignores-active-descendant');

  const relatedBefore = archiveCalls;
  const activityPlan = await rejected(caller, { action: 'archive', archiveScope: 'related',
    targetId: groupRoot.id, requestId: 'scope-related-plan' }, 'ACTIVITY_REQUIRES_CONFIRMATION');
  assert.equal(activityPlan.archiveScope, 'related'); assert.equal(typeof activityPlan.planId, 'string');
  assert.deepEqual(new Set(activityPlan.targets.map(item => item.id)), new Set([groupRoot.id, groupChild.id, groupLeaf.id]));
  assert.equal(archiveCalls, relatedBefore); assert.equal(stopCalls, beforeChoiceStops);
  assert.equal(groupChild.status, 'running');
  await rejected(caller, { action: 'archive', archiveScope: 'single', targetId: groupRoot.id,
    planId: activityPlan.planId, requestId: 'scope-mismatch', stopActivity: true }, 'IDEMPOTENCY_CONFLICT');
  await rejected(caller, { action: 'archive', targetId: groupRoot.id,
    planId: activityPlan.planId, requestId: 'scope-missing-commit', stopActivity: true }, 'INVALID_ARGUMENT');
  assert.equal(archiveCalls, relatedBefore); assert.equal(stopCalls, beforeChoiceStops);
  await rejected(caller, { action: 'archive', archiveScope: 'related', targetId: groupRoot.id,
    planId: activityPlan.planId, requestId: 'scope-related-no-stop', stopActivity: false }, 'ACTIVITY_REQUIRES_CONFIRMATION');
  assert.equal(archiveCalls, relatedBefore); assert.equal(stopCalls, beforeChoiceStops);
  assert.equal(groupChild.status, 'running');
  const related = await success(caller, { action: 'archive', archiveScope: 'related', targetId: groupRoot.id,
    planId: activityPlan.planId, requestId: 'scope-related-confirmed', stopActivity: true });
  assert.equal(related.archiveScope, 'related');
  assert.deepEqual(nativeArchiveOrder.slice(relatedBefore), [groupLeaf.id, groupChild.id, groupRoot.id]);
  for (const agent of [groupRoot, groupChild, groupLeaf]) assert.ok(root.workspaceRegistry.archivedSessionIds.includes(agent.id));
  assert.equal(groupChild.status, 'idle');
  const relatedReplayCalls = archiveCalls, relatedReplayStops = stopCalls;
  assert.equal((await success(caller, { action: 'archive', archiveScope: 'related', targetId: groupRoot.id,
    planId: activityPlan.planId, requestId: 'scope-related-confirmed', stopActivity: true })).replayed, true);
  assert.equal(archiveCalls, relatedReplayCalls); assert.equal(stopCalls, relatedReplayStops);
  groupGate.release();
  check('related-scope-is-not-stop-consent-exact-plan-child-first-root-last-replay-no-retry');

  const { agent: selfIdle } = await create('fixture-self-idle');
  const selfIdleResult = await success(selfIdle, { action: 'archive', archiveScope: 'single', targetId: selfIdle.id, requestId: 'self-idle-archive' });
  assert.equal(selfIdleResult.archived, true); assert.equal(selfIdleResult.archiveScope, 'single');
  assert.equal(selfIdleResult.stopActivityRequested, false);
  assert.equal(root.agents.get(selfIdle.id), selfIdle);
  assert.equal((await store.read()).archives.find(entry => entry.requestId === 'self-idle-archive').state, 'succeeded');
  check('real-toolruntime-self-single-idle-archive-succeeds-and-persists');

  const { agent: selfActive } = await create('fixture-self-active');
  const selfGate = hold(selfActive.id);
  selfActive.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'Fixture self archive held turn' }], source: { kind: 'user' } }));
  await timeout(selfGate.entered, 'self held turn');
  await rejected(selfActive, { action: 'archive', archiveScope: 'single', targetId: selfActive.id,
    requestId: 'self-active-default' }, 'ACTIVITY_REQUIRES_CONFIRMATION');
  assert.equal(selfActive.status, 'running');
  assert.ok(!root.workspaceRegistry.archivedSessionIds.includes(selfActive.id));
  const selfAbort = new AbortController();
  const removeSelfAbort = root.on('workspace/session-stop', ({ sessionId }) => {
    if (sessionId === selfActive.id) selfAbort.abort(new Error('Fixture tool cancellation after native archive persistence'));
  });
  let selfDelivery;
  try {
    selfDelivery = await run(selfActive, { action: 'archive', archiveScope: 'single', targetId: selfActive.id,
      requestId: 'self-active-confirmed', stopActivity: true }, { signal: selfAbort.signal });
  } finally { removeSelfAbort(); }
  assert.equal(selfAbort.signal.aborted, true);
  assert.equal(selfActive.status, 'idle');
  const selfIntent = (await store.read()).archives.find(entry => entry.requestId === 'self-active-confirmed');
  assert.equal(selfIntent.state, 'succeeded'); assert.equal(selfIntent.result.archived, true);
  assert.equal(selfIntent.result.cancelledAfterSubmission, true);
  assert.equal(selfIntent.result.stopActivityRequested, true);
  assert.ok((await freshWorkspaceRead()).archived.includes(selfActive.id));
  selfGate.release();
  check('self-active-default-refused-explicit-stop-post-submit-abort-retains-durable-result', {
    callerToolReturnedOk: selfDelivery.value?.ok === true,
    cancellationFixture: 'Native stop cancels held turn; test observer aborts the ToolRuntime execution signal only after persistence.',
  });

  // A retained pre-upgrade unknown intent is fixture data, not a fabricated Host
  // success. It must never be retried, including after the plugin is reopened.
  const { agent: uncertain } = await create('fixture-prior-unknown');
  await store.mutate(draft => {
    draft.archives.push({ senderId: caller.id, targetId: uncertain.id, requestId: 'legacy-unknown',
      fingerprint: createHash('sha256').update(JSON.stringify({ targetId: uncertain.id, stopActivity: false })).digest('hex'),
      stopActivity: false, state: 'unknown', stage: 'restart',
      error: { code: 'ARCHIVE_RESTART_UNKNOWN', message: 'Fixture interrupted legacy intent; do not retry.' } });
  });
  await mounted.close(); mounted = undefined;
  reopenedStore = await createStore(join(tmp, 'link-store'));
  assert.equal((await reopenedStore.read()).archives.find(e => e.requestId === 'cold-archive').result.archived, true);
  await reopenedStore.close(); reopenedStore = undefined;
  await mount({ sameDirectoryOnly: true });
  const unknownBefore = archiveCalls, unknownStops = stopCalls;
  const legacyReplay = await rejected(caller, { action: 'archive', targetId: uncertain.id,
    requestId: 'legacy-unknown' }, 'ARCHIVE_RESTART_UNKNOWN');
  assert.equal(legacyReplay.replayed, true);
  await rejected(caller, { action: 'archive', archiveScope: 'single', targetId: uncertain.id,
    requestId: 'unknown-new-request' }, 'ARCHIVE_PRIOR_UNKNOWN');
  assert.equal(archiveCalls, unknownBefore); assert.equal(stopCalls, unknownStops);
  assert.ok(!root.workspaceRegistry.archivedSessionIds.includes(uncertain.id));
  assert.equal((await store.read()).archives.find(entry => entry.requestId === 'legacy-unknown').state, 'unknown');
  assert.equal((await store.read()).archives.find(entry => entry.requestId === 'self-active-confirmed').result.cancelledAfterSubmission, true);
  check('legacy-unknown-reopen-replay-and-new-request-no-native-retry-self-result-retained');
  const strictBefore = [...root.workspaceRegistry.archivedSessionIds];
  await rejected(caller, { action: 'archive', archiveScope: 'single', targetId: cross.id, requestId: 'cross-denied' }, 'ACCESS_DENIED');
  await rejected(caller, { action: 'archive', archiveScope: 'single', targetId: cold.id, requestId: 'cold-strict-denied' }, 'ACCESS_DENIED');
  assert.deepEqual(root.workspaceRegistry.archivedSessionIds, strictBefore);
  const { agent: strictTarget } = await create('fixture-strict-target');
  assert.equal((await success(caller, { action: 'archive', archiveScope: 'single', targetId: strictTarget.id, requestId: 'same-directory-allowed' })).archived, true);
  check('strict-current-directory-cross-and-cold-denied-same-directory-allowed');
  const finalFresh = await freshWorkspaceRead();
  for (const targetId of [active.id, cold.id, strictTarget.id]) assert.ok(finalFresh.archived.includes(targetId));
  assert.ok(!finalFresh.archived.includes(idle.id));
  assert.equal(modelCalls, 0); assert.equal(defaultWrites, 0);
  check('plugin-ledger-reopen-and-fresh-host-archive-readback-zero-model-default-writes');
  report.stopObservations = stopObservations;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  for (const gate of gates.values()) gate.release();
  gates.clear();
  const cleanup = [];
  if (mounted) cleanup.push(() => mounted.close());
  if (reopenedStore) cleanup.push(() => reopenedStore.close());
  for (const activation of activations.reverse()) cleanup.push(() => activation.dispose());
  for (const handle of handles.reverse()) cleanup.push(() => handle.dispose());
  if (root) cleanup.push(() => root.fiber.dispose());
  for (const dispose of cleanup) try { await timeout(Promise.resolve().then(dispose), 'cleanup'); } catch (error) {
    failure ??= error; (report.cleanupErrors ??= []).push(error.message);
  }
  loader.deregister();
  try { await rm(tmp, { recursive: true, force: true }); } catch (error) { failure ??= error; (report.cleanupErrors ??= []).push(error.message); }
  report.ok = !failure; report.modelCalls = modelCalls; report.defaultWrites = defaultWrites;
  report.bodyCalls = bodyCalls; report.archiveCalls = archiveCalls; report.activityCalls = activityCalls; report.stopCalls = stopCalls;
  console.log(JSON.stringify(report, null, 2));
  if (failure) process.exitCode = 1;
}
