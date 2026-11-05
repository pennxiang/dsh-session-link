#!/usr/bin/env node
/** Isolated rc.5 Loader/client-module metadata contract smoke.
 * Only a new Context and explicitly authored temporary package/profile are used.
 * No production configuration, private registry cache, browser or model is used.
 * DSH_RUNTIME points to a runtime directory containing package.json/node_modules.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = process.env.DSH_RUNTIME;
if (!runtime) throw new Error('Set DSH_RUNTIME to the runtime directory containing package.json and node_modules.');
const requireRuntime = createRequire(resolve(runtime, 'package.json'));
const load = name => import(pathToFileURL(requireRuntime.resolve(`@deepseek-ai/${name}`)).href);
const report = {
  pluginVersion: createRequire(import.meta.url)('../package.json').version,
  runtimeVersion: requireRuntime('./package.json').version,
  isolation: { freshContext: true, temporaryProfileOnly: true, privateCacheAccess: false,
    productionProfileAccess: false, registeredLlmProviders: 0, networkRequests: 0 },
  fixtures: ['temporary dsh-session-link package manifest, bundle patch and inert host module',
    'temporary profile manifest and isolated installation anchor; real AppBoot readBundlePatches/composeEntries',
    'temporary registration-only client bundle; not the production plugin implementation'],
  checks: [],
  limitations: ['Host graph and bundle serving only; not browser rendering, HMR delivery or actual plugin behavior.',
    'Same-id replacement uses public Loader remove/create lifecycle, not private cache invalidation.'],
};
assert.equal(report.pluginVersion, '0.1.0');
assert.equal(report.runtimeVersion, '0.2.1-rc.5', 'Only the installed rc.5 contract is asserted.');
const tmp = await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-link-client-modules-')));
const packageId = 'dsh-session-link';
const entryId = 'session-link-fixture';
const bare = packageId;
const bundleEntry = './index.js';
const packageRoot = join(tmp, 'node_modules', packageId);
const expectedEntryUrl = pathToFileURL(join(packageRoot, 'index.js')).href;
const installRoot = join(tmp, 'isolated-install');
const installAnchor = join(installRoot, 'package.json');
const manifestPath = join(packageRoot, 'package.json');
const baseUrl = pathToFileURL(join(tmp, 'cordis.yml')).href;
let root, failure;
let graphNotifications = 0;
const mountedStages = [];
const disposedStages = [];
const check = (name, details = {}) => report.checks.push({ name, passed: true, ...details });
const timeout = async (promise, label) => {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10000);
    })]);
  } finally { clearTimeout(timer); }
};

try {
  await mkdir(packageRoot, { recursive: true });
  await mkdir(installRoot, { recursive: true });
  await writeFile(installAnchor, JSON.stringify({ name: 'isolated-install-anchor', private: true, type: 'module' }));
  const manifest = { name: packageId, version: '0.1.0', type: 'module',
    exports: { '.': './index.js', './client': './client.js', './package.json': './package.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' } } };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await writeFile(join(tmp, 'package.json'), JSON.stringify({ name: 'isolated-client-module-profile', private: true,
    type: 'module', dsh: { profile: { bundles: [packageId] } } }));
  await writeFile(join(tmp, 'cordis.yml'), '# Explicit temporary resolution base; no production config is loaded.\n');
  await writeFile(join(packageRoot, 'index.js'), `export const name = ${JSON.stringify(packageId)};
export function apply(ctx, config) {
  ctx.emit('fixture/session-link-mounted', config.stage);
  ctx.effect(() => () => ctx.emit('fixture/session-link-disposed', config.stage));
}
`);
  const bundle = `window.__ModuleLoader__.load({id:${JSON.stringify(packageId)},factory(){return {fixture:"temporary-client-module"}}});\n`;
  await writeFile(join(packageRoot, 'client.js'), bundle);

  const { Context } = await load('cordis');
  const { Loader } = await load('cordis-plugin-loader');
  const { ClientModuleRegistry } = await load('dsh-client-modules');
  const { readBundlePatches, composeEntries } = await load('dsh-app-boot');
  const composeStage = async (name, stage) => {
    // JSON is valid YAML. The real AppBoot bundle loader must read this
    // package's actual dsh.bundle patch and anchor inserted relative names
    // beside that patch, not beside the profile's root config.
    await writeFile(join(packageRoot, 'cordis.patch.yml'), JSON.stringify([
      { insert: [{ id: entryId, name, config: { stage } }] },
    ], null, 2));
    const patches = readBundlePatches('isolated-client-module-smoke', { dir: tmp, installAnchor });
    const warnings = [];
    const entries = composeEntries([patches], message => warnings.push(message));
    assert.deepEqual(warnings, []);
    assert.equal(entries.length, 1, 'The real bundle patch phase composes one stable-id row.');
    assert.equal(entries[0].id, entryId);
    assert.deepEqual(entries[0].config, { stage });
    return entries[0];
  };
  root = new Context();
  root.on('fixture/session-link-mounted', stage => mountedStages.push(stage));
  root.on('fixture/session-link-disposed', stage => disposedStages.push(stage));
  await root.plugin(Loader, { baseUrl });
  // This is the unmodified real Loader, including its real Node resolution.
  // A bare-package import must resolve from the temporary profile base.
  assert.ok(root.loader.internal, 'The real Loader needs Node internals for tree-anchored bare imports.');
  await root.plugin(ClientModuleRegistry);
  const registry = root.clientModules;
  const loader = root.loader;
  root.effect(() => registry.onGraphChanged(() => { graphNotifications++; }));
  const settle = async () => {
    await timeout(loader.await(), 'public Loader lifecycle settlement');
    // ClientModuleRegistry intentionally reconciles lifecycle changes in a
    // microtask. Yield once, without calling its private flush/cache methods.
    await new Promise(resolve => setImmediate(resolve));
  };
  const entry = () => [...loader.entries()].filter(item => item.id === entryId);
  const assertMounted = (name, stage) => {
    const entries = entry();
    assert.equal(entries.length, 1, 'Exactly one Loader entry owns the stable id.');
    assert.equal(entries[0].options.name, name);
    assert.equal(entries[0].parent.tree.ctx.baseUrl, baseUrl);
    assert.equal(entries[0].fiber.state, 2, 'Fixture host plugin is active.');
    assert.equal(entries[0].moduleNamespace.name, packageId);
    assert.equal(mountedStages.at(-1), stage);
  };
  const create = async options => {
    const id = await loader.create(options);
    assert.equal(id, entryId);
    await settle();
    assertMounted(options.name, options.config.stage);
  };
  const replace = async options => {
    // Entry.update does not promise to re-import a changed name. Explicit
    // public remove/create guarantees a real remount while preserving id.
    loader.remove(entryId);
    await settle();
    assert.equal(entry().length, 0);
    await create(options);
  };

  const initial = await composeStage(bare, 'no-client-declaration');
  assert.equal(initial.name, bare, 'AppBoot leaves a bare package-root name literal.');
  await create(initial);
  assert.deepEqual(registry.graph().entries, []);
  assert.equal(registry.clientPath(packageId), undefined);
  assert.equal(graphNotifications, 0);
  const emptyRev = registry.graph().rev;
  check('real-loader-bare-entry-without-client-declaration-has-no-graph-row', { entryId, specifier: bare });

  manifest.dsh.client = { platform: 'web', immediately: true, inject: [] };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')).dsh, manifest.dsh);
  const unchangedBare = await composeStage(bare, 'same-bare-after-manifest-upgrade');
  assert.equal(unchangedBare.name, bare);
  await replace(unchangedBare);
  assert.deepEqual(registry.graph().entries, [], 'Negative control: manifest upgrade alone does not invalidate the cached no-client verdict.');
  assert.equal(registry.graph().rev, emptyRev);
  assert.equal(registry.clientPath(packageId), undefined);
  assert.equal(graphNotifications, 0);
  assert.deepEqual(disposedStages, ['no-client-declaration']);
  check('same-id-same-bare-real-remount-retains-negative-metadata-verdict', { entryId, specifier: bare, graphRows: 0 });

  // Guard against the original direct-Loader-only false positive: AppBoot
  // anchors this name at the BUNDLE patch, so repeating node_modules here
  // would point into a nonexistent nested package tree.
  const wrongRelative = './node_modules/dsh-session-link/index.js';
  const wrongEntry = await composeStage(wrongRelative, 'wrong-profile-relative-entry');
  assert.equal(wrongEntry.name, pathToFileURL(join(packageRoot, 'node_modules', packageId, 'index.js')).href);
  assert.notEqual(wrongEntry.name, expectedEntryUrl);
  const migrated = await composeStage(bundleEntry, 'pathlike-after-manifest-upgrade');
  assert.equal(migrated.name, expectedEntryUrl, 'AppBoot anchors ./index.js at the bundle patch and emits the absolute file URL.');
  assert.equal(new URL(migrated.name).protocol, 'file:');
  check('real-appboot-bundle-patch-anchors-own-index-at-package-not-profile', {
    insertedName: bundleEntry, composedName: migrated.name,
    wrongInsertedName: wrongRelative, wrongComposedName: wrongEntry.name,
  });
  await replace(migrated);
  const graph = registry.graph();
  assert.equal(graph.entries.length, 1);
  assert.equal(graph.entries[0].id, packageId, 'Browser module id comes from the nearest package manifest, not the pathlike Loader specifier.');
  assert.equal(graph.entries[0].immediately, true);
  assert.deepEqual(graph.entries[0].inject, []);
  assert.notEqual(graph.rev, emptyRev);
  assert.equal(registry.clientPath(packageId), join(packageRoot, 'client.js'));
  assert.equal(graphNotifications, 1, 'Only the positive pathlike remount changes the graph.');
  assert.deepEqual(mountedStages, ['no-client-declaration', 'same-bare-after-manifest-upgrade', 'pathlike-after-manifest-upgrade']);
  assert.deepEqual(disposedStages, ['no-client-declaration', 'same-bare-after-manifest-upgrade']);
  assert.equal(new Set(graph.entries.map(item => item.id)).size, 1);
  assert.equal([...loader.entries()].length, 1);
  assert.equal(graph.batches.flatMap(batch => batch.entries).filter(id => id === packageId).length, 1);
  check('same-id-pathlike-real-remount-discovers-client-row-with-stable-package-id', {
    entryId, insertedName: bundleEntry, specifier: migrated.name, moduleId: graph.entries[0].id, graphRows: graph.entries.length,
    graphNotifications, mountedStages: [...mountedStages], disposedStages: [...disposedStages],
  });

  const response = await registry.fetchBundle(new Request(new URL(graph.entries[0].url, 'http://fixture.invalid/')));
  assert.equal(response.status, 200);
  const served = await response.text();
  assert.ok(served.includes(bundle.trim()));
  assert.equal((served.match(/temporary-client-module/g) ?? []).length, 1);
  check('public-revisioned-bundle-response-serves-one-temporary-module-without-network', { status: response.status });

  loader.remove(entryId);
  await settle();
  assert.deepEqual(registry.graph().entries, []);
  assert.equal(registry.clientPath(packageId), undefined);
  assert.equal([...loader.entries()].length, 0);
  assert.equal(graphNotifications, 2);
  assert.deepEqual(disposedStages, mountedStages);
  check('public-loader-removal-disposes-module-and-removes-graph-row');
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  if (root) try { await timeout(Promise.resolve(root.fiber.dispose()), 'Context disposal'); } catch (error) {
    report.cleanupErrors ??= []; report.cleanupErrors.push(error.message); failure ??= error;
  }
  try { await rm(tmp, { recursive: true, force: true }); } catch (error) {
    report.cleanupErrors ??= []; report.cleanupErrors.push(error.message); failure ??= error;
  }
  report.ok = !failure;
  report.modelCalls = 0;
  console.log(JSON.stringify(report, null, 2));
  if (failure) process.exitCode = 1;
}
