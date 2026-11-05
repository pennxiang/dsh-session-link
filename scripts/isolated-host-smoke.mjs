#!/usr/bin/env node
/** Isolated rc.5 contract smoke. No installed plugin graph, user logs or network adapters.
 * DSH_RUNTIME must point to a DSH runtime directory containing package.json/node_modules.
 * Only this process's fresh Context and temporary directory can receive messages.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHostAdapter } from '../lib/host-adapter.js';
import { createStore } from '../lib/store.js';

const runtime = process.env.DSH_RUNTIME;
if (!runtime) throw new Error('Set DSH_RUNTIME to the runtime directory containing package.json and node_modules.');
const requireRuntime = createRequire(resolve(runtime, 'package.json'));
const load = name => import(pathToFileURL(requireRuntime.resolve(`@deepseek-ai/${name}`)).href);
// Resolve the local plugin's bare host dependencies against the explicitly selected
// runtime, without installing/mounting the user's Cordis configuration or plugins.
const loader = registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) return { url: pathToFileURL(requireRuntime.resolve(specifier)).href, shortCircuit: true };
  return nextResolve(specifier, context);
} });
const report = { pluginVersion: createRequire(import.meta.url)('../package.json').version, runtimeVersion: requireRuntime('@deepseek-ai/dsh-subagent/package.json').version,
  isolation: { freshContext: true, temporaryFilesOnly: true, sessionPersistence: 'temporary-jsonl', registeredLlmProviders: 0 },
  checks: [], matrix: [], limitations: [] };
assert.equal(report.pluginVersion, '0.1.0');
assert.equal(report.runtimeVersion, '0.2.1-rc.5', 'This smoke asserts only the audited rc.5 contract.');
const tmp = await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-link-host-')));
const handles = [];
const activations = [];
const gates = new Map();
let root, restoredRoot, host, mounted;
let preSteps = 0;
let llmCalls = 0;
let failure;
const timeout = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10000);
    })]);
  } finally { clearTimeout(timer); }
};
const check = (name, data = {}) => report.checks.push({ name, passed: true, ...data });
const pending = agent => [...agent.inbox.nextTurn, ...agent.inbox.nextStep];
function hold(id) {
  let release, enter;
  const promise = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = { promise, release, entered, enter };
  gates.set(id, gate);
  return { entered, release() { gates.delete(id); release(); } };
}
try {
  const { Context } = await load('cordis');
  const llm = await load('dsh-llm');
  const carrier = await load('dsh-subagent/internal');
  root = new Context();
  for (const name of ['dsh-session', 'dsh-agent', 'dsh-system-prompt']) await root.plugin((await load(name)).default);
  // Namespace export, never .default; the backend only sees this temporary root.
  await root.plugin(await load('dsh-session-persistence-jsonl'), { root: join(tmp, 'sessions'), compression: 'none' });
  await root.plugin((await load('dsh-tools')).default, { mode: 'native' });
  await root.plugin(llm.default);
  // No providers are registered. This tripwire is in addition to rejecting every
  // proposed step; unexpected calls fail immediately and can never reach a model.
  root.llm.prepareCall = async () => { llmCalls++; throw new Error('FORBIDDEN_LLM_CALL'); };
  root.llm.stream = () => { llmCalls++; throw new Error('FORBIDDEN_LLM_CALL'); };
  await root.plugin((await load('dsh-session-projection')).default);
  await root.plugin((await load('dsh-agent-loop')).default, { agents: [], maxParallelToolCalls: 10 });
  const queryModule = await load('dsh-session-query');
  await root.plugin(queryModule.SessionQueryEngine ?? queryModule.default);
  await root.plugin((await load('dsh-fs-local')).default, { cwd: tmp });
  await root.plugin((await load('dsh-working-directory')).default, { defaultDirectory: tmp });
  await root.plugin((await load('dsh-subagent')).default);
  await root.plugin(await load('dsh-subagent-spawn-in-process'), { providerName: 'spawn' });
  root.on('agent/created', ({ agent }) => {
    assert.ok(agent.id.startsWith('fixture-'), 'Only fixture agents may be created.');
    assert.equal(agent.session.header.cwd, tmp);
    agent.ctx.on('agent/pre-step', async ({ signal }) => {
      preSteps++;
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
  async function create(id, kind = 'session', parent) {
    const h = await root.agents.create({ sessionId: id, meta: { cwd: tmp,
      ...(kind === 'sidechat' ? { origin: 'subagent', parentSession: parent.id } : {}) },
      setup: kind === 'sidechat' ? (_ctx, agent) => {
        agent.session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'sidechat', label: 'fixture sidechat' });
      } : undefined });
    handles.push(h);
    return h.agent;
  }
  const ordinary = [await create('fixture-session-a'), await create('fixture-session-b')];
  const sidechat = [await create('fixture-sidechat-a', 'sidechat', ordinary[0]), await create('fixture-sidechat-b', 'sidechat', ordinary[0])];
  host = createHostAdapter(root, { createUserMessage: llm.createUserMessage,
    subagentVersion: report.runtimeVersion, queueHostSubagentPrompt: carrier.queueHostSubagentPrompt,
    steerHostSubagentPrompt: carrier.steerHostSubagentPrompt });
  assert.equal((await host.describe(sidechat[0].id)).kind, 'sidechat');
  assert.equal((await host.describe(ordinary[0].id)).kind, 'session');
  check('real-session-query-and-subagent-projection-classification');

  async function delivery(sender, target, mode) {
    const text = `fixture ${sender.id} -> ${target.id} (${mode})`;
    const accepted = await host.deliver({ senderId: sender.id, targetId: target.id, text, mode });
    // For waking messages the native inbox may already have claimed before the
    // Promise returns. Read only the isolated SessionQuery snapshot to find it.
    const source = { kind: 'agent-message', form: 'relay', senderSessionId: sender.id };
    const window = await root.sessionQuery.readEvent({ sessionId: target.id, seq: target.session.seq - 1, before: 50, after: 0 });
    const inserted = window.events.filter(e => e.type === 'agent/inbox/spliced').flatMap(e => e.data.inserted);
    const recorded = inserted.find(message => message.id === accepted.messageId);
    assert.ok(recorded, 'Accepted id appears in the real native inbox insertion event.');
    assert.deepEqual(recorded.source, source, 'That exact message preserves the actual relay sender.');
    assert.deepEqual(recorded.content, [{ type: 'text', text }]);
    if (gates.has(target.id)) {
      assert.ok(pending(target).some(m => m.id === accepted.messageId), 'Held target retains the exact accepted message.');
      assert.equal((await host.receipt(target.id, accepted.messageId)).state, 'pending');
    }
    if (mode === 'inject') {
      assert.ok(pending(target).some(m => m.id === accepted.messageId));
      assert.equal(target.status, 'running');
      assert.equal((await host.receipt(target.id, accepted.messageId)).state, 'pending');
    } else if (!gates.has(target.id)) {
      await timeout(target.whenIdle(), target.id);
      assert.equal((await host.receipt(target.id, accepted.messageId)).state, 'claimed');
      const settled = await root.sessionQuery.readEvent({ sessionId: target.id, seq: target.session.seq - 1, before: 10, after: 0 });
      const end = settled.events.findLast(event => event.type === 'turn/end');
      assert.equal(end?.data.reason.kind, 'blocked', 'A real pre-step rejection, not a provider error, settled the wake.');
    }
    return accepted;
  }
  // First prove native queues for ordinary and sidechat kinds before attempting
  // any managed child. Same-kind cells use distinct agents, never self-send.
  const initialKinds = { session: ordinary, sidechat };
  for (const [from, senders] of Object.entries(initialKinds)) for (const [to, targets] of Object.entries(initialKinds)) {
    const target = from === to ? targets[1] : targets[0];
    assert.equal(target.status, 'idle');
    const beforeRejectedInject = target.session.seq;
    await assert.rejects(() => host.deliver({ senderId: senders[0].id, targetId: target.id,
      text: 'fixture idle injection must not queue', mode: 'inject' }), { code: 'TARGET_NOT_RUNNING' });
    assert.equal(target.session.seq, beforeRejectedInject, 'Rejected idle inject must not mutate the native session.');
    const gate = hold(target.id);
    target.followup(llm.createUserMessage({ content: [{ type: 'text', text: 'fixture pre-step gate seed' }], source: { kind: 'user' } }));
    await timeout(gate.entered, `pre-step entered ${target.id}`);
    assert.equal(target.status, 'running');
    const a = await delivery(senders[0], target, 'inject');
    const b = await delivery(senders[0], target, 'auto');
    assert.equal(b.mode, 'steer');
    gate.release();
    await timeout(target.whenIdle(), `running matrix settled ${target.id}`);
    // A blocked pre-step closes the seed turn without consuming its later
    // next-step inputs. Verify that preservation, then wake the real native
    // driver again and require exact claims rather than treating acceptance as
    // consumption or allowing a pending receipt to satisfy the final assertion.
    assert.equal((await host.receipt(target.id, a.messageId)).state, 'pending');
    assert.equal((await host.receipt(target.id, b.messageId)).state, 'pending');
    const idleWake = await delivery(senders[0], target, 'auto');
    assert.equal(idleWake.mode, 'followup');
    assert.equal((await host.receipt(target.id, a.messageId)).state, 'claimed');
    assert.equal((await host.receipt(target.id, b.messageId)).state, 'claimed');
    assert.equal(pending(target).length, 0);
    report.matrix.push({ phase: 'ordinary-sidechat', from, to, modes: ['idle-inject-rejected', 'running-inject', 'running-auto/steer', 'idle-auto/followup'], passed: true });
  }
  check('ordinary-sidechat-real-inbox-2x2');

  // Caller-delivery activations are genuinely owned by SubagentManager, but do
  // not auto-notify the parent. This smoke mounts real temporary JSONL for local results.
  const children = [];
  for (const suffix of ['a', 'b']) {
    const id = `fixture-child-${suffix}`;
    const gate = hold(id);
    const activation = await root.subagents.startActivation({ provider: 'spawn', childId: id, label: id,
      request: { parent: ordinary[0], prompt: [{ type: 'text', text: 'fixture initial prompt' }] },
      signal: new AbortController().signal, delivery: 'caller' });
    activations.push(activation);
    activation.result.catch(() => {});
    await timeout(gate.entered, `managed pre-step entered ${id}`);
    const child = root.agents.get(id);
    assert.ok(child, 'Manager publishes a real live Agent.');
    assert.equal((await host.describe(id)).kind, 'subagent');
    assert.equal((await host.describe(id)).canReceive, true);
    children.push(child);
  }
  const kinds = { session: ordinary, sidechat, subagent: children };
  for (const [from, senders] of Object.entries(kinds)) for (const [to, targets] of Object.entries(kinds)) {
    const target = from === to ? targets[1] : targets[0];
    const a = await delivery(senders[0], target, 'auto');
    assert.equal(a.mode, to === 'subagent' ? 'steer' : 'followup');
    report.matrix.push({ phase: 'managed-live-3x3', from, to, mode: a.mode, passed: true });
  }
  check('managed-child-official-internal-carrier-3x3');
  await assert.rejects(() => host.deliver({ senderId: ordinary[0].id, targetId: children[0].id, text: 'fixture', mode: 'inject' }), { code: 'MODE_UNSUPPORTED' });
  check('managed-child-inject-rejected');
  const queuedChild = await delivery(sidechat[0], children[0], 'followup');
  assert.equal(queuedChild.mode, 'followup');
  assert.ok(children[0].inbox.nextTurn.some(message => message.id === queuedChild.messageId));
  check('managed-child-official-queue-carrier');

  const { mount } = await import('../index.js');
  const durableResults = [];
  async function assertLocalResult(value, agent, kind, body) {
    assert.equal(value.persisted, true);
    assert.equal(value.sessionId, agent.id);
    const window = await root.sessionQuery.readEvent({ sessionId: agent.id, seq: value.eventSeq, before: 0, after: 0 });
    const event = window.target;
    assert.equal(event.type, 'user/message');
    assert.equal(event.surfaceOp, 'append');
    assert.equal(event.data.id, value.messageId);
    assert.equal(event.data.role, 'user');
    assert.equal(event.data.source.kind, 'dsh-session-link-result');
    assert.equal(event.data.source.form, 'notice');
    assert.equal(event.data.source.sessionId, agent.id);
    assert.equal(event.data.source.recordKind, kind);
    assert.ok(event.data.content[0].text.endsWith(`\n\n${body}`), 'Local notice must contain the substantive result, not only an acknowledgement.');
    const handle = await root.sessionPersistence.open(agent.id, 'read');
    try {
      assert.deepEqual((await handle.read()).events.find(item => item.seq === event.seq), event,
        'The exact notice must already be durable, without an extra test flush.');
    } finally { await handle.close(); }
    durableResults.push({ agentId: agent.id, event });
    return event;
  }
  let localBeforeRemoteChecks = 0;
  let localBeforeTaskCompletionChecks = 0;
  mounted = await mount(root, {}, { directory: join(tmp, 'plugin-store'), async createStore(directory) {
    const realStore = await createStore(directory);
    return { ...realStore, mutate(fn) {
      return realStore.mutate(async draft => {
        const completedBefore = new Set(draft.tasks.filter(task => task.status === 'completed').map(task => task.id));
        const result = await fn(draft);
        for (const task of draft.tasks.filter(task => task.status === 'completed' && !completedBefore.has(task.id))) {
          const record = draft.resultRecords.find(entry => entry.kind === 'task-result'
            && entry.relatedIds.taskId === task.id && entry.relatedIds.revision === task.revision);
          assert.ok(record, 'Task completion commit requires its local result ledger entry first.');
          assert.equal(record.state, 'persisted');
          assert.equal(record.sessionId, task.assigneeId);
          const handle = await root.sessionPersistence.open(record.sessionId, 'read');
          try {
            const event = (await handle.read()).events.find(event => event.seq === record.eventSeq);
            assert.equal(event.type, 'user/message');
            assert.equal(event.data.id, record.messageId);
            assert.equal(event.data.source.kind, 'dsh-session-link-result');
            assert.equal(event.data.source.recordKind, 'task-result');
            assert.ok(event.data.content[0].text.endsWith(`\n\n${task.result}`));
          } finally { await handle.close(); }
          localBeforeTaskCompletionChecks++;
        }
        return result;
      });
    } };
  }, createHostAdapter(ctx, options) {
    const realHost = createHostAdapter(ctx, options);
    const deliver = realHost.deliver.bind(realHost);
    // Observation only: run the real adapter after checking its exact sender's
    // already-flushed notice through the real temporary persistence API.
    realHost.deliver = async input => {
      const envelope = JSON.parse(input.text);
      const handle = await ctx.sessionPersistence.open(input.senderId, 'read').catch(error => {
        (report.persistenceObservationErrors ??= []).push({ senderId: input.senderId, message: error.message, cause: error.cause?.message, stack: error.stack });
        throw error;
      });
      try {
        const records = (await handle.read()).events.filter(event => event.type === 'user/message'
          && event.data.source?.kind === 'dsh-session-link-result'
          && event.data.source.relatedIds?.deliveryId === envelope.deliveryId);
        assert.equal(records.length, 1, 'Remote admission must follow exactly one durable local record.');
        assert.equal(records[0].data.source.sessionId, input.senderId);
        assert.equal(records[0].data.source.recordKind, 'outgoing-message');
        assert.ok(records[0].data.content[0].text.endsWith(`\n\n${envelope.message}`));
      } catch (error) {
        (report.persistenceObservationErrors ??= []).push({ senderId: input.senderId, message: error.message, stack: error.stack });
        throw error;
      } finally { await handle.close(); }
      localBeforeRemoteChecks++;
      return deliver(input);
    };
    return realHost;
  } });
  assert.equal(mounted.toolNames.length, 9);
  for (const agents of Object.values(kinds)) for (const agent of agents) for (const name of mounted.toolNames)
    assert.ok(root.tools.get(name, agent), `${name} visible in ${agent.id}`);
  const outcome = await root.tools.execute({ name: 'link_sessions', arguments: {}, agent: ordinary[0], callId: 'fixture-tool-call', signal: new AbortController().signal });
  assert.equal(outcome.isError, false, JSON.stringify(outcome));
  assert.equal(outcome.value.ok, true);
  assert.ok(JSON.stringify(outcome).includes('fixture-sidechat-a'));
  const sent = await root.tools.execute({ name: 'link_send', arguments: { targetId: children[0].id, message: 'fixture service-to-managed delivery', requestId: 'fixture-idempotency' },
    agent: sidechat[0], callId: 'fixture-send-tool-call', signal: new AbortController().signal });
  assert.equal(sent.isError, false, JSON.stringify(sent));
  assert.equal(sent.value.ok, true, JSON.stringify(sent));
  assert.equal(sent.value.transport, 'accepted');
  assert.equal(sent.value.receipt, 'unknown', 'Acceptance alone does not establish an observed inbox receipt.');
  const sentMessage = pending(children[0]).find(message => message.id === sent.value.hostMessageId);
  assert.ok(sentMessage);
  assert.deepEqual(sentMessage.source, { kind: 'agent-message', form: 'relay', senderSessionId: sidechat[0].id });
  assert.ok(JSON.stringify(sentMessage.content).includes('fixture service-to-managed delivery'));
  check('real-plugin-mount-nine-tools-and-tool-runtime-execution');
  check('real-tool-service-managed-queue-and-authoritative-peer-source');
  await assertLocalResult(sent.value.localResult, sidechat[0], 'outgoing-message', 'fixture service-to-managed delivery');
  assert.equal(localBeforeRemoteChecks, 1);
  check('local-result-user-message-jsonl-durable-before-real-remote-admission');

  // Declared visible fixture content is read through the real query engine, not
  // via user files. Private reasoning and tool arguments must never leak.
  // The visible-content fixture must also satisfy JSONL's released lifecycle
  // codec: an assistant message belongs to a balanced explicit turn/step, not
  // an out-of-turn append. No model is run to author this declared fixture.
  const prior = await root.sessionQuery.readEvent({ sessionId: ordinary[1].id,
    seq: ordinary[1].session.seq - 1, before: 50, after: 0 });
  const fixtureTurn = prior.events.findLast(event => event.type === 'turn/end').data.turn + 1;
  const fixtureStep = 1;
  ordinary[1].session.append('turn/start', { turn: fixtureTurn });
  ordinary[1].session.append('step/start', { turn: fixtureTurn, step: fixtureStep });
  ordinary[1].session.append('assistant/message', { turn: fixtureTurn, step: fixtureStep, stream: [], message: llm.createAssistantMessage({
    source: { provider: 'fixture', model: 'fixture' }, content: [
      { type: 'text', text: 'fixture visible text' }, { type: 'reasoning', text: 'PRIVATE_FIXTURE_REASONING' }] }) }, { surfaceOp: 'append' });
  ordinary[1].session.append('step/end', { turn: fixtureTurn, step: fixtureStep });
  ordinary[1].session.append('turn/end', { turn: fixtureTurn, reason: { kind: 'completed' } });
  const activity = await host.activity(ordinary[1].id, { maxChars: 512, limit: 2 });
  assert.ok(JSON.stringify(activity.events).includes('fixture visible text'));
  assert.ok(!JSON.stringify(activity).includes('PRIVATE_FIXTURE_REASONING'));
  assert.ok(JSON.stringify(activity.events).length <= 512);
  check('real-query-bounded-visible-activity');
  let toolCall = 0;
  async function invoke(name, args, agent = ordinary[0]) {
    const result = await root.tools.execute({ name, arguments: args, agent,
      callId: `fixture-extra-tool-${++toolCall}`, signal: new AbortController().signal });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(result.value.ok, true, JSON.stringify(result));
    return result.value;
  }
  const status = await invoke('link_status', { deliveryId: sent.value.deliveryId }, sidechat[0]);
  assert.equal(status.delivery.receipt, 'pending');
  const visibleActivity = await invoke('link_activity', { targetId: ordinary[1].id, maxChars: 512 });
  assert.ok(JSON.stringify(visibleActivity.events).includes('fixture visible text'));
  assert.ok(!JSON.stringify(visibleActivity).includes('PRIVATE_FIXTURE_REASONING'));
  const reception = await invoke('link_reception', { enabled: false }, sidechat[1]);
  assert.equal(reception.enabled, false);
  await invoke('link_reception', { enabled: true }, sidechat[1]);
  const offer = await invoke('link_task', { action: 'create', targetId: children[1].id, title: 'fixture assignment', instructions: 'fixture task, no execution requested' });
  assert.equal(offer.task.status, 'offered');
  const completed = await invoke('link_task', { action: 'update', taskId: offer.task.id, revision: offer.task.revision,
    status: 'completed', result: 'fixture self-reported result' }, children[1]);
  assert.equal(completed.task.status, 'completed');
  assert.equal(completed.verification, 'self-reported');
  assert.equal(localBeforeTaskCompletionChecks, 1, 'Task completed state cannot commit before the exact native local result is durable.');
  check('six-original-tools-execute-through-real-tool-runtime');
  const completionEvent = await assertLocalResult(completed.localResult, children[1], 'task-result', 'fixture self-reported result');
  assert.equal(completionEvent.data.source.relatedIds.taskId, offer.task.id);
  assert.equal(completionEvent.data.source.relatedIds.ownerId, ordinary[0].id);
  assert.equal(completionEvent.data.source.relatedIds.revision, completed.task.revision);
  const independent = await invoke('link_send', { targetId: ordinary[0].id,
    message: 'fixture independently owned second result', requestId: 'fixture-independent-source' }, ordinary[1]);
  await timeout(ordinary[0].whenIdle(), 'independent peer idle');
  await assertLocalResult(independent.localResult, ordinary[1], 'outgoing-message', 'fixture independently owned second result');
  for (const agent of [sidechat[0], children[1], ordinary[1], ordinary[0]]) {
    assert.equal(await root.sessions.flush(agent.session), true);
    const handle = await root.sessionPersistence.open(agent.id, 'read');
    try {
      const notices = (await handle.read()).events.filter(event => event.type === 'user/message'
        && event.data.source?.kind === 'dsh-session-link-result');
      for (const notice of notices) assert.equal(notice.data.source.sessionId, agent.id, 'Producer-owned local source must never cross-write to another session.');
      for (const result of durableResults) assert.equal(notices.filter(event => event.data.id === result.event.data.id).length,
        result.agentId === agent.id ? 1 : 0, 'Exact local notice identity occurs once only in its executing session.');
    } finally { await handle.close(); }
  }
  assert.equal(localBeforeRemoteChecks, 3, 'Send, task offer, and independent send all checkpoint before real remote admission.');
  assert.equal(llmCalls, 0);
  check('completed-task-substantive-local-result-and-independent-session-no-cross-writes');

  restoredRoot = new Context();
  await restoredRoot.plugin((await load('dsh-session')).default);
  await restoredRoot.plugin(await load('dsh-session-persistence-jsonl'), { root: join(tmp, 'sessions'), compression: 'none' });
  for (const result of durableResults) {
    const handle = await restoredRoot.sessionPersistence.open(result.agentId, 'read');
    try {
      assert.deepEqual((await handle.read()).events.find(event => event.data?.id === result.event.data.id), result.event);
    } finally { await handle.close(); }
  }
  check('fresh-persistence-scope-exact-native-local-result-readback');

  // Dispose exact managed activations. Aborted held steps cannot call a model.
  for (const activation of activations) await timeout(activation.dispose(), 'managed activation dispose');
  assert.equal(root.agents.get(children[0].id), undefined);
  await assert.rejects(() => host.deliver({ senderId: ordinary[0].id, targetId: children[0].id, text: 'must not resurrect' }), { code: 'TARGET_NOT_LIVE' });
  assert.equal(root.agents.get(children[0].id), undefined);
  check('disposed-managed-child-not-resurrected');
  await mounted.close(); mounted = undefined;
  for (const name of ['link_sessions', 'link_send', 'link_status', 'link_activity', 'link_task', 'link_reception', 'link_models', 'link_session_create', 'link_session_archive']) assert.equal(root.tools.get(name, ordinary[0]), undefined);
  check('plugin-unload-removes-all-nine-tools');
  assert.ok(preSteps > 0);
  assert.equal(llmCalls, 0);
  check('zero-model-calls', { preSteps, llmCalls });
  report.limitations.push('Sidechat uses a real root Agent with an authoritative fixture sidechat descriptor; the separate Better Sidebar plugin is not mounted.',
    'Managed children use caller-delivery activations held at pre-step; no cold Agent resume, structured-finalization or closing-race success claim is made.',
    'Native user/message and fresh temporary JSONL readback are tested; actual client Conversation rendering/visibility requires separate browser verification.');
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  for (const gate of gates.values()) gate.release();
  gates.clear();
  const cleanup = [];
  if (mounted) cleanup.push(() => mounted.close());
  if (host) cleanup.push(() => host.close());
  for (const activation of [...activations].reverse()) cleanup.push(() => activation.dispose());
  for (const handle of [...handles].reverse()) cleanup.push(() => handle.dispose());
  if (restoredRoot) cleanup.push(() => restoredRoot.fiber.dispose());
  if (root) cleanup.push(() => root.fiber.dispose());
  for (const dispose of cleanup) try { await timeout(Promise.resolve().then(dispose), 'cleanup'); } catch (error) {
    report.cleanupErrors ??= []; report.cleanupErrors.push(error.message); failure ??= error;
  }
  loader.deregister();
  await rm(tmp, { recursive: true, force: true });
  report.ok = !failure;
  report.llmCalls = llmCalls;
  console.log(JSON.stringify(report, null, 2));
  if (failure) process.exitCode = 1;
}
