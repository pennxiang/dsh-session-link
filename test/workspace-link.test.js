import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceLink } from '../lib/workspace-link.js';

async function fixture(t) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'workspace-link-')));
  const source = join(dir, 'source'); const target = join(dir, 'target');
  await mkdir(source); await mkdir(target);
  const records = new Map(); const calls = [];
  function add(id, path, sessionIds = []) {
    const item = { id, path, sessionIds, async attachSession(sessionId) {
      calls.push(['attach', id, sessionId]);
      if (!item.sessionIds.includes(sessionId)) item.sessionIds.push(sessionId);
    } };
    records.set(id, item); return item;
  }
  add('source', source, ['caller']);
  const ctx = { workspaceRegistry: { list: () => [...records.values()], get: id => records.get(id), async create(path) {
    calls.push(['create', path]); return [...records.values()].find(item => item.path === path) ?? add(`workspace-${records.size}`, path);
  } } };
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { dir, source, target, records, calls, add, ctx, link: createWorkspaceLink(ctx),
    plan: overrides => createWorkspaceLink(ctx).plan({ sourceId: 'caller', sourceCwd: source, targetCwd: source, ...overrides }) };
}

test('same-directory creation chooses exact source membership, without read side effects', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.plan(), { workspaceId: 'source', path: f.source, selection: 'source-membership' });
  assert.deepEqual(f.calls, []);
});

test('cross-directory creation never attaches to source workspace', async t => {
  const f = await fixture(t); f.add('target', f.target);
  const plan = await f.plan({ targetCwd: f.target });
  assert.deepEqual(plan, { workspaceId: 'target', path: f.target, selection: 'target-directory' });
  const ensured = await f.link.ensure(plan);
  await f.link.attach(ensured, 'new-root');
  assert.deepEqual(f.records.get('source').sessionIds, ['caller']);
  assert.deepEqual(f.records.get('target').sessionIds, ['new-root']);
  f.link.verify(ensured, 'new-root');
});

test('changed caller cwd does not blindly follow historical workspace membership', async t => {
  const f = await fixture(t); f.add('target', f.target);
  assert.equal((await f.plan({ sourceCwd: f.target, targetCwd: f.target })).workspaceId, 'target');
});

test('explicit workspace requires the exact canonical target path', async t => {
  const f = await fixture(t); f.add('target', f.target);
  assert.equal(f.link.pathFor('target'), f.target);
  assert.equal((await f.plan({ workspaceId: 'target', targetCwd: f.target })).selection, 'explicit');
  await assert.rejects(f.plan({ workspaceId: 'target' }), { code: 'WORKSPACE_CWD_MISMATCH' });
  await assert.rejects(f.plan({ workspaceId: 'missing' }), { code: 'WORKSPACE_NOT_FOUND' });
  assert.deepEqual(f.calls, []);
});

test('exact workspace lookup refuses silent identity substitution even at the same path', async t => {
  const f = await fixture(t);
  const wrong = { ...f.records.get('source'), id: 'substituted-id' };
  f.ctx.workspaceRegistry.get = () => wrong;
  assert.throws(() => f.link.pathFor('source'), { code: 'WORKSPACE_CONTRACT_INVALID' });
  await assert.rejects(f.plan({ workspaceId: 'source' }), { code: 'WORKSPACE_CONTRACT_INVALID' });
  await assert.rejects(f.link.ensure({ workspaceId: 'source', path: f.source }), { code: 'WORKSPACE_CONTRACT_INVALID' });
  await assert.rejects(f.link.attach({ workspaceId: 'source', path: f.source }, 'new-root'), { code: 'WORKSPACE_CONTRACT_INVALID' });
  assert.throws(() => f.link.verify({ workspaceId: 'source', path: f.source }, 'new-root'), { code: 'WORKSPACE_CONTRACT_INVALID' });
  assert.deepEqual(f.calls, []);
});

test('symlink cwd maps to its canonical workspace rather than a new registration', async t => {
  const f = await fixture(t); const alias = join(f.dir, 'alias'); await symlink(f.source, alias);
  assert.equal((await f.plan({ targetCwd: alias })).workspaceId, 'source');
});

test('workspace plan/create is separated and registration races reuse the canonical entry', async t => {
  const f = await fixture(t);
  const plan = await f.plan({ targetCwd: f.target });
  assert.deepEqual(plan, { path: f.target, selection: 'new-directory' });
  assert.equal(f.calls.length, 0);
  const created = await f.link.ensure(plan);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
  const again = await f.link.ensure(plan);
  assert.equal(again.workspaceId, created.workspaceId);
  assert.equal(f.calls.filter(call => call[0] === 'create').length, 1);
});

test('duplicate canonical paths and ambiguous source memberships fail without choosing one', async t => {
  const f = await fixture(t); f.add('duplicate', f.source);
  await assert.rejects(f.plan(), { code: 'WORKSPACE_AMBIGUOUS' });
  f.records.delete('duplicate'); f.add('second-owner', f.target, ['caller']);
  await assert.rejects(f.plan(), { code: 'WORKSPACE_AMBIGUOUS' });
});

test('attachment is idempotent, read back, and cannot steal another workspace membership', async t => {
  const f = await fixture(t); const plan = await f.plan();
  await f.link.attach(plan, 'new'); await f.link.attach(plan, 'new');
  assert.equal(f.calls.filter(call => call[0] === 'attach').length, 1);
  f.add('target', f.target, ['owned']);
  await assert.rejects(f.link.attach(plan, 'owned'), { code: 'WORKSPACE_MEMBERSHIP_CONFLICT' });
  f.records.get('source').attachSession = async () => {};
  await assert.rejects(f.link.attach(plan, 'missing'), { code: 'WORKSPACE_ATTACH_FAILED' });
});

test('pre-abort and unsupported workspace capabilities never register or attach', async t => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.plan({ signal: controller.signal }), { code: 'ABORTED' });
  await assert.rejects(f.link.ensure({ path: f.target }, { signal: controller.signal }), { code: 'ABORTED' });
  delete f.ctx.workspaceRegistry.list;
  await assert.rejects(f.plan(), { code: 'WORKSPACE_UNAVAILABLE' });
  assert.deepEqual(f.calls, []);
});

test('late cancellation after workspace registration still returns the known identity', async t => {
  const f = await fixture(t); const controller = new AbortController();
  f.ctx.workspaceRegistry.create = async path => { const value = f.add('created', path); controller.abort(); return value; };
  const result = await f.link.ensure({ path: f.target }, { signal: controller.signal });
  assert.equal(result.workspaceId, 'created');
});
