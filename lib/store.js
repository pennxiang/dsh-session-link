import { mkdir, open, rename, unlink, chmod, rmdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const fail = (code, message) => Object.assign(new Error(message), { code });
const fresh = () => ({ version: 1, deliveries: [], tasks: [], reception: {} });
const copy = value => structuredClone(value);

/** One writer per directory. A stale lock is deliberately fail-closed, not stolen. */
export async function createStore(directory, options = {}) {
  if (typeof directory !== 'string' || !directory) throw fail('INVALID_DIRECTORY', 'A storage directory is required');
  const root = resolve(directory);
  const file = join(root, 'state.json');
  const lock = join(root, '.writer-lock');
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 || maxBytes > 128 * 1024 * 1024) throw fail('INVALID_CONFIG', 'Invalid maxBytes');
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw fail('STORE_LOCKED', 'Storage has an exclusive writer lock; after a crash, verify the previous writer is stopped before manually removing .writer-lock');
    throw error;
  }
  let state;
  let tail = Promise.resolve();
  let closing = false;
  let closePromise;
  const ownerPath = join(lock, 'owner.json');
  async function persist(next) {
    const text = JSON.stringify(next);
    if (Buffer.byteLength(text) > maxBytes) throw fail('STORE_FULL', 'Storage byte limit exceeded');
    const temp = join(root, `.state-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temp, 'wx', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, file);
      // Durability of the rename is separate from durability of the file contents.
      const dir = await open(root, 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally {
      if (handle) await handle.close();
      await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  function validate(next) {
    if (!next || next.version !== 1 || !Array.isArray(next.deliveries) || !Array.isArray(next.tasks) || !next.reception || typeof next.reception !== 'object' || Array.isArray(next.reception)) throw fail('INVALID_STATE', 'Unsupported or malformed storage state');
  }
  async function unlock() {
    await unlink(ownerPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await rmdir(lock);
  }
  try {
    const owner = await open(ownerPath, 'wx', 0o600);
    try { await owner.writeFile(JSON.stringify({ pid: process.pid, nonce: randomUUID() })); } finally { await owner.close(); }
    try {
      const handle = await open(file, 'r');
      try {
        if ((await handle.stat()).size > maxBytes) throw fail('STORE_FULL', 'Existing state exceeds storage byte limit');
        state = JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
      await chmod(file, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      state = fresh();
    }
    validate(state);
    for (const delivery of state.deliveries) {
      if (delivery.state === 'sending') {
        delivery.state = 'unknown';
        delivery.receipt = 'unknown';
        delivery.error = { code: 'RESTART_UNKNOWN', message: 'Interrupted intent: inspect before retrying with a new requestId' };
      }
    }
    for (const task of state.tasks) {
      const delivery = state.deliveries.find(item => item.id === task.deliveryId);
      if (delivery) task.deliveryState = delivery.state;
      else if (task.deliveryState === 'sending') task.deliveryState = 'unknown';
    }
    await persist(state);
  } catch (error) {
    await unlock().catch(() => {});
    throw error;
  }
  return {
    async read() {
      if (closing) throw fail('STORE_CLOSED', 'Store is closed');
      await tail;
      return copy(state);
    },
    mutate(fn) {
      if (closing) return Promise.reject(fail('STORE_CLOSED', 'Store is closed'));
      if (typeof fn !== 'function') return Promise.reject(fail('INVALID_MUTATION', 'Mutation must be a function'));
      const operation = tail.then(async () => {
        const draft = copy(state);
        const result = await fn(draft);
        validate(draft);
        // Serialize and detach so callback-retained references cannot mutate committed state.
        const committed = JSON.parse(JSON.stringify(draft));
        await persist(committed);
        state = committed;
        return copy(result);
      });
      tail = operation.catch(() => {});
      return operation;
    },
    close() {
      if (!closePromise) {
        closing = true;
        closePromise = tail.then(unlock);
      }
      return closePromise;
    },
  };
}
