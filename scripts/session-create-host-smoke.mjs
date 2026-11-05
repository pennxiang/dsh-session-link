#!/usr/bin/env node
/** Isolated SessionController integration. DSH_RUNTIME selects installed modules;
 * no production configuration, sockets or network adapter is loaded. Session JSONL
 * and Workspace JSON persistence are real and restricted to a fresh temporary root.
 * Mocked peripheral services are explicitly enumerated in the JSON report. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createStore } from '../lib/store.js';
import { createHostAdapter } from '../lib/host-adapter.js';

if (!process.env.DSH_RUNTIME) throw new Error('Set DSH_RUNTIME to the runtime directory containing package.json and node_modules.');
const requireRuntime = createRequire(resolve(process.env.DSH_RUNTIME, 'package.json'));
const load = name => import(pathToFileURL(requireRuntime.resolve(`@deepseek-ai/${name}`)).href);
const loader = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) return { url: pathToFileURL(requireRuntime.resolve(specifier)).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const report = {
  pluginVersion: createRequire(import.meta.url)('../package.json').version,
  runtimeVersion: requireRuntime('@deepseek-ai/dsh-api-session-controller/package.json').version,
  isolation: { freshContext: true, temporaryFilesOnly: true, sessionPersistence: 'temporary-jsonl', workspacePersistence: 'temporary-json' },
  real: ['Cordis', 'SessionStore', 'AgentRegistry', 'AgentLoop', 'SessionQueryEngine', 'SessionProjectionRegistry',
    'SessionController', 'LlmRuntime validation', 'PermissionPresetService', 'WorkingDirectory', 'SessionTitle', 'ToolRuntime',
    'JSONL SessionPersistence', 'WorkspaceRegistry', 'Storage/JSON/Domain'],
  fixtures: ['preset resolver/mounter (no user presets)',
    'Typert registrations only (no transport)', 'attachments metadata and file-upload resolver',
    'remote-access allows predicate (no remote calls)', 'shell/approval configuration only (no executor)',
    'agentDefaultModel fixed selection with counted saveSelection', 'offline fake LlmAdapter metadata; stream always throws'],
  checks: [], limitations: ['No GUI/client visibility, remote transport, actual preset loader composition or cold Agent resume is tested; fresh-scope persistence reads are covered.'],
};
assert.equal(report.pluginVersion, '0.1.0');
assert.equal(report.runtimeVersion, '0.2.1-rc.5');
const tmp = await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-create-host-')));
let root, restoredRoot, creator, store, pluginFiber, adapter, mounted, reopenedStore;
const crossCwd = join(tmp, 'cross-directory');
const creatorStoreDirectory = join(tmp, 'plugin-store');
async function mountTemporaryPersistence(ctx) {
  // Namespace exports: this plugin deliberately has no default export.
  await ctx.plugin(await load('dsh-session-persistence-jsonl'), { root: join(tmp, 'sessions'), compression: 'none' });
  await ctx.plugin((await load('dsh-storage')).default);
  await ctx.plugin(await load('dsh-storage-json'), { root: join(tmp, 'workspace-storage') });
  await ctx.plugin(await load('dsh-storage-domain'), { backend: 'json', routes: {} });
  await ctx.plugin((await load('dsh-workspace')).default);
}
let saveSelectionCalls = 0, modelCalls = 0, preSteps = 0;
let failure;
const check = name => report.checks.push({ name, passed: true });
const timeout = async (promise, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10000);
  })]); } finally { clearTimeout(timer); }
};
try {
  const { Context } = await load('cordis');
  const llm = await load('dsh-llm');
  await mkdir(crossCwd);
  root = new Context();
  for (const name of ['dsh-session', 'dsh-agent', 'dsh-system-prompt']) await root.plugin((await load(name)).default);
  await mountTemporaryPersistence(root);
  await root.plugin((await load('dsh-tools')).default, { mode: 'native' });
  await root.plugin(llm.default);
  class OfflineAdapter extends llm.LlmAdapter {
    async listModels(provider) { return ['fixture-default', 'fixture-exact', 'fixture-no-reasoning'].map(id => ({ provider, id, name: id })); }
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, ...(model === 'fixture-no-reasoning' ? {} : {
        reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' }
      }) };
    }
    async *stream() { modelCalls++; throw new Error('FORBIDDEN_MODEL_CALL'); }
  }
  root.llm.registerAdapter(['fixture-provider'], new OfflineAdapter());
  await root.plugin((await load('dsh-session-projection')).default);
  await root.plugin((await load('dsh-agent-loop')).default, { agents: [], maxParallelToolCalls: 10 });
  const query = await load('dsh-session-query');
  await root.plugin(query.SessionQueryEngine ?? query.default);
  await root.plugin((await load('dsh-fs-local')).default, { cwd: tmp });
  await root.plugin((await load('dsh-working-directory')).default, { defaultDirectory: tmp });
  await root.plugin((await load('dsh-session-title')).default, { fallbackMaxWords: 8, fallbackMaxBytes: 100, maxTitleBytes: 512 });
  const provide = (name, value) => root.provide(name, value);
  provide('shell', { sandboxMode: 'read-only' });
  provide('approval', { config: { policy: 'ask' } });
  await root.plugin((await load('dsh-permission-presets')).default, {
    presets: { 'read-only': { sandbox: 'read-only', approval: 'ask' }, 'workspace-write': { sandbox: 'workspace-write', approval: 'ask' } },
    defaultPreset: 'read-only',
  });
  const defaultSelection = { provider: 'fixture-provider', model: 'fixture-default' };
  provide('agentDefaultModel', { currentSelection: () => ({ ...defaultSelection }), saveSelection: async () => { saveSelectionCalls++; } });
  provide('attachments', { imageLimits: { maxImageBytes: 1, maxImagesPerMessage: 1, maxMessageImageBytes: 1,
    maxImagePixels: 1, maxImageDimension: 1, mediaTypes: ['image/png'] } });
  provide('fileUploads', { registerAgentResolver: () => () => {} });
  provide('remoteAccess', { allows: () => true });
  const registration = () => () => {};
  provide('typert', { resources: { register: registration }, lookups: { register: registration, configure: registration },
    contexts: { registerHost: registration, configureHost: registration } });
  const presetDefinition = (await load('dsh-agent-preset-registry')).agentPresetProjectionDefinition;
  root.sessionProjections.register(presetDefinition);
  provide('agentPresets', {
    async resolve(id = 'fixture-preset-original') {
      assert.ok(['fixture-preset-original', 'fixture-preset-current'].includes(id));
      return { id };
    },
    async mount(_ctx, id) { return { id }; }, // Controller writes the selected preset into fresh Session metadata.
  });
  root.on('agent/created', ({ agent }) => {
    assert.ok([tmp, crossCwd].includes(agent.session.header.cwd), 'Every fixture stays inside an explicitly allowed temporary directory.');
    agent.ctx.on('agent/pre-step', async () => { preSteps++; return { kind: 'reject' }; });
  });
  await root.plugin((await load('dsh-api-session-controller')).default, { nativeOpen: false, listWorkSliceMs: 16 });
  assert.ok(root.sessionController);
  const callerRecord = await root.sessionController.create({ cwd: tmp, agentPreset: 'fixture-preset-original' });
  const caller = root.agents.get(callerRecord.sessionId);
  assert.ok(caller);
  assert.equal(root.workspaceRegistry.list().length, 0, 'Original cwd-only caller may remain unbound.');
  // Observe, but do not stub, the real Controller contract used by every new root.
  const controllerCreate = root.sessionController.create.bind(root.sessionController);
  const controllerRequests = [];
  root.sessionController.create = async request => {
    controllerRequests.push(structuredClone(request));
    assert.equal(Object.hasOwn(request, 'cwd'), false, 'Creator must pass workspaceId, never cwd, to Controller.create.');
    assert.equal(typeof request.workspaceId, 'string');
    return controllerCreate(request);
  };
  root.permissionPresets.set(caller.session, 'workspace-write');
  caller.session.append('agent-preset/selected', { agentPreset: 'fixture-preset-current' });
  assert.equal(root.permissionPresets.current(caller.session), 'workspace-write');
  root.sessionController.agents.selectForNextRequest(caller, { provider: 'fixture-provider', model: 'fixture-exact', reasoningEffort: 'high' });
  check('real-controller-and-permission-service-fixture-mounted');

  const { createSessionCreator } = await import('../lib/session-create.js');
  store = await createStore(creatorStoreDirectory);
  pluginFiber = await root.plugin({ name: 'isolated-session-creator-fixture', apply(ctx) {
    creator = createSessionCreator({ ctx, store, createUserMessage: llm.createUserMessage,
      controllerVersion: report.runtimeVersion, config: {} });
    ctx.effect(() => () => creator.close());
  } });
  assert.ok(creator);
  const exec = { agent: caller, signal: new AbortController().signal };
  const providers = await creator.models({}, exec);
  assert.ok(JSON.stringify(providers).includes('fixture-provider'));
  const catalog = await creator.models({ provider: 'fixture-provider' }, exec);
  assert.ok(JSON.stringify(catalog).includes('fixture-exact'));
  assert.ok(JSON.stringify(catalog).includes('high'));
  check('real-offline-llm-directory-and-reasoning-metadata');

  const initialCount = root.agents.list().length;
  for (const [label, invalid, code] of [
    ['unknown-provider', { provider: 'absent-provider', model: 'fixture-exact' }, 'PROVIDER_NOT_FOUND'],
    ['unlisted-model', { provider: 'fixture-provider', model: 'not-advertised' }, 'MODEL_NOT_FOUND'],
    ['unsupported-effort', { provider: 'fixture-provider', model: 'fixture-exact', reasoningEffort: 'impossible' }, 'UNSUPPORTED_REASONING_EFFORT'],
    ['effort-on-nonreasoning-model', { provider: 'fixture-provider', model: 'fixture-no-reasoning', reasoningEffort: 'high' }, 'UNSUPPORTED_REASONING_EFFORT'],
  ]) {
    await assert.rejects(() => creator.create({ ...invalid, requestId: `fixture-invalid-${label}` }, exec), { code });
    assert.equal(root.agents.list().length, initialCount, `${label} must fail before creating any Agent.`);
    assert.equal(root.sessions.list().length, initialCount, `${label} must fail before creating any Session.`);
  }
  check('unsupported-routes-and-efforts-reject-before-creation');
  for (const [label, handoff, code] of [
    ['exclusive', { task: 'fixture task', initialMessage: 'fixture prompt' }, 'INVALID_HANDOFF'],
    ['background-only', { context: 'fixture context without task' }, 'INVALID_HANDOFF'],
    ...['task', 'context', 'decisions', 'constraints'].map(key => [key, { task: 'fixture task', [key]: 'x'.repeat(4001) }, 'INVALID_ARGUMENT']),
    ['serialized-total', { task: 'x'.repeat(4000), context: 'y'.repeat(4000), decisions: 'z'.repeat(4000) }, 'INVALID_HANDOFF'],
  ]) {
    await assert.rejects(() => creator.create({ provider: 'fixture-provider', model: 'fixture-exact',
      requestId: `fixture-invalid-handoff-${label}`, ...handoff }, exec), { code });
    assert.equal(root.agents.list().length, initialCount);
    assert.equal(root.sessions.list().length, initialCount);
    assert.equal(root.workspaceRegistry.list().length, 0, 'Invalid handoff cannot register a workspace.');
  }
  check('structured-handoff-mutual-exclusion-field-and-serialized-limits-before-side-effects');

  const args = { provider: 'fixture-provider', model: 'fixture-exact', reasoningEffort: 'high',
    requestId: 'fixture-create-exact', title: 'Fixture exact route' };
  const created = await creator.create(args, exec);
  report.createdResult = created;
  const targetId = created.sessionId;
  const target = root.agents.get(targetId);
  assert.ok(target, 'Creator must return the exact real controller-created session id.');
  assert.ok(root.agents.roots().includes(target));
  assert.equal(target.session.header.parentSession, undefined);
  assert.equal(target.session.header.origin, undefined);
  assert.equal(root.permissionPresets.current(target.session), 'workspace-write');
  assert.equal(root.sessionProjections.stateOf(target.session, 'agentPreset'), 'fixture-preset-current');
  assert.equal(target.status, 'idle');
  assert.equal(target.inbox.nextTurn.length + target.inbox.nextStep.length, 0);
  assert.equal(preSteps, 0, 'No initial message means no turn or model invocation.');
  assert.equal(modelCalls, 0);
  check('ordinary-root-permissions-current-preset-and-no-prompt-idle');
  const sameWorkspace = root.workspaceRegistry.get(created.workspaceId);
  assert.ok(sameWorkspace);
  assert.equal(sameWorkspace.path, tmp);
  assert.ok(sameWorkspace.sessionIds.includes(targetId));
  assert.equal(root.workspaceRegistry.list().filter(workspace => workspace.sessionIds.includes(targetId)).length, 1);
  assert.ok(!sameWorkspace.sessionIds.includes(caller.id), 'Binding the new root must not silently bind its cwd-only creator.');
  assert.equal(controllerRequests[0].workspaceId, sameWorkspace.id);
  check('real-workspace-created-new-root-bound-and-readback-unique');

  const exact = { provider: 'fixture-provider', model: 'fixture-exact', reasoningEffort: 'high' };
  assert.deepEqual(root.sessionController.agents.selectionFor(target).current, exact);
  assert.deepEqual(root.sessionProjections.stateOf(target.session, 'modelSelection').pending, exact);
  const { assembleContextFor, agentEvents } = await load('dsh-agent');
  const assembly = await root.systemPrompt.assemble(assembleContextFor(target, exec.signal));
  assert.equal(assembly.variables.provider, exact.provider);
  assert.equal(assembly.variables.model, exact.model);
  const request = await agentEvents(root, target).waterfall('agent/request', { signal: exec.signal }, async () => ({
    provider: 'wrong-inherited', model: 'wrong-inherited', reasoningEffort: 'low',
  }));
  assert.deepEqual(request, exact, 'Installed controller cache must control the next actual request assembly.');
  assert.equal(saveSelectionCalls, 0);
  assert.deepEqual(root.agentDefaultModel.currentSelection(), defaultSelection);
  check('controller-cache-projection-assembly-exact-and-global-default-unchanged');

  const repeated = await creator.create(args, exec);
  assert.equal(repeated.sessionId, targetId);
  assert.equal(root.agents.list().length, initialCount + 1);
  await assert.rejects(() => creator.create({ ...args, model: 'fixture-default' }, exec));
  assert.equal(root.agents.list().length, initialCount + 1);
  check('creation-idempotency-and-conflicting-key-no-extra-root');
  const defaulted = await creator.create({ provider: 'fixture-provider', model: 'fixture-exact', requestId: 'fixture-default-effort' }, exec);
  const defaultedAgent = root.agents.get(defaulted.sessionId);
  assert.deepEqual(root.sessionController.agents.selectionFor(defaultedAgent).current,
    { provider: 'fixture-provider', model: 'fixture-exact', reasoningEffort: 'low' });
  const noReasoning = await creator.create({ provider: 'fixture-provider', model: 'fixture-no-reasoning', requestId: 'fixture-no-reasoning' }, exec);
  const plainAgent = root.agents.get(noReasoning.sessionId);
  assert.deepEqual(root.sessionController.agents.selectionFor(plainAgent).current,
    { provider: 'fixture-provider', model: 'fixture-no-reasoning' });
  await root.systemPrompt.assemble(assembleContextFor(plainAgent, exec.signal));
  const cleared = await agentEvents(root, plainAgent).waterfall('agent/request', { signal: exec.signal }, async () => ({
    provider: 'wrong-inherited', model: 'wrong-inherited', reasoningEffort: 'high',
  }));
  assert.deepEqual(cleared, { provider: 'fixture-provider', model: 'fixture-no-reasoning' });
  assert.equal(preSteps, 0);
  check('omitted-effort-uses-exact-model-default-or-clears-inherited-effort');

  adapter = createHostAdapter(root, { createUserMessage: llm.createUserMessage });
  assert.equal((await adapter.describe(targetId)).kind, 'session');
  assert.equal((await adapter.describe(targetId)).canReceive, true);
  const linked = await adapter.deliver({ senderId: caller.id, targetId, text: 'fixture explicit root link', mode: 'followup' });
  await timeout(target.whenIdle(), 'linked root idle');
  assert.equal((await adapter.receipt(targetId, linked.messageId)).state, 'claimed');
  check('created-root-supports-real-link-inbox');

  const prompted = await creator.create({ provider: 'fixture-provider', model: 'fixture-exact', reasoningEffort: 'low',
    requestId: 'fixture-create-prompt', initialMessage: 'fixture first message' }, exec);
  const promptedAgent = root.agents.get(prompted.sessionId);
  assert.ok(promptedAgent);
  await timeout(promptedAgent.whenIdle(), 'initial prompt settled');
  const events = await root.sessionQuery.readEvent({ sessionId: promptedAgent.id, seq: promptedAgent.session.seq - 1, before: 50, after: 0 });
  const inserted = events.events.filter(event => event.type === 'agent/inbox/spliced').flatMap(event => event.data.inserted);
  const first = inserted.find(message => JSON.stringify(message.content).includes('fixture first message'));
  assert.ok(first, 'Initial message uses the real Inbox.');
  assert.deepEqual(first.source, { kind: 'agent-message', form: 'relay', senderSessionId: caller.id });
  assert.equal(events.events.findLast(event => event.type === 'turn/end')?.data.reason.kind, 'blocked');
  assert.equal(modelCalls, 0);
  check('initial-message-real-relay-and-pre-step-reject-no-model');
  const afterPromptSeq = promptedAgent.session.seq;
  const afterPromptAgents = root.agents.list().length;
  const promptedReplay = await creator.create({ provider: 'fixture-provider', model: 'fixture-exact', reasoningEffort: 'low',
    requestId: 'fixture-create-prompt', initialMessage: 'fixture first message' }, exec);
  assert.equal(promptedReplay.sessionId, promptedAgent.id);
  assert.equal(promptedReplay.replayed, true);
  assert.equal(promptedAgent.session.seq, afterPromptSeq, 'Idempotent replay must not enqueue the initial message again.');
  assert.equal(root.agents.list().length, afterPromptAgents);
  check('initial-message-idempotency-neither-recreates-nor-resends');

  const sameExplicit = await creator.create({ provider: 'fixture-provider', model: 'fixture-exact',
    requestId: 'fixture-explicit-same', workspaceId: sameWorkspace.id, cwd: tmp }, exec);
  assert.equal(sameExplicit.workspaceId, sameWorkspace.id);
  assert.equal(root.agents.get(sameExplicit.sessionId).session.header.cwd, tmp);
  assert.ok(sameWorkspace.sessionIds.includes(sameExplicit.sessionId));
  const crossWorkspace = await root.workspaceRegistry.create(crossCwd, 'Fixture cross-directory');
  const beforeMismatch = root.agents.list().length;
  await assert.rejects(() => creator.create({ provider: 'fixture-provider', model: 'fixture-exact',
    requestId: 'fixture-workspace-mismatch', workspaceId: crossWorkspace.id, cwd: tmp }, exec), { code: 'WORKSPACE_CWD_MISMATCH' });
  assert.equal(root.agents.list().length, beforeMismatch);
  const crossCreated = await creator.create({ provider: 'fixture-provider', model: 'fixture-exact',
    requestId: 'fixture-explicit-cross', workspaceId: crossWorkspace.id }, exec);
  assert.equal(crossCreated.cwd, crossCwd);
  assert.equal(crossCreated.workspaceId, crossWorkspace.id);
  assert.equal(root.agents.get(crossCreated.sessionId).session.header.cwd, crossCwd);
  assert.ok(crossWorkspace.sessionIds.includes(crossCreated.sessionId));
  assert.ok(!sameWorkspace.sessionIds.includes(crossCreated.sessionId));
  assert.ok(!crossWorkspace.sessionIds.includes(target.id));
  check('explicit-same-and-cross-workspace-bindings-and-mismatch-reject');

  const handoff = { task: 'fixture structured task', context: 'fixture scoped context',
    decisions: 'fixture prior decision', constraints: 'fixture no network or model' };
  const handed = await creator.create({ provider: 'fixture-provider', model: 'fixture-exact',
    requestId: 'fixture-structured-handoff', workspaceId: crossWorkspace.id, ...handoff }, exec);
  const handoffAgent = root.agents.get(handed.sessionId);
  await timeout(handoffAgent.whenIdle(), 'structured handoff settled');
  const handoffWindow = await root.sessionQuery.readEvent({ sessionId: handed.sessionId, seq: handoffAgent.session.seq - 1, before: 50, after: 0 });
  const handoffMessage = handoffWindow.events.filter(event => event.type === 'agent/inbox/spliced')
    .flatMap(event => event.data.inserted).find(message => message.id === handed.initialMessage.messageId);
  assert.ok(handoffMessage, 'The exact handoff message must enter the real Inbox.');
  assert.deepEqual(handoffMessage.source, { kind: 'agent-message', form: 'relay', senderSessionId: caller.id });
  const envelope = JSON.parse(handoffMessage.content[0].text);
  assert.equal(envelope.senderId, caller.id);
  assert.equal(envelope.requestId, 'fixture-structured-handoff');
  const body = JSON.parse(envelope.message);
  assert.equal(body.Task, handoff.task);
  assert.equal(body.Context, handoff.context);
  assert.equal(body['Decisions (reference)'], handoff.decisions);
  assert.equal(body.Constraints, handoff.constraints);
  assert.match(body.provenance, /not copied conversation history/);
  assert.equal(handed.workspaceId, crossWorkspace.id);
  assert.ok(crossWorkspace.sessionIds.includes(handed.sessionId));
  assert.equal(handoffAgent.session.header.parentSession, undefined);
  assert.equal(handoffAgent.session.header.origin, undefined);
  assert.ok(root.agents.roots().includes(handoffAgent));
  assert.equal(modelCalls, 0);
  check('structured-handoff-real-inbox-untrusted-relay-workspace-and-ordinary-root');

  const { mount } = await import('../index.js');
  mounted = await mount(root, {}, { directory: join(tmp, 'mounted-tool-store') });
  assert.equal(mounted.toolNames.length, 9);
  const invoke = async (name, args, agent = caller) => {
    const result = await root.tools.execute({ name, arguments: args, agent, signal: exec.signal, callId: `fixture-native-${name}` });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.value.ok, true, JSON.stringify(result));
    return result.value;
  };
  const toolModels = await invoke('link_models', { provider: 'fixture-provider' });
  assert.ok(toolModels.models.some(model => model.model === 'fixture-exact'));
  const toolCreated = await invoke('link_session_create', { provider: 'fixture-provider', model: 'fixture-exact', reasoningEffort: 'high', requestId: 'fixture-native-create' });
  const toolAgent = root.agents.get(toolCreated.sessionId);
  assert.ok(toolAgent);
  assert.deepEqual(root.sessionController.agents.selectionFor(toolAgent).current, exact);
  for (const name of mounted.toolNames) assert.ok(root.tools.get(name, toolAgent), `${name} visible to the new ordinary root`);
  const callerSeqBeforeSend = caller.session.seq;
  const nativeLink = await invoke('link_send', { targetId: toolAgent.id, message: 'fixture native-tool linked root' });
  assert.equal(nativeLink.localResult.persisted, true);
  assert.equal(nativeLink.localResult.sessionId, caller.id);
  const localWindow = await root.sessionQuery.readEvent({ sessionId: caller.id, seq: nativeLink.localResult.eventSeq, before: 0, after: 0 });
  assert.equal(localWindow.target.type, 'user/message');
  assert.equal(localWindow.target.surfaceOp, 'append');
  assert.equal(localWindow.target.data.id, nativeLink.localResult.messageId);
  assert.equal(localWindow.target.data.source.kind, 'dsh-session-link-result');
  assert.equal(localWindow.target.data.source.recordKind, 'outgoing-message');
  assert.equal(localWindow.target.data.source.sessionId, caller.id);
  assert.ok(localWindow.target.data.content[0].text.includes('fixture native-tool linked root'));
  assert.equal(caller.session.seq, callerSeqBeforeSend + 1, 'Only the local notice is appended in the executing idle caller.');
  assert.equal(caller.status, 'idle', 'Recording the local notice cannot start a model turn.');
  const persistedCaller = await root.sessionPersistence.open(caller.id, 'read');
  try {
    const persisted = (await persistedCaller.read()).events.find(event => event.seq === nativeLink.localResult.eventSeq);
    assert.deepEqual(persisted, localWindow.target, 'Success must already be durable in the temporary JSONL backend.');
  } finally { await persistedCaller.close(); }
  await timeout(toolAgent.whenIdle(), 'tool-linked root idle');
  const nativeStatus = await invoke('link_status', { deliveryId: nativeLink.deliveryId });
  assert.equal(nativeStatus.delivery.receipt, 'claimed');
  await mounted.close(); mounted = undefined;
  assert.equal(root.agents.get(toolAgent.id), toolAgent, 'Unloading actual plugin tools must preserve created roots.');
  check('native-models-create-send-status-tools-and-created-root-visibility');
  check('native-send-local-user-message-notice-is-durable-without-local-turn');

  await pluginFiber.dispose(); pluginFiber = undefined;
  assert.equal(root.agents.get(targetId), target, 'Plugin unload must not dispose the Host-owned new root.');
  assert.equal(root.agents.get(promptedAgent.id), promptedAgent);
  assert.equal(saveSelectionCalls, 0);
  assert.equal(modelCalls, 0);
  check('creator-plugin-unload-preserves-host-owned-roots');

  await creator.close(); creator = undefined;
  await store.close(); store = undefined;
  reopenedStore = await createStore(creatorStoreDirectory);
  const retainedCreations = (await reopenedStore.read()).creations;
  for (const result of [created, defaulted, noReasoning, prompted, sameExplicit, crossCreated, handed]) {
    const entry = retainedCreations.find(item => item.sessionId === result.sessionId);
    assert.ok(entry);
    assert.equal(entry.senderId, caller.id, 'Creation source relation must survive plugin-store reopen.');
    assert.equal(entry.workspaceId, result.workspaceId);
    assert.equal(entry.cwd, result.cwd);
    assert.equal(entry.state, 'ready');
  }
  assert.deepEqual(retainedCreations.find(item => item.sessionId === handed.sessionId).handoff, handoff);
  await reopenedStore.close(); reopenedStore = undefined;
  for (const session of root.sessions.list()) assert.equal(await root.sessions.flush(session), true);
  restoredRoot = new Context();
  await restoredRoot.plugin((await load('dsh-session')).default);
  await mountTemporaryPersistence(restoredRoot);
  for (const result of [created, defaulted, noReasoning, prompted, sameExplicit, crossCreated, handed, toolCreated]) {
    const owners = restoredRoot.workspaceRegistry.list().filter(workspace => workspace.sessionIds.includes(result.sessionId));
    assert.equal(owners.length, 1, 'Fresh Host scope must retain unique Workspace membership.');
    assert.equal(owners[0].id, result.workspaceId);
    assert.equal(owners[0].path, result.cwd);
    const snapshot = await restoredRoot.sessionPersistence.stat(result.sessionId);
    assert.equal(snapshot.header.cwd, result.cwd);
    assert.equal(snapshot.header.origin, undefined);
    assert.equal(snapshot.header.parentSession, undefined);
  }
  const coldCaller = await restoredRoot.sessionPersistence.open(caller.id, 'read');
  try {
    const local = (await coldCaller.read()).events.find(event => event.data?.id === nativeLink.localResult.messageId);
    assert.deepEqual(local, localWindow.target, 'Fresh persistence scope must retain the exact producer-owned local result.');
  } finally { await coldCaller.close(); }
  assert.ok(!restoredRoot.workspaceRegistry.list().some(workspace => workspace.sessionIds.includes(caller.id)));
  check('reopened-ledger-source-handoff-and-fresh-host-workspace-jsonl-metadata-ownership');
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  const cleanup = [];
  if (mounted) cleanup.push(() => mounted.close());
  if (pluginFiber) cleanup.push(() => pluginFiber.dispose());
  if (creator) cleanup.push(() => creator.close());
  if (adapter) cleanup.push(() => adapter.close());
  if (store) cleanup.push(() => store.close());
  if (reopenedStore) cleanup.push(() => reopenedStore.close());
  if (restoredRoot) cleanup.push(() => restoredRoot.fiber.dispose());
  if (root) cleanup.push(() => root.fiber.dispose());
  for (const dispose of cleanup) try { await timeout(Promise.resolve().then(dispose), 'cleanup'); } catch (error) {
    failure ??= error; (report.cleanupErrors ??= []).push(error.message);
  }
  loader.deregister();
  await rm(tmp, { recursive: true, force: true });
  report.ok = !failure;
  report.modelCalls = modelCalls;
  report.preSteps = preSteps;
  report.saveSelectionCalls = saveSelectionCalls;
  console.log(JSON.stringify(report, null, 2));
  if (failure) process.exitCode = 1;
}
