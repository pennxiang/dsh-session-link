import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter } from '../lib/host-adapter.js';

function fixture() {
  const registry = new Map();
  const listeners = new Map();
  const reads = [];
  const deliveries = [];
  const bridges = [];
  let serial = 0;
  const emit = (event, info) => { for (const fn of listeners.get(event) ?? []) fn(info); };
  const createUserMessage = input => ({ id: `message-${++serial}`, role: 'user', ...input });
  const ctx = {
    agents: { get: id => registry.get(id), list: () => [...registry.values()],
      roots: () => [...registry.values()].filter(agent => !agent.runtimeParent),
      resume() { throw new Error('NEVER RESUME'); } },
    workspaceRegistry: { archivedSessionIds: [] },
    workingDirectory: { get: session => session.currentCwd },
    subagents: {},
    sessionProjections: { stateOf: (session, key) => session.projections[key] },
    sessionQuery: {
      async readEvent(request, signal) {
        if (signal?.aborted) throw new Error('abort');
        reads.push(request);
        const session = registry.get(request.sessionId)?.session;
        if (!session) throw new Error('missing');
        const startSeq = Math.max(0, request.seq - request.before);
        const endSeq = Math.min(session.events.length - 1, request.seq + request.after);
        return { session: session.header, inheritedEventCount: session.inheritedEventCount,
          target: session.events[request.seq], events: session.events.slice(startSeq, endSeq + 1), startSeq, endSeq };
      },
      async listSessions() { return [{ header: { id: 'cold-child', origin: 'subagent', parentSession: 'root' }, live: true, persisted: true }]; },
    },
    on(event, listener) {
      const group = listeners.get(event) ?? new Set();
      group.add(listener);
      listeners.set(event, group);
      return () => group.delete(listener);
    },
  };
  const add = (id, kind = 'session', status = 'idle', parentId = 'root') => {
    const events = [];
    const projections = { title: `Title ${id}` };
    if (kind !== 'session') {
      events.push({ seq: 0, type: 'subagent/descriptor', time: 1, data: { version: 3, provider: kind === 'sidechat' ? 'sidechat' : 'spawn', mode: 'continuable', label: id } });
      projections.subagent = { identity: { mode: 'continuable', seq: 0, label: id } };
    }
    const session = {
      header: { id, cwd: '/original', ...(kind !== 'session' ? { origin: 'subagent', parentSession: parentId } : {}) },
      currentCwd: `/current/${id}`, events, projections, inheritedEventCount: 0,
      get seq() { return events.length; },
      isOwnSeq: seq => seq >= session.inheritedEventCount && seq < events.length,
      ownEvents() { throw new Error('Deprecated ownEvents MUST NOT be called'); },
      snapshotEvents() { throw new Error('Deprecated snapshotEvents MUST NOT be called'); },
      eventAt() { throw new Error('Deprecated eventAt MUST NOT be called'); },
    };
    const agent = { id, session, status, ...(kind === 'subagent' ? { runtimeParent: parentId } : {}), inbox: { nextTurn: [], nextStep: [] } };
    for (const mode of ['followup', 'steer', 'inject']) agent[mode] = message => {
      deliveries.push({ targetId: id, mode, message });
      agent.inbox[mode === 'followup' ? 'nextTurn' : 'nextStep'].push(message);
      emit('agent/inbox/inserted', { agent, message });
    };
    registry.set(id, agent);
    return agent;
  };
  const bridge = mode => async (runtime, parent, targetId, content, source, signal) => {
    bridges.push({ runtime, parent, targetId, content, source, signal, mode });
    const message = createUserMessage({ content, source });
    registry.get(targetId)[mode](message);
    return message.id;
  };
  const options = { createUserMessage, subagentVersion: '0.2.1-rc.5',
    queueHostSubagentPrompt: bridge('followup'), steerHostSubagentPrompt: bridge('steer') };
  const host = createHostAdapter(ctx, options);
  return { registry, listeners, reads, deliveries, bridges, emit, ctx, add, options, host };
}

for (const senderKind of ['session', 'sidechat', 'subagent']) {
  for (const targetKind of ['session', 'sidechat', 'subagent']) {
    test(`live ${senderKind} -> ${targetKind} retains real author and host message id`, async () => {
      const f = fixture();
      f.add('root');
      const sender = f.add('sender', senderKind);
      const target = f.add('target', targetKind, 'running');
      const result = await f.host.deliver({ senderId: sender.id, targetId: target.id, text: 'peer request' });
      const accepted = f.deliveries.at(-1);
      assert.equal(result.messageId, accepted.message.id);
      assert.equal(result.mode, 'steer');
      assert.equal(result.targetStatus, 'running');
      assert.deepEqual(accepted.message.source, { kind: 'agent-message', form: 'relay', senderSessionId: sender.id });
      assert.deepEqual(accepted.message.content, [{ type: 'text', text: 'peer request' }]);
      assert.equal(f.bridges.length, targetKind === 'subagent' ? 1 : 0);
      if (targetKind === 'subagent') assert.equal(f.bridges[0].parent, f.registry.get('root'));
    });
  }
}

test('auto idle followup; explicit steer/followup/inject preserve modes', async () => {
  const f = fixture(); f.add('a'); f.add('b');
  assert.equal((await f.host.deliver({ senderId: 'a', targetId: 'b', text: 'x' })).mode, 'followup');
  for (const mode of ['steer', 'followup', 'inject']) {
    if (mode === 'inject') f.registry.get('b').status = 'running';
    assert.equal((await f.host.deliver({ senderId: 'a', targetId: 'b', text: 'x', mode })).mode, mode);
  }
});

test('inject refuses idle ordinary and sidechat targets without queueing', async () => {
  for (const kind of ['session', 'sidechat']) {
    const f = fixture(); f.add('sender'); f.add('target', kind);
    await assert.rejects(f.host.deliver({ senderId: 'sender', targetId: 'target', text: 'x', mode: 'inject' }), { code: 'TARGET_NOT_RUNNING', definitelyNotDelivered: true });
    assert.equal(f.deliveries.length, 0);
  }
});

test('exact senderAgent rejects a stale same-id execution object', async () => {
  const f = fixture(); const oldSender = f.add('sender'); f.add('target');
  const replacement = f.add('sender');
  await assert.rejects(f.host.deliver({ senderId: 'sender', senderAgent: oldSender, targetId: 'target', text: 'x' }), { code: 'SENDER_NOT_LIVE', definitelyNotDelivered: true });
  assert.equal(f.deliveries.length, 0);
  await f.host.deliver({ senderId: 'sender', senderAgent: replacement, targetId: 'target', text: 'x' });
  assert.equal(f.deliveries.length, 1);
});

test('managed inject is explicitly unsupported and never downgraded', async () => {
  const f = fixture(); f.add('root'); f.add('sender'); f.add('child', 'subagent');
  await assert.rejects(f.host.deliver({ senderId: 'sender', targetId: 'child', text: 'x', mode: 'inject' }), { code: 'MODE_UNSUPPORTED', definitelyNotDelivered: true });
  assert.equal(f.bridges.length, 0);
  assert.equal(f.deliveries.length, 0);
});

test('cold targets, ended children, self send and nonlive sender never send', async () => {
  const f = fixture(); f.add('a');
  for (const request of [
    { senderId: 'a', targetId: 'cold-child', code: 'TARGET_NOT_LIVE' },
    { senderId: 'a', targetId: 'a', code: 'SELF_SEND' },
    { senderId: 'unknown', targetId: 'a', code: 'SENDER_NOT_LIVE' },
  ]) await assert.rejects(f.host.deliver({ ...request, text: 'x' }), { code: request.code });
  assert.equal(f.deliveries.length, 0);
});

test('archive registry is authoritative for ordinary, sidechat and managed child', async () => {
  for (const kind of ['session', 'sidechat', 'subagent']) {
    const f = fixture(); f.add('root'); f.add('sender'); f.add('target', kind);
    f.ctx.workspaceRegistry.archivedSessionIds.push('target');
    assert.equal((await f.host.describe('target')).reason, 'TARGET_ARCHIVED');
    await assert.rejects(f.host.deliver({ senderId: 'sender', targetId: 'target', text: 'x' }), { code: 'TARGET_ARCHIVED' });
    assert.equal(f.deliveries.length, 0);
  }
});

test('managed host bridge owns closure and structured-finalization rejection', async () => {
  for (const code of ['ACTIVATION_CLOSING', 'INPUT_CLOSED', 'DRAINING', 'UNAUTHORIZED']) {
    const f = fixture(); f.add('root'); f.add('sender'); f.add('child', 'subagent', 'running');
    const rejectingBridge = async () => { throw Object.assign(new Error('host rejected'), { code }); };
    const host = createHostAdapter(f.ctx, { ...f.options, steerHostSubagentPrompt: rejectingBridge });
    await assert.rejects(host.deliver({ senderId: 'sender', targetId: 'child', text: 'x' }), { code });
    assert.equal(f.deliveries.length, 0, 'must not fall back to unsafe bare steer');
    host.close();
  }
});

test('unknown bridge version, missing parent and one-shot child fail closed', async () => {
  const f = fixture(); f.add('root'); f.add('sender'); const child = f.add('child', 'subagent');
  const unknown = createHostAdapter(f.ctx, { ...f.options, subagentVersion: '0.2.2' });
  await assert.rejects(unknown.deliver({ senderId: 'sender', targetId: 'child', text: 'x' }), { code: 'TARGET_LIFECYCLE_UNAVAILABLE' });
  unknown.close();
  f.registry.delete('root');
  await assert.rejects(f.host.deliver({ senderId: 'sender', targetId: 'child', text: 'x' }), { code: 'TARGET_PARENT_NOT_LIVE' });
  child.session.events[0].data.mode = 'one-shot';
  const oneShot = createHostAdapter(f.ctx, f.options);
  await assert.rejects(oneShot.deliver({ senderId: 'sender', targetId: 'child', text: 'x' }), { code: 'TARGET_NOT_CONTINUABLE' });
  oneShot.close();
  assert.equal(f.deliveries.length, 0);
});

test('unknown lifecycle status is never silently treated as idle', async () => {
  const f = fixture(); f.add('sender'); f.add('target', 'session', 'closing');
  assert.equal((await f.host.describe('target')).canReceive, false);
  await assert.rejects(f.host.deliver({ senderId: 'sender', targetId: 'target', text: 'x' }), { code: 'TARGET_LIFECYCLE_UNAVAILABLE' });
});

test('abort is checked before and after async descriptor reads', async () => {
  const f = fixture(); f.add('sender'); f.add('target', 'sidechat');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.host.deliver({ senderId: 'sender', targetId: 'target', text: 'x', signal: controller.signal }), { code: 'ABORTED' });
  const second = new AbortController();
  const read = f.ctx.sessionQuery.readEvent;
  f.ctx.sessionQuery.readEvent = async (...args) => { const result = await read(...args); second.abort(); return result; };
  await assert.rejects(f.host.deliver({ senderId: 'sender', targetId: 'target', text: 'x', signal: second.signal }), { code: 'ABORTED' });
  assert.equal(f.deliveries.length, 0);
});

test('replaced target or sender during preparation cannot receive', async () => {
  for (const who of ['sender', 'target']) {
    const f = fixture(); f.add('sender'); f.add('target', 'sidechat');
    const read = f.ctx.sessionQuery.readEvent;
    f.ctx.sessionQuery.readEvent = async (...args) => { const result = await read(...args); f.add(who); return result; };
    await assert.rejects(f.host.deliver({ senderId: 'sender', targetId: 'target', text: 'x' }), { code: who === 'sender' ? 'SENDER_NOT_LIVE' : 'TARGET_NOT_LIVE' });
    assert.equal(f.deliveries.length, 0);
  }
});

test('factory reentrancy is checked before direct send', async () => {
  const f = fixture(); f.add('sender'); f.add('target');
  const host = createHostAdapter(f.ctx, { createUserMessage(input) { f.registry.delete('target'); return { id: 'x', ...input }; } });
  await assert.rejects(host.deliver({ senderId: 'sender', targetId: 'target', text: 'x' }), { code: 'TARGET_NOT_LIVE' });
  assert.equal(f.deliveries.length, 0);
  host.close();
});

test('native acceptance followed by abort remains accepted, never auto retries', async () => {
  const f = fixture(); f.add('sender'); const target = f.add('target');
  const controller = new AbortController(); const native = target.followup;
  target.followup = message => { native(message); controller.abort(); };
  const result = await f.host.deliver({ senderId: 'sender', targetId: 'target', text: 'x', signal: controller.signal });
  assert.equal(result.messageId, 'message-1');
  assert.equal(f.deliveries.length, 1);
});

test('list uses real kind, live registry, current cwd and bounded result', async () => {
  const f = fixture(); f.add('root'); f.add('Side Chat misleading title'); f.add('actual-side', 'sidechat'); f.add('child', 'subagent');
  const result = await f.host.list({ limit: 2 });
  assert.equal(result.sessions.length, 2); assert.equal(result.truncated, true);
  const filtered = await f.host.list({ query: 'actual-side' });
  assert.equal(filtered.sessions[0].kind, 'sidechat');
  assert.equal(filtered.sessions[0].cwd, '/current/actual-side');
  assert.equal((await f.host.describe('Side Chat misleading title')).kind, 'session');
  const withCold = await f.host.list({ includeCold: true });
  assert.deepEqual(withCold.sessions.at(-1), { id: 'cold-child', title: 'cold-child', kind: 'subagent', parentId: 'root', status: 'persisted', live: false, archived: false, canReceive: false, reason: 'TARGET_NOT_LIVE' });
});

test('describe preserves historical access via directory metadata without logs or resume', async () => {
  const f = fixture();
  const cold = await f.host.describe('cold-child');
  assert.equal(cold.id, 'cold-child');
  assert.equal(cold.live, false);
  assert.equal(cold.canReceive, false);
  assert.equal(cold.status, 'persisted');
  assert.equal(cold.kind, 'subagent');
  assert.equal(cold.parentId, 'root');
  assert.equal(f.reads.length, 0);
  await assert.rejects(f.host.describe('not-found'), { code: 'SESSION_NOT_FOUND' });
  await assert.rejects(f.host.activity('cold-child'), { code: 'TARGET_NOT_LIVE' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.host.describe('cold-child', { signal: controller.signal }), { code: 'ABORTED' });
});

test('inherited sidechat descriptor cannot relabel a managed child or bypass admission', async () => {
  const f = fixture(); f.add('root'); f.add('sender'); const child = f.add('child', 'sidechat');
  child.session.inheritedEventCount = 1;
  assert.equal((await f.host.describe('child')).kind, 'subagent');
  await assert.rejects(f.host.deliver({ senderId: 'sender', targetId: 'child', text: 'x' }), { code: 'TARGET_NOT_CONTINUABLE' });
});

test('Better Sidebar boundary-stamped seeded root is a live deliverable sidechat', async () => {
  const f = fixture(); f.add('root'); const sender = f.add('sender'); const side = f.add('seeded-side', 'sidechat');
  // Production Better Sidebar appends its own descriptor to the seed, then
  // sets inheritedEventCount=seed.length. Its Agent has no runtime parent.
  side.session.header.isSeeded = true;
  side.session.events.unshift({ seq: 0, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'INHERITED PRIVATE HISTORY' }] } } });
  side.session.events[1].seq = 1;
  side.session.projections.subagent.identity.seq = 1;
  side.session.inheritedEventCount = 2;
  side.session.events.push({ seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'own reply' }] } } });
  assert.equal(side.session.isOwnSeq(1), false, 'reproduces actual producer boundary');
  const summary = await f.host.describe(side.id);
  assert.equal(summary.kind, 'sidechat');
  assert.equal(summary.canReceive, true);
  const listed = await f.host.list({ query: side.id });
  assert.equal(listed.sessions[0].kind, 'sidechat');
  const receipt = await f.host.deliver({ senderId: sender.id, senderAgent: sender, targetId: side.id, text: 'peer request' });
  assert.equal(receipt.mode, 'followup');
  assert.equal(f.bridges.length, 0, 'plugin-owned sidechat must not go through managed continuation');
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].message.source.senderSessionId, sender.id);
  const activity = await f.host.activity(side.id);
  assert.deepEqual(activity.events.map(event => event.text), ['own reply']);
  assert.doesNotMatch(JSON.stringify(activity), /INHERITED PRIVATE HISTORY/);
  assert.equal(f.reads.filter(read => read.seq === 1 && read.before === 0).length, 1, 'descriptor metadata is cached, not repeatedly read');
});

test('seed-sidechat exception rejects ancestors and managed runtime children', async () => {
  for (const mismatch of ['not-boundary', 'managed-child', 'no-roots-api', 'wrong-root-instance', 'not-seeded', 'missing-parent', 'wrong-provider', 'one-shot', 'wrong-version']) {
    const f = fixture(); f.add('root'); f.add('sender'); const side = f.add('target', 'sidechat');
    side.session.header.isSeeded = true;
    side.session.inheritedEventCount = 1;
    if (mismatch === 'not-boundary') {
      side.session.events.push({ seq: 1, type: 'session/end-seed', data: { inherited: true } });
      side.session.inheritedEventCount = 2;
    }
    if (mismatch === 'managed-child') side.runtimeParent = 'root';
    if (mismatch === 'no-roots-api') delete f.ctx.agents.roots;
    if (mismatch === 'wrong-root-instance') f.ctx.agents.roots = () => [{ ...side }];
    if (mismatch === 'not-seeded') side.session.header.isSeeded = false;
    if (mismatch === 'missing-parent') delete side.session.header.parentSession;
    if (mismatch === 'wrong-provider') side.session.events[0].data.provider = 'spawn';
    if (mismatch === 'one-shot') side.session.events[0].data.mode = 'one-shot';
    if (mismatch === 'wrong-version') side.session.events[0].data.version = 999;
    assert.equal((await f.host.describe(side.id)).kind, 'subagent', mismatch);
    await assert.rejects(f.host.deliver({ senderId: 'sender', targetId: side.id, text: 'x' }), { code: 'TARGET_NOT_CONTINUABLE' }, mismatch);
    assert.equal(f.deliveries.length, 0, mismatch);
  }
});

test('seed-sidechat direct delivery rechecks exact root after preparation', async () => {
  for (const mutationPoint of ['query', 'factory']) {
    const f = fixture(); f.add('root'); f.add('sender'); const side = f.add('target', 'sidechat');
    side.session.header.isSeeded = true;
    side.session.inheritedEventCount = 1;
    const options = { ...f.options };
    if (mutationPoint === 'query') {
      const read = f.ctx.sessionQuery.readEvent;
      f.ctx.sessionQuery.readEvent = async (...args) => { const result = await read(...args); side.runtimeParent = 'root'; return result; };
    } else {
      options.createUserMessage = input => { side.runtimeParent = 'root'; return f.options.createUserMessage(input); };
    }
    const host = createHostAdapter(f.ctx, options);
    await assert.rejects(host.deliver({ senderId: 'sender', targetId: side.id, text: 'x' }), {
      code: mutationPoint === 'query' ? 'TARGET_NOT_CONTINUABLE' : 'TARGET_LIFECYCLE_UNAVAILABLE',
    });
    assert.equal(f.deliveries.length, 0);
    host.close();
  }
});

test('activity strips inherited, hidden, user, reasoning, system and raw tool data', async () => {
  const f = fixture(); const agent = f.add('target');
  const row = (type, data, extra = {}) => agent.session.events.push({ seq: agent.session.events.length, time: agent.session.events.length * 10, type, data, ...extra });
  row('assistant/message', { message: { content: [{ type: 'text', text: 'INHERITED' }] } });
  agent.session.inheritedEventCount = 1;
  row('session/end-seed', { inherited: true });
  row('system/message', { message: { content: [{ type: 'text', text: 'SYSTEM SECRET' }] } });
  row('user/message', { content: [{ type: 'text', text: 'PRIVATE HUMAN PROMPT' }] });
  row('assistant/attempt', { stream: [{ text: 'REASONING ATTEMPT' }] });
  row('assistant/message', { message: { content: [{ type: 'reasoning', text: 'CHAIN OF THOUGHT' }, { type: 'text', text: 'visible answer' }, { type: 'text', text: 'HIDDEN TEXT', hidden: true }] }, stream: [{ text: 'PRIVATE STREAM' }] });
  row('assistant/message', { message: { content: [{ type: 'text', text: 'PRIVATE MESSAGE' }], channel: 'analysis' } });
  row('assistant/message', { message: { content: [{ type: 'text', text: 'HIDDEN EVENT' }] } }, { hidden: true });
  row('tool/call', { callId: 'call-1', name: 'bash', arguments: 'SECRET ARGS' });
  row('tool/result', { message: { toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'SECRET OUTPUT' }] }, error: { reason: 'SECRET ERROR' }, meta: { token: 'SECRET META' } });
  const result = await f.host.activity('target');
  assert.equal(result.events.length, 3);
  assert.equal(result.events[0].text, 'visible answer');
  assert.deepEqual(result.events[1], { seq: 8, timestamp: 80, type: 'tool', toolName: 'bash', status: 'started' });
  assert.deepEqual(result.events[2], { seq: 9, timestamp: 90, type: 'tool', toolName: 'bash', status: 'error', elapsedMs: 10 });
  assert.doesNotMatch(JSON.stringify(result), /INHERITED|SECRET|PRIVATE|CHAIN OF THOUGHT|HIDDEN/);
  assert.ok(f.reads.every(read => read.before <= 50 && read.after === 0));
});

test('activity enforces event, character and line bounds and marks truncation', async () => {
  const f = fixture(); const agent = f.add('target');
  for (let seq = 0; seq < 100; seq++) agent.session.events.push({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: ('x'.repeat(900) + '\n').repeat(100) }] } } });
  const result = await f.host.activity('target', { limit: 2, maxChars: 300 });
  assert.ok(result.events.length <= 2);
  assert.ok(JSON.stringify(result.events).length <= 300);
  assert.ok(result.events.every(event => event.text.split('\n').length <= 40));
  assert.equal(result.truncated, true);
  assert.equal(f.reads.length, 1);
  assert.equal(f.reads[0].before, 50);
});

test('empty activity and missing reader are explicit, no deprecated fallback', async () => {
  const f = fixture(); f.add('empty');
  assert.deepEqual((await f.host.activity('empty')).events, []);
  f.ctx.sessionQuery = undefined;
  await assert.rejects(f.host.activity('empty'), { code: 'ACTIVITY_UNAVAILABLE' });
});

test('receipts distinguish pending, claimed, discarded and unknown, not execution', async () => {
  const f = fixture(); f.add('sender'); const target = f.add('target', 'session', 'running');
  const result = await f.host.deliver({ senderId: 'sender', targetId: 'target', text: 'x' });
  assert.equal((await f.host.receipt('target', result.messageId)).state, 'pending');
  const message = target.inbox.nextStep.shift();
  assert.equal((await f.host.receipt('target', result.messageId)).state, 'unknown', 'absence alone does not mean claimed');
  f.emit('agent/inbox/claimed', { agent: target, message, turn: 1 });
  assert.equal((await f.host.receipt('target', result.messageId)).state, 'claimed');
  const other = await f.host.deliver({ senderId: 'sender', targetId: 'target', text: 'y' });
  const removed = target.inbox.nextStep.shift();
  f.emit('agent/inbox/discarded', { agent: target, message: removed });
  assert.equal((await f.host.receipt('target', other.messageId)).state, 'discarded');
  assert.equal((await f.host.receipt('target', 'missing')).state, 'unknown');
  assert.equal(target.status, 'running');
});

test('bridge claim before Promise resolves is not overwritten with pending', async () => {
  const f = fixture(); f.add('root'); f.add('sender'); const target = f.add('child', 'subagent');
  const host = createHostAdapter(f.ctx, { ...f.options, queueHostSubagentPrompt: async () => {
    f.emit('agent/inbox/claimed', { agent: target, message: { id: 'bridge-fast' }, turn: 1 });
    return 'bridge-fast';
  } });
  await host.deliver({ senderId: 'sender', targetId: 'child', text: 'x' });
  assert.equal((await host.receipt('child', 'bridge-fast')).state, 'claimed');
  host.close();
});

test('uncertain native exception is propagated, not retried or labeled definitely unsent', async () => {
  const f = fixture(); f.add('sender'); const target = f.add('target');
  const native = target.followup;
  target.followup = message => { native(message); throw new Error('post-acceptance listener failure'); };
  await assert.rejects(f.host.deliver({ senderId: 'sender', targetId: 'target', text: 'x' }), error => error.definitelyNotDelivered !== true);
  assert.equal(f.deliveries.length, 1);
});

test('validation rejects invalid modes, limits and oversized messages', async () => {
  const f = fixture(); f.add('sender'); f.add('target');
  await assert.rejects(f.host.list({ limit: NaN }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.host.activity('target', { maxChars: 0 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.host.deliver({ senderId: 'sender', targetId: 'target', text: 'x', mode: 'interrupt' }), { code: 'INVALID_MODE' });
  await assert.rejects(f.host.deliver({ senderId: 'sender', targetId: 'target', text: 'x'.repeat(65537) }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.deliveries.length, 0);
});

test('managed bridge always receives a real AbortSignal even when omitted', async () => {
  const f = fixture(); f.add('root'); f.add('sender'); f.add('child', 'subagent');
  const host = createHostAdapter(f.ctx, { ...f.options, queueHostSubagentPrompt: async (_runtime, _parent, _id, _content, _source, signal) => {
    signal.throwIfAborted();
    return 'bridge-with-signal';
  } });
  assert.equal((await host.deliver({ senderId: 'sender', targetId: 'child', text: 'x' })).messageId, 'bridge-with-signal');
  host.close();
});

test('unknown descriptor version cannot masquerade as sidechat', async () => {
  const f = fixture(); f.add('root'); f.add('sender'); const child = f.add('child', 'sidechat');
  child.session.events[0].data.version = 999;
  assert.equal((await f.host.describe('child')).kind, 'subagent');
  await assert.rejects(f.host.deliver({ senderId: 'sender', targetId: 'child', text: 'x' }), { code: 'TARGET_NOT_CONTINUABLE' });
  assert.equal(f.deliveries.length, 0);
});

test('receipt cache is bounded and does not invent state after eviction', async () => {
  const f = fixture(); const target = f.add('target');
  const host = createHostAdapter(f.ctx, { ...f.options, receiptLimit: 1 });
  f.emit('agent/inbox/claimed', { agent: target, message: { id: 'old' } });
  f.emit('agent/inbox/claimed', { agent: target, message: { id: 'new' } });
  assert.equal((await host.receipt('target', 'old')).state, 'unknown');
  assert.equal((await host.receipt('target', 'new')).state, 'claimed');
  host.close();
});

test('close releases event listeners and rejects subsequent operations', async () => {
  const f = fixture(); f.add('a');
  f.host.close(); f.host.close();
  assert.ok([...f.listeners.values()].every(group => group.size === 0));
  await assert.rejects(f.host.describe('a'), { code: 'ADAPTER_CLOSED' });
});
