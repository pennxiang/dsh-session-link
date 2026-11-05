import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { createService } from '../lib/service.js';
import { createResultDelivery, RESULT_SOURCE_KIND } from '../lib/result-delivery.js';

const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'session-link-result-'));
  let store = await createStore(join(directory, 'ledger'));
  const registry = new Map(); const hooks = {};
  const calls = { append: [], flush: [], query: [], wake: 0 };
  let serial = 0;
  const add = (id, origin) => {
    const events = [];
    const session = {
      header: { id, ...(origin ? { origin } : {}) }, events, inheritedEventCount: 0,
      get seq() { return events.length; },
      append(type, data, options) {
        hooks.beforeAppend?.(session);
        assert.equal(type, 'user/message');
        assert.equal(options.surfaceOp, 'append');
        assert.equal(data.role, 'user');
        assert.equal(data.source.kind, RESULT_SOURCE_KIND);
        const event = structuredClone({ type, seq: events.length, time: 123, data, ...options });
        events.push(event); calls.append.push({ id, event });
        hooks.afterAppend?.(session, event);
        return event;
      },
    };
    const agent = { id, session, status: 'running' };
    for (const name of ['followup', 'inject', 'steer']) agent[name] = () => { calls.wake++; throw new Error('Recording must not wake or send to any Agent'); };
    registry.set(id, agent); return agent;
  };
  const agent = add('executor'); const owner = add('owner');
  const ctx = {
    agents: { get: id => registry.get(id) }, workspaceRegistry: { archivedSessionIds: [] },
    sessions: { async flush(session) {
      calls.flush.push(session.header.id);
      if (hooks.flush) return hooks.flush(session);
      await writeFile(join(directory, `${session.header.id}.json`), JSON.stringify(session.events), { mode: 0o600 });
      return true;
    } },
    sessionQuery: { async readEvent(request) {
      calls.query.push(request);
      if (hooks.query) return hooks.query(request);
      const session = registry.get(request.sessionId).session;
      return { inheritedEventCount: session.inheritedEventCount, target: structuredClone(session.events[request.seq]) };
    } },
  };
  const factory = input => {
    const message = { ...structuredClone(input), role: 'user', id: `local-message-${++serial}` };
    hooks.factory?.(message); return message;
  };
  const options = () => ({ ctx, store, createUserMessage: factory, now: () => 1000, config });
  let delivery = createResultDelivery(options());
  t.after(async () => { await delivery.close(); await store.close(); await rm(directory, { recursive: true, force: true }); });
  const args = extra => ({ agent, recordId: 'task:one:2', title: '任务结果', text: 'Fixture **substantive result**.', kind: 'task-result', relatedIds: { taskId: 'one', revision: 2, ownerId: 'owner' }, ...extra });
  return { directory, registry, agent, owner, ctx, calls, hooks, add, args, options,
    get delivery() { return delivery; }, get store() { return store; },
    record: extra => delivery.record(args(extra)),
    async restart() { await delivery.close(); await store.close(); store = await createStore(join(directory, 'ledger')); delivery = createResultDelivery(options()); },
  };
}

function linkedService(f, t) {
  const remote = [];
  const host = {
    async describe(id) {
      const agent = f.registry.get(id);
      if (!agent) throw Object.assign(new Error('fixture missing session'), { code: 'SESSION_NOT_FOUND' });
      return { id, title: id, live: true, status: agent.status, kind: 'session', cwd: f.directory, canReceive: true };
    },
    async deliver(input) {
      assert.equal(f.registry.get(input.senderId), input.senderAgent);
      assert.ok((await f.store.read()).resultRecords.some(record => record.sessionId === input.senderId && record.state === 'persisted'), 'local native flush and ledger confirmation must precede the first remote call');
      remote.push(input); return { messageId: `remote-${remote.length}`, mode: 'followup' };
    },
    async receipt() { return { state: 'unknown' }; },
  };
  const service = createService({ host, store: f.store, resultDelivery: f.delivery });
  t.after(() => service.close());
  return { service, remote, call: (name, args, agent = f.agent) => service.execute(name, args, { agent }) };
}

test('local result is a persisted producer-owned user surface notice, not model/human text or a new turn', async t => {
  const f = await fixture(t);
  const result = await f.record();
  assert.equal(result.persisted, true);
  assert.equal(result.localState, 'persisted');
  assert.equal(result.sessionId, f.agent.id);
  assert.equal(result.eventSeq, 0);
  assert.equal(result.replayed, false);
  const saved = JSON.parse(await readFile(join(f.directory, 'executor.json'), 'utf8'));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].type, 'user/message');
  assert.equal(saved[0].surfaceOp, 'append');
  assert.equal(saved[0].data.role, 'user');
  assert.equal(saved[0].data.source.kind, RESULT_SOURCE_KIND);
  assert.equal(saved[0].data.source.form, 'notice');
  assert.equal(saved[0].data.source.recordKind, 'task-result');
  assert.equal(saved[0].data.source.sessionId, f.agent.id);
  assert.match(saved[0].data.content[0].text, /插件记录.*未独立验证/);
  assert.match(saved[0].data.content[0].text, /Fixture \*\*substantive result\*\*\./);
  assert.equal(saved[0].data.source.provider, undefined);
  assert.equal(f.owner.session.events.length, 0, 'must never append into the owner conversation');
  assert.equal(f.calls.wake, 0);
  assert.deepEqual(f.calls.flush, ['executor']);
  const ledger = await readFile(join(f.directory, 'ledger', 'state.json'), 'utf8');
  assert.doesNotMatch(ledger, /substantive result/, 'ledger stores identity/fingerprint, not a transcript copy');
});

test('outgoing local notice truthfully records content, not delivery or task completion', async t => {
  const f = await fixture(t);
  const result = await f.record({ recordId: 'send:d1', title: '发送内容', kind: 'outgoing-message', relatedIds: { deliveryId: 'd1', targetId: 'owner' }, text: 'Fixture requested result.' });
  assert.equal(result.persisted, true);
  const event = f.agent.session.events[0];
  assert.equal(event.data.source.recordKind, 'outgoing-message');
  assert.match(event.data.content[0].text, /不是送达、阅读或完成证明/);
  assert.equal(f.calls.wake, 0);
});

test('record keys are session-scoped, preserve revisions and reject changed content', async t => {
  const f = await fixture(t);
  const first = await f.record();
  const replay = await f.record({ relatedIds: { ownerId: 'owner', revision: 2, taskId: 'one' } });
  assert.equal(replay.messageId, first.messageId);
  assert.equal(replay.replayed, true);
  await assert.rejects(f.record({ text: 'changed' }), { code: 'LOCAL_RESULT_CONFLICT' });
  await assert.rejects(f.record({ relatedIds: { taskId: 'one', revision: 3, ownerId: 'owner' } }), { code: 'LOCAL_RESULT_CONFLICT' });
  const other = await f.record({ agent: f.owner });
  assert.notEqual(other.messageId, first.messageId);
  assert.equal(other.sessionId, 'owner');
  assert.equal(f.calls.append.length, 2);
});

test('many concurrent same-key calls append once; two component instances cannot duplicate an intent', async t => {
  const f = await fixture(t);
  const first = await Promise.all(Array.from({ length: 20 }, () => f.record()));
  assert.equal(new Set(first.map(x => x.messageId)).size, 1);
  assert.equal(f.calls.append.length, 1);
  const second = createResultDelivery(f.options()); t.after(() => second.close());
  const outcomes = await Promise.allSettled([f.record({ recordId: 'raced' }), second.record(f.args({ recordId: 'raced' }))]);
  assert.ok(outcomes.some(x => x.status === 'fulfilled' && x.value.persisted));
  assert.equal(f.calls.append.length, 2);
  assert.equal((await f.store.read()).resultRecords.length, 2);
});

test('stale execution identity, replaced session header and archived senders never append', async t => {
  const f = await fixture(t);
  await assert.rejects(f.record({ agent: { ...f.agent } }), { code: 'SENDER_NOT_LIVE' });
  f.agent.session.header.id = 'owner';
  await assert.rejects(f.record(), { code: 'SENDER_NOT_LIVE' });
  f.agent.session.header.id = f.agent.id;
  f.ctx.workspaceRegistry.archivedSessionIds.push(f.agent.id);
  await assert.rejects(f.record(), { code: 'SENDER_ARCHIVED' });
  assert.equal(f.calls.append.length, 0);
});

test('abort before intent or between intent and append writes no surface and supports safe explicit retry', async t => {
  const f = await fixture(t);
  const pre = new AbortController(); pre.abort();
  await assert.rejects(f.record({ signal: pre.signal }), { code: 'ABORTED' });
  assert.equal((await f.store.read()).resultRecords, undefined);
  const middle = new AbortController();
  const mutate = f.store.mutate;
  let first = true;
  f.store.mutate = async fn => { const value = await mutate(fn); if (first) { first = false; middle.abort(); } return value; };
  await assert.rejects(f.record({ signal: middle.signal }), { code: 'ABORTED', localState: 'not-written' });
  assert.equal(f.calls.append.length, 0);
  f.store.mutate = mutate;
  assert.equal((await f.record()).persisted, true);
  assert.equal(f.calls.append.length, 1);
});

test('abort after append still flushes the committed record but does not report uncancelled success', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.hooks.afterAppend = () => controller.abort();
  await assert.rejects(f.record({ signal: controller.signal }), { code: 'ABORTED', localState: 'persisted', persisted: true });
  assert.equal(f.calls.append.length, 1);
  assert.equal(f.calls.flush.length, 1);
  assert.equal((await f.store.read()).resultRecords[0].state, 'persisted');
  const retried = await f.record();
  assert.equal(retried.replayed, true);
  assert.equal(f.calls.append.length, 1);
});

test('flush failure is recoverable across restart using only the exact owned event; never reappend', async t => {
  const f = await fixture(t);
  f.hooks.flush = async () => { throw new Error('fixture persistence outage'); };
  let messageId;
  await assert.rejects(f.record(), error => { messageId = error.messageId; return error.code === 'LOCAL_RESULT_FLUSH_FAILED' && error.eventSeq === 0 && error.localState === 'appended'; });
  await f.restart();
  delete f.hooks.flush;
  const recovered = await f.record();
  assert.equal(recovered.persisted, true);
  assert.equal(recovered.replayed, true);
  assert.equal(recovered.messageId, messageId);
  assert.equal(f.calls.append.length, 1);
  assert.deepEqual(f.calls.query, [{ sessionId: 'executor', seq: 0, before: 0, after: 0 }]);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'executor.json'), 'utf8')).length, 1);
});

test('flush returning false is memory-only, not durable success', async t => {
  const f = await fixture(t);
  f.hooks.flush = async () => false;
  await assert.rejects(f.record(), { code: 'LOCAL_RESULT_DURABILITY_UNAVAILABLE', localState: 'appended' });
  assert.equal((await f.store.read()).resultRecords[0].state, 'appended');
});

test('append acknowledgment failure can verify the same event and flush without duplicating it', async t => {
  const f = await fixture(t);
  f.hooks.afterAppend = () => { throw new Error('fixture throw after local commit'); };
  await assert.rejects(f.record(), { code: 'LOCAL_RESULT_UNCERTAIN', localState: 'unknown', eventSeq: 0 });
  delete f.hooks.afterAppend;
  const replay = await f.record();
  assert.equal(replay.replayed, true);
  assert.equal(f.calls.append.length, 1);
});

test('crash window without a saved event sequence never uses a tail miss as permission to append again', async t => {
  const f = await fixture(t);
  const mutate = f.store.mutate;
  let count = 0;
  f.store.mutate = fn => ++count === 2 ? Promise.reject(new Error('fixture lost seq write')) : mutate(fn);
  await assert.rejects(f.record(), { code: 'LOCAL_RESULT_PERSISTENCE_UNCERTAIN', localState: 'unknown', eventSeq: 0 });
  f.store.mutate = mutate;
  assert.equal((await f.store.read()).resultRecords[0].eventSeq, undefined);
  await f.restart();
  await assert.rejects(f.record(), { code: 'LOCAL_RESULT_UNCERTAIN' });
  assert.equal(f.calls.append.length, 1);
  assert.equal(f.calls.query.length, 0);
});

test('recovery rejects inherited records and mismatched content, IDs or producer sources', async t => {
  for (const mutation of ['inherited', 'body', 'source', 'id', 'record-id']) await t.test(mutation, async t => {
    const f = await fixture(t);
    f.hooks.flush = async () => false;
    await assert.rejects(f.record(), { code: 'LOCAL_RESULT_DURABILITY_UNAVAILABLE' });
    delete f.hooks.flush;
    const event = f.agent.session.events[0];
    if (mutation === 'inherited') f.agent.session.inheritedEventCount = 1;
    if (mutation === 'body') event.data.content[0].text = 'unrelated content';
    if (mutation === 'source') event.data.source.kind = 'user';
    if (mutation === 'id') event.data.id = 'foreign-message';
    if (mutation === 'record-id') event.data.source.recordId = 'foreign-record';
    await assert.rejects(f.record(), { code: 'LOCAL_RESULT_IDENTITY_MISMATCH' });
    assert.equal(f.calls.append.length, 1);
    assert.equal(f.calls.flush.length, 1);
  });
});

test('bounded ledger never evicts unresolved result identities and does not persist result bodies', async t => {
  const f = await fixture(t, { maxResultRecords: 1 });
  f.hooks.flush = async () => false;
  await assert.rejects(f.record(), { code: 'LOCAL_RESULT_DURABILITY_UNAVAILABLE' });
  await assert.rejects(f.record({ recordId: 'new' }), { code: 'LOCAL_RESULT_CAPACITY' });
  assert.equal(f.calls.append.length, 1);
  assert.equal((await f.store.read()).resultRecords.length, 1);
});

test('message factory cannot misattribute a plugin result as human or model content', async t => {
  for (const mutation of ['role', 'source', 'content']) await t.test(mutation, async t => {
    const f = await fixture(t);
    f.hooks.factory = message => {
      if (mutation === 'role') message.role = 'assistant';
      if (mutation === 'source') message.source = { kind: 'user' };
      if (mutation === 'content') message.content[0].text = 'substituted';
    };
    await assert.rejects(f.record(), { code: 'LOCAL_RESULT_MESSAGE_INVALID' });
    assert.equal(f.calls.append.length, 0);
  });
});

test('pure recovery queries that ignore cancellation cannot hang caller abort or component close', async t => {
  for (const mode of ['abort', 'close']) await t.test(mode, async t => {
    const f = await fixture(t);
    f.hooks.flush = async () => false;
    await assert.rejects(f.record(), { code: 'LOCAL_RESULT_DURABILITY_UNAVAILABLE' });
    delete f.hooks.flush;
    const entered = gate();
    f.hooks.query = () => { entered.resolve(); return new Promise(() => {}); };
    const controller = new AbortController();
    const pending = f.record({ signal: controller.signal });
    const rejected = assert.rejects(pending, { code: mode === 'abort' ? 'ABORTED' : 'LOCAL_RESULT_UNCERTAIN' });
    await entered.promise;
    if (mode === 'abort') controller.abort(); else await f.delivery.close();
    await rejected;
    assert.equal(f.calls.append.length, 1);
    assert.equal((await f.store.read()).resultRecords[0].state, 'appended');
  });
});

test('real service plus recorder flushes full outgoing content locally before remote delivery and replay stays single', async t => {
  const f = await fixture(t); const link = linkedService(f, t);
  const args = { targetId: 'owner', message: 'Fixture final **answer** to the creator.', requestId: 'result-send' };
  const sent = await link.call('link_send', args);
  assert.equal(sent.transport, 'accepted');
  assert.equal(sent.localResult.persisted, true);
  assert.equal(sent.localResult.sessionId, 'executor');
  assert.equal(sent.localResult.recordId, `send:${sent.deliveryId}`);
  assert.equal(f.agent.session.events.length, 1);
  assert.equal(f.owner.session.events.length, 0);
  const restored = JSON.parse(await readFile(join(f.directory, 'executor.json'), 'utf8'));
  assert.match(restored[0].data.content[0].text, /Fixture final \*\*answer\*\*/);
  assert.equal(restored[0].data.source.recordKind, 'outgoing-message');
  const replay = await link.call('link_send', args);
  assert.equal(replay.replayed, true);
  assert.equal(link.remote.length, 1);
  assert.equal(f.calls.append.length, 1);
  assert.equal(f.calls.flush.length, 1);
});

test('real service does not call remote when local result flush fails, and send replay never resubmits', async t => {
  const f = await fixture(t); const link = linkedService(f, t);
  f.hooks.flush = async () => false;
  const args = { targetId: 'owner', message: 'Fixture unflushed result.', requestId: 'not-forwarded' };
  await assert.rejects(link.call('link_send', args), error => error.code === 'LOCAL_RESULT_DURABILITY_UNAVAILABLE' && Boolean(error.deliveryId));
  assert.equal(link.remote.length, 0);
  const saved = (await f.store.read()).deliveries[0];
  assert.equal(saved.remoteAttempted, false);
  assert.equal(saved.localResultState, 'appended');
  delete f.hooks.flush;
  const replay = await link.call('link_send', args);
  assert.equal(replay.replayed, true);
  assert.equal(link.remote.length, 0);
  assert.equal(f.calls.append.length, 1);
});

test('real task completion commits only after one local full result and never substitutes owner forwarding', async t => {
  const f = await fixture(t); const link = linkedService(f, t);
  const created = await link.call('link_task', { action: 'create', targetId: 'executor', title: 'Fixture task', instructions: 'Return a substantive result.' }, f.owner);
  assert.equal(f.agent.session.events.length, 0);
  const complete = await link.call('link_task', { action: 'update', taskId: created.task.id, revision: 1, status: 'completed', result: 'Fixture completed **result body**.' });
  assert.equal(complete.task.status, 'completed');
  assert.equal(complete.task.revision, 2);
  assert.equal(complete.task.resultRecord.recordId, `task:${created.task.id}:2`);
  assert.equal(complete.localResult.localState, 'persisted');
  assert.equal(f.agent.session.events.length, 1);
  assert.equal(f.agent.session.events[0].data.source.recordKind, 'task-result');
  assert.match(f.agent.session.events[0].data.content[0].text, /Fixture completed \*\*result body\*\*/);
  assert.equal(link.remote.length, 1, 'only original task instructions were forwarded; completion does not implicitly send');
  assert.equal(f.calls.flush.filter(id => id === 'executor').length, 1);
  await assert.rejects(link.call('link_task', { action: 'update', taskId: created.task.id, revision: 2, status: 'completed', result: 'Fixture completed **result body**.' }), { code: 'TASK_TERMINAL' });
  assert.equal(f.agent.session.events.length, 1);
});

test('failed completion retains original task state and same CAS retry repairs flush without duplicate local result', async t => {
  const f = await fixture(t); const link = linkedService(f, t);
  const created = await link.call('link_task', { action: 'create', targetId: 'executor', title: 'Fixture task', instructions: 'Return a result.' }, f.owner);
  const args = { action: 'update', taskId: created.task.id, revision: 1, status: 'completed', result: 'Fixture retryable task result.' };
  f.hooks.flush = async session => session.header.id === 'executor' ? false : true;
  await assert.rejects(link.call('link_task', args), { code: 'LOCAL_RESULT_DURABILITY_UNAVAILABLE' });
  const before = (await f.store.read()).tasks[0];
  assert.equal(before.status, 'offered');
  assert.equal(before.revision, 1);
  assert.equal(f.agent.session.events.length, 1);
  delete f.hooks.flush;
  const completed = await link.call('link_task', args);
  assert.equal(completed.task.status, 'completed');
  assert.equal(completed.task.revision, 2);
  assert.equal(f.agent.session.events.length, 1);
  assert.equal(link.remote.length, 1);
  assert.equal(f.calls.query.length, 1);
});

test('close drains accepted durability work but does not close the shared store or wake/dispose sessions', async t => {
  const f = await fixture(t);
  const entered = gate(); const release = gate();
  f.hooks.flush = async () => { entered.resolve(); await release.promise; return true; };
  const operation = f.record();
  await entered.promise;
  const closed = f.delivery.close();
  await assert.rejects(f.record({ recordId: 'after-close' }), { code: 'LOCAL_RESULT_CLOSED' });
  release.resolve();
  await operation; await closed;
  assert.equal((await f.store.read()).resultRecords[0].state, 'persisted');
  await f.store.mutate(state => { state.reception.probe = { enabled: false }; });
  assert.equal(f.registry.get('executor'), f.agent);
  assert.equal(f.calls.wake, 0);
});
