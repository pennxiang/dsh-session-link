import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../lib/service.js';
import { createStore } from '../lib/store.js';
import { TOOLS } from '../lib/tool-schema.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const coded = code => Object.assign(new Error(code), { code });

async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'session-link-independent-'));
  let store = await createStore(directory);
  let clock = 1000000;
  let id = 0;
  const sessions = new Map(['a', 'b', 'c', 'd'].map((id, i) => [id, {
    id, title: `fixture ${id}`, kind: ['session', 'sidechat', 'subagent', 'session'][i],
    cwd: '/fixture/same', live: true, archived: false, status: 'idle', canReceive: true,
  }]));
  const deliveries = [];
  const host = {
    async describe(id) { if (!sessions.has(id)) throw coded('SESSION_NOT_FOUND'); return structuredClone(sessions.get(id)); },
    async list() { return { sessions: structuredClone([...sessions.values()]), truncated: false }; },
    async deliver(input) { deliveries.push(input); return { messageId: `host-${deliveries.length}`, mode: 'followup' }; },
    async receipt() { return { state: 'pending' }; },
    async activity(id) { return { session: sessions.get(id), events: [], truncated: false }; },
  };
  const makeService = () => createService({ host, store, config, now: () => clock, uuid: () => `review-${++id}` });
  let service = makeService();
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    directory, host, sessions, deliveries,
    get service() { return service; }, get store() { return store; },
    call: (who, name, args, signal) => service.execute(name, args, { agent: { id: who }, signal }),
    tick: n => { clock += n; },
    async restart() { await service.close(); store = await createStore(directory); service = makeService(); },
  };
}
const send = (f, who = 'a', extra = {}) => f.call(who, 'link_send', { targetId: 'b', message: 'fixture message', ...extra });
const create = (f, extra = {}) => f.call('a', 'link_task', { action: 'create', targetId: 'b', title: 'fixture task', instructions: 'fixture instructions', ...extra });

test('review: task/send requestId namespace conflicts safely in both orders and remains sender-scoped', async t => {
  const f = await fixture(t);
  await send(f, 'a', { requestId: 'shared-send' });
  await assert.rejects(create(f, { requestId: 'shared-send', instructions: 'fixture message' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await create(f, { requestId: 'shared-task' });
  await assert.rejects(send(f, 'a', { requestId: 'shared-task', message: 'fixture instructions' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await send(f, 'c', { requestId: 'shared-send' });
  assert.equal(f.deliveries.length, 3);
  assert.equal((await f.store.read()).tasks.length, 1);
});

test('review: concurrent task creates reserve one task and one send; changed-title replay conflicts', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 24 }, () => create(f, { requestId: 'one-task' })));
  assert.equal(new Set(results.map(x => x.task.id)).size, 1);
  assert.equal(results.filter(x => x.replayed).length, 23);
  assert.equal(f.deliveries.length, 1);
  assert.equal((await f.store.read()).tasks.length, 1);
  await assert.rejects(create(f, { requestId: 'one-task', title: 'changed' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('review: restart converts saved in-flight intent to unknown and identical replay never resends', async t => {
  const f = await fixture(t);
  const args = { requestId: 'restart' };
  const first = await create(f, args);
  // Fixture-only crash image: durable intent exists but the acceptance write did not survive.
  await f.store.mutate(state => {
    const d = state.deliveries[0];
    d.state = 'sending'; d.receipt = 'unknown'; delete d.hostMessageId;
    state.tasks[0].deliveryState = 'sending';
  });
  await f.restart();
  const replay = await create(f, args);
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.id, first.task.id);
  assert.equal(replay.task.deliveryState, 'unknown');
  assert.equal(replay.delivery.transport, 'unknown');
  assert.equal(replay.delivery.error.code, 'RESTART_UNKNOWN');
  assert.equal(f.deliveries.length, 1);
  const disk = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  assert.equal(disk.deliveries[0].state, 'unknown');
});

test('review: sameDirectoryOnly covers receipt-id, replay, task update/cancel and both participant directions', async t => {
  const f = await fixture(t, { sameDirectoryOnly: true });
  const created = await create(f, { requestId: 'directory-task' });
  const sent = await send(f, 'a', { requestId: 'directory-send' });
  f.sessions.get('b').cwd = '/fixture/other';
  for (const [who, name, args] of [
    ['a', 'link_send', { targetId: 'b', message: 'fixture message', requestId: 'directory-send' }],
    ['a', 'link_task', { action: 'create', targetId: 'b', title: 'fixture task', instructions: 'fixture instructions', requestId: 'directory-task' }],
    ['a', 'link_status', { deliveryId: sent.deliveryId }],
    ['b', 'link_status', { deliveryId: sent.deliveryId }],
    ['a', 'link_task', { action: 'cancel', taskId: created.task.id, revision: 1 }],
    ['b', 'link_task', { action: 'update', taskId: created.task.id, revision: 1, status: 'working' }],
    ['b', 'link_task', { action: 'get', taskId: created.task.id }],
  ]) await assert.rejects(f.call(who, name, args), { code: 'ACCESS_DENIED' });
  assert.deepEqual((await f.call('b', 'link_task', { action: 'list' })).tasks, []);
  assert.equal(f.deliveries.length, 2);
  assert.equal((await f.store.read()).tasks[0].revision, 1);
});

test('review: missing directory fails closed and normalized same directory is accepted', async t => {
  const f = await fixture(t, { sameDirectoryOnly: true });
  f.sessions.get('b').cwd = '/fixture/same/../same/';
  await send(f);
  delete f.sessions.get('b').cwd;
  await assert.rejects(send(f), { code: 'ACCESS_DENIED' });
  await assert.rejects(f.call('a', 'link_activity', { targetId: 'b' }), { code: 'ACCESS_DENIED' });
  assert.ok(!(await f.call('a', 'link_sessions', {})).sessions.some(x => x.id === 'b'));
});

test('review: outsiders cannot read/change tasks or reconcile receipts, even with spoofed sender fields', async t => {
  const f = await fixture(t);
  const created = await create(f);
  let receipts = 0;
  f.host.receipt = async () => { receipts++; return { state: 'claimed' }; };
  for (const args of [
    { action: 'get' },
    { action: 'cancel', revision: 1 },
    { action: 'update', revision: 1, status: 'completed', result: 'spoof' },
  ]) await assert.rejects(f.call('c', 'link_task', { ...args, taskId: created.task.id, senderId: 'a', ownerId: 'c', assigneeId: 'c' }), { code: 'ACCESS_DENIED' });
  await assert.rejects(f.call('c', 'link_status', { deliveryId: created.delivery.deliveryId, targetId: 'a', senderId: 'a' }), { code: 'ACCESS_DENIED' });
  assert.equal(receipts, 0);
  assert.deepEqual((await f.call('c', 'link_task', { action: 'list' })).tasks, []);
  const snapshot = (await f.call('a', 'link_task', { action: 'get', taskId: created.task.id })).task;
  snapshot.ownerId = 'c';
  assert.equal((await f.store.read()).tasks[0].ownerId, 'a');
});

test('review: describe identity mismatch cannot authorize a caller or target', async t => {
  const f = await fixture(t);
  const original = f.host.describe;
  f.host.describe = async id => ({ ...await original(id), id: id === 'a' ? 'c' : id });
  await assert.rejects(send(f), { code: 'IDENTITY_MISMATCH' });
  f.host.describe = async id => ({ ...await original(id), id: id === 'b' ? 'c' : id });
  await assert.rejects(send(f), { code: 'IDENTITY_MISMATCH' });
  assert.equal(f.deliveries.length, 0);
});

test('review: full in-flight delivery history fails closed instead of evicting intent', async t => {
  const f = await fixture(t, { recentDeliveries: 1 });
  await f.store.mutate(state => state.deliveries.push({ id: 'fixture-pending', senderId: 'c', targetId: 'd', state: 'sending', createdAt: 1 }));
  await assert.rejects(send(f), { code: 'DELIVERY_CAPACITY' });
  assert.deepEqual((await f.store.read()).deliveries.map(x => x.id), ['fixture-pending']);
  assert.equal(f.deliveries.length, 0);
});

test('review: restarted unknown cannot be evicted to admit a send or silently resend its requestId', async t => {
  const f = await fixture(t, { recentDeliveries: 1 });
  f.host.deliver = async input => { f.deliveries.push(input); throw new Error('fixture uncertainty after enqueue'); };
  await assert.rejects(send(f, 'a', { requestId: 'uncertain-key' }), { transport: 'unknown' });
  await f.restart();
  await assert.rejects(send(f, 'a', { requestId: 'new-key' }), { code: 'DELIVERY_CAPACITY' });
  const replay = await send(f, 'a', { requestId: 'uncertain-key' });
  assert.equal(replay.transport, 'unknown');
  assert.equal(replay.replayed, true);
  assert.equal(f.deliveries.length, 1);
  assert.equal((await f.store.read()).deliveries.length, 1);
});

test('review: retention eviction cannot reset in-process pair rate; rate bookkeeping capacity converges', async t => {
  const f = await fixture(t, { recentDeliveries: 1, maxMessagesPerMinute: 2 });
  await send(f);
  await send(f, 'b', { targetId: 'a' });
  assert.equal((await f.store.read()).deliveries.length, 1);
  await assert.rejects(send(f), { code: 'RATE_LIMITED' });
  await assert.rejects(send(f, 'c', { targetId: 'd' }), { code: 'RATE_LIMITED' });
  f.tick(60000);
  await send(f, 'c', { targetId: 'd' });
  assert.equal(f.deliveries.length, 3);
  await assert.rejects(send(f), { code: 'RATE_LIMITED' });
  f.tick(60000);
  await send(f);
  assert.equal(f.deliveries.length, 4);
});

test('review: update versus owner cancellation has exactly one CAS winner without messages', async t => {
  const f = await fixture(t);
  const created = await create(f);
  const taskId = created.task.id;
  const outcomes = await Promise.allSettled([
    f.call('b', 'link_task', { action: 'update', taskId, revision: 1, status: 'working', progress: 'fixture work' }),
    f.call('a', 'link_task', { action: 'cancel', taskId, revision: 1, reason: 'fixture cancel' }),
  ]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(x => x.status === 'rejected');
  assert.ok(['REVISION_CONFLICT', 'TASK_TERMINAL'].includes(rejected.reason.code));
  assert.equal((await f.store.read()).tasks[0].revision, 2);
  assert.equal(f.deliveries.length, 1);
});

test('review: abort after intent commit records failure but never enters the host', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const realMutate = f.store.mutate;
  let mutations = 0;
  f.store.mutate = async callback => {
    const value = await realMutate(callback);
    if (++mutations === 1) controller.abort();
    return value;
  };
  await assert.rejects(f.call('a', 'link_send', { targetId: 'b', message: 'fixture', requestId: 'abort' }, controller.signal), { code: 'ABORTED', transport: 'failed' });
  assert.equal(f.deliveries.length, 0);
  const records = (await f.store.read()).deliveries;
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'failed');
});

test('review: close drains in-flight outcome and already-admitted work; refuses new writes', async t => {
  const f = await fixture(t);
  const entered = deferred(); const release = deferred();
  f.host.deliver = async input => { f.deliveries.push(input); entered.resolve(); await release.promise; return { messageId: 'host-close', mode: 'followup' }; };
  const pending = send(f);
  await entered.promise;
  assert.equal((await f.store.read()).deliveries[0].state, 'sending');
  const queued = f.call('b', 'link_reception', { enabled: false });
  const closed = f.service.close();
  await assert.rejects(send(f), { code: 'SERVICE_CLOSED' });
  release.resolve();
  assert.equal((await pending).transport, 'accepted');
  await queued; await closed;
  const disk = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
  assert.equal(disk.deliveries[0].state, 'accepted');
  assert.equal(disk.reception.b.enabled, false);
});

test('review: host malformed result and persistence uncertainty never trigger implicit retries', async t => {
  const f = await fixture(t);
  f.host.deliver = async input => { f.deliveries.push(input); return {}; };
  await assert.rejects(send(f, 'a', { requestId: 'bad-result' }), { code: 'INVALID_HOST_RESULT', transport: 'unknown' });
  const replay = await send(f, 'a', { requestId: 'bad-result' });
  assert.equal(replay.transport, 'unknown');
  assert.equal(f.deliveries.length, 1);
  const realMutate = f.store.mutate;
  let mutations = 0;
  f.store.mutate = callback => ++mutations === 2 ? Promise.reject(coded('FIXTURE_DISK_FAILURE')) : realMutate(callback);
  await assert.rejects(send(f, 'a', { requestId: 'bad-disk' }), error => error.code === 'PERSISTENCE_UNCERTAIN' && Boolean(error.deliveryId));
  f.store.mutate = realMutate;
  const replay2 = await send(f, 'a', { requestId: 'bad-disk' });
  assert.equal(replay2.transport, 'sending');
  assert.equal(f.deliveries.length, 2);
});

test('review: published numeric bounds and requestId length match runtime validation', async t => {
  const f = await fixture(t);
  for (const [name, key, base] of [
    ['link_sessions', 'limit', {}],
    ['link_activity', 'limit', { targetId: 'b' }],
    ['link_activity', 'maxChars', { targetId: 'b' }],
    ['link_task', 'limit', { action: 'list' }],
  ]) {
    const schema = TOOLS.find(x => x.name === name).parameters.properties[key];
    await f.call('a', name, { ...base, [key]: schema.minimum });
    await f.call('a', name, { ...base, [key]: schema.maximum });
    for (const value of [schema.minimum - 1, schema.maximum + 1, 1.5, '10']) {
      await assert.rejects(f.call('a', name, { ...base, [key]: value }), { code: 'INVALID_ARGUMENT' });
    }
  }
  const max = TOOLS.find(x => x.name === 'link_send').parameters.properties.requestId.maxLength;
  await send(f, 'a', { requestId: 'k'.repeat(max) });
  await assert.rejects(send(f, 'a', { requestId: 'k'.repeat(max + 1) }), { code: 'INVALID_ARGUMENT' });
});

test('review: published maximum progress is accepted by the service', async t => {
  const f = await fixture(t);
  const created = await create(f);
  const max = TOOLS.find(x => x.name === 'link_task').parameters.properties.progress.maxLength;
  const response = await f.call('b', 'link_task', { action: 'update', taskId: created.task.id, revision: 1, progress: 'x'.repeat(max) });
  assert.equal(response.task.progress.length, max);
});
