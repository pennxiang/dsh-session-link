import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createStore } from '../lib/store.js';
import { createSessionArchiver } from '../lib/session-archive.js';

async function fixture(t, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'session-archive-')); const cwd = join(dir, 'cwd'); await mkdir(cwd);
  const store = await createStore(join(dir, 'ledger'));
  const live = new Map(); const headers = new Map(); const titles = new Map();
  const archived = []; const pinned = []; const calls = []; const events = [];
  const activity = new Map(); let before; let persist; let after; let stop;
  function add(id, { kind = 'session', parentId = 'root', cold = false, title = `Title ${id}`, directory = cwd } = {}) {
    const header = { id, cwd: directory, ...(kind === 'session' ? {} : { origin: 'subagent', parentSession: parentId, isSeeded: kind === 'sidechat' }) };
    headers.set(id, header); if (title !== undefined) titles.set(id, title);
    if (cold) return { id, header };
    const agent = { id, status: 'idle', session: { header, currentCwd: directory }, kind };
    live.set(id, agent); return agent;
  }
  const ctx = {
    agents: { get: id => live.get(id), list: () => [...live.values()], resume() { throw new Error('MUST NOT RESUME'); } },
    sessions: { get: id => live.get(id)?.session },
    workingDirectory: { get: session => session.currentCwd },
    sessionQuery: {
      async listSessions(signal) { signal?.throwIfAborted(); return [...headers.values()].map(header => ({ header, live: live.has(header.id), persisted: true })); },
      readSession() { throw new Error('MUST NOT READ TRANSCRIPT'); },
      readEvent() { throw new Error('ARCHIVE DOES NOT NEED TRANSCRIPT EVENTS'); },
    },
    sessionController: { async list(_request, signal) { signal?.throwIfAborted(); return { items: [...headers.values()].map(header => ({ sessionId: header.id, origin: header.origin, parentSessionId: header.parentSession, cwd: header.cwd, projections: { values: { title: titles.get(header.id), privatePrompt: 'SECRET PROJECTION' } } })) }; } },
    sessionProjections: { cachedSnapshot: session => ({ values: { title: titles.get(session.header.id) } }) },
    workspaceRegistry: {
      archivedSessionIds: archived, pinnedSessionIds: pinned,
      async archiveSession(targetId, options) {
        calls.push({ targetId, options });
        if (archived.includes(targetId)) return;
        if (!headers.has(targetId)) throw Object.assign(new Error('missing'), { name: 'WorkspaceUnknownSessionError', sessionId: targetId });
        await before?.(targetId, options);
        if (!options.stopActivity && activity.has(targetId)) throw Object.assign(new Error('active raw secret'), { name: 'WorkspaceActiveSessionError', sessionId: targetId, activity: activity.get(targetId) });
        await persist?.(targetId);
        archived.push(targetId); const index = pinned.indexOf(targetId); if (index >= 0) pinned.splice(index, 1);
        events.push(['persist', targetId]);
        if (options.stopActivity) { events.push(['stop-request', targetId]); try { await stop?.(targetId); } catch { /* Native registry logs and swallows stop-provider failure. */ } }
        await after?.(targetId);
      },
    },
  };
  add('root'); const caller = add('caller'); add('target');
  const options = { ctx, store, config, now: () => 1000 };
  const archiver = createSessionArchiver(options);
  t.after(async () => { await archiver.close(); await store.close(); await rm(dir, { recursive: true, force: true }); });
  const exec = { agent: caller };
  return { dir, cwd, store, ctx, add, live, headers, titles, archived, pinned, calls, events, activity, caller, exec, options, archiver,
    run: args => archiver.execute({ action: 'archive', targetId: 'target', requestId: 'once', ...args }, exec),
    onBefore: fn => { before = fn; }, onPersist: fn => { persist = fn; }, onAfter: fn => { after = fn; }, onStop: fn => { stop = fn; } };
}

for (const callerKind of ['session', 'sidechat', 'subagent']) for (const targetKind of ['session', 'sidechat', 'subagent']) {
  test(`native archive control permits ${callerKind} caller and ${targetKind} target without delivery restrictions`, async t => {
    const f = await fixture(t); const caller = f.add('caller', { kind: callerKind }); f.add('target', { kind: targetKind });
    f.pinned.push('target');
    const result = await f.archiver.execute({ action: 'archive', targetId: 'target', requestId: 'matrix' }, { agent: caller });
    assert.equal(result.operation, 'archive'); assert.equal(result.channel, 'session-link-control');
    assert.equal(result.archived, true); assert.equal(result.readback, true); assert.equal(result.archiveState, 'succeeded');
    assert.equal(result.stopActivityRequested, false); assert.equal(f.pinned.includes('target'), false);
    assert.deepEqual(f.calls, [{ targetId: 'target', options: { stopActivity: false } }]);
    assert.doesNotMatch(JSON.stringify(result), /allStopped|activityStopped/);
  });
}

test('cold and ungrouped targets archive through native registry without wake or transcript access', async t => {
  const f = await fixture(t); f.live.delete('target');
  assert.equal((await f.run()).archived, true);
  assert.equal(f.live.has('target'), false);
});

test('discovery merges cold cached titles and returns no raw projection or global archive set', async t => {
  const f = await fixture(t); f.add('cold', { cold: true, title: 'Quarterly Research' }); f.add('untitled', { cold: true }); f.titles.delete('untitled');
  f.archived.push('target');
  const found = await f.archiver.execute({ action: 'list', query: 'quarterly' }, f.exec);
  assert.equal(found.operation, 'archive-discovery'); assert.equal(found.sessions[0].id, 'cold');
  assert.equal(found.sessions[0].title, 'Quarterly Research'); assert.equal(found.sessions[0].status, 'persisted');
  const all = await f.archiver.execute({ action: 'list', includeArchived: true }, f.exec);
  assert.equal(all.sessions.find(item => item.id === 'untitled').title, null);
  assert.equal(all.sessions.find(item => item.id === 'untitled').titleAvailable, false);
  assert.equal(all.sessions.find(item => item.id === 'target').archived, true);
  assert.equal(all.sessions.find(item => item.id === 'caller').canArchive, true);
  assert.equal(all.sessions.find(item => item.id === 'caller').isSelf, true);
  assert.equal(all.sessions.find(item => item.id === 'target').isSelf, false);
  assert.doesNotMatch(JSON.stringify(all), /SECRET PROJECTION|archivedSessionIds|pinnedSessionIds/);
  assert.equal((await f.archiver.execute({ action: 'list', limit: 1 }, f.exec)).truncated, true);
});

test('missing cold title capability stays explicit instead of inventing a title', async t => {
  const f = await fixture(t); f.add('cold', { cold: true }); delete f.ctx.sessionController;
  const result = await f.archiver.execute({ action: 'list', query: 'cold' }, f.exec);
  assert.equal(result.sessions[0].title, null); assert.equal(result.sessions[0].titleAvailable, false);
  assert.equal(result.titleCapability, 'live-cache-only');
});

test('active default refuses before persist, projects bounded facts, and never escalates the same request', async t => {
  const f = await fixture(t);
  f.activity.set('target', [{ kind: 'turn', private: 'SECRET', items: [{ id: 'target', label: 'Visible turn', arguments: 'SECRET ARGS', output: 'SECRET OUTPUT' }] }]);
  await assert.rejects(f.run(), error => {
    assert.equal(error.code, 'ACTIVITY_REQUIRES_CONFIRMATION'); assert.equal(error.archived, false);
    assert.match(error.activitySummary, /Visible turn/); assert.doesNotMatch(error.activitySummary, /SECRET/); return true;
  });
  assert.equal(f.events.length, 0); assert.equal(f.archived.includes('target'), false);
  await assert.rejects(f.run({ stopActivity: true }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.run(), error => error.code === 'ACTIVITY_REQUIRES_CONFIRMATION' && error.replayed === true);
  assert.equal(f.calls.length, 1);
  const confirmed = await f.run({ requestId: 'explicit-stop', stopActivity: true });
  assert.equal(confirmed.archived, true); assert.equal(confirmed.stopActivityRequested, true);
  assert.deepEqual(f.events, [['persist', 'target'], ['stop-request', 'target']]);
});

test('Host stop failures do not imply rollback or a claim that all activity stopped', async t => {
  const f = await fixture(t); f.onStop(() => { throw new Error('provider did not stop'); });
  const result = await f.run({ stopActivity: true });
  assert.equal(result.archived, true); assert.equal(result.stopActivityRequested, true);
  assert.equal(result.activityStopped, undefined); assert.equal(result.allStopped, undefined);
});

test('already archived is no-op even with a fresh stop request; same-key concurrency is idempotent', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => f.run({ stopActivity: true })));
  assert.equal(f.calls.length, 1); assert.equal(results.filter(result => result.replayed).length, 4);
  const duplicate = await f.run({ requestId: 'already', stopActivity: true });
  assert.equal(duplicate.alreadyArchived, true); assert.equal(duplicate.stopActivityRequested, false);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.run({ targetId: 'missing' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('btw self is allowed while durable subagent ancestors remain forbidden', async t => {
  const f = await fixture(t);
  const mid = f.add('middle', { kind: 'subagent', parentId: 'root', cold: true });
  const child = f.add('btw', { kind: 'sidechat', parentId: mid.id });
  for (const targetId of ['middle', 'root']) await assert.rejects(f.archiver.execute({ action: 'archive', targetId, requestId: targetId }, { agent: child }), { code: 'ARCHIVE_SELF_OR_ANCESTOR' });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.archiver.execute({ action: 'archive', targetId: 'target', requestId: 'other' }, { agent: child })).archived, true);
  assert.equal((await f.archiver.execute({ action: 'archive', targetId: 'btw', requestId: 'self', archiveScope: 'single' }, { agent: child })).archived, true);
});

test('ordinary fork lineage is not a subagent ownership chain', async t => {
  const f = await fixture(t); f.caller.session.header.parentSession = 'target';
  assert.equal((await f.run()).archived, true);
});

test('archived caller/ancestor, missing ancestry, cyclic ancestry and stale exact caller all reject', async t => {
  const f = await fixture(t); const child = f.add('child', { kind: 'sidechat' });
  f.archived.push('root');
  await assert.rejects(f.archiver.execute({ action: 'archive', targetId: 'target', requestId: 'x' }, { agent: child }), { code: 'SENDER_ARCHIVED' });
  f.archived.length = 0; child.session.header.parentSession = 'missing';
  await assert.rejects(f.archiver.execute({ action: 'list' }, { agent: child }), { code: 'SENDER_LINEAGE_UNAVAILABLE' });
  child.session.header.parentSession = child.id;
  await assert.rejects(f.archiver.execute({ action: 'list' }, { agent: child }), { code: 'SENDER_LINEAGE_UNAVAILABLE' });
  await assert.rejects(f.archiver.execute({ action: 'list' }, { agent: { ...f.caller } }), { code: 'SENDER_NOT_LIVE' });
  assert.equal(f.calls.length, 0);
});

test('strict directory scope rejects different live cwd and all cold cwd guesses', async t => {
  const f = await fixture(t, { sameDirectoryOnly: true }); const other = join(f.dir, 'other'); await mkdir(other);
  f.live.get('target').session.currentCwd = other;
  await assert.rejects(f.run(), { code: 'ACCESS_DENIED' });
  f.live.delete('target');
  await assert.rejects(f.run(), { code: 'ACCESS_DENIED' });
  const list = await f.archiver.execute({ action: 'list' }, f.exec);
  assert.equal(list.sessions.some(item => item.id === 'target'), false);
  assert.equal(f.calls.length, 0);
});

test('strict scope rejects target replacement and current-cwd drift across metadata awaits', async t => {
  for (const drift of ['replace', 'target-cwd', 'source-cwd']) {
    const f = await fixture(t, { sameDirectoryOnly: true }); const other = join(f.dir, 'other'); await mkdir(other);
    const target = f.live.get('target'); let changed = false;
    f.ctx.workingDirectory.get = session => {
      const cwd = session.currentCwd;
      if (session === target.session && !changed) {
        changed = true;
        if (drift === 'replace') f.add('target', { directory: other });
        else if (drift === 'target-cwd') target.session.currentCwd = other;
        else f.caller.session.currentCwd = other;
      }
      return cwd;
    };
    await assert.rejects(f.run(), { code: 'ACCESS_DENIED' });
    assert.equal(f.calls.length, 0);
  }
});

test('caller ancestry rechecks after durable intent, before native archive', async t => {
  const f = await fixture(t); const child = f.add('child', { kind: 'sidechat' });
  const guardedStore = { read: () => f.store.read(), async mutate(fn) {
    const result = await f.store.mutate(fn);
    if (result?.inserted) f.archived.push('root');
    return result;
  } };
  const archiver = createSessionArchiver({ ...f.options, store: guardedStore });
  await assert.rejects(archiver.execute({ action: 'archive', targetId: 'target', requestId: 'scope' }, { agent: child }), { code: 'SENDER_ARCHIVED', state: 'failed' });
  assert.equal(f.calls.length, 0); assert.equal((await f.store.read()).archives[0].state, 'failed');
  await archiver.close();
});

test('preabort has no intent or native call; abort after native submission awaits durable readback', async t => {
  const f = await fixture(t); const first = new AbortController(); first.abort();
  await assert.rejects(f.archiver.execute({ action: 'archive', targetId: 'target', requestId: 'pre' }, { agent: f.caller, signal: first.signal }), { code: 'ABORTED' });
  assert.equal(f.calls.length, 0); assert.equal((await f.store.read()).archives, undefined);
  const during = new AbortController(); f.onBefore(() => during.abort());
  const result = await f.archiver.execute({ action: 'archive', targetId: 'target', requestId: 'during' }, { agent: f.caller, signal: during.signal });
  assert.equal(result.archived, true); assert.equal(result.cancelledAfterSubmission, true);
  assert.equal((await f.store.read()).archives[0].state, 'succeeded');
});

test('intent is durable before side effects; ledger admission failure cannot archive', async t => {
  const f = await fixture(t);
  f.onBefore(async () => { assert.equal((await f.store.read()).archives[0].state, 'archiving'); });
  await f.run();
  const broken = createSessionArchiver({ ...f.options, store: { read: () => f.store.read(), mutate: () => Promise.reject(new Error('disk failed')) } });
  await assert.rejects(broken.execute({ action: 'archive', targetId: 'root', requestId: 'fail' }, f.exec), /disk failed/);
  await broken.close(); assert.equal(f.calls.length, 1);
});

test('native persistence uncertainty and committed-then-error stay unknown/partial without automatic retry', async t => {
  for (const when of ['persist', 'after']) {
    const f = await fixture(t);
    if (when === 'persist') f.onPersist(() => { throw new Error('raw disk secret'); });
    else f.onAfter(() => { throw new Error('postcommit secret'); });
    await assert.rejects(f.run(), { code: when === 'persist' ? 'ARCHIVE_UNCERTAIN' : 'ARCHIVE_PARTIAL', state: when === 'persist' ? 'unknown' : 'partial' });
    await assert.rejects(f.run(), error => error.replayed === true);
    assert.equal(f.calls.length, 1);
    assert.doesNotMatch(JSON.stringify(await f.store.read()), /raw disk secret|postcommit secret/);
  }
});

test('native resolved promise without affirmative archive readback is never success', async t => {
  for (const missing of [false, true]) {
    const f = await fixture(t);
    f.ctx.workspaceRegistry.archiveSession = async () => {
      if (missing) Object.defineProperty(f.ctx.workspaceRegistry, 'archivedSessionIds', { get() { throw new Error('unavailable'); } });
    };
    await assert.rejects(f.run(), { code: 'ARCHIVE_UNCERTAIN', state: 'unknown', readback: missing ? null : false });
    const entry = (await f.store.read()).archives[0];
    assert.equal(entry.state, 'unknown'); assert.equal(entry.result.archived, missing ? null : false);
  }
});

test('target lost at native admission maps known refusal only with confirmed unarchived readback', async t => {
  const f = await fixture(t);
  f.ctx.workspaceRegistry.archiveSession = async () => { throw Object.assign(new Error('secret missing path'), { name: 'WorkspaceUnknownSessionError', sessionId: 'target' }); };
  await assert.rejects(f.run(), { code: 'SESSION_NOT_FOUND', state: 'failed', readback: false });
  assert.doesNotMatch(JSON.stringify(await f.store.read()), /secret missing path/);
});

test('result ledger persistence failure reports truthful archive bit, never success or automatic resend', async t => {
  const f = await fixture(t); let failWrites = false;
  f.onAfter(() => { failWrites = true; });
  const store = { read: () => f.store.read(), mutate: fn => failWrites ? Promise.reject(new Error('result disk failure')) : f.store.mutate(fn) };
  const archiver = createSessionArchiver({ ...f.options, store });
  await assert.rejects(archiver.execute({ action: 'archive', targetId: 'target', requestId: 'result-fail' }, f.exec), { code: 'ARCHIVE_PERSISTENCE_UNCERTAIN', archived: true });
  assert.equal((await f.store.read()).archives[0].state, 'archiving');
  failWrites = false;
  await assert.rejects(archiver.execute({ action: 'archive', targetId: 'target', requestId: 'result-fail' }, f.exec), { code: 'ARCHIVE_UNCERTAIN', replayed: true });
  assert.equal(f.calls.length, 1); await archiver.close();
});

test('restarted archive intent becomes unknown and cannot be repeated', async t => {
  const f = await fixture(t);
  await f.store.mutate(draft => { draft.archives = [{ senderId: 'caller', targetId: 'target', requestId: 'interrupted', fingerprint: createHash('sha256').update(JSON.stringify({ targetId: 'target', stopActivity: false })).digest('hex'), state: 'archiving', stage: 'archive' }]; });
  await assert.rejects(f.run({ requestId: 'interrupted' }), { code: 'ARCHIVE_RESTART_UNKNOWN', state: 'unknown', replayed: true });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.read()).archives[0].state, 'unknown');
});

test('unknown target, capacity, malformed input and missing capability fail closed with lazy mount', async t => {
  const f = await fixture(t, { maxArchives: 1 });
  await assert.rejects(f.run({ targetId: 'missing' }), { code: 'SESSION_NOT_FOUND' });
  await assert.rejects(f.run({ requestId: 'x'.repeat(129) }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.run({ stopActivity: 'true' }), { code: 'INVALID_ARGUMENT' });
  await f.run(); await assert.rejects(f.run({ requestId: 'new' }), { code: 'ARCHIVE_CAPACITY' });
  const headless = createSessionArchiver({ ctx: f.ctx, store: f.store }); delete f.ctx.workspaceRegistry;
  await assert.rejects(headless.execute({ action: 'list' }, f.exec), { code: 'ARCHIVE_HOST_UNAVAILABLE' }); await headless.close();
});

test('close cancels pure lists but drains admitted native side effects and leaves shared store open', async t => {
  const f = await fixture(t);
  let release; const gate = new Promise(resolve => { release = resolve; });
  let entered; const didEnter = new Promise(resolve => { entered = resolve; });
  f.onBefore(async () => { entered(); await gate; });
  const operation = f.run(); await didEnter;
  let closed = false; const closing = f.archiver.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  release(); assert.equal((await operation).archived, true); await closing;
  assert.ok(await f.store.read());
  await assert.rejects(f.run(), { code: 'ARCHIVER_CLOSED' });
});

async function enableCascade(f) {
  const run = f.run; f.run = args => run({ archiveScope: 'related', ...args });
  f.add('child'); f.add('grandchild');
  const workspace = { id: 'workspace', sessionIds: ['target', 'child', 'grandchild', 'caller', 'root'] };
  f.ctx.workspaceRegistry.list = () => [workspace];
  f.ctx.workspaceRegistry.get = id => id === workspace.id ? workspace : undefined;
  f.ctx.waterfall = async (event, { sessionId }) => { assert.equal(event, 'workspace/session-activity'); return f.activity.get(sessionId) ?? []; };
  await f.store.mutate(d => { d.creations = [{ senderId: 'target', sessionId: 'child', state: 'ready' }, { senderId: 'child', sessionId: 'grandchild', state: 'partial' }]; });
  return workspace;
}

test('Tool archive cascades without another tool, preserves idempotency and uses actual caller', async t => {
  const f = await fixture(t); await enableCascade(f);
  const result = await f.run(); assert.equal(result.cascade, true); assert.equal(result.archiveState, 'succeeded');
  assert.deepEqual(f.calls.map(item => item.targetId), ['grandchild', 'child', 'target']);
  assert.equal((await f.run()).replayed, true); assert.equal(f.calls.length, 3);
  await f.store.mutate(d => { d.creations = []; });
  assert.equal((await f.run()).replayed, true); assert.equal(f.calls.length, 3);
  await assert.rejects(f.run({ targetId: 'root' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('Tool active child refuses zero mutations and requires exact plan plus fresh explicit stop', async t => {
  const f = await fixture(t); await enableCascade(f); f.activity.set('child', [{ kind: 'turn' }]); let planId;
  await assert.rejects(f.run(), error => { planId = error.planId; return error.code === 'ACTIVITY_REQUIRES_CONFIRMATION' && typeof planId === 'string'; });
  assert.equal(f.calls.length, 0); assert.equal(f.archived.length, 0);
  await assert.rejects(f.run({ stopActivity: true }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.run({ planId, stopActivity: true }), { code: 'IDEMPOTENCY_CONFLICT' });
  const result = await f.run({ planId, stopActivity: true, requestId: 'confirmed' });
  assert.equal(result.archiveState, 'succeeded'); assert.equal(result.stopActivityRequested, true);
  assert.equal((await f.run({ planId, stopActivity: true, requestId: 'confirmed' })).replayed, true);
});

test('Tool group fences still catch durable ancestors hidden among descendants', async t => {
  for (const forbidden of ['root']) {
    const f = await fixture(t); await enableCascade(f);
    await f.store.mutate(d => d.creations.push({ senderId: 'target', sessionId: forbidden, state: 'ready' }));
    const agent = forbidden === 'caller' ? f.caller : f.add('btw-caller', { kind: 'sidechat', parentId: 'root' });
    await assert.rejects(f.archiver.execute({ action: 'archive', targetId: 'target', requestId: 'group', archiveScope: 'related' }, { agent }), { code: 'ARCHIVE_SELF_OR_ANCESTOR' });
    assert.equal(f.calls.length, 0); assert.equal(f.archived.length, 0);
  }
});

test('Tool directory fence covers every descendant and owner capability stays separate', async t => {
  const f = await fixture(t, { sameDirectoryOnly: true }); await enableCascade(f); f.live.delete('grandchild');
  await assert.rejects(f.run(), { code: 'ACCESS_DENIED' });
  await assert.rejects(f.run({ owner: true }), { code: 'INVALID_ARGUMENT' });
  assert.equal(f.calls.length, 0);
  const g = await fixture(t); await enableCascade(g);
  const plan = await g.archiver.planForOwner({ targetId: 'target', requestId: 'owner', archiveScope: 'related' });
  await assert.rejects(g.run({ planId: plan.planId, requestId: 'tool' }), { code: 'ARCHIVE_PLAN_NOT_FOUND' });
  assert.equal((await g.archiver.commitForOwner({ planId: plan.planId, requestId: 'owner-commit', archiveScope: 'related' })).archiveState, 'succeeded');
});

test('old single-target requestId cannot acquire new descendants or become a cascade commit', async t => {
  const f = await fixture(t); await f.run(); await enableCascade(f);
  const result = await f.run({ archiveScope: undefined }); assert.equal(result.replayed, true); assert.equal(result.cascade, undefined); assert.equal(f.calls.length, 1);
  await assert.rejects(f.run({ planId: 'new' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('Tool creation candidate prefilter must not bypass an in-flight actual child', async t => {
  const f = await fixture(t); await enableCascade(f);
  await f.store.mutate(d => { d.creations = [{ senderId: 'target', sessionId: 'child', state: 'creating' }]; });
  await assert.rejects(f.run(), { code: 'ARCHIVE_GRAPH_UNSTABLE' });
  assert.equal(f.calls.length, 0); assert.equal(f.archived.length, 0);
});

test('Tool missing scope chooses neither group nor stop, and explicit single ignores every descendant', async t => {
  const f = await fixture(t, { sameDirectoryOnly: true }); await enableCascade(f);
  f.live.delete('grandchild'); f.activity.set('child', [{ kind: 'turn' }]);
  await f.store.mutate(d => { d.creations[0].state = 'creating'; });
  await assert.rejects(f.run({ archiveScope: undefined, stopActivity: true }), error => {
    assert.equal(error.code, 'ARCHIVE_SCOPE_REQUIRED'); assert.equal(error.planId, undefined);
    assert.deepEqual(error.allowedScopes, ['single', 'related']); return true;
  });
  assert.equal(f.calls.length, 0);
  const read = f.store.read.bind(f.store);
  f.store.read = async () => { const state = await read(); Object.defineProperty(state, 'creations', { get() { throw new Error('SINGLE MUST NOT READ CREATIONS'); } }); return state; };
  const result = await f.run({ archiveScope: 'single', requestId: 'chosen-single' });
  assert.equal(result.archiveScope, 'single'); assert.equal(result.stopActivityRequested, false);
  assert.deepEqual(f.calls.map(item => item.targetId), ['target']);
});

test('scope choice does not disclose candidate existence before target ancestor or cwd authorization', async t => {
  const f = await fixture(t); await enableCascade(f);
  const child = f.add('btw-caller', { kind: 'sidechat', parentId: 'target' });
  await assert.rejects(f.archiver.execute({ action: 'archive', targetId: 'target', requestId: 'ancestor-choice' }, { agent: child }), error => {
    assert.equal(error.code, 'ARCHIVE_SELF_OR_ANCESTOR'); assert.equal(error.allowedScopes, undefined); return true;
  });
  assert.equal(f.calls.length, 0);
  const g = await fixture(t, { sameDirectoryOnly: true }); await enableCascade(g);
  const other = join(g.dir, 'other'); await mkdir(other); g.live.get('target').session.currentCwd = other;
  const read = g.store.read.bind(g.store);
  g.store.read = async () => { const state = await read(); Object.defineProperty(state, 'creations', { get() { throw new Error('UNAUTHORIZED CANDIDATE READ'); } }); return state; };
  await assert.rejects(g.run({ archiveScope: undefined }), error => {
    assert.equal(error.code, 'ACCESS_DENIED'); assert.equal(error.allowedScopes, undefined); return true;
  });
  assert.equal(g.calls.length, 0);
});

test('Tool single blocks only target unknown, never unknown descendant with pending root', async t => {
  const f = await fixture(t); await enableCascade(f);
  f.onPersist(target => { if (target === 'child') throw new Error('uncertain child'); });
  await assert.rejects(f.run(), { code: 'ARCHIVE_UNCERTAIN' });
  const before = f.calls.length;
  await assert.rejects(f.run({ targetId: 'child', archiveScope: 'single', requestId: 'unknown-retry' }), { code: 'ARCHIVE_PRIOR_UNKNOWN' });
  assert.equal(f.calls.length, before);
  const result = await f.run({ archiveScope: 'single', requestId: 'root-only' });
  assert.equal(result.archived, true); assert.equal(f.calls.at(-1).targetId, 'target');
});

for (const kind of ['session', 'sidechat', 'subagent']) test(`self ${kind} stop persists despite caller cancellation and disposal`, async t => {
  const f = await fixture(t); const caller = f.add('self', { kind }); const controller = new AbortController();
  f.activity.set('self', [{ kind: 'turn' }]);
  const exec = { agent: caller, signal: controller.signal };
  const args = { action: 'archive', targetId: 'self', archiveScope: 'single' };
  await assert.rejects(f.archiver.execute({ ...args, requestId: 'preflight' }, exec), { code: 'ACTIVITY_REQUIRES_CONFIRMATION' });
  assert.equal(f.archived.includes('self'), false);
  f.onStop(target => { if (target === 'self') { controller.abort(); f.live.delete('self'); } });
  const result = await f.archiver.execute({ ...args, requestId: 'confirmed', stopActivity: true }, exec);
  assert.equal(result.archived, true); assert.equal(result.cancelledAfterSubmission, true);
  assert.equal(result.archiveScope, 'single'); assert.equal(result.allStopped, undefined);
  const entry = (await f.store.read()).archives.find(item => item.requestId === 'confirmed');
  assert.equal(entry.state, 'succeeded'); assert.equal(entry.result.cancelledAfterSubmission, true);
});

test('related self root is last and durable result survives its final stop/disposal', async t => {
  const f = await fixture(t); await enableCascade(f); const controller = new AbortController();
  const caller = f.live.get('target'); const exec = { agent: caller, signal: controller.signal }; let planId;
  const args = { action: 'archive', targetId: 'target', archiveScope: 'related', stopActivity: true };
  await assert.rejects(f.archiver.execute({ ...args, requestId: 'prepare' }, exec), error => { planId = error.planId; return error.code === 'ACTIVITY_REQUIRES_CONFIRMATION'; });
  f.onStop(target => { if (target === 'target') { controller.abort(); f.live.delete(target); } });
  const result = await f.archiver.execute({ ...args, planId, requestId: 'confirm' }, exec);
  assert.equal(result.archiveState, 'succeeded'); assert.equal(result.cancelledAfterSubmission, true);
  assert.deepEqual(f.calls.map(item => item.targetId), ['grandchild', 'child', 'target']);
  assert.equal((await f.store.read()).archivePlans[0].state, 'succeeded');
});

test('self entry inside another related group may stop continuation without losing its known archive', async t => {
  const f = await fixture(t); await enableCascade(f); const controller = new AbortController();
  await f.store.mutate(d => d.creations.push({ senderId: 'target', sessionId: 'caller', state: 'ready' }));
  f.exec.signal = controller.signal; let planId;
  await assert.rejects(f.run({ stopActivity: true }), error => { planId = error.planId; return error.code === 'ACTIVITY_REQUIRES_CONFIRMATION'; });
  f.onStop(target => { if (target === 'caller') { controller.abort(); f.live.delete(target); } });
  await assert.rejects(f.run({ planId, requestId: 'confirm', stopActivity: true }), error => {
    assert.equal(error.archiveState, 'partial'); assert.ok(error.archivedIds.includes('caller'));
    assert.ok(error.remaining.includes('target')); assert.equal(error.cancelledAfterSubmission, true); return true;
  });
  assert.equal(f.archived.includes('target'), false);
  assert.equal((await f.store.read()).archivePlans[0].items.find(item => item.id === 'caller').state, 'archived');
});

test('hanging metadata is bounded and close never resumes or archives while abandoning a read', async t => {
  const f = await fixture(t); f.ctx.sessionQuery.listSessions = () => new Promise(() => {});
  const pending = assert.rejects(f.archiver.execute({ action: 'list' }, f.exec), { code: 'READ_SCOPE_CLOSED' });
  await f.archiver.close(); await pending; assert.equal(f.calls.length, 0);
  const short = createSessionArchiver({ ...f.options, metadataTimeoutMs: 20 }); const keeper = setTimeout(() => {}, 1000);
  try { await assert.rejects(short.execute({ action: 'archive', targetId: 'target', requestId: 'timeout' }, f.exec), { code: 'METADATA_TIMEOUT' }); }
  finally { clearTimeout(keeper); await short.close(); }
  assert.equal(f.calls.length, 0);
});
