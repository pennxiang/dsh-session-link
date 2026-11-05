import test from 'node:test';
import assert from 'node:assert/strict';
import { createService } from '../lib/service.js';
import { TOOLS, concurrencySafe } from '../lib/tool-schema.js';

function fixture(sessionCreator) {
  const agent = { id: 'caller' };
  const counts = { hostClose: 0, storeClose: 0 };
  const service = createService({ sessionCreator,
    host: { describe: async id => ({ id, live: true, archived: false, cwd: '/fixture' }), close: () => { counts.hostClose++; } },
    store: { close: async () => { counts.storeClose++; } },
  });
  return { service, exec: { agent, signal: new AbortController().signal }, counts };
}

test('creator tools dispatch exact exec identity and omit optional undefined outputs', async () => {
  const calls = [];
  const creator = {
    create: async (args, exec) => { calls.push(['create', args, exec]); return { sessionId: 'new-session', omitted: undefined }; },
    models: async (args, exec) => { calls.push(['models', args, exec]); return { providers: [{ id: 'provider', omitted: undefined }] }; },
    close() {},
  };
  const { service, exec } = fixture(creator);
  try {
    const args = { provider: 'provider', model: 'model', requestId: 'request' };
    assert.deepEqual(await service.execute('link_session_create', args, exec), { sessionId: 'new-session' });
    assert.deepEqual(await service.execute('link_models', {}, exec), { providers: [{ id: 'provider' }] });
    assert.equal(calls[0][1], args);
    assert.equal(calls[0][2].agent, exec.agent);
    assert.ok(calls[1][2].signal instanceof AbortSignal);
    assert.equal(calls[1][2].signal.aborted, false);
    assert.equal(calls[1][2].agent, exec.agent);
  } finally { await service.close(); }
});

test('unsupported deployments keep original tools and report creation capability absence', async () => {
  const { service, exec } = fixture();
  try {
    await assert.rejects(service.execute('link_session_create', {}, exec), { code: 'CREATE_UNAVAILABLE' });
    await assert.rejects(service.execute('link_models', {}, exec), { code: 'CATALOG_UNAVAILABLE' });
  } finally { await service.close(); }
});

test('creator drains before shared store closes, all resources close even if creator fails', async () => {
  const sequence = [];
  const service = createService({ host: { close: () => sequence.push('host') },
    store: { close: () => sequence.push('store') },
    sessionCreator: { close: async () => { sequence.push('creator'); throw new Error('fixture close'); } },
  });
  await assert.rejects(service.close(), /fixture close/);
  assert.deepEqual(sequence, ['creator', 'store', 'host']);
  await assert.rejects(service.close(), /fixture close/);
  assert.deepEqual(sequence, ['creator', 'store', 'host']);
});

test('nine tool declarations expose strict creation, archive and bounded discovery', () => {
  assert.equal(TOOLS.length, 9);
  const create = TOOLS.find(tool => tool.name === 'link_session_create');
  assert.deepEqual(create.parameters.required, ['provider', 'model', 'requestId']);
  assert.equal(create.parameters.additionalProperties, false);
  assert.equal(create.parameters.properties.reasoningEffort.maxLength, 100);
  assert.equal(create.parameters.properties.provider.maxLength, 200);
  assert.equal(create.parameters.properties.model.maxLength, 200);
  assert.equal(create.timeoutMs, 120000);
  const models = TOOLS.find(tool => tool.name === 'link_models');
  assert.equal(models.parameters.properties.limit.maximum, 100);
  assert.equal(models.parameters.properties.provider.maxLength, 200);
  assert.equal(concurrencySafe('link_session_create', {}), false);
  assert.equal(concurrencySafe('link_models', {}), true);
  const archive = TOOLS.find(tool => tool.name === 'link_session_archive');
  assert.deepEqual(archive.parameters.required, ['action']);
  assert.equal(archive.parameters.additionalProperties, false);
  assert.deepEqual(archive.parameters.properties.action.enum, ['list', 'archive']);
  assert.equal(archive.parameters.properties.targetId.maxLength, 256);
  assert.equal(archive.parameters.properties.requestId.maxLength, 128);
  assert.equal(concurrencySafe('link_session_archive', { action: 'list' }), true);
  assert.equal(concurrencySafe('link_session_archive', { action: 'archive' }), false);
});
