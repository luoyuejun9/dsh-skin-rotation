#!/usr/bin/env node
/**
 * Verify the real npm tarball: pack it, unpack it into a clean directory, and
 * assert the shipped package can actually load — without publishing anything.
 *
 * Checks, in order:
 *   1. `npm pack` succeeds and produces exactly one tarball;
 *   2. every path in `files` is present in the tarball, and nothing outside it
 *      (tests, tools, CI config, local notes) leaks in;
 *   3. `main` / `exports` targets exist and every shipped .js parses;
 *   4. the packed package resolves from a directory with no repo nearby, and
 *      its plugin exports (name / apply / inject) are intact;
 *   5. the packed cordis.patch.yml inserts exactly one row for this package.
 *
 * Usage: node tools/verify-package.mjs
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'dsh-skin-rotation-pack-'));
const failures = [];
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`  FAIL ${label}: ${error.message}`);
  }
};

console.log(`verifying ${manifest.name}@${manifest.version}`);

// 1. pack
const packDir = join(work, 'pack');
mkdirSync(packDir, { recursive: true });
const packed = execFileSync('npm', ['pack', '--pack-destination', packDir, '--json'], {
  cwd: packageDir,
  encoding: 'utf8',
  env: { ...process.env, npm_config_cache: join(work, 'npm-cache'), npm_config_loglevel: 'error' },
});
const packInfo = JSON.parse(packed);
assert.equal(packInfo.length, 1, 'npm pack must produce exactly one tarball');
const tarball = join(packDir, packInfo[0].filename);
const shipped = packInfo[0].files.map((file) => file.path).sort();
console.log(`  packed ${packInfo[0].filename} (${shipped.length} files, ${packInfo[0].size} bytes)`);

// 2. whitelist and no leaks
const required = ['package.json', 'cordis.patch.yml', 'lib/index.js', 'lib/client.js', 'lib/semver.js', 'lib/state.js', 'lib/rotation.js', 'lib/patch.js', 'README.md', 'LICENSE'];
check('every required runtime file is shipped', () => {
  for (const path of required) assert.ok(shipped.includes(path), `missing from tarball: ${path}`);
});
check('no repo-only files leak into the tarball', () => {
  const leaked = shipped.filter((path) => /^(test|tools|\.github|dist)\//.test(path) || path.includes('.tx.json') || path.includes('local-notes'));
  assert.deepEqual(leaked, [], `unexpected files: ${leaked.join(', ')}`);
});

// 3. unpack and parse
const unpacked = join(work, 'unpacked');
mkdirSync(unpacked, { recursive: true });
execFileSync('tar', ['-xzf', tarball, '-C', unpacked]);
const root = join(unpacked, 'package');
check('manifest entry points exist', () => {
  assert.ok(existsSync(join(root, manifest.main)), `main missing: ${manifest.main}`);
  for (const [key, value] of Object.entries(manifest.exports ?? {})) {
    const target = typeof value === 'string' ? value : value.import ?? value.default;
    if (target !== undefined) assert.ok(existsSync(join(root, target)), `exports["${key}"] missing: ${target}`);
  }
});
check('every shipped .js parses', () => {
  for (const path of shipped.filter((p) => p.endsWith('.js'))) {
    execFileSync(process.execPath, ['--check', join(root, path)], { stdio: 'pipe' });
  }
});
check('the bundle manifest declares dsh.bundle and a web client', () => {
  const packedManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(packedManifest.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(packedManifest.dsh?.client?.platform, 'web');
  assert.equal(typeof packedManifest.engines?.dsh, 'string');
});

// 4. load it from an isolated directory (the repo must not be on the resolution path)
const isolated = join(work, 'isolated');
mkdirSync(join(isolated, 'node_modules'), { recursive: true });
cpSync(root, join(isolated, 'node_modules', manifest.name), { recursive: true });
writeFileSync(join(isolated, 'package.json'), JSON.stringify({ name: 'pack-check', private: true, type: 'module' }), 'utf8');
const entry = join(isolated, 'node_modules', manifest.name, manifest.main);
const module = await import(pathToFileURL(entry).href);
check('the packed host half exports the plugin surface', () => {
  assert.equal(module.name, manifest.name);
  assert.deepEqual(module.inject, ['webServer']);
  assert.equal(typeof module.apply, 'function');
  assert.equal(typeof module.executeRotation, 'function');
  assert.equal(typeof module.defaultState, 'function');
});
check('the packed cordis.patch.yml inserts exactly this package', () => {
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8');
  const inserts = patch.split('- id:').length - 1;
  assert.equal(inserts, 1, `expected one inserted row, found ${inserts}`);
  assert.ok(patch.includes(`name: ${manifest.name}`), 'the inserted row must name this package');
});
check('no absolute developer paths are shipped', () => {
  for (const path of shipped.filter((p) => /\.(js|json|yml|md)$/.test(p))) {
    const text = readFileSync(join(root, path), 'utf8');
    assert.equal(/\/Users\/[a-z]/i.test(text), false, `absolute path found in ${path}`);
  }
});

rmSync(work, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`\n${failures.length} package check(s) failed`);
  process.exit(1);
}
console.log('\npackage verification passed');
void readdirSync;
