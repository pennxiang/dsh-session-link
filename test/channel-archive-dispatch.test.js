import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../lib/service.js';

function fixture(extra = {}) {
  let state = { version: 1, deliveries: [], tasks: [], reception: {} };
  const agent = { id: 'caller' };
  const events = [];
  const store = {
    read: async () => structuredClone(state),
    mutate: async fn => { const draft = structuredClone(state); const value = await fn(draft); state = draft; return structuredClone(value); },
    close: async () => { events.push('store-close'); },
  };
  const host = {
    describe: async id => ({ id, title: id, kind: 'session', cwd: '/fixture', live: true, archived: false, status: 'idle', canReceive: true }),
    list: async () => ({ sessions: [{ id: 'peer', title: 'peer', kind: 'session', cwd: '/fixture', live: true, archived: false, status: 'idle', canReceive: true }] }),
    deliver: async value => { events.push(value); return { accepted: true, messageId: 'message-one', transport: 'followup' }; },
    close: async () => { events.push('host-close'); },
  };
  return { service: createService({ host, store, ...extra }), agent, exec: { agent, signal: new AbortController().signal }, events, state: () => state };
}

test('discovery and status attach only scoped read-only communication advice with exact caller', async () => {
  const calls = [];
  const advice = { channel: 'session-link', nativeEligibility: 'candidate', admission: 'not-probed', recommendedChannel: 'native-if-host-admits', automaticDispatch: false, automaticFallback: false };
  const f = fixture({ communicationPolicy: { inspect: async input => { calls.push(input); return advice; } } });
  try {
    const discovered = await f.service.execute('link_sessions', {}, f.exec);
    assert.deepEqual(discovered.sessions[0].communication, advice);
    const status = await f.service.execute('link_status', { targetId: 'peer' }, f.exec);
    assert.deepEqual(status.session.communication, advice);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.agent, f.agent);
      assert.equal(call.targetId, 'peer');
      assert.equal(call.self.id, 'caller');
      assert.ok(call.signal instanceof AbortSignal);
    }
    assert.deepEqual(f.state().deliveries, []);
    assert.deepEqual(f.state().tasks, []);
    assert.deepEqual(f.events, []);
  } finally { await f.service.close(); }
});

test('a Link send stays visibly Link and dispatches once without a second native task ledger', async () => {
  const f = fixture();
  try {
    const args = { targetId: 'peer', message: 'Substantive result; no automatic ACK required.', requestId: 'one-send' };
    const result = await f.service.execute('link_send', args, f.exec);
    assert.equal(result.channel, 'session-link');
    assert.equal(f.events.length, 1);
    const envelope = JSON.parse(f.events[0].text);
    assert.equal(envelope.channel, 'session-link');
    assert.equal(envelope.lifecycleOwnerChanged, false);
    assert.match(envelope.channelPolicy, /native/i);
    assert.equal(f.state().deliveries.length, 1);
    assert.equal(f.state().tasks.length, 0);
    const replay = await f.service.execute('link_send', args, f.exec);
    assert.equal(replay.replayed, true);
    assert.equal(replay.channel, 'session-link');
    assert.equal(f.events.length, 1);
  } finally { await f.service.close(); }
});

test('archive dispatch preserves exact caller and control operation, then drains before store close', async () => {
  const calls = [];
  const sequence = [];
  const archiver = {
    execute: async (args, exec) => { calls.push({ args, exec }); return { operation: args.action === 'list' ? 'archive-discovery' : 'archive', channel: 'session-link-control', targetId: args.targetId }; },
    close: async () => { sequence.push('archiver'); },
  };
  const f = fixture({ sessionArchiver: archiver });
  const list = { action: 'list', query: 'exact title', limit: 1 };
  const write = { action: 'archive', targetId: 'peer', requestId: 'archive-one' };
  assert.equal((await f.service.execute('link_session_archive', list, f.exec)).operation, 'archive-discovery');
  const result = await f.service.execute('link_session_archive', write, f.exec);
  assert.equal(result.channel, 'session-link-control');
  assert.equal(result.operation, 'archive');
  assert.equal(calls[0].args, list);
  assert.equal(calls[1].args, write);
  for (const call of calls) assert.equal(call.exec.agent, f.agent);
  await f.service.close();
  assert.deepEqual(sequence, ['archiver']);
  assert.deepEqual(f.events, ['store-close', 'host-close']);
});

test('held archive mutation does not block read-only discovery and admitted mutation drains on close', async () => {
  let finish; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { finish = resolve; });
  let archiverClosed = false;
  const f = fixture({ sessionArchiver: {
    execute: async args => args.action === 'list' ? { operation: 'archive-discovery' } : (entered(), await held, { operation: 'archive' }),
    close: async () => { archiverClosed = true; },
  } });
  const pending = f.service.execute('link_session_archive', { action: 'archive', targetId: 'peer', requestId: 'held' }, f.exec);
  await started;
  assert.equal((await f.service.execute('link_sessions', {}, f.exec)).sessions[0].id, 'peer');
  assert.equal((await f.service.execute('link_session_archive', { action: 'list' }, f.exec)).operation, 'archive-discovery');
  const closing = f.service.close();
  await Promise.resolve();
  assert.equal(archiverClosed, false);
  assert.deepEqual(f.events, []);
  finish();
  await pending;
  await closing;
  assert.equal(archiverClosed, true);
  await assert.rejects(f.service.execute('link_session_archive', { action: 'list' }, f.exec), { code: 'SERVICE_CLOSED' });
});

test('missing archive capability fails without removing the original tools', async () => {
  const f = fixture();
  try {
    await assert.rejects(f.service.execute('link_session_archive', { action: 'list' }, f.exec), { code: 'ARCHIVE_UNAVAILABLE' });
    assert.equal((await f.service.execute('link_sessions', {}, f.exec)).sessions.length, 1);
  } finally { await f.service.close(); }
});

test('pure communication metadata waits are bounded and never hold unrelated mutations', async () => {
  const f = fixture({ metadataTimeoutMs: 20, communicationPolicy: { inspect: () => new Promise(() => {}) } });
  // Production deadline timers are intentionally unref'ed; keep this isolated
  // Node test alive without changing that shutdown contract.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const discovery = f.service.execute('link_sessions', {}, f.exec);
    const rejected = assert.rejects(discovery, error => ['METADATA_TIMEOUT', 'READ_TIMEOUT'].includes(error.code));
    assert.equal((await f.service.execute('link_reception', { enabled: false }, f.exec)).enabled, false);
    await rejected;
  } finally { clearInterval(keepAlive); await f.service.close(); }
});
