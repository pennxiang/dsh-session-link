const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 120000;
const failure = (code, message) => Object.assign(new Error(message), { code });

function validateTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) throw failure('INVALID_TIMEOUT', `Metadata timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} milliseconds.`);
  return value;
}
function validateSignal(signal) {
  if (signal !== undefined && (typeof signal?.addEventListener !== 'function' || typeof signal?.removeEventListener !== 'function' || typeof signal?.aborted !== 'boolean')) throw failure('INVALID_SIGNAL', 'Expected an AbortSignal.');
}

/**
 * Bound a PURE METADATA operation even when its provider ignores cancellation.
 * Never wrap create/deliver/persist/other side effects: a timed-out operation may
 * still run underneath. Late completion is observed and discarded, not retried.
 * The operation receives a fresh signal aborted on timeout, caller cancel, or
 * scope shutdown. Every completion path removes parent listeners and its timer.
 */
export function raceMetadata(operation, { signal, shutdownSignal, timeoutMs = DEFAULT_TIMEOUT_MS, timeoutCode = 'METADATA_TIMEOUT' } = {}) {
  if (typeof operation !== 'function') return Promise.reject(failure('INVALID_OPERATION', 'Metadata operation must be a function.'));
  try {
    validateTimeout(timeoutMs);
    validateSignal(signal);
    validateSignal(shutdownSignal);
    if (typeof timeoutCode !== 'string' || !/^[A-Z][A-Z_]{0,79}$/.test(timeoutCode)) throw failure('INVALID_TIMEOUT', 'Invalid metadata timeout error code.');
  } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let timer;
    const cleanups = [];
    function finish(error, value, cancelUnderlying = false, rejected = error !== undefined) {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
      if (cancelUnderlying) controller.abort(error);
      if (rejected) reject(error); else resolve(value);
    }
    function listen(source, code, message) {
      if (source === undefined) return;
      const callback = () => finish(failure(code, message), undefined, true);
      if (source.aborted) { callback(); return; }
      source.addEventListener('abort', callback, { once: true });
      cleanups.push(() => source.removeEventListener('abort', callback));
      // Native signals cannot change between these synchronous statements, but
      // this also keeps injected signal implementations fail-closed.
      if (source.aborted) callback();
    }
    listen(shutdownSignal, 'READ_SCOPE_CLOSED', 'Metadata scope was closed.');
    if (settled) return;
    listen(signal, 'ABORTED', 'Metadata operation was cancelled.');
    if (settled) return;
    timer = setTimeout(() => finish(failure(timeoutCode, 'Metadata operation exceeded its bounded deadline.'), undefined, true), timeoutMs);
    timer.unref?.();
    // Attach both handlers before the provider can settle. Even an eventual
    // rejection after our timeout/cancellation is consumed, never unhandled.
    Promise.resolve().then(() => {
      if (settled) return undefined;
      return operation(controller.signal);
    }).then(value => finish(undefined, value), error => finish(error));
  });
}

/** Read-only lifetime scope. Closing drains wrappers, not abandoned providers. */
export function createReadScope({ timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  validateTimeout(timeoutMs);
  const shutdown = new AbortController();
  const active = new Set();
  let closing = false;
  let closed;
  return {
    run(operation, options = {}) {
      if (closing) return Promise.reject(failure('READ_SCOPE_CLOSED', 'Metadata scope is closed.'));
      const promise = raceMetadata(operation, { ...options, timeoutMs: options.timeoutMs ?? timeoutMs, shutdownSignal: shutdown.signal });
      active.add(promise);
      promise.then(() => active.delete(promise), () => active.delete(promise));
      return promise;
    },
    close() {
      if (!closed) {
        closing = true;
        shutdown.abort();
        closed = Promise.allSettled([...active]).then(() => undefined);
      }
      return closed;
    },
  };
}
