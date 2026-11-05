import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../lib/service.js';
import { createStore } from '../lib/store.js';

async function fixture(t, config = {}, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'session-link-service-'));
  const store = await createStore(directory);
  const sessions = new Map();
  for (const [index, kind] of ['session', 'sidechat', 'subagent'].entries()) {
    for (const suffix of ['a', 'b']) {
      const id = `${index}-${suffix}`;
      sessions.set(id, { id, title: `${kind} ${suffix}`, kind, cwd: '/same', status: 'idle', live: true, canReceive: true });
    }
  }
  const calls = [];
  const activityCalls = [];
  let clock = 100000;
  let serial = 0;
  let failDelivery;
  let receipt = 'pending';
  let events = [];
  const host = {
    async describe(id) {
      if (!sessions.has(id)) throw Object.assign(new Error('not found'), { code: 'SESSION_NOT_FOUND' });
      return structuredClone(sessions.get(id));
    },
    async list({ limit, includeCold, excludeIds = [], cwd }) {
      assert.equal(includeCold, false);
      const all = [...sessions.values()].filter(item => !excludeIds.includes(item.id) && (cwd === undefined || item.cwd === cwd));
      return { sessions: structuredClone(all.slice(0, limit)), truncated: all.length > limit };
    },
    async deliver(input) {
      calls.push(input);
      if (failDelivery) throw failDelivery;
      return { messageId: `host-${calls.length}`, mode: input.mode === 'auto' ? (sessions.get(input.targetId).status === 'running' ? 'steer' : 'followup') : input.mode, targetStatus: sessions.get(input.targetId).status };
    },
    async receipt() { return { state: receipt }; },
    async activity(id, options) { activityCalls.push(options); return { session: await host.describe(id), events, truncated: false }; },
  };
  const service = createService({ host, store, now: () => clock, uuid: () => `id-${++serial}`, config, ...extra });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    store, service, host, sessions, calls, activityCalls, directory,
    as: async (id, name, args, signal) => {
      const result = await service.execute(name, args, { agent: { id }, signal });
      assert.deepEqual(result, JSON.parse(JSON.stringify(result)), 'Every successful tool result must be lossless JSON');
      return result;
    },
    tick: amount => { clock += amount; },
    fail: value => { failDelivery = value; },
    receipt: value => { receipt = value; },
    events: value => { events = value; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function within(promise, milliseconds = 100) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('controlled metadata test deadline exceeded')), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

test('discovery limit counts accessible peers rather than self and other directories', async t => {
  const f = await fixture(t, { sameDirectoryOnly: true });
  f.sessions.get('0-b').cwd = '/elsewhere';
  const result = await f.as('0-a', 'link_sessions', { limit: 1 });
  assert.deepEqual(result.sessions.map(item => item.id), ['1-a']);
  assert.equal(result.self.id, '0-a');
});

test('a held catalog cannot block unrelated service discovery or reception writes', async t => {
  const held = deferred();
  const entered = deferred();
  const creator = { models() { entered.resolve(); return held.promise; }, async close() {} };
  const f = await fixture(t, {}, { sessionCreator: creator });
  const modelCall = f.as('0-a', 'link_models', {}).catch(cause => cause);
  await entered.promise;
  try {
    const discovery = await within(f.as('0-a', 'link_sessions', { limit: 1 }));
    assert.equal(discovery.sessions.length, 1);
    assert.equal((await within(f.as('0-a', 'link_reception', { enabled: false }))).enabled, false);
  } finally { held.resolve({ providers: [] }); await modelCall; }
});

test('service close settles held read wrappers without waiting for provider completion', async t => {
  const held = deferred();
  const entered = deferred();
  const creator = { models() { entered.resolve(); return held.promise; }, async close() {} };
  const f = await fixture(t, {}, { sessionCreator: creator });
  const modelCall = f.as('0-a', 'link_models', {}).catch(cause => cause);
  await entered.promise;
  try {
    await within(f.service.close());
    assert.equal((await modelCall).code, 'READ_SCOPE_CLOSED');
  } finally { held.resolve({ providers: [] }); await modelCall; }
});

test('catalog timeout and caller cancellation do not poison subsequent writes', async t => {
  const held = deferred();
  const entered = deferred();
  const creator = { models() { entered.resolve(); return held.promise; }, async close() {} };
  const f = await fixture(t, {}, { sessionCreator: creator, metadataTimeoutMs: 100 });
  const timeoutCall = f.as('0-a', 'link_models', {});
  await within(assert.rejects(timeoutCall, { code: 'METADATA_TIMEOUT' }), 500);
  const controller = new AbortController();
  const cancelled = f.as('0-a', 'link_models', {}, controller.signal);
  const cancelledResult = assert.rejects(cancelled, { code: 'ABORTED' });
  controller.abort();
  await cancelledResult;
  assert.equal((await f.as('0-a', 'link_reception', { enabled: true })).enabled, true);
  held.reject(new Error('late catalog failure is observed'));
  await new Promise(resolve => setImmediate(resolve));
});

test('close drains an admitted queued create before closing its creator dependency', async t => {
  const heldDelivery = deferred();
  const entered = deferred();
  const order = [];
  let creatorClosed = false;
  const creator = {
    async create() {
      assert.equal(creatorClosed, false, 'admitted create must still have an open dependency');
      order.push('create');
      return { state: 'ready', sessionId: 'created-before-close' };
    },
    async close() { creatorClosed = true; order.push('creator-close'); },
  };
  const f = await fixture(t, {}, { sessionCreator: creator });
  f.host.deliver = () => { entered.resolve(); return heldDelivery.promise; };
  const sending = f.as('0-a', 'link_send', { targetId: '1-a', message: 'held native admission' });
  await entered.promise;
  const queued = f.as('0-a', 'link_session_create', {});
  const closed = f.service.close();
  await assert.rejects(f.as('0-a', 'link_reception', { enabled: false }), { code: 'SERVICE_CLOSED' });
  heldDelivery.resolve({ messageId: 'host-accepted', mode: 'followup' });
  assert.equal((await sending).transport, 'accepted');
  assert.equal((await queued).state, 'ready');
  await closed;
  assert.deepEqual(order, ['create', 'creator-close']);
});

test('close does not race or abandon a side-effecting native delivery', async t => {
  const f = await fixture(t);
  const entered = deferred();
  const admission = deferred();
  f.host.deliver = () => { entered.resolve(); return admission.promise; };
  const sending = f.as('0-a', 'link_send', { targetId: '1-a', message: 'side effect remains owned' });
  await entered.promise;
  let closed = false;
  const closing = f.service.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(closed, false, 'only metadata may be abandoned, not actual admission');
  admission.resolve({ messageId: 'native-accepted', mode: 'followup' });
  assert.equal((await sending).transport, 'accepted');
  await closing;
});

function localReceipt(input) {
  return { recordId: input.recordId, sessionId: input.agent.id, messageId: `local-${input.recordId}`, eventSeq: 1, localState: 'persisted', persisted: true };
}

test('send durably records substantive local content after intent and before remote admission', async t => {
  const order = [];
  let f;
  const recorder = {
    async record(input) {
      const state = await f.store.read();
      assert.equal(state.deliveries[0].state, 'sending');
      assert.equal(input.recordId, `send:${state.deliveries[0].id}`);
      assert.equal(input.kind, 'outgoing-message');
      assert.equal(input.title, '发送内容');
      assert.equal(input.text, 'the actual answer');
      assert.equal(input.agent.id, '0-a');
      order.push('local-persisted');
      return localReceipt(input);
    },
    async close() {},
  };
  f = await fixture(t, {}, { resultDelivery: recorder });
  const deliver = f.host.deliver;
  f.host.deliver = async input => { order.push('remote'); return deliver(input); };
  const sent = await f.as('0-a', 'link_send', { targetId: '1-a', message: 'the actual answer', requestId: 'with-local' });
  assert.deepEqual(order, ['local-persisted', 'remote']);
  assert.equal(sent.localResult.persisted, true);
  assert.equal(sent.remoteAttempted, true);
  assert.equal(sent.receipt, 'unknown');
  await f.as('0-a', 'link_send', { targetId: '1-a', message: 'the actual answer', requestId: 'with-local' });
  assert.deepEqual(order, ['local-persisted', 'remote'], 'idempotent replay neither appends nor sends');
});

test('local result failure never sends remotely and unknown local evidence cannot be evicted', async t => {
  for (const localState of ['not-written', 'unknown', 'appended']) {
    let attempts = 0;
    const recorder = { async record() { attempts++; throw Object.assign(new Error('local flush unavailable'), { code: 'LOCAL_RESULT_FLUSH_FAILED', localState }); }, async close() {} };
    const f = await fixture(t, { recentDeliveries: 1 }, { resultDelivery: recorder });
    const args = { targetId: '1-a', message: 'not remotely sent', requestId: 'local-failure' };
    await assert.rejects(f.as('0-a', 'link_send', args), { code: 'LOCAL_RESULT_FLUSH_FAILED', localState, remoteAttempted: false, transport: 'failed', stage: 'local-result' });
    assert.equal(f.calls.length, 0);
    const replay = await f.as('0-a', 'link_send', args);
    assert.equal(replay.transport, 'failed');
    assert.equal(replay.localResultState, localState);
    assert.equal(replay.remoteAttempted, false);
    assert.equal(attempts, 1);
    if (localState !== 'not-written') await assert.rejects(f.as('0-a', 'link_send', { ...args, requestId: 'another' }), { code: 'DELIVERY_CAPACITY' });
  }
});

test('task completion flushes local result first; local failure leaves task revision and status unchanged', async t => {
  const records = [];
  let failTaskResult = true;
  const recorder = {
    async record(input) {
      records.push(input);
      if (input.kind === 'task-result' && failTaskResult) throw Object.assign(new Error('flush failed'), { code: 'LOCAL_RESULT_FLUSH_FAILED', localState: 'appended' });
      return localReceipt(input);
    },
    async close() {},
  };
  const f = await fixture(t, {}, { resultDelivery: recorder });
  const { task } = await f.as('0-a', 'link_task', { action: 'create', targetId: '1-a', title: 'work', instructions: 'work' });
  const update = { action: 'update', taskId: task.id, revision: 1, status: 'completed', result: 'substantive finished result' };
  await assert.rejects(f.as('1-a', 'link_task', update), { code: 'LOCAL_RESULT_FLUSH_FAILED' });
  const unchanged = (await f.as('0-a', 'link_task', { action: 'get', taskId: task.id })).task;
  assert.equal(unchanged.status, 'offered');
  assert.equal(unchanged.revision, 1);
  failTaskResult = false;
  const finished = await f.as('1-a', 'link_task', update);
  assert.equal(finished.task.status, 'completed');
  assert.equal(finished.task.revision, 2);
  assert.equal(finished.localResult.recordId, `task:${task.id}:2`);
  const completion = records.filter(item => item.kind === 'task-result');
  assert.equal(completion[0].recordId, completion[1].recordId);
  assert.equal(completion[1].relatedIds.revision, 2);
  assert.equal(completion[1].agent.id, '1-a');
  assert.equal(completion[1].text, update.result);
  assert.equal(f.calls.length, 1, 'completion does not send an automatic remote ACK');
});

test('unconfirmed local append cannot masquerade as durable result success', async t => {
  const recorder = { async record(input) { return { ...localReceipt(input), persisted: false, localState: 'appended' }; }, async close() {} };
  const f = await fixture(t, {}, { resultDelivery: recorder });
  await assert.rejects(f.as('0-a', 'link_send', { targetId: '1-a', message: 'never sent' }), { code: 'LOCAL_RESULT_UNCERTAIN', transport: 'failed', remoteAttempted: false });
  assert.equal(f.calls.length, 0);
});

test('close drains result recording and remote state before closing recorder and shared store', async t => {
  const entered = deferred();
  const flush = deferred();
  const order = [];
  let f;
  const recorder = {
    async record(input) { entered.resolve(); await flush.promise; order.push('recorded'); return localReceipt(input); },
    async close() { await f.store.read(); order.push('recorder-close'); },
  };
  f = await fixture(t, {}, { resultDelivery: recorder });
  f.host.close = async () => { order.push('host-close'); };
  const sending = f.as('0-a', 'link_send', { targetId: '1-a', message: 'owned local side effect' });
  await entered.promise;
  const closing = f.service.close();
  assert.deepEqual(order, []);
  flush.resolve();
  assert.equal((await sending).transport, 'accepted');
  await closing;
  assert.deepEqual(order, ['recorded', 'recorder-close', 'host-close']);
});

test('all live 3x3 kinds communicate in both directions with authoritative identity and untrusted envelope', async t => {
  const f = await fixture(t);
  for (let sender = 0; sender < 3; sender++) {
    for (let target = 0; target < 3; target++) {
      const a = `${sender}-a`, b = `${target}-b`;
      const sent = await f.as(a, 'link_send', { targetId: b, message: 'requested information', senderId: 'spoof', mode: 'auto' });
      assert.equal(sent.senderId, a);
      assert.equal(sent.transport, 'accepted');
      assert.equal(sent.receipt, 'unknown');
      const envelope = JSON.parse(f.calls.at(-1).text);
      assert.equal(envelope.senderId, a);
      assert.match(envelope.trust, /UNTRUSTED PEER/);
      assert.match(envelope.replyPolicy, /Do not send acknowledgements/);
      const reply = await f.as(b, 'link_send', { targetId: a, message: 'substantive answer', replyTo: sent.deliveryId });
      assert.equal(reply.hops, 1);
    }
  }
  assert.equal(f.calls.length, 18);
  await assert.rejects(f.as('0-a', 'link_send', { targetId: '0-a', message: 'self' }), { code: 'SELF_SEND' });
  await assert.rejects(f.service.execute('link_sessions', {}, { agent: {} }), { code: 'INVALID_ARGUMENT' });
});

test('delivery forwards the exact execution agent instance for host identity race checks', async t => {
  const f = await fixture(t);
  const actual = { id: '0-a', instanceToken: {} };
  await f.service.execute('link_send', { targetId: '1-a', message: 'work', senderAgent: { id: 'spoof' } }, { agent: actual });
  assert.equal(f.calls.at(-1).senderAgent, actual);
  await f.service.execute('link_task', { action: 'create', targetId: '1-a', title: 'task', instructions: 'work', senderAgent: { id: 'spoof' } }, { agent: actual });
  assert.equal(f.calls.at(-1).senderAgent, actual);
});

test('rejects cold, archived, unavailable targets and non-live senders without delivery', async t => {
  const f = await fixture(t);
  const target = f.sessions.get('1-a');
  target.live = false;
  target.status = 'persisted';
  await assert.rejects(f.as('0-a', 'link_send', { targetId: target.id, message: 'cold', wake: true }), { code: 'TARGET_NOT_LIVE' });
  await assert.rejects(f.as(target.id, 'link_sessions', {}), { code: 'SENDER_NOT_LIVE' });
  target.live = true;
  target.archived = true;
  await assert.rejects(f.as('0-a', 'link_send', { targetId: target.id, message: 'archived' }), { code: 'TARGET_ARCHIVED' });
  target.archived = false;
  target.canReceive = false;
  await assert.rejects(f.as('0-a', 'link_send', { targetId: target.id, message: 'unavailable' }), { code: 'TARGET_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
});

test('reception is caller-only, persisted, blocks new sends/tasks but not reads or outgoing', async t => {
  const f = await fixture(t);
  await f.as('1-a', 'link_reception', { enabled: false, targetId: '0-a' });
  assert.equal((await f.store.read()).reception['1-a'].enabled, false);
  await assert.rejects(f.as('0-a', 'link_send', { targetId: '1-a', message: 'paused' }), { code: 'RECEPTION_PAUSED' });
  await assert.rejects(f.as('0-a', 'link_task', { action: 'create', targetId: '1-a', title: 'work', instructions: 'do work' }), { code: 'RECEPTION_PAUSED' });
  await f.as('1-a', 'link_send', { targetId: '0-a', message: 'outgoing allowed' });
  assert.equal((await f.store.read()).reception['1-a'].enabled, false);
  assert.equal((await f.as('0-a', 'link_status', { targetId: '1-a' })).receptionEnabled, false);
  await f.as('1-a', 'link_reception', { enabled: true });
  await f.as('0-a', 'link_send', { targetId: '1-a', message: 'resumed' });
});

test('concurrent same-key idempotency sends once; changed arguments conflict', async t => {
  const f = await fixture(t);
  const args = { targetId: '1-a', message: 'once', requestId: 'req' };
  const results = await Promise.all(Array.from({ length: 10 }, () => f.as('0-a', 'link_send', args)));
  assert.equal(new Set(results.map(item => item.deliveryId)).size, 1);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.as('0-a', 'link_send', { ...args, message: 'different' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await f.as('0-b', 'link_send', args);
  assert.equal(f.calls.length, 2);
});

test('uncertain host failure persists unknown and same request never automatically retries', async t => {
  const f = await fixture(t);
  f.fail(new Error('lost connection after queue insertion'));
  const args = { targetId: '1-a', message: 'maybe delivered', requestId: 'unknown' };
  await assert.rejects(f.as('0-a', 'link_send', args), cause => cause.transport === 'unknown' && Boolean(cause.deliveryId));
  f.fail(undefined);
  const replay = await f.as('0-a', 'link_send', args);
  assert.equal(replay.transport, 'unknown');
  assert.equal(replay.replayed, true);
  assert.equal(f.calls.length, 1);
  await f.as('0-a', 'link_send', { ...args, requestId: 'explicit-retry' });
  assert.equal(f.calls.length, 2);
});

test('abort before commit sends nothing; proven host rejection is failed, never accepted', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(f.as('0-a', 'link_send', { targetId: '1-a', message: 'abort' }, controller.signal), { code: 'ABORTED' });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.read()).deliveries.length, 0);
  f.fail(Object.assign(new Error('inbox refused'), { code: 'TARGET_NOT_LIVE', definitelyNotDelivered: true }));
  await assert.rejects(f.as('0-a', 'link_send', { targetId: '1-a', message: 'reject' }), { code: 'TARGET_NOT_LIVE', transport: 'failed' });
  assert.equal((await f.store.read()).deliveries[0].state, 'failed');
});

test('unordered pair rate limit applies both directions and expires without timers', async t => {
  const f = await fixture(t, { maxMessagesPerMinute: 2 });
  await f.as('0-a', 'link_send', { targetId: '1-a', message: 'one' });
  await f.as('1-a', 'link_send', { targetId: '0-a', message: 'two' });
  await assert.rejects(f.as('0-a', 'link_send', { targetId: '1-a', message: 'three' }), { code: 'RATE_LIMITED' });
  f.tick(60001);
  await f.as('1-a', 'link_send', { targetId: '0-a', message: 'fresh window' });
  assert.equal(f.calls.length, 3);
});

test('reply chains require reverse participants and enforce hop bounds', async t => {
  const f = await fixture(t, { maxHops: 1 });
  const first = await f.as('0-a', 'link_send', { targetId: '1-a', message: 'question' });
  await assert.rejects(f.as('0-b', 'link_send', { targetId: '1-a', message: 'manufactured', replyTo: first.deliveryId }), { code: 'INVALID_REPLY' });
  await assert.rejects(f.as('0-a', 'link_send', { targetId: '1-a', message: 'wrong direction', replyTo: first.deliveryId }), { code: 'INVALID_REPLY' });
  const second = await f.as('1-a', 'link_send', { targetId: '0-a', message: 'answer', replyTo: first.deliveryId });
  await assert.rejects(f.as('0-a', 'link_send', { targetId: '1-a', message: 'loop', replyTo: second.deliveryId }), { code: 'HOP_LIMIT' });
  assert.equal(f.calls.length, 2);
});

test('acceptance reports unknown until an observed receipt even when host already claimed or discarded', async t => {
  const f = await fixture(t);
  for (const receipt of ['pending', 'claimed', 'discarded']) {
    f.receipt(receipt);
    const sent = await f.as('0-a', 'link_send', { targetId: '1-a', message: `already ${receipt}` });
    assert.equal(sent.transport, 'accepted');
    assert.equal(sent.receipt, 'unknown');
    const status = await f.as('0-a', 'link_status', { deliveryId: sent.deliveryId });
    assert.equal(status.delivery.receipt, receipt);
    assert.equal(status.delivery.transport, 'accepted');
  }
});

test('receipt and runtime never imply business completion; delivery ACL is participant-only', async t => {
  const f = await fixture(t);
  const sent = await f.as('0-a', 'link_send', { targetId: '1-a', message: 'work' });
  f.sessions.get('1-a').status = 'running';
  f.receipt('claimed');
  const status = await f.as('0-a', 'link_status', { deliveryId: sent.deliveryId });
  assert.equal(status.session.status, 'running');
  assert.equal(status.delivery.receipt, 'claimed');
  assert.equal(status.delivery.transport, 'accepted');
  assert.equal(status.delivery.status, undefined);
  await assert.rejects(f.as('0-b', 'link_status', { deliveryId: sent.deliveryId }), { code: 'ACCESS_DENIED' });
  await assert.rejects(f.as('0-a', 'link_status', { deliveryId: sent.deliveryId, targetId: '2-a' }), { code: 'INVALID_ARGUMENT' });
  assert.equal((await f.as('1-a', 'link_status', { deliveryId: sent.deliveryId })).session.id, '0-a');
});

test('same-directory policy applies to discovery, reads, tasks, and sends', async t => {
  const f = await fixture(t, { sameDirectoryOnly: true });
  const created = await f.as('0-a', 'link_task', { action: 'create', targetId: '1-a', title: 'work', instructions: 'work' });
  f.sessions.get('1-a').cwd = '/elsewhere';
  const listed = await f.as('0-a', 'link_sessions', {});
  assert.ok(!listed.sessions.some(item => item.id === '1-a'));
  for (const [name, args] of [
    ['link_send', { targetId: '1-a', message: 'blocked' }],
    ['link_status', { targetId: '1-a' }],
    ['link_activity', { targetId: '1-a' }],
    ['link_task', { action: 'get', taskId: created.task.id }],
    ['link_task', { action: 'create', targetId: '1-a', title: 'new', instructions: 'blocked' }],
  ]) await assert.rejects(f.as('0-a', name, args), { code: 'ACCESS_DENIED' });
  assert.deepEqual((await f.as('0-a', 'link_task', { action: 'list' })).tasks, []);
});

test('activity bounds output and strips reasoning, inherited content and tool args', async t => {
  const f = await fixture(t);
  f.events([
    { type: 'reasoning', text: 'SECRET-REASON' },
    { type: 'text', inherited: true, text: 'SECRET-PARENT' },
    { type: 'text', role: 'assistant', text: 'visible '.repeat(100), reasoning: 'SECRET-FIELD', arguments: { password: 'SECRET-ARG' } },
  ]);
  const result = await f.as('0-a', 'link_activity', { targetId: '1-a', limit: 3, maxChars: 256 });
  const json = JSON.stringify(result);
  assert.doesNotMatch(json, /SECRET/);
  assert.equal(result.truncated, true);
  assert.equal(result.events.length, 1);
  assert.ok(result.events[0].text.length <= 256);
  assert.equal(f.activityCalls[0].maxChars, 256);
});

test('host-readable cold peer metadata permits task reads and cancellation without delivery', async t => {
  const f = await fixture(t);
  const { task } = await f.as('0-a', 'link_task', { action: 'create', targetId: '1-a', title: 'work', instructions: 'work' });
  f.sessions.get('1-a').live = false;
  f.sessions.get('1-a').status = 'persisted';
  assert.equal((await f.as('0-a', 'link_task', { action: 'get', taskId: task.id })).task.id, task.id);
  assert.equal((await f.as('0-a', 'link_task', { action: 'list' })).tasks.length, 1);
  const cancelled = await f.as('0-a', 'link_task', { action: 'cancel', taskId: task.id, revision: 1 });
  assert.equal(cancelled.task.status, 'cancelled');
  assert.equal(f.calls.length, 1);
});

test('same-directory policy fails closed for cold metadata with only historical cwd', async t => {
  const f = await fixture(t, { sameDirectoryOnly: true });
  const { task } = await f.as('0-a', 'link_task', { action: 'create', targetId: '1-a', title: 'work', instructions: 'work' });
  f.sessions.get('1-a').live = false;
  assert.equal(f.sessions.get('1-a').cwd, f.sessions.get('0-a').cwd);
  await assert.rejects(f.as('0-a', 'link_task', { action: 'get', taskId: task.id }), { code: 'ACCESS_DENIED' });
  await assert.rejects(f.as('0-a', 'link_task', { action: 'cancel', taskId: task.id, revision: 1 }), { code: 'ACCESS_DENIED' });
  const listed = await f.as('0-a', 'link_task', { action: 'list' });
  assert.deepEqual(listed.tasks, []);
  assert.equal(listed.truncated, true);
});

test('safe target lifecycle reason codes survive service preflight errors', async t => {
  const f = await fixture(t);
  const target = f.sessions.get('1-a');
  target.canReceive = false;
  target.reason = 'TARGET_LIFECYCLE_UNAVAILABLE';
  await assert.rejects(f.as('0-a', 'link_send', { targetId: target.id, message: 'blocked' }), { code: 'TARGET_LIFECYCLE_UNAVAILABLE' });
  target.reason = 'untrusted arbitrary text';
  await assert.rejects(f.as('0-a', 'link_send', { targetId: target.id, message: 'blocked' }), { code: 'TARGET_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
});

test('task list skips an unavailable peer without hiding other live task records', async t => {
  const f = await fixture(t);
  await f.as('0-a', 'link_task', { action: 'create', targetId: '1-a', title: 'cold later', instructions: 'work' });
  const live = await f.as('0-a', 'link_task', { action: 'create', targetId: '2-a', title: 'live task', instructions: 'work' });
  const describe = f.host.describe;
  f.host.describe = async (id, options) => {
    if (id === '1-a') throw Object.assign(new Error('no longer live'), { code: 'TARGET_NOT_LIVE' });
    return describe(id, options);
  };
  const listed = await f.as('0-a', 'link_task', { action: 'list' });
  assert.deepEqual(listed.tasks.map(task => task.id), [live.task.id]);
  assert.equal(listed.truncated, true);
});

test('task owner/assignee ACL, CAS, required results and strict terminal immutability', async t => {
  const f = await fixture(t);
  const created = await f.as('0-a', 'link_task', { action: 'create', targetId: '1-a', title: 'task', instructions: 'do thing', requestId: 'task-key' });
  assert.equal(created.task.status, 'offered');
  assert.equal(created.task.deliveryState, 'accepted');
  const replay = await f.as('0-a', 'link_task', { action: 'create', targetId: '1-a', title: 'task', instructions: 'do thing', requestId: 'task-key' });
  assert.equal(replay.task.id, created.task.id);
  assert.equal(f.calls.length, 1);
  const taskId = created.task.id;
  await assert.rejects(f.as('0-b', 'link_task', { action: 'get', taskId }), { code: 'ACCESS_DENIED' });
  assert.deepEqual((await f.as('0-b', 'link_task', { action: 'list' })).tasks, []);
  await assert.rejects(f.as('0-a', 'link_task', { action: 'update', taskId, revision: 1, status: 'working' }), { code: 'ACCESS_DENIED' });
  const working = await f.as('1-a', 'link_task', { action: 'update', taskId, revision: 1, status: 'working', progress: 'half' });
  assert.equal(working.task.revision, 2);
  await assert.rejects(f.as('1-a', 'link_task', { action: 'update', taskId, revision: 1, status: 'blocked' }), { code: 'REVISION_CONFLICT' });
  await assert.rejects(f.as('1-a', 'link_task', { action: 'update', taskId, revision: 2, status: 'completed' }), { code: 'RESULT_REQUIRED' });
  const done = await f.as('1-a', 'link_task', { action: 'update', taskId, revision: 2, status: 'completed', result: 'finished result' });
  assert.equal(done.verification, 'self-reported');
  assert.equal(done.task.deliveryState, 'accepted');
  await assert.rejects(f.as('0-a', 'link_task', { action: 'cancel', taskId, revision: 3 }), { code: 'TASK_TERMINAL' });
  assert.equal(f.calls.length, 1, 'updates never auto-ACK');
});

test('task failed delivery remains offered; owner cancellation does not interrupt target', async t => {
  const f = await fixture(t);
  f.fail(new Error('uncertain delivery'));
  let taskId;
  await assert.rejects(f.as('0-a', 'link_task', { action: 'create', targetId: '1-a', title: 'task', instructions: 'do thing' }), cause => { taskId = cause.taskId; return Boolean(taskId); });
  const offered = (await f.as('0-a', 'link_task', { action: 'get', taskId })).task;
  assert.equal(offered.status, 'offered');
  assert.equal(offered.deliveryState, 'unknown');
  await assert.rejects(f.as('1-a', 'link_task', { action: 'cancel', taskId, revision: 1 }), { code: 'ACCESS_DENIED' });
  const cancelled = await f.as('0-a', 'link_task', { action: 'cancel', taskId, revision: 1, reason: 'not needed' });
  assert.equal(cancelled.task.status, 'cancelled');
  assert.equal(cancelled.task.cancellation.interruptedAgent, false);
  assert.equal(f.calls.length, 1);
});

test('bounded delivery history protects active tasks and task storage never silently evicts', async t => {
  const f = await fixture(t, { maxTasks: 1, recentDeliveries: 1 });
  const first = await f.as('0-a', 'link_task', { action: 'create', targetId: '1-a', title: 'task', instructions: 'do thing' });
  await assert.rejects(f.as('0-a', 'link_task', { action: 'create', targetId: '1-b', title: 'next', instructions: 'do next' }), { code: 'TASK_CAPACITY' });
  await assert.rejects(f.as('0-a', 'link_send', { targetId: '1-a', message: 'next' }), { code: 'DELIVERY_CAPACITY' });
  assert.equal((await f.store.read()).tasks[0].id, first.task.id);
});

test('terminal task delivery stays retained so idempotent create cannot duplicate a task', async t => {
  const f = await fixture(t, { recentDeliveries: 1 });
  const args = { action: 'create', targetId: '1-a', title: 'task', instructions: 'work', requestId: 'persistent-task-key' };
  const created = await f.as('0-a', 'link_task', args);
  await f.as('0-a', 'link_task', { action: 'cancel', taskId: created.task.id, revision: 1 });
  await assert.rejects(f.as('0-a', 'link_send', { targetId: '1-a', message: 'cannot evict task evidence' }), { code: 'DELIVERY_CAPACITY' });
  const replay = await f.as('0-a', 'link_task', args);
  assert.equal(replay.task.id, created.task.id);
  assert.equal(replay.task.status, 'cancelled');
  assert.equal(f.calls.length, 1);
});

test('uncertain intent cannot be evicted even at capacity', async t => {
  const f = await fixture(t, { recentDeliveries: 1 });
  const args = { targetId: '1-a', message: 'possibly delivered', requestId: 'uncertain' };
  f.fail(new Error('transport ambiguity'));
  await assert.rejects(f.as('0-a', 'link_send', args), { transport: 'unknown' });
  f.fail(undefined);
  await assert.rejects(f.as('0-a', 'link_send', { targetId: '1-a', message: 'new key' }), { code: 'DELIVERY_CAPACITY' });
  assert.equal((await f.as('0-a', 'link_send', args)).transport, 'unknown');
  assert.equal(f.calls.length, 1);
});

test('abort after intent persistence but before host call records definite failure and sends nothing', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  let mutations = 0;
  const store = {
    read: () => f.store.read(),
    async mutate(fn) {
      const result = await f.store.mutate(fn);
      if (++mutations === 1) controller.abort();
      return result;
    },
    async close() {},
  };
  const service = createService({ host: f.host, store });
  await assert.rejects(service.execute('link_send', { targetId: '1-a', message: 'cancel before send' }, { agent: { id: '0-a' }, signal: controller.signal }), { code: 'ABORTED', transport: 'failed' });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.read()).deliveries[0].state, 'failed');
  await service.close();
});

test('service enforces schema limits without trusting external tool validation', async t => {
  const f = await fixture(t);
  for (const [name, args] of [
    ['link_sessions', { limit: 101 }],
    ['link_task', { action: 'list', limit: 101 }],
    ['link_activity', { targetId: '1-a', maxChars: 255 }],
    ['link_activity', { targetId: '1-a', maxChars: 20001 }],
    ['link_activity', { targetId: '1-a', limit: 51 }],
    ['link_send', { targetId: '1-a', message: 'm', requestId: 'r'.repeat(129) }],
  ]) await assert.rejects(f.as('0-a', name, args), { code: 'INVALID_ARGUMENT' });
  const { task } = await f.as('0-a', 'link_task', { action: 'create', targetId: '1-a', title: 't', instructions: 'i' });
  await assert.rejects(f.as('1-a', 'link_task', { action: 'update', taskId: task.id, revision: 1, progress: 'p'.repeat(4001) }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.as('1-a', 'link_task', { action: 'update', taskId: task.id, revision: 1, result: 'r'.repeat(8001) }), { code: 'INVALID_ARGUMENT' });
  const updated = await f.as('1-a', 'link_task', { action: 'update', taskId: task.id, revision: 1, progress: 'p'.repeat(4000) });
  assert.equal(updated.task.progress.length, 4000);
});

test('configuration rejects unbounded limits and close rejects future work', async t => {
  assert.throws(() => createService({ host: {}, store: {}, config: { maxHops: Infinity } }), { code: 'INVALID_CONFIG' });
  assert.throws(() => createService({ host: {}, store: {}, config: { enabled: 'yes' } }), { code: 'INVALID_CONFIG' });
  const f = await fixture(t);
  await f.service.close();
  await assert.rejects(f.as('0-a', 'link_sessions', {}), { code: 'SERVICE_CLOSED' });
});
