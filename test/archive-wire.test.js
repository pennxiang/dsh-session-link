import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../lib/service.js';
import { archiveDetails, archiveOutcome } from '../lib/archive-public.js';
import { createArchiveHandler } from '../lib/archive-route.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(creator, archiver, config = {}) {
  const events = [];
  const service = createService({
    host: { describe: async id => ({ id, live: true, archived: false, kind: 'session', cwd: '/fixture' }), close: async () => events.push('host-close') },
    store: { close: async () => events.push('store-close') },
    sessionCreator: { models: async () => ({ providers: [] }), close: async () => events.push('creator-close'), ...creator },
    sessionArchiver: { close: async () => events.push('archiver-close'), ...archiver }, config,
  });
  return { service, events, exec: { agent: { id: 'actual-caller' } } };
}

test('owner commit waits for admitted creation; independent metadata remains readable', async () => {
  const entered = deferred(), release = deferred(), order = [];
  const input = { planId: 'plan', requestId: 'commit' }, options = { signal: new AbortController().signal };
  const { service, exec } = fixture({ create: async () => { order.push('create'); entered.resolve(); await release.promise; order.push('created'); return { sessionId: 'child' }; } }, { commitForOwner: async (args, opts) => { assert.equal(args, input); assert.equal(opts, options); assert.equal('agent' in opts, false); order.push('archive'); return { archiveState: 'succeeded' }; } });
  try {
    const creating = service.execute('link_session_create', {}, exec);
    await entered.promise;
    const archiving = service.commitArchiveForOwner(input, options);
    assert.deepEqual(await service.execute('link_models', {}, exec), { providers: [] });
    assert.deepEqual(order, ['create']);
    release.resolve(); await creating; await archiving;
    assert.deepEqual(order, ['create', 'created', 'archive']);
  } finally { release.resolve(); await service.close(); }
});

test('owner commit also excludes later creates and drains queued create before shutdown', async () => {
  const entered = deferred(), release = deferred(), order = [];
  const { service, exec, events } = fixture({ create: async () => { order.push('create'); return { sessionId: 'child' }; } }, { commitForOwner: async () => { order.push('archive'); entered.resolve(); await release.promise; order.push('archived'); return {}; } });
  const archiving = service.commitArchiveForOwner({ planId: 'plan' });
  await entered.promise;
  const creating = service.execute('link_session_create', {}, exec), closed = service.close();
  await assert.rejects(service.commitArchiveForOwner({}), { code: 'SERVICE_CLOSED' });
  assert.deepEqual(order, ['archive']); assert.deepEqual(events, []);
  release.resolve(); await Promise.all([archiving, creating, closed]);
  assert.deepEqual(order, ['archive', 'archived', 'create']);
  assert.deepEqual(events, ['creator-close', 'archiver-close', 'store-close', 'host-close']);
});

test('failed owner commit does not poison create queue; disabled/missing capability fail closed', async () => {
  const first = fixture({ create: async () => ({ sessionId: 'still-works' }) }, { commitForOwner: async () => { throw Object.assign(new Error('changed'), { code: 'ARCHIVE_PLAN_CHANGED' }); } });
  try { await assert.rejects(first.service.commitArchiveForOwner({}), { code: 'ARCHIVE_PLAN_CHANGED' }); assert.equal((await first.service.execute('link_session_create', {}, first.exec)).sessionId, 'still-works'); } finally { await first.service.close(); }
  const missing = fixture({}, {}), disabled = fixture({}, { commitForOwner: async () => assert.fail('disabled must not commit') }, { enabled: false });
  try { await assert.rejects(missing.service.commitArchiveForOwner({}), { code: 'ARCHIVE_UNAVAILABLE' }); await assert.rejects(disabled.service.commitArchiveForOwner({}), { code: 'DISABLED' }); } finally { await missing.service.close(); await disabled.service.close(); }
});

test('archive public diagnostics retain exact outcome but strip arbitrary native objects', () => {
  const source = { planId: 'plan', targetId: 'parent', archiveState: 'partial', archivedIds: ['child'], remaining: ['parent'], failed: [{ id: 'parent', state: 'unknown', transcript: 'SECRET' }], stopActivityRequested: false, atomic: true, stack: 'SECRET', agent: { token: 'SECRET' } };
  const result = archiveDetails({ ...source, outcome: source, targets: [{ id: 'child', title: 'Child title', alreadyArchived: false, transcript: 'SECRET' }], activity: [{ sessionId: 'child', title: 'Child title', totalGroups: 1, groups: [{ kind: 'job', items: [{ id: 'job', label: 'Job title', rawArgs: 'SECRET' }], totalItems: 1 }] }] });
  assert.equal(result.atomic, false); assert.deepEqual(result.archivedIds, ['child']); assert.deepEqual(result.outcome.failed, [{ id: 'parent', state: 'unknown' }]); assert.equal(JSON.stringify(result).includes('SECRET'), false);
  assert.equal(archiveOutcome({ archiveState: 'unknown' }), undefined, 'missing factual arrays must not become fabricated empty counts');
});

test('scope choice diagnostics never manufacture or leak a committable plan', () => {
  const choice = { code: 'ARCHIVE_SCOPE_REQUIRED', targetId: 'parent', allowedScopes: ['single', 'related'], agent: { token: 'SECRET' } };
  assert.deepEqual(archiveDetails(choice), { targetId: 'parent', allowedScopes: ['single', 'related'] });
  for (const extra of [{ planId: 'bad' }, { targets: [] }, { outcome: {} }]) assert.deepEqual(archiveDetails({ ...choice, ...extra }), { targetId: 'parent' });
  for (const allowedScopes of [['single'], ['single', 'single'], ['single', 'related', 'all'], 'related']) assert.deepEqual(archiveDetails({ ...choice, allowedScopes }), { targetId: 'parent' });
});

test('scoped outcomes retain actual post-submission cancellation evidence', () => {
  const value = { archiveScope: 'single', planId: 'plan', targetId: 'self', archiveState: 'succeeded', archivedIds: ['self'], remaining: [], failed: [], stopActivityRequested: true, cancelledAfterSubmission: true };
  assert.equal(archiveOutcome(value).archiveScope, 'single');
  assert.equal(archiveDetails({ ...value, outcome: value }).outcome.cancelledAfterSubmission, true);
  assert.equal('archiveScope' in archiveOutcome({ ...value, archiveScope: 'all' }), false);
});

test('owner route validates scope and forwards choice separately from scoped plan/commit', async () => {
  const calls = [];
  const handler = createArchiveHandler({ archiver: {
    planForOwner: async args => { calls.push(['plan', args]); if (!args.archiveScope) throw Object.assign(new Error('SECRET'), { code: 'ARCHIVE_SCOPE_REQUIRED', targetId: args.targetId, allowedScopes: ['single', 'related'] }); return { handled: true, archiveScope: args.archiveScope, planId: 'plan', targets: [{ id: args.targetId }] }; },
    commitForOwner: async args => { calls.push(['commit', args]); return { archiveScope: args.archiveScope, archiveState: 'succeeded' }; },
  } });
  const send = value => handler.fetch(new Request('https://owner.invalid/api/session-link/archive', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }));
  try {
    const missing = await send({ action: 'plan', targetId: 'parent', requestId: 'choose' });
    assert.equal(missing.status, 409); const wire = await missing.json();
    assert.deepEqual(wire.error.allowedScopes, ['single', 'related']); assert.equal(wire.error.targetId, 'parent');
    assert.equal('planId' in wire.error, false); assert.equal(JSON.stringify(wire).includes('SECRET'), false);
    for (const archiveScope of ['single', 'related']) {
      assert.equal((await send({ action: 'plan', targetId: 'parent', requestId: `prepare-${archiveScope}`, archiveScope })).status, 200);
      assert.equal((await send({ action: 'commit', planId: 'plan', requestId: `commit-${archiveScope}`, archiveScope, stopActivity: false })).status, 200);
    }
    const before = calls.length;
    for (const archiveScope of [undefined, null, 'all', 1, []]) assert.equal((await send({ action: 'commit', planId: 'plan', requestId: 'invalid', archiveScope })).status, 400);
    assert.equal((await send({ action: 'plan', targetId: 'parent', requestId: 'invalid', archiveScope: 'all' })).status, 400);
    assert.equal(calls.length, before, 'invalid scope must not reach either engine entry');
    assert.deepEqual(calls[2], ['commit', { planId: 'plan', requestId: 'commit-single', archiveScope: 'single', stopActivity: false }]);
  } finally { await handler.close(); }
});
