import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
async function scan(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory() && !['node_modules', '.git', 'artifacts'].includes(entry.name)) await scan(path);
    else if (entry.isFile() && /\.(m?js)$/.test(entry.name)) {
      const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
      if (result.status !== 0) throw new Error(`${relative(root, path)}: ${result.stderr || result.error}`);
    }
  }
}
await scan(root);
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
for (const name of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
  assert(!Object.keys(pkg[name] || {}).some(key => key === 'cordis' || key === '@deepseek-ai/cordis'), 'Do not package Cordis or force a duplicate Host framework.');
}
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare']) assert(!(hook in pkg.scripts), `Forbidden install hook: ${hook}`);
const { TOOLS } = await import('../lib/tool-schema.js');
assert.equal(new Set(TOOLS.map(tool => tool.name)).size, 9);
for (const tool of TOOLS) {
  assert(tool.name.startsWith('link_'));
  assert.equal(tool.parameters.type, 'object');
  assert.equal(tool.parameters.additionalProperties, false);
  for (const key of tool.parameters.required || []) assert(key in tool.parameters.properties);
}
console.log('Syntax, plugin manifest and nine tool schemas passed.');
