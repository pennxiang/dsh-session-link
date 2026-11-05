import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveCascade } from '../lib/archive-cascade.js';

function fixture(t, config = {}) {
  let state = { creations: [] }; const headers = new Map(); const agents = new Map(); const archived = []; const calls = []; const active = new Map(); const queried = [];
  const members = ['root', 'child', 'grandchild']; const other = [];
  let afterArchive; let duringActivity; let writes; let failArchive;
  function add(id, header = {}, live = true) {
    const value = { id, cwd: '/tmp', ...header }; headers.set(id, value);
    if (live) agents.set(id, { id, status: 'idle', session: { header: value } });
  }
  for (const name of [...members, 'caller']) add(name);
  state.creations.push({ senderId: 'root', sessionId: 'child', state: 'ready' }, { senderId: 'child', sessionId: 'grandchild', state: 'unknown' });
  const ws = { id: 'workspace', sessionIds: members }; const ws2 = { id: 'other', sessionIds: other };
  const ctx = {
    agents: { get: id => agents.get(id), list: () => [...agents.values()], resume() { throw new Error('NO WAKE'); } },
    sessionQuery: { async listSessions() { return [...headers.values()].map(header => ({ header })); }, readSession() { throw new Error('NO TRANSCRIPT'); } },
    workingDirectory: { get: session => session.header.cwd },
    sessionProjections: { cachedSnapshot: session => ({ values: { title: `Title ${session.header.id}`, secret: 'SECRET' } }) },
    async waterfall(name, args) { assert.equal(name, 'workspace/session-activity'); queried.push(args.sessionId); await duringActivity?.(args.sessionId); return active.get(args.sessionId) ?? []; },
    workspaceRegistry: {
      list: () => [ws, ws2], get: id => id === ws.id ? ws : id === ws2.id ? ws2 : undefined, archivedSessionIds: archived,
      async archiveSession(id, options) {
        calls.push({ id, options }); await failArchive?.(id);
        if (!options.stopActivity && active.has(id)) throw Object.assign(new Error('private active'), { name: 'WorkspaceActiveSessionError', sessionId: id });
        archived.push(id); await afterArchive?.(id, options);
      },
      create() { throw new Error('NO WORKSPACE MUTATION'); }, retain() { throw new Error('NO RETAIN'); },
    },
  };
  const store = { async read() { return structuredClone(state); }, async mutate(fn) {
    const copy = structuredClone(state); const value = await fn(copy); await writes?.(copy); state = copy; return structuredClone(value);
  } };
  const authorized = [];
  const authorizeTool = async (id, exec) => { assert.equal(exec.agent, agents.get('caller')); authorized.push(id); if (id === 'caller') throw Object.assign(new Error('self'), { code: 'ARCHIVE_SELF_OR_ANCESTOR' }); };
  const options = { ctx, store, config, authorizeTool };
  const engine = createArchiveCascade(options); t.after(() => engine.close());
  return { engine, ctx, store, options, headers, agents, archived, calls, active, queried, members, other, add, authorized,
    exec: { agent: agents.get('caller') },
    plan: (args = {}) => engine.planForOwner({ archiveScope: 'related', targetId: 'root', requestId: 'plan', ...args }),
    commit: (planId, args = {}) => engine.commitForOwner({ archiveScope: 'related', planId, requestId: 'commit', ...args }),
    onArchive: fn => { afterArchive = fn; }, onActivity: fn => { duringActivity = fn; }, onWrite: fn => { writes = fn; }, failArchive: fn => { failArchive = fn; } };
}

test('plan is nonmutating; complete same-Workspace graph commits children first and root last', async t => {
  const f = fixture(t); const plan = await f.plan();
  assert.equal(plan.handled, true); assert.equal(plan.hasRelatedDescendants, true);
  assert.deepEqual(plan.targets.map(row => row.id), ['grandchild', 'child', 'root']); assert.equal(f.calls.length, 0);
  const result = await f.commit(plan.planId);
  assert.deepEqual(result.archivedIds, ['grandchild', 'child', 'root']); assert.deepEqual(result.remaining, []);
  assert.deepEqual(f.calls.map(row => row.id), ['grandchild', 'child', 'root']); assert.equal(result.archiveState, 'succeeded');
  assert.equal(result.atomic, false); assert.doesNotMatch(JSON.stringify(result), /allStopped|activityStopped|SECRET/);
  assert.equal((await f.commit(plan.planId)).replayed, true); assert.equal(f.calls.length, 3);
});

test('active child preflight never archives root; stop needs exact plan and new request', async t => {
  const f = fixture(t); f.active.set('child', [{ kind: 'job', secret: 'SECRET', items: [{ id: 'job', label: 'Build', output: 'SECRET' }] }]);
  const plan = await f.plan(); assert.equal(plan.requiresConfirmation, true);
  assert.equal(plan.activity[0].sessionId, 'child'); assert.equal(plan.activity[0].title, 'Title child');
  assert.doesNotMatch(JSON.stringify(plan), /SECRET/);
  await assert.rejects(f.commit(plan.planId), error => error.code === 'ACTIVITY_REQUIRES_CONFIRMATION' && error.planId === plan.planId);
  assert.equal(f.calls.length, 0); assert.equal(f.archived.length, 0);
  await assert.rejects(f.commit(plan.planId, { stopActivity: true }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.commit(plan.planId, { requestId: 'plan', stopActivity: true }), { code: 'IDEMPOTENCY_CONFLICT' });
  const result = await f.commit(plan.planId, { requestId: 'confirmed', stopActivity: true });
  assert.equal(result.stopActivityRequested, true); assert.equal(result.archiveState, 'succeeded');
});

test('cancelled UI preparation and no-related-root stay zero mutation', async t => {
  const f = fixture(t); await f.plan(); assert.equal(f.calls.length, 0);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.engine.commitForOwner({ archiveScope: 'related', planId: 'none', requestId: 'x' }, { signal: controller.signal }), { code: 'ABORTED' });
  const result = await f.engine.planForOwner({ targetId: 'grandchild', requestId: 'single' });
  assert.equal(result.handled, false); assert.equal(result.hasRelatedDescendants, false); assert.equal(f.calls.length, 0);
});

test('confirmation cannot expand, shrink or move a group after its plan', async t => {
  for (const drift of ['add', 'remove', 'workspace', 'identity']) {
    const f = fixture(t); const plan = await f.plan();
    if (drift === 'add') { f.add('new'); f.members.push('new'); await f.store.mutate(d => d.creations.push({ senderId: 'root', sessionId: 'new', state: 'ready' })); }
    if (drift === 'remove') await f.store.mutate(d => { d.creations.pop(); });
    if (drift === 'workspace') { f.members.splice(f.members.indexOf('child'), 1); f.other.push('child'); }
    if (drift === 'identity') f.headers.get('child').isSeeded = true;
    await assert.rejects(f.commit(plan.planId, { stopActivity: true }), { code: 'ARCHIVE_PLAN_CHANGED' });
    assert.equal(f.calls.length, 0);
  }
});

test('current membership and live identities are rechecked across metadata awaits', async t => {
  for (const drift of ['workspace', 'replace']) {
    const f = fixture(t); let changed = false;
    f.onActivity(() => { if (changed) return; changed = true;
      if (drift === 'workspace') f.members.splice(f.members.indexOf('child'), 1);
      else f.agents.set('child', { ...f.agents.get('child') });
    });
    await assert.rejects(f.plan(), { code: 'ARCHIVE_PLAN_CHANGED' }); assert.equal(f.calls.length, 0);
  }
});

test('first retained provenance wins; cross-Workspace and nonordinary branches are excluded', async t => {
  const f = fixture(t); f.add('outside'); f.other.push('outside');
  for (const [name, header] of [['btw', { origin: 'subagent', isSeeded: true }], ['native', { origin: 'subagent' }], ['fork', { parentSession: 'root' }]]) { f.add(name, header); f.members.push(name); }
  await f.store.mutate(d => {
    d.creations.unshift({ senderId: 'outside', sessionId: 'child', state: 'ready' });
    for (const name of ['outside', 'btw', 'native', 'fork']) d.creations.push({ senderId: 'root', sessionId: name, state: 'ready' });
  });
  await assert.rejects(f.plan(), { code: 'ARCHIVE_PLAN_CHANGED' }); assert.equal(f.calls.length, 0);
});

test('cycles including root self-edge fail closed rather than silently cutting an edge', async t => {
  for (const parent of ['root', 'grandchild']) {
    const f = fixture(t); await f.store.mutate(d => d.creations.push({ senderId: parent, sessionId: 'root', state: 'ready' }));
    await assert.rejects(f.plan(), { code: 'ARCHIVE_GRAPH_CYCLE' }); assert.equal(f.calls.length, 0);
  }
});

test('cold and archived nodes remain traversable without activation or duplicate stops', async t => {
  const f = fixture(t); f.agents.delete('child'); f.agents.delete('grandchild'); f.archived.push('root', 'child');
  const plan = await f.plan(); assert.equal(plan.handled, true); assert.equal(plan.targets.length, 3);
  assert.deepEqual(f.queried, ['grandchild']);
  const result = await f.commit(plan.planId, { stopActivity: true });
  assert.deepEqual(f.calls.map(row => row.id), ['grandchild']); assert.equal(result.archived, true);
});

test('malformed/incomplete graphs, missing metadata and missing activity do not partially archive', async t => {
  for (const kind of ['oversize', 'missing', 'activity', 'registry']) {
    const f = fixture(t);
    if (kind === 'oversize') await f.store.mutate(d => { d.creations = Array.from({ length: 1001 }, () => d.creations[0]); });
    if (kind === 'missing') { f.headers.delete('child'); f.agents.delete('child'); }
    if (kind === 'activity') delete f.ctx.waterfall;
    if (kind === 'registry') delete f.ctx.workspaceRegistry.list;
    await assert.rejects(f.plan(), { code: { oversize: 'ARCHIVE_GRAPH_INCOMPLETE', missing: 'ARCHIVE_METADATA_INVALID', activity: 'ARCHIVE_ACTIVITY_UNAVAILABLE', registry: 'ARCHIVE_WORKSPACE_UNAVAILABLE' }[kind] });
    assert.equal(f.calls.length, 0);
  }
});

test('Tool cannot consume Owner plans or bypass its real caller and every target fence', async t => {
  const f = fixture(t); const owner = await f.plan();
  await assert.rejects(f.engine.planForTool({ archiveScope: 'related', targetId: 'root', requestId: 'missing-caller' }), { code: 'SENDER_NOT_LIVE' });
  await assert.rejects(f.engine.commitForTool({ archiveScope: 'related', planId: owner.planId, requestId: 'missing-caller' }), { code: 'SENDER_NOT_LIVE' });
  await assert.rejects(f.engine.commitForTool({ archiveScope: 'related', planId: owner.planId, requestId: 'x' }, f.exec), { code: 'ARCHIVE_PLAN_NOT_FOUND' });
  await assert.rejects(f.engine.planForTool({ archiveScope: 'related', targetId: 'root', requestId: 'x' }, { agent: { ...f.exec.agent } }), { code: 'SENDER_NOT_LIVE' });
  const tool = await f.engine.planForTool({ archiveScope: 'related', targetId: 'root', requestId: 'tool' }, f.exec);
  assert.ok(['root', 'child', 'grandchild'].every(id => f.authorized.includes(id)));
  await assert.rejects(f.engine.commitForTool({ archiveScope: 'related', targetId: 'child', planId: tool.planId, requestId: 'wrong-root' }, f.exec), { code: 'IDEMPOTENCY_CONFLICT' });
  await f.store.mutate(d => d.creations.push({ senderId: 'root', sessionId: 'caller', state: 'ready' })); f.members.push('caller');
  await assert.rejects(f.engine.planForTool({ archiveScope: 'related', targetId: 'root', requestId: 'self' }, f.exec), { code: 'ARCHIVE_SELF_OR_ANCESTOR' });
  assert.equal(f.calls.length, 0);
});

test('strict owner directory fence is live/current and cannot be replaced by Workspace path', async t => {
  const f = fixture(t, { sameDirectoryOnly: true }); f.agents.delete('child');
  await assert.rejects(f.plan(), { code: 'ACCESS_DENIED' }); assert.equal(f.calls.length, 0);
});

test('per-item native uncertainty stops before parent and never replays pending mutations', async t => {
  for (const when of ['before', 'after']) {
    const f = fixture(t); const plan = await f.plan();
    if (when === 'before') f.failArchive(id => { if (id === 'child') throw new Error('SECRET disk failed'); });
    else f.onArchive(id => { if (id === 'child') throw new Error('SECRET postcommit'); });
    await assert.rejects(f.commit(plan.planId), error => {
      assert.equal(error.archiveState, when === 'before' ? 'unknown' : 'partial');
      assert.ok(error.archivedIds.includes('grandchild')); assert.ok(error.remaining.includes('root')); return true;
    });
    assert.deepEqual(f.calls.map(row => row.id), ['grandchild', 'child']);
    await assert.rejects(f.commit(plan.planId), error => error.replayed === true);
    await assert.rejects(f.commit(plan.planId, { requestId: 'new' }), { code: 'ARCHIVE_PLAN_TERMINAL' });
    assert.equal(f.calls.length, 2); assert.doesNotMatch(JSON.stringify(await f.store.read()), /SECRET/);
  }
});

test('Host active race after preflight stays partial and never archives root or claims atomicity', async t => {
  const f = fixture(t); const plan = await f.plan(); f.onArchive(id => { if (id === 'grandchild') f.active.set('child', [{ kind: 'turn' }]); });
  await assert.rejects(f.commit(plan.planId), error => error.code === 'ACTIVITY_REQUIRES_CONFIRMATION' && error.archiveState === 'partial' && error.atomic === false);
  assert.deepEqual(f.archived, ['grandchild']); assert.equal(f.calls.some(row => row.id === 'root'), false);
});

test('abort after first native submission waits its readback and stops the remaining group', async t => {
  const f = fixture(t); const plan = await f.plan(); const controller = new AbortController();
  f.onArchive(() => controller.abort());
  await assert.rejects(f.engine.commitForOwner({ archiveScope: 'related', planId: plan.planId, requestId: 'during' }, { signal: controller.signal }), error => error.code === 'ABORTED' && error.archiveState === 'partial' && error.cancelledAfterSubmission === true);
  assert.deepEqual(f.archived, ['grandchild']); assert.equal((await f.store.read()).archivePlans[0].items[0].state, 'archived');
});

test('interrupted submission becomes unknown on restart, while uncommitted plans expire', async t => {
  const f = fixture(t); const plan = await f.plan();
  await f.store.mutate(d => { const p = d.archivePlans[0]; p.state = 'committing'; p.items[0].state = 'submitting'; p.attempts.push({ requestId: 'interrupted', state: 'committing', stopActivity: false }); });
  await f.engine.close(); const next = createArchiveCascade(f.options); t.after(() => next.close());
  await assert.rejects(next.commitForOwner({ archiveScope: 'related', planId: plan.planId, requestId: 'interrupted' }), { code: 'ARCHIVE_RESTART_UNKNOWN', archiveState: 'unknown', replayed: true });
  assert.equal(f.calls.length, 0);
  const g = fixture(t); const pending = await g.plan(); await g.engine.close(); const restarted = createArchiveCascade(g.options); t.after(() => restarted.close());
  await assert.rejects(restarted.commitForOwner({ archiveScope: 'related', planId: pending.planId, requestId: 'x' }), { code: 'ARCHIVE_PLAN_CHANGED' });
});

test('capacity and failed durable submission prevent any native archive', async t => {
  const f = fixture(t, { maxArchives: 1 }); const plan = await f.plan();
  await assert.rejects(f.plan({ requestId: 'another' }), { code: 'ARCHIVE_CAPACITY' });
  f.onWrite(d => { if (d.archivePlans[0].state === 'committing') throw new Error('disk offline'); });
  await assert.rejects(f.commit(plan.planId), /disk offline/); assert.equal(f.calls.length, 0);
});

test('fresh plan cannot bypass overlapping unknown outcome and cold activity uses cached titles', async t => {
  const f = fixture(t); f.agents.delete('child');
  f.ctx.sessionController = { async list() { return { items: [{ sessionId: 'child', projections: { values: { title: 'Cold title', secret: 'SECRET' } } }] }; } };
  f.active.set('child', [{ kind: 'schedule' }]);
  const plan = await f.plan(); assert.equal(plan.activity[0].title, 'Cold title');
  f.failArchive(id => { if (id === 'grandchild') throw new Error('unknown'); });
  await assert.rejects(f.commit(plan.planId, { stopActivity: true }), { code: 'ARCHIVE_UNCERTAIN' });
  await assert.rejects(f.plan({ requestId: 'fresh' }), { code: 'ARCHIVE_PRIOR_UNKNOWN' }); assert.equal(f.calls.length, 1);
});

test('confirmed Host stop can dispose completed children without expanding the plan', async t => {
  const f = fixture(t, { sameDirectoryOnly: true }); const plan = await f.plan();
  f.onArchive(id => f.agents.delete(id));
  const result = await f.commit(plan.planId, { stopActivity: true });
  assert.equal(result.archiveState, 'succeeded'); assert.deepEqual(result.archivedIds, ['grandchild', 'child', 'root']);
});

test('result persistence failure preserves known per-item readback and does not resubmit', async t => {
  const f = fixture(t); const plan = await f.plan(); let broken = false;
  f.onArchive(() => { broken = true; }); f.onWrite(() => { if (broken) throw new Error('private write failure'); });
  await assert.rejects(f.commit(plan.planId), error => error.code === 'ARCHIVE_PERSISTENCE_UNCERTAIN' && error.archiveState === 'unknown' && error.archivedIds.includes('grandchild') && error.remaining.includes('root'));
  broken = false;
  await assert.rejects(f.commit(plan.planId), error => error.replayed === true);
  assert.equal(f.calls.length, 1);
});

test('planning includes the entire 1000-entry ledger rather than a frontend 200-edge snapshot', async t => {
  const f = fixture(t);
  await f.store.mutate(d => {
    d.creations = [];
    for (let index = 0; index < 1000; index++) {
      const name = `child-${index}`; f.add(name); f.members.push(name);
      d.creations.push({ senderId: index === 0 ? 'outside' : 'root', sessionId: name, state: 'ready' });
    }
  });
  const plan = await f.plan(); assert.equal(plan.targets.length, 1000); assert.equal(plan.targets.at(-1).id, 'root');
  assert.equal(f.queried.length, 1000); assert.equal(f.calls.length, 0);
  await f.store.mutate(d => { d.creations[0].senderId = 'root'; });
  await assert.rejects(f.plan({ requestId: 'too-many-targets' }), { code: 'ARCHIVE_GRAPH_INCOMPLETE' });
  assert.equal(f.calls.length, 0);
});

test('in-flight creation in the selected component cannot become a single-root fallback', async t => {
  for (const state of ['creating', 'intent', 'failed']) {
    const f = fixture(t);
    await f.store.mutate(d => { d.creations = [{ senderId: 'root', sessionId: 'child', state }]; });
    assert.equal(await f.engine.hasCandidates('root'), true);
    await assert.rejects(f.plan(), { code: 'ARCHIVE_GRAPH_UNSTABLE' }); assert.equal(f.calls.length, 0);
  }
  const f = fixture(t); const plan = await f.plan();
  await f.store.mutate(d => d.creations.push({ senderId: 'child', sessionId: 'not-yet-attached', state: 'creating' }));
  await assert.rejects(f.commit(plan.planId), { code: 'ARCHIVE_GRAPH_UNSTABLE' }); assert.equal(f.calls.length, 0);
  const g = fixture(t);
  await g.store.mutate(d => d.creations.push({ senderId: 'caller', sessionId: 'elsewhere', state: 'creating' }));
  assert.equal((await g.plan()).handled, true); assert.equal(g.calls.length, 0);
  const h = fixture(t);
  await h.store.mutate(d => { d.creations = [{ senderId: 'root', sessionId: 'unresolved-id', state: 'unknown' }]; });
  await assert.rejects(h.plan(), { code: 'ARCHIVE_GRAPH_UNSTABLE' }); assert.equal(h.calls.length, 0);
});

test('missing scope returns only choice and stop consent cannot choose related implicitly', async t => {
  for (const state of ['ready', 'creating', 'unknown']) {
    const f = fixture(t); await f.store.mutate(d => { d.creations[0].state = state; });
    await assert.rejects(f.plan({ archiveScope: undefined, stopActivity: true }), error => {
      assert.equal(error.code, 'ARCHIVE_SCOPE_REQUIRED'); assert.equal(error.targetId, 'root');
      assert.deepEqual(error.allowedScopes, ['single', 'related']); assert.equal(error.planId, undefined); return true;
    });
    assert.equal(f.calls.length, 0); assert.equal(f.queried.length, 0);
    assert.equal((await f.store.read()).archivePlans.length, 0);
  }
});

test('single Owner plan never reads creation graph or validates unrelated descendant identities', async t => {
  const f = fixture(t, { sameDirectoryOnly: true });
  f.agents.get('child').session.header.id = 'broken-child'; f.agents.delete('grandchild');
  f.active.set('child', [{ kind: 'turn' }]);
  const rawRead = f.store.read;
  f.store.read = async () => { const value = await rawRead(); Object.defineProperty(value, 'creations', { get() { throw new Error('NO CREATION READ FOR SINGLE'); } }); return value; };
  const plan = await f.plan({ archiveScope: 'single' });
  assert.equal(plan.archiveScope, 'single'); assert.equal(plan.hasRelatedDescendants, false);
  assert.deepEqual(plan.targets.map(item => item.id), ['root']); assert.deepEqual(f.queried, ['root']);
  f.members.splice(f.members.indexOf('child'), 1);
  const result = await f.commit(plan.planId, { archiveScope: 'single' });
  assert.equal(result.cascade, false); assert.equal(result.archiveScope, 'single'); assert.deepEqual(result.archivedIds, ['root']);
  assert.deepEqual(f.calls.map(item => item.id), ['root']);
});

test('single Owner activity is independent from scope, and commit scope must match exactly', async t => {
  const f = fixture(t); f.active.set('root', [{ kind: 'turn' }]);
  const plan = await f.plan({ archiveScope: 'single' }); assert.equal(plan.requiresConfirmation, true);
  await assert.rejects(f.commit(plan.planId, { archiveScope: undefined }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.commit(plan.planId, { archiveScope: 'related' }), { code: 'IDEMPOTENCY_CONFLICT' });
  await assert.rejects(f.commit(plan.planId, { archiveScope: 'single' }), { code: 'ACTIVITY_REQUIRES_CONFIRMATION' });
  assert.equal(f.calls.length, 0);
  const result = await f.commit(plan.planId, { archiveScope: 'single', stopActivity: true, requestId: 'confirmed' });
  assert.equal(result.archiveScope, 'single'); assert.deepEqual(result.archivedIds, ['root']);
  await assert.rejects(f.plan({ archiveScope: 'related' }), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('single unknown quarantine intersects the target, not another unresolved descendant', async t => {
  const f = fixture(t); const old = await f.plan();
  await f.store.mutate(d => { const plan = d.archivePlans[0]; plan.state = 'unknown'; plan.items[0].state = 'unknown'; });
  const single = await f.plan({ archiveScope: 'single', requestId: 'root-only' });
  assert.equal((await f.commit(single.planId, { archiveScope: 'single' })).archiveState, 'succeeded');
  await assert.rejects(f.plan({ targetId: 'grandchild', archiveScope: 'single', requestId: 'unknown-target' }), { code: 'ARCHIVE_PRIOR_UNKNOWN' });
  assert.deepEqual(f.calls.map(item => item.id), ['root']);
  assert.notEqual(old.planId, single.planId);
});

test('legacy unscoped planned intent cannot be promoted, but historical terminal is read-only replay', async t => {
  const f = fixture(t); const old = await f.plan();
  await f.store.mutate(d => { delete d.archivePlans[0].archiveScope; });
  await assert.rejects(f.commit(old.planId), { code: 'ARCHIVE_PLAN_CHANGED' }); assert.equal(f.calls.length, 0);
  const g = fixture(t); const done = await g.plan(); const result = await g.commit(done.planId);
  await g.store.mutate(d => { delete d.archivePlans[0].archiveScope; });
  const replay = await g.commit(done.planId, { archiveScope: undefined });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.archivedIds, result.archivedIds); assert.equal(g.calls.length, 3);
  await assert.rejects(g.commit(done.planId), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('explicit related cannot silently downgrade to singleton after relationship removal', async t => {
  const f = fixture(t); await f.store.mutate(d => { d.creations = []; });
  await assert.rejects(f.plan(), { code: 'ARCHIVE_PLAN_CHANGED' }); assert.equal(f.calls.length, 0);
  assert.equal((await f.plan({ archiveScope: undefined })).handled, false);
});

test('single Owner still binds exact current target Workspace and identity', async t => {
  for (const drift of ['workspace', 'identity']) {
    const f = fixture(t); const plan = await f.plan({ archiveScope: 'single' });
    if (drift === 'workspace') { f.members.splice(f.members.indexOf('root'), 1); f.other.push('root'); }
    else f.agents.set('root', { ...f.agents.get('root') });
    await assert.rejects(f.commit(plan.planId, { archiveScope: 'single' }), { code: 'ARCHIVE_PLAN_CHANGED' }); assert.equal(f.calls.length, 0);
  }
});

test('metadata timeout is bounded and shutdown drains an admitted native call', async t => {
  const f = fixture(t); const plan = await f.plan();
  let entered; const start = new Promise(resolve => { entered = resolve; }); let release; const gate = new Promise(resolve => { release = resolve; });
  f.onArchive(async id => { if (id === 'grandchild') { entered(); await gate; } });
  const operation = f.commit(plan.planId); await start;
  let closed = false; const closing = f.engine.close().then(() => { closed = true; }); await Promise.resolve(); assert.equal(closed, false);
  release(); assert.equal((await operation).archiveState, 'succeeded'); await closing;
  const g = fixture(t); g.ctx.waterfall = () => new Promise(() => {}); const short = createArchiveCascade({ ...g.options, metadataTimeoutMs: 10 });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(short.planForOwner({ archiveScope: 'related', targetId: 'root', requestId: 'timeout' }), { code: 'METADATA_TIMEOUT' }); }
  finally { clearTimeout(keepAlive); await short.close(); }
  assert.equal(g.calls.length, 0);
});
