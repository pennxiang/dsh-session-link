import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createStore } from '../lib/store.js';

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'session-link-store-'));
  return dir;
}

test('store persists atomically, is private, and returns detached snapshots', async t => {
  const dir = await directory(t);
  const store = await createStore(dir);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  assert.deepEqual(await store.read(), { version: 1, deliveries: [], tasks: [], reception: {} });
  let retained;
  await store.mutate(state => { retained = state; state.reception.a = { enabled: false }; return 'ok'; });
  retained.reception.a.enabled = true;
  const snapshot = await store.read();
  snapshot.reception.a.enabled = true;
  assert.equal((await store.read()).reception.a.enabled, false);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, 'state.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).reception.a.enabled, false);
});

test('store serializes concurrent writes, rolls back failed mutation, and drains close', async t => {
  const dir = await directory(t);
  const store = await createStore(dir);
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  await Promise.all(Array.from({ length: 30 }, (_, index) => store.mutate(state => { state.reception[index] = { enabled: false }; })));
  await assert.rejects(store.mutate(state => { state.tasks.push({ id: 'not-committed' }); throw new Error('rollback'); }), /rollback/);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = store.mutate(async state => { await gate; state.reception.last = { enabled: true }; });
  const closed = store.close();
  await assert.rejects(store.mutate(() => {}), { code: 'STORE_CLOSED' });
  release();
  await pending;
  await closed;
  assert.equal(await store.close(), undefined);
});

test('exclusive ownership refuses another writer and allows clean restart', async t => {
  const dir = await directory(t);
  const first = await createStore(dir);
  await assert.rejects(createStore(dir), { code: 'STORE_LOCKED' });
  await first.mutate(state => {
    state.deliveries.push({ id: 'd', state: 'sending', receipt: 'pending' });
    state.tasks.push({ id: 'task', deliveryId: 'd', deliveryState: 'sending', status: 'offered' });
  });
  await first.close();
  const second = await createStore(dir);
  t.after(async () => { await second.close(); await rm(dir, { recursive: true, force: true }); });
  const state = await second.read();
  assert.equal(state.deliveries[0].state, 'unknown');
  assert.equal(state.deliveries[0].receipt, 'unknown');
  assert.equal(state.tasks[0].deliveryState, 'unknown');
  assert.equal(state.tasks[0].status, 'offered');
});

test('real crashed writer fails closed; explicit dead-lock removal recovers intent unknown', async t => {
  const dir = await directory(t);
  const moduleURL = new URL('../lib/store.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `import {createStore} from ${JSON.stringify(moduleURL)}; const s=await createStore(${JSON.stringify(dir)}); await s.mutate(x=>x.deliveries.push({id:'crash',state:'sending'})); process.exit(0);`], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  await assert.rejects(createStore(dir), { code: 'STORE_LOCKED' });
  // The child has exited: removal is explicit operator-style recovery, never lock theft.
  await rm(join(dir, '.writer-lock'), { recursive: true });
  const recovered = await createStore(dir);
  t.after(async () => { await recovered.close(); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await recovered.read()).deliveries[0].state, 'unknown');
});

test('invalid state and oversized mutations do not overwrite committed data', async t => {
  const dir = await directory(t);
  const store = await createStore(dir, { maxBytes: 1024 });
  t.after(async () => { await store.close(); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(store.mutate(state => { state.version = 2; }), { code: 'INVALID_STATE' });
  await assert.rejects(store.mutate(state => { state.reception.large = { data: 'x'.repeat(2048) }; }), { code: 'STORE_FULL' });
  assert.equal((await store.read()).version, 1);
  await store.close();
  await writeFile(join(dir, 'state.json'), '{broken', { mode: 0o600 });
  await assert.rejects(createStore(dir), SyntaxError);
  // Failed initialization released its own lock rather than wedging the directory.
  await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 7, deliveries: [], tasks: [], reception: {} }));
  await assert.rejects(createStore(dir), { code: 'INVALID_STATE' });
});
