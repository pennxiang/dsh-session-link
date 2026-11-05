// Isolated package/import/lifetime smoke. Real Host exports, fake tools registry;
// no production Context, sessions, profile, HTTP requests, models or credentials.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const runtime = process.env.DSH_RUNTIME;
if (!runtime) throw new Error('Set DSH_RUNTIME to the DSH runtime directory containing package.json and node_modules.');
const version = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).version;
const temp = await mkdtemp(join(tmpdir(), 'dsh-session-link-package-'));
try {
  const pkg = join(temp, 'plugin');
  await mkdir(join(pkg, 'node_modules'), { recursive: true });
  for (const name of ['index.js', 'lib', 'package.json', 'cordis.patch.yml']) await cp(join(root, name), join(pkg, name), { recursive: true });
  await symlink(resolve(runtime, 'node_modules', '@deepseek-ai'), join(pkg, 'node_modules', '@deepseek-ai'), 'dir');
  const plugin = await import(pathToFileURL(join(pkg, 'index.js')).href);
  const definitions = new Map();
  let storeClosed = 0;
  let serviceClosed = 0;
  let pendingDone = false;
  let resolveWork;
  let sawOptions;
  const store = { close: async () => { storeClosed++; } };
  const ctx = { tools: { register(def) {
    assert(!definitions.has(def.name));
    definitions.set(def.name, def);
    return () => definitions.delete(def.name);
  } } };
  const runtimeHandle = await plugin.mount(ctx, {}, {
    directory: join(temp, 'data'),
    createStore: async () => store,
    createHostAdapter: (_ctx, options) => { sawOptions = options; return {}; },
    createService: () => ({
      async execute(name, args, exec) {
        assert.equal(exec.agent.id, 'fixture-caller');
        if (args.fail) throw Object.assign(new Error('Fixture rejected'), { code: 'FIXTURE_REJECTED', deliveryId: 'delivery-1', sessionId: 'created-root', requestedSessionId: 'requested-root', stage: 'selection', state: 'partial', replayed: true, targetId: 'archive-target', activitySummary: 'x'.repeat(5000), archived: false, readback: false, stopActivityRequested: false });
        if (args.wait) {
          await new Promise(resolve => { resolveWork = resolve; });
          pendingDone = true;
        }
        return { name, sender: exec.agent.id };
      },
      async close() { serviceClosed++; await store.close(); },
    }),
  });
  assert.equal(definitions.size, 9);
  assert.equal(typeof sawOptions.createUserMessage, 'function');
  assert.equal(sawOptions.subagentVersion, version);
  if (version === '0.2.1-rc.5') {
    assert.equal(typeof sawOptions.queueHostSubagentPrompt, 'function');
    assert.equal(typeof sawOptions.steerHostSubagentPrompt, 'function');
  }
  for (const def of definitions.values()) {
    assert.equal(def.deferLoading, undefined);
    assert.equal(def.parameters.additionalProperties, false);
    const answer = await def.execute({}, { agent: { id: 'fixture-caller' } });
    assert.equal(answer.ok, true);
    assert.equal(answer.sender, 'fixture-caller');
    const failure = await def.execute({ fail: true }, { agent: { id: 'fixture-caller' } });
    assert.equal(failure.ok, false);
    assert.equal(failure.error.code, 'FIXTURE_REJECTED');
    assert.equal(failure.error.deliveryId, 'delivery-1');
    assert.equal(failure.error.sessionId, 'created-root');
    assert.equal(failure.error.requestedSessionId, 'requested-root');
    assert.equal(failure.error.stage, 'selection');
    assert.equal(failure.error.state, 'partial');
    assert.equal(failure.error.replayed, true);
    assert.equal(failure.error.targetId, 'archive-target');
    assert.equal(failure.error.activitySummary.length, 4000);
    assert.equal(failure.error.archived, false);
    assert.equal(failure.error.readback, false);
    assert.equal(failure.error.stopActivityRequested, false);
  }
  const operation = definitions.get('link_send').execute({ wait: true }, { agent: { id: 'fixture-caller' } });
  await Promise.resolve();
  const closing = runtimeHandle.close();
  assert.equal(pendingDone, false);
  assert.equal(serviceClosed, 0, 'must not close persistence under inflight delivery');
  resolveWork();
  await operation;
  await closing;
  await runtimeHandle.close();
  assert.equal(definitions.size, 0);
  assert.equal(serviceClosed, 1);
  assert.equal(storeClosed, 1);
  const disabled = await plugin.mount(ctx, { enabled: false }, { createStore: () => { throw new Error('disabled must not open store'); } });
  assert.deepEqual(disabled.toolNames, []);
  await disabled.close();
  let failedStoreClosed = 0;
  let failedHostClosed = 0;
  await assert.rejects(plugin.mount(ctx, {}, {
    createStore: async () => ({ close: async () => { failedStoreClosed++; } }),
    createHostAdapter: () => ({ close: async () => { failedHostClosed++; } }),
    createService: () => { throw new Error('Fixture service initialization failure'); },
  }), /Fixture service initialization failure/);
  assert.equal(failedStoreClosed, 1);
  assert.equal(failedHostClosed, 1, 'failed initialization must dispose receipt listeners');
  const schemaDefaults = plugin.Config({});
  assert.equal(schemaDefaults.enabled, true);
  assert.equal(schemaDefaults.sameDirectoryOnly, false);
  assert.equal(schemaDefaults.maxMessageChars, 8000);
  console.log(JSON.stringify({ ok: true, hostVersion: version, tools: runtimeHandle.toolNames, realHostExports: true, registry: 'isolated fixture', lifetimeDrained: true, productionSessionsTouched: false }, null, 2));
} finally {
  await rm(temp, { recursive: true, force: true });
}
