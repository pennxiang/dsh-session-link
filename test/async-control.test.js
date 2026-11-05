import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { raceMetadata, createReadScope } from '../lib/async-control.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function deadline(promise, milliseconds = 1000) {
  // Production deadline timers are deliberately unref'ed. This independent
  // test watchdog keeps the process alive and detects non-convergent wrappers.
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test watchdog expired')), milliseconds); })]);
  } finally { clearTimeout(timer); }
}

test('metadata resolves values and forwards synchronous/async failures without retaining listeners', async () => {
  const caller = new AbortController();
  const shutdown = new AbortController();
  assert.equal(await raceMetadata(() => 42, { signal: caller.signal, shutdownSignal: shutdown.signal }), 42);
  const failure = new Error('provider failed');
  await assert.rejects(raceMetadata(() => { throw failure; }, { signal: caller.signal }), error => error === failure);
  await assert.rejects(raceMetadata(() => Promise.reject(failure), { signal: caller.signal }), error => error === failure);
  await raceMetadata(() => Promise.reject(null)).then(() => assert.fail('null rejection must not resolve'), reason => assert.equal(reason, null));
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  assert.equal(getEventListeners(shutdown.signal, 'abort').length, 0);
});

test('100ms deadline settles non-abortable metadata and consumes late provider rejection', async () => {
  const held = deferred();
  const caller = new AbortController();
  const shutdown = new AbortController();
  let internalSignal;
  const operation = raceMetadata(signal => { internalSignal = signal; return held.promise; }, { signal: caller.signal, shutdownSignal: shutdown.signal, timeoutMs: 100 });
  await deadline(assert.rejects(operation, { code: 'METADATA_TIMEOUT' }));
  assert.equal(internalSignal.aborted, true);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  assert.equal(getEventListeners(shutdown.signal, 'abort').length, 0);
  held.reject(new Error('late rejected provider; must be observed'));
  await new Promise(resolve => setImmediate(resolve));
});

test('caller abort interrupts wrapper, signals underlying work and ignores late resolution', async () => {
  const held = deferred();
  const entered = deferred();
  const caller = new AbortController();
  let internalSignal;
  const operation = raceMetadata(signal => { internalSignal = signal; entered.resolve(); return held.promise; }, { signal: caller.signal });
  const result = assert.rejects(operation, { code: 'ABORTED' });
  await entered.promise;
  assert.equal(getEventListeners(caller.signal, 'abort').length, 1);
  caller.abort();
  await deadline(result);
  assert.equal(internalSignal.aborted, true);
  assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  held.resolve('late success');
  await new Promise(resolve => setImmediate(resolve));
});

test('already cancelled caller or closed scope never invokes provider', async () => {
  const controller = new AbortController();
  controller.abort();
  let invoked = 0;
  await assert.rejects(raceMetadata(() => ++invoked, { signal: controller.signal }), { code: 'ABORTED' });
  await assert.rejects(raceMetadata(() => ++invoked, { shutdownSignal: controller.signal }), { code: 'READ_SCOPE_CLOSED' });
  assert.equal(invoked, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('scope close cancels all held reads without joining uncooperative providers', async () => {
  const scope = createReadScope();
  const held = Array.from({ length: 3 }, deferred);
  const entered = Array.from({ length: 3 }, deferred);
  const calls = held.map((item, index) => scope.run(() => { entered[index].resolve(); return item.promise; }).catch(error => error));
  await Promise.all(entered.map(item => item.promise));
  const closing = scope.close();
  assert.equal(scope.close(), closing);
  await deadline(closing, 100);
  assert.deepEqual((await Promise.all(calls)).map(error => error.code), ['READ_SCOPE_CLOSED', 'READ_SCOPE_CLOSED', 'READ_SCOPE_CLOSED']);
  await assert.rejects(scope.run(() => 'new work'), { code: 'READ_SCOPE_CLOSED' });
  for (const item of held) item.reject(new Error('late shutdown rejection'));
  await new Promise(resolve => setImmediate(resolve));
});

test('operation timers are unrefed and cleared after cancellation', async () => {
  const original = globalThis.setTimeout;
  const observed = [];
  globalThis.setTimeout = (...args) => { const timer = original(...args); observed.push(timer); return timer; };
  const caller = new AbortController();
  try {
    const operation = raceMetadata(() => new Promise(() => {}), { signal: caller.signal });
    assert.equal(observed.length, 1);
    assert.equal(observed[0].hasRef(), false);
    const result = assert.rejects(operation, { code: 'ABORTED' });
    caller.abort();
    await result;
    assert.equal(getEventListeners(caller.signal, 'abort').length, 0);
  } finally { globalThis.setTimeout = original; }
});

test('metadata deadlines are finite bounded integers and malformed inputs fail closed', async () => {
  for (const timeoutMs of [0, -1, Infinity, NaN, 120001, 0.5]) {
    await assert.rejects(raceMetadata(() => 1, { timeoutMs }), { code: 'INVALID_TIMEOUT' });
    assert.throws(() => createReadScope({ timeoutMs }), { code: 'INVALID_TIMEOUT' });
  }
  await assert.rejects(raceMetadata(undefined), { code: 'INVALID_OPERATION' });
  await assert.rejects(raceMetadata(() => 1, { signal: {} }), { code: 'INVALID_SIGNAL' });
});
