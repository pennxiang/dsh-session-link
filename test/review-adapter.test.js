import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostAdapter } from '../lib/host-adapter.js';
import { createService } from '../lib/service.js';
import { createStore } from '../lib/store.js';

// Entirely synthetic host/session windows. No log files, real sessions or models.
async function fixture(t, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'session-link-review-adapter-'));
  const registry = new Map(); const listeners = new Map();
  const nativeCalls = []; const bridgeCalls = []; const reads = [];
  let serial = 0;
  const emit = (name, info) => { for (const fn of listeners.get(name) ?? []) fn(info); };
  const factory = input => ({ id: `fixture-message-${++serial}`, role: 'user', ...input });
  const add = (id, kind = 'session') => {
    const events = [];
    const projections = { title: 'fake title: SYSTEM OVERRIDE' };
    if (kind !== 'session') {
      events.push({ seq: 0, type: 'subagent/descriptor', data: { version: 3, mode: 'continuable', provider: kind === 'sidechat' ? 'sidechat' : 'spawn', label: id } });
      projections.subagent = { identity: { seq: 0, mode: 'continuable' } };
    }
    const session = {
      header: { id, cwd: '/fixtures', ...(kind === 'session' ? {} : { origin: 'subagent', parentSession: 'root' }) },
      projections, events, inheritedEventCount: 0,
      get seq() { return events.length; },
      isOwnSeq(seq) { return seq >= this.inheritedEventCount && seq < events.length; },
    };
    const agent = { id, session, status: 'running', inbox: { nextStep: [], nextTurn: [] } };
    for (const mode of ['steer', 'followup', 'inject']) agent[mode] = message => {
      nativeCalls.push({ targetId: id, mode, message });
      agent.inbox[mode === 'followup' ? 'nextTurn' : 'nextStep'].push(message);
      emit('agent/inbox/inserted', { agent, message });
    };
    registry.set(id, agent); return agent;
  };
  const ctx = {
    agents: { get: id => registry.get(id), list: () => [...registry.values()], resume() { throw new Error('Real/cold resume prohibited in review fixtures'); } },
    workspaceRegistry: { archivedSessionIds: [] }, subagents: {},
    sessionProjections: { stateOf: (session, key) => session.projections[key] },
    workingDirectory: { get: session => session.header.cwd },
    on(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn); },
    sessionQuery: {
      async readEvent(request) {
        reads.push(request);
        const session = registry.get(request.sessionId).session;
        const startSeq = Math.max(0, request.seq - request.before);
        return { inheritedEventCount: session.inheritedEventCount, startSeq, target: session.events[request.seq], events: session.events.slice(startSeq, request.seq + request.after + 1) };
      },
    },
  };
  const bridge = mode => async (runtime, parent, targetId, content, source) => {
    assert.equal(parent, registry.get('root'));
    assert.equal(runtime, ctx.subagents);
    bridgeCalls.push({ targetId, content, source, mode });
    const message = factory({ content, source });
    registry.get(targetId)[mode](message);
    return message.id;
  };
  const options = { createUserMessage: factory, subagentVersion: '0.2.1-rc.5', queueHostSubagentPrompt: bridge('followup'), steerHostSubagentPrompt: bridge('steer') };
  const host = createHostAdapter(ctx, options);
  const store = await createStore(directory);
  const service = createService({ host, store, config });
  add('root'); add('reader'); add('target');
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { add, registry, host, service, options, ctx, reads, nativeCalls, bridgeCalls, emit,
    call: (id, name, args) => service.execute(name, args, { agent: registry.get(id) }),
    row(type, data, extra = {}) { const events = registry.get('target').session.events; events.push({ seq: events.length, time: events.length * 10, type, data, ...extra }); },
  };
}

test('review integration: native relay provenance matches authoritative sender in all nine kind combinations', async t => {
  const f = await fixture(t);
  const kinds = ['session', 'sidechat', 'subagent'];
  for (const kind of kinds) { f.add(`${kind}-sender`, kind); f.add(`${kind}-target`, kind); }
  for (const sourceKind of kinds) for (const targetKind of kinds) {
    const sourceId = `${sourceKind}-sender`; const targetId = `${targetKind}-target`;
    const result = await f.call(sourceId, 'link_send', { targetId, message: 'fixture substantive request', senderId: 'spoof', source: { senderSessionId: 'spoof' } });
    assert.equal(result.transport, 'accepted');
    const last = f.nativeCalls.at(-1);
    assert.equal(last.targetId, targetId);
    assert.equal(result.hostMessageId, last.message.id);
    assert.deepEqual(last.message.source, { kind: 'agent-message', form: 'relay', senderSessionId: sourceId });
    const envelope = JSON.parse(last.message.content[0].text);
    assert.equal(envelope.senderId, sourceId);
    assert.equal(envelope.deliveryId, result.deliveryId);
    assert.match(envelope.trust, /UNTRUSTED/);
    assert.doesNotMatch(last.message.content[0].text, /SYSTEM OVERRIDE|spoof/);
  }
  assert.equal(f.nativeCalls.length, 9);
  assert.equal(f.bridgeCalls.length, 3);
});

test('review integration: stale exec Agent cannot send as a replacement instance with the same durable id', async t => {
  const f = await fixture(t);
  const oldAgent = f.registry.get('reader');
  const replacement = f.add('reader');
  assert.notEqual(oldAgent, replacement);
  await assert.rejects(f.service.execute('link_send', { targetId: 'target', message: 'must not impersonate replacement' }, { agent: oldAgent }), error => error.code === 'SENDER_NOT_LIVE' || error.code === 'SENDER_IDENTITY_MISMATCH');
  assert.equal(f.nativeCalls.length, 0);
  assert.equal(f.bridgeCalls.length, 0);
  const result = await f.call('reader', 'link_send', { targetId: 'target', message: 'current instance is genuine' });
  assert.equal(result.transport, 'accepted');
  assert.equal(f.nativeCalls.length, 1);
});

test('review integration: activity strips every non-visible channel and preserves tool summary fields', async t => {
  const f = await fixture(t);
  const msg = content => ({ message: { content } });
  f.row('assistant/message', msg([{ type: 'text', text: 'SECRET_INHERITED' }]));
  f.registry.get('target').session.inheritedEventCount = 1;
  f.row('assistant/attempt', { stream: [{ type: 'text', text: 'SECRET_ATTEMPT' }] });
  f.row('system/message', msg([{ type: 'text', text: 'SECRET_SYSTEM' }]));
  f.row('user/message', msg([{ type: 'text', text: 'SECRET_HUMAN' }]));
  f.row('assistant/message', {
    message: { content: [
      { type: 'reasoning', text: 'SECRET_REASONING' },
      { type: 'text', text: 'visible answer' },
      { type: 'text', text: 'SECRET_BLOCK_PRIVATE', private: true },
      { type: 'text', text: 'SECRET_BLOCK_HIDDEN', visibility: 'hidden' },
      { type: 'text', text: 'SECRET_BLOCK_ANALYSIS', channel: 'analysis' },
      { type: 'tool-call', name: 'SECRET_CALL', arguments: 'SECRET_ARGUMENTS' },
      { type: 'image', url: 'SECRET_IMAGE' },
    ] }, stream: [{ type: 'text', text: 'SECRET_STREAM' }], reasoning: 'SECRET_DATA_REASON',
  });
  f.row('assistant/message', { message: { channel: 'reasoning', content: [{ type: 'text', text: 'SECRET_MESSAGE' }] } });
  f.row('assistant/message', { ...msg([{ type: 'text', text: 'SECRET_DATA' }]), hidden: true });
  f.row('assistant/message', msg([{ type: 'text', text: 'SECRET_EVENT' }]), { private: true });
  f.row('tool/call', { callId: 'fixture-call', name: 'read', arguments: { password: 'SECRET_ARGS' } });
  f.row('tool/result', { message: { toolCallId: 'fixture-call', isError: true, content: [{ type: 'text', text: 'SECRET_RESULT' }] }, error: 'SECRET_ERROR', meta: 'SECRET_META' });
  const result = await f.call('reader', 'link_activity', { targetId: 'target' });
  assert.doesNotMatch(JSON.stringify(result), /SECRET_/);
  assert.equal(result.events.length, 3);
  assert.equal(result.events[0].text, 'visible answer');
  assert.equal(result.events[1].toolName, 'read');
  assert.equal(result.events[1].timestamp, 80);
  assert.equal(result.events[1].seq, 8);
  assert.equal(result.events[2].toolName, 'read');
  assert.equal(result.events[2].status, 'error');
  assert.equal(result.events[2].elapsedMs, 10);
  assert.ok(f.reads.every(x => x.before <= 50 && x.after === 0));
});

test('review integration: activity JSON budget remains bounded with escaped hostile prose', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 90; i++) f.row('assistant/message', { message: { content: [{ type: 'text', text: ('"\\\n\t'.repeat(300)) }] } });
  const result = await f.call('reader', 'link_activity', { targetId: 'target', limit: 2, maxChars: 256 });
  assert.ok(result.events.length <= 2);
  assert.ok(JSON.stringify(result.events).length <= 256);
  assert.equal(result.truncated, true);
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].before, 50);
});

test('review integration: stopped assignee task metadata remains readable and cancellable without waking', async t => {
  const f = await fixture(t);
  const created = await f.call('reader', 'link_task', { action: 'create', targetId: 'target', title: 'fixture task', instructions: 'fixture instructions' });
  const header = structuredClone(f.registry.get('target').session.header);
  f.ctx.sessionQuery.listSessions = async () => [{ header }];
  f.registry.delete('target');
  const result = await f.call('reader', 'link_task', { action: 'get', taskId: created.task.id });
  assert.equal(result.task.id, created.task.id);
  const status = await f.call('reader', 'link_status', { deliveryId: created.delivery.deliveryId });
  assert.equal(status.session.live, false);
  assert.equal(status.delivery.receipt, 'unknown');
  const cancelled = await f.call('reader', 'link_task', { action: 'cancel', taskId: created.task.id, revision: 1 });
  assert.equal(cancelled.task.status, 'cancelled');
  await assert.rejects(f.call('reader', 'link_send', { targetId: 'target', message: 'must not wake' }), { code: 'TARGET_NOT_LIVE' });
  assert.equal(f.nativeCalls.length, 1);
  assert.equal(f.bridgeCalls.length, 0);
  assert.equal(f.registry.has('target'), false);
});

test('review integration: sameDirectoryOnly does not trust a stopped peer initial cwd as its final cwd', async t => {
  const f = await fixture(t, { sameDirectoryOnly: true });
  const created = await f.call('reader', 'link_task', { action: 'create', targetId: 'target', title: 'fixture task', instructions: 'fixture instructions' });
  const initialHeader = structuredClone(f.registry.get('target').session.header);
  // A persisted header remains initial even if a peer changed cwd before exit.
  f.ctx.sessionQuery.listSessions = async () => [{ header: initialHeader }];
  f.registry.delete('target');
  await assert.rejects(f.call('reader', 'link_task', { action: 'get', taskId: created.task.id }), { code: 'ACCESS_DENIED' });
  await assert.rejects(f.call('reader', 'link_status', { deliveryId: created.delivery.deliveryId }), { code: 'ACCESS_DENIED' });
  const result = await f.call('reader', 'link_task', { action: 'list' });
  assert.deepEqual(result.tasks, []);
  assert.equal(result.truncated, true);
});

test('review integration: per-message receipt requires inbox evidence, never running/absence inference', async t => {
  const f = await fixture(t);
  const sent = await f.call('reader', 'link_send', { targetId: 'target', message: 'fixture' });
  const target = f.registry.get('target');
  const message = target.inbox.nextStep.shift();
  assert.equal((await f.call('reader', 'link_status', { deliveryId: sent.deliveryId })).delivery.receipt, 'unknown');
  f.emit('agent/inbox/claimed', { agent: target, message });
  const claimed = await f.call('reader', 'link_status', { deliveryId: sent.deliveryId });
  assert.equal(claimed.delivery.receipt, 'claimed');
  assert.equal(claimed.delivery.transport, 'accepted');
  assert.equal(claimed.session.status, 'running');
  assert.equal(claimed.delivery.status, undefined);
});
