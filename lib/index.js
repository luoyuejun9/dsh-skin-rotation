/**
 * dsh-skin-rotation — host half.
 *
 * Smart skin rotation for DeepSeek Harness: local-first, configurable, and
 * recoverable. Every launch the host applies one rotation policy (random /
 * sequential / weighted / fixed) over the pool of installed, compatible,
 * non-excluded skins by rewriting the shared `dsh-skin managed` block of the
 * profile patch and the higher-priority home patch. DSH's own HMR patch
 * watcher then recomposes the live tree, so the page that opens afterwards
 * already carries the chosen skin.
 *
 * The block format, the "keep every foreign YAML record" rules, and the
 * discovery/validation walk mirror
 * `@smalltailqwq/dsh-client-ui-skin-deep-whale-manager` (MIT), so both plugins
 * can own the same block without fighting each other.
 *
 * The plugin never touches a skin's own files, its `skin.json`, or the skin
 * manager's state. Rotation state is a versioned preference stored beside the
 * profile, and a bounded history of completed rotations.
 *
 * @module dsh-skin-rotation
 */

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { satisfies } from './semver.js';
import {
  SCHEMA_VERSION,
  MODES,
  RECENT_RULES,
  readState,
  writeState,
  readHistory,
  appendHistory,
  writeHistory,
  defaultState,
  capturePreset,
  applyPreset,
  isValidPresetName,
} from './state.js';
import {
  classifyPool,
  chooseTarget,
  nextSequentialIndex,
  pickTarget as pickTargetCore,
  POOL_STATUS,
} from './rotation.js';
import {
  MANAGED_START,
  MANAGED_END,
  inspectBlock,
  stripManagedBlock,
  renderManagedBlock,
  switchPatch,
  atomicWrite,
  beginTransaction,
  completeTransaction,
  findPendingJournal,
  readJournal,
  rollbackFromJournal,
  cleanupJournals,
  classifyWriteState,
} from './patch.js';

/* -------------------------------------------------------------------------- */
/* v1-compatible re-exports (tests and embedders keep working unchanged)      */
/* -------------------------------------------------------------------------- */

export { satisfies };
export { MANAGED_START, MANAGED_END, stripManagedBlock, renderManagedBlock, switchPatch, atomicWrite };
export {
  readState,
  writeState,
  readHistory,
  appendHistory,
  writeHistory,
  defaultState,
  capturePreset,
  applyPreset,
  isValidPresetName,
  SCHEMA_VERSION,
};

export const name = 'dsh-skin-rotation';

/** The web carrier must be up before the settings route can be registered. */
export const inject = ['webServer'];

/** Same-origin host route used by the settings card. */
export const SKIN_ROTATION_ROUTE = '/api/dsh/skin-rotation';

/** @deprecated alias kept for the v1 surface; prefer patch.js exports. */
export const STATE_FILE = '.dsh-skin-rotation.json';

/* -------------------------------------------------------------------------- */
/* profile patch resolution                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the current profile's patch from the environment.
 * @param env - process environment.
 * @param cwd - current working directory.
 * @returns absolute path of the profile patch.
 */
export function resolveProfilePatch(env = process.env, cwd = process.cwd()) {
  const configuredHome = env.DSH_HOME?.trim();
  const harnessHome = configuredHome !== undefined && configuredHome !== ''
    ? resolve(configuredHome)
    : join(homedir(), '.dsh');
  const explicitProfile = env.DSH_SKIN_PROFILE?.trim() || env.DSH_PROFILE?.trim();
  const profilesDir = join(harnessHome, 'profiles');
  const inferredProfile = dirname(resolve(cwd)) === resolve(profilesDir) ? basename(resolve(cwd)) : undefined;
  const profile = explicitProfile || inferredProfile || 'web';
  if (!/^[a-zA-Z0-9._-]+$/.test(profile)) throw new Error('invalid-profile-name');
  return join(profilesDir, profile, 'cordis.patch.yml');
}

/**
 * Prefer the running Loader's own base URL over process-level fallbacks.
 * @param baseUrl - the root Loader base URL.
 * @param env - process environment.
 * @param cwd - current working directory.
 * @returns absolute path of the profile patch.
 */
export function resolveRuntimeProfilePatch(baseUrl, env = process.env, cwd = process.cwd()) {
  if (baseUrl !== undefined) {
    try {
      const baseDir = resolve(fileURLToPath(baseUrl));
      if (basename(dirname(baseDir)) === 'profiles') {
        const profile = basename(baseDir);
        if (!/^[a-zA-Z0-9._-]+$/.test(profile)) throw new Error('invalid-profile-name');
        return join(baseDir, 'cordis.patch.yml');
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid-profile-name') throw error;
    }
  }
  return resolveProfilePatch(env, cwd);
}

/**
 * Both live user layers, lowest priority first; the home layer wins.
 * @param profilePatch - absolute path of the profile patch.
 * @returns the profile patch and the home patch.
 */
export function patchTargetsForProfile(profilePatch) {
  return [profilePatch, join(dirname(dirname(dirname(profilePatch))), 'cordis.patch.yml')];
}

/* -------------------------------------------------------------------------- */
/* skin discovery                                                             */
/* -------------------------------------------------------------------------- */

/** Every dependency and declared bundle of a profile manifest. */
function packageNames(manifestPath) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const names = new Set(Object.keys(manifest.dependencies ?? {}));
    for (const value of manifest.dsh?.profile?.bundles ?? []) {
      if (typeof value === 'string') names.add(value);
    }
    return [...names];
  } catch {
    return [];
  }
}

/** Locate one package's `skin.json`, resolving the way the profile does. */
function skinManifestPath(profileManifest, packageName) {
  const require = createRequire(profileManifest);
  const located = (manifestPath) => {
    try {
      const own = JSON.parse(readFileSync(join(dirname(manifestPath), 'package.json'), 'utf8'));
      if (typeof own.name === 'string' && own.name !== '') return { manifestPath, packageName: own.name };
    } catch {
      /* fall through to the requested name */
    }
    return { manifestPath, packageName };
  };
  try {
    return located(require.resolve(`${packageName}/skin.json`));
  } catch {
    try {
      const candidate = join(dirname(require.resolve(`${packageName}/package.json`)), 'skin.json');
      return existsSync(candidate) ? located(candidate) : null;
    } catch {
      const candidate = join(dirname(profileManifest), 'node_modules', ...packageName.split('/'), 'skin.json');
      return existsSync(candidate) ? located(candidate) : null;
    }
  }
}

/**
 * Validate one `skin.json` into a catalog entry.
 * @param manifest - the parsed `skin.json`.
 * @param installedPackage - the package name the manifest was found under.
 * @returns the entry, or null when the manifest is not a valid skin.
 */
export function catalogEntry(manifest, installedPackage) {
  const id = manifest?.id;
  const skinName = manifest?.name;
  const packageName = manifest?.package;
  const wiringId = manifest?.wiring?.id;
  const bodyAttr = manifest?.bodyAttr;
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(id)) return null;
  if (typeof skinName !== 'string' || skinName.trim() === '') return null;
  if (packageName !== installedPackage) return null;
  if (typeof wiringId !== 'string' || !/^[a-zA-Z0-9@/_.:-]+$/.test(wiringId)) return null;
  if (typeof bodyAttr !== 'string' || !/^data-[a-z0-9_.:-]+$/.test(bodyAttr)) return null;
  return {
    id,
    name: skinName,
    ...(typeof manifest.nameEn === 'string' ? { nameEn: manifest.nameEn } : {}),
    ...(typeof manifest.tagline === 'string' ? { tagline: manifest.tagline } : {}),
    ...(typeof manifest.taglineEn === 'string' ? { taglineEn: manifest.taglineEn } : {}),
    ...(typeof manifest.author === 'string' ? { author: manifest.author } : {}),
    package: packageName,
    wiringId,
    bodyAttr,
    order: typeof manifest.order === 'number' && Number.isFinite(manifest.order) ? manifest.order : 100,
  };
}

/** Accepted exact grants of one profile; an unreadable file grants nothing. */
export function readProfileExemptions(profileDir) {
  try {
    const value = JSON.parse(readFileSync(join(profileDir, 'compatibility.json'), 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    for (const [key, versions] of Object.entries(value)) {
      if (Array.isArray(versions) && versions.every((version) => typeof version === 'string')) out[key] = versions;
    }
    return out;
  } catch {
    return {};
  }
}

/** The running DSH version, read from the boot package's own manifest. */
export function readDshRuntimeVersion(entry) {
  const target = entry ?? process.argv[1];
  try {
    if (target === undefined || target === '') return undefined;
    const manifest = createRequire(target).resolve('@deepseek-ai/dsh-app-boot/package.json');
    const value = JSON.parse(readFileSync(manifest, 'utf8')).version;
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Judge one plugin manifest the way the host's admission check does.
 * @param manifest - the parsed package.json.
 * @param runtimeVersion - the running DSH version.
 * @param exemptions - the profile's exact grants.
 * @returns the unsatisfied dsh peers, or undefined when the host admits it.
 */
export function evaluateSkinCompatibility(manifest, runtimeVersion, exemptions = {}) {
  if (manifest === null || typeof manifest !== 'object') return undefined;
  const { name: packageName, version, peerDependencies } = manifest;
  if (peerDependencies === null || typeof peerDependencies !== 'object' || Array.isArray(peerDependencies)) return undefined;
  const peers = {};
  for (const [peer, range] of Object.entries(peerDependencies)) {
    if (peer !== '@deepseek-ai/dsh' && !peer.startsWith('@deepseek-ai/dsh-')) continue;
    if (typeof range !== 'string') {
      peers[peer] = String(range);
      continue;
    }
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtimeVersion : range;
    if (requirement.trim() === '' || !satisfies(runtimeVersion, requirement)) peers[peer] = range;
  }
  if (Object.keys(peers).length === 0) return undefined;
  if (typeof packageName !== 'string' || typeof version !== 'string') return undefined;
  const key = `${packageName}@${version}`;
  return {
    package: key,
    runtimeVersion,
    peers,
    exempted: exemptions[key]?.includes(runtimeVersion) === true,
  };
}

/**
 * Discover every installed package that exposes a valid `skin.json`.
 * @param profilePatch - absolute path of the profile patch.
 * @param runtimeVersion - the running DSH version; when known, denied skins carry `compatibility`.
 * @returns the catalog, sorted by the skins' own declared order.
 */
export function discoverInstalledSkins(profilePatch = resolveProfilePatch(), runtimeVersion = readDshRuntimeVersion()) {
  const profileManifest = join(dirname(profilePatch), 'package.json');
  const exemptions = runtimeVersion === undefined ? {} : readProfileExemptions(dirname(profilePatch));
  const found = [];
  const ids = new Set();
  const wiringIds = new Set();
  for (const packageName of packageNames(profileManifest)) {
    const skin = skinManifestPath(profileManifest, packageName);
    if (skin === null) continue;
    try {
      const entry = catalogEntry(JSON.parse(readFileSync(skin.manifestPath, 'utf8')), skin.packageName);
      if (entry === null || ids.has(entry.id) || wiringIds.has(entry.wiringId)) continue;
      ids.add(entry.id);
      wiringIds.add(entry.wiringId);
      if (runtimeVersion !== undefined) {
        let manifest;
        try {
          manifest = JSON.parse(readFileSync(join(dirname(skin.manifestPath), 'package.json'), 'utf8'));
        } catch {
          manifest = undefined;
        }
        const compatibility = evaluateSkinCompatibility(manifest, runtimeVersion, exemptions);
        if (compatibility !== undefined) entry.compatibility = compatibility;
      }
      found.push(entry);
    } catch {
      /* one unreadable skin must not hide the others */
    }
  }
  return found.sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}

/**
 * Skins the host will actually load: no unsatisfied dsh peer, or an exact grant.
 * @param catalog - the discovered catalog.
 * @returns the admissible skins.
 */
export function admissibleSkins(catalog) {
  return catalog.filter((skin) => skin.compatibility === undefined || skin.compatibility.exempted);
}

/* -------------------------------------------------------------------------- */
/* patch state (enabled-skin computation)                                     */
/* -------------------------------------------------------------------------- */

/** The last explicit `disabled` value for each installed skin in one layer. */
export function readSkinStates(source, catalog) {
  const known = new Set(catalog.map((skin) => skin.wiringId));
  const states = new Map();
  let currentId;
  let currentIndent = -1;
  let propertyIndent;
  for (const line of source.split(/\r?\n/)) {
    const entry = line.match(/^(\s*)-\s+id:\s*(['"]?)([^'"#\s]+)\2\s*(?:#.*)?$/);
    if (entry !== null) {
      if (entry[1].length !== 0) continue;
      currentId = known.has(entry[3]) ? entry[3] : undefined;
      currentIndent = entry[1].length;
      propertyIndent = undefined;
      continue;
    }
    if (currentId === undefined) continue;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= currentIndent) {
      currentId = undefined;
      continue;
    }
    propertyIndent = propertyIndent === undefined ? indent : Math.min(propertyIndent, indent);
    const disabled = line.match(/^\s*disabled:\s*(true|false)\s*(?:#.*)?$/);
    if (disabled !== null && indent === propertyIndent) states.set(currentId, disabled[1] === 'true');
  }
  return states;
}

/**
 * Installed skins that are effectively enabled after profile then home
 * overrides. A skin with no explicit row anywhere is enabled: it is the skin's
 * own bundle patch, not the managed block, that inserts the row.
 * @param sources - the patch layers, lowest priority first.
 * @param catalog - the discovered catalog.
 * @returns the effectively enabled skins.
 */
export function enabledSkins(sources, catalog) {
  const states = new Map();
  for (const source of sources) {
    for (const [id, disabled] of readSkinStates(source, catalog)) states.set(id, disabled);
  }
  return catalog.filter((skin) => states.get(skin.wiringId) !== true);
}

/**
 * The one skin the host loads after profile and home overrides, else `official`.
 * @param sources - the patch layers, lowest priority first.
 * @param catalog - the discovered catalog.
 * @returns the active skin id.
 */
export function activeSkinTarget(sources, catalog) {
  const enabled = admissibleSkins(enabledSkins(sources, catalog));
  return enabled.length === 1 ? enabled[0].id : 'official';
}

/* -------------------------------------------------------------------------- */
/* rotation engine                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The user order for sequential mode: `state.order` filtered to ids still in
 * the pool, appending pool members missing from the order so newly installed
 * skins join at the end deterministically (never relying on scan order).
 */
function sequentialOrder(pool, state) {
  const poolIds = new Set(pool.map((skin) => skin.id));
  const ordered = (state.order ?? []).filter((id) => poolIds.has(id));
  const appended = pool.filter((skin) => !ordered.includes(skin.id)).map((skin) => skin.id);
  return [...ordered, ...appended];
}

/**
 * Persist one target in every live layer, then commit. A crash between file
 * writes leaves a journal that a later boot can roll back — this is crash
 * safety across local files, not a distributed transaction.
 * @param target - the skin id to enable, or `official`.
 * @param patchPaths - the patch layers, lowest priority first.
 * @param catalog - the discovered catalog.
 * @param txDir - directory for the transaction journal.
 * @returns { journalPath, originals } for the caller to complete or roll back.
 */
export function useSkin(target, patchPaths, catalog, txDir = undefined) {
  if (target !== 'official' && !catalog.some((skin) => skin.id === target)) {
    throw new Error(`skin-not-installed: ${target}`);
  }
  const originals = patchPaths.map((path) => ({
    path,
    existed: existsSync(path),
    source: existsSync(path) ? readFileSync(path, 'utf8') : '',
  }));
  for (const original of originals) {
    const inspection = inspectBlock(original.source);
    if (inspection.multiple || inspection.hasBeginOnly || inspection.hasEndOnly) {
      throw new Error(`refusing-to-write: managed block of ${basename(original.path)} is ${inspection.hasBeginOnly ? 'missing its END marker' : inspection.hasEndOnly ? 'missing its BEGIN marker' : 'duplicated'}`);
    }
  }
  const next = originals.map((original) => switchPatch(original.source, target, catalog));
  let journalPath = null;
  if (txDir !== undefined) journalPath = beginTransaction(txDir, target, originals).journalPath;
  const written = [];
  try {
    originals.forEach((original, index) => {
      // Create the parent directory on first write so a fresh profile works.
      mkdirSync(dirname(original.path), { recursive: true });
      atomicWrite(original.path, next[index]);
      written.push(original);
    });
  } catch (error) {
    for (const original of written.reverse()) {
      if (original.existed) atomicWrite(original.path, original.source);
      else rmSync(original.path, { force: true });
    }
    if (journalPath !== null) completeTransaction(journalPath);
    throw error;
  }
  return { journalPath, originals };
}

/**
 * Complete a successful `useSkin`: drop the journal and persist the new state
 * plus one history record. History/state failures are recorded, not thrown.
 * @returns the updated state.
 */
export function commitRotation(context, state, target, previous, trigger, journalPath, orderedIds) {
  if (journalPath !== null && journalPath !== undefined) completeTransaction(journalPath);
  const mode = state.mode;
  const next = {
    ...state,
    currentSkin: target,
    lastPicked: target,
    lastBootId: trigger === 'startup' ? context.bootId : state.lastBootId,
    lastRotatedAt: Date.now(),
    sequentialIndex: mode === 'sequential'
      ? nextSequentialIndex(state, orderedIds ?? [], target)
      : state.sequentialIndex,
    recentHistory: mode === 'random' || mode === 'weighted'
      ? [target, ...(state.recentHistory ?? []).filter((id) => id !== target)].slice(0, 8)
      : (state.recentHistory ?? []),
  };
  try {
    writeState(context.profileDir, next);
  } catch (error) {
    context.logger?.warn?.('[skin-rotation] state write failed after rotation', error);
  }
  const cap = state.historyLimit ?? 100;
  try {
    appendHistory(context.profileDir, {
      at: next.lastRotatedAt,
      from: previous,
      to: target,
      trigger,
      mode,
      ok: true,
      stage: 'committed',
      reason: null,
    }, cap);
    // Enforce the configured bound immediately so a lowered limit takes effect
    // now, not only after the next rotation.
    const all = readHistory(context.profileDir, 10000);
    if (all.length > cap) writeHistory(context.profileDir, all.slice(0, cap));
  } catch (error) {
    context.logger?.warn?.('[skin-rotation] history append failed', error);
  }
  return next;
}

/**
 * Record a failed rotation without touching the skin configuration.
 */
export function failRotation(context, state, previous, attempted, trigger, stage, reason) {
  try {
    appendHistory(context.profileDir, {
      at: Date.now(),
      from: previous,
      to: attempted ?? null,
      trigger,
      mode: state.mode,
      ok: false,
      stage,
      reason,
    }, state.historyLimit ?? 100);
  } catch {
    /* a history failure must never break the main flow */
  }
  return state;
}

/**
 * Execute one full rotation decision for a trigger. Pure decision → guarded
 * write → committed state/history. Every failure is recorded with its stage.
 * @param context - { patchPaths, profileDir, bootId, logger? }.
 * @param state - normalized state.
 * @param trigger - 'startup' | 'manual' | 'restore'.
 * @param options - { random?, ignoreFixed? }.
 * @returns { rotated, reason, target?, previous?, state, detail? }.
 */
export function executeRotation(context, state, trigger, options = {}) {
  const random = options.random ?? Math.random;
  const catalog = discoverInstalledSkins(context.patchPaths[0]);
  const sources = context.patchPaths.map((path) => (existsSync(path) ? readFileSync(path, 'utf8') : ''));
  const previous = activeSkinTarget(sources, catalog);

  if (!state.enabled && trigger !== 'manual' && trigger !== 'restore') {
    return { rotated: false, reason: 'disabled', state };
  }
  if (trigger === 'startup' && state.lastBootId === context.bootId) {
    return { rotated: false, reason: 'already-rotated', state };
  }

  const { skins, pool } = classifyPool(catalog, state);
  void skins;
  const effectiveState = options.ignoreFixed && state.mode === 'fixed'
    ? { ...state, mode: 'random', fixedSkin: null }
    : state;
  const orderedIds = sequentialOrder(pool, effectiveState);
  const decision = chooseTarget(pool, effectiveState, { random, current: previous });

  if (decision.target === null || decision.reason !== 'ok') {
    failRotation(context, state, previous, null, trigger, 'decide', decision.reason);
    return { rotated: false, reason: decision.reason, previous, state };
  }
  const target = decision.target.id;
  if (target === previous && pool.length === 1) {
    return { rotated: false, reason: 'unchanged', previous, state };
  }

  let journalPath = null;
  let originals = null;
  try {
    ({ journalPath, originals } = useSkin(target, context.patchPaths, catalog, context.profileDir));
  } catch (error) {
    failRotation(context, state, previous, target, trigger, 'write', error instanceof Error ? error.message : String(error));
    return { rotated: false, reason: 'write-failed', previous, state, detail: error instanceof Error ? error.message : String(error) };
  }
  const next = commitRotation(context, state, target, previous, trigger, journalPath, orderedIds);
  return { rotated: true, reason: 'ok', target, previous, state: next };
}

/** Boot-time entry: decides and performs this launch's rotation, once. */
export function rotateOnLaunch(context, state, random = Math.random) {
  return executeRotation(context, state, 'startup', { random });
}

/** Restore the most recent *successful* rotation target that is still usable. */
export function restorePrevious(context, state, random = Math.random) {
  const history = readHistory(context.profileDir, 100).filter((record) => record.ok && record.to !== null && record.to !== undefined);
  const catalog = discoverInstalledSkins(context.patchPaths[0]);
  const { pool } = classifyPool(catalog, state);
  const usable = new Set(pool.map((skin) => skin.id));
  const target = history.find((record) => usable.has(record.to) && record.to !== state.currentSkin);
  if (target === undefined) {
    return { restored: false, reason: 'no-usable-previous', state };
  }
  const result = executeRotation(context, state, 'restore', { random, ignoreFixed: true });
  return { restored: result.rotated, reason: result.reason, target: result.target, previous: result.previous, state: result.state };
}

/* -------------------------------------------------------------------------- */
/* boot recovery: finish or roll back an interrupted transaction              */
/* -------------------------------------------------------------------------- */

/**
 * On boot, recover from a crash that landed between the patch writes and the
 * journal completion. `complete` writes are finished (journal dropped, state
 * re-pointed); `none`/`partial` writes are rolled back to the captured
 * originals. When the on-disk content matches neither expectation the files
 * changed in ways the journal cannot explain, so recovery stops and reports
 * rather than overwriting a possibly hand-edited configuration.
 */
export function recoverPendingTransaction(context, state) {
  const journalPath = findPendingJournal(context.profileDir);
  if (journalPath === null) return { recovered: false, reason: 'none' };
  const journal = readJournal(journalPath);
  if (journal === null) return { recovered: false, reason: 'unreadable-journal' };
  const originals = journal.originals.map((entry) => ({
    path: entry.path,
    existed: entry.existed,
    source: typeof entry.source === 'string' ? entry.source : (entry.existed && existsSync(entry.path) ? readFileSync(entry.path, 'utf8') : ''),
  }));
  const catalog = discoverInstalledSkins(context.patchPaths[0]);
  const next = originals.map((original) => switchPatch(original.source, journal.target, catalog));
  const stateName = classifyWriteState(originals, next, journal);

  if (stateName === 'complete') {
    completeTransaction(journalPath);
    try {
      const nextState = { ...state, currentSkin: journal.target, lastPicked: journal.target, lastRotatedAt: Date.now() };
      writeState(context.profileDir, nextState);
    } catch (error) {
      context.logger?.warn?.('[skin-rotation] state write failed finishing recovered transaction', error);
    }
    context.logger?.info?.(`[skin-rotation] completed interrupted transaction ${journal.txId} targeting ${journal.target}`);
    return { recovered: true, reason: 'completed', journal };
  }

  const explainable = originals.every((original, index) => {
    const current = existsSync(original.path) ? readFileSync(original.path, 'utf8') : '';
    return current === original.source || current === next[index];
  });
  if (!explainable) {
    context.logger?.warn?.('[skin-rotation] pending transaction left files that changed outside the journal; not auto-overwriting', journal);
    return { recovered: false, reason: 'conflict', journal };
  }
  rollbackFromJournal(journal, originals);
  completeTransaction(journalPath);
  context.logger?.info?.(`[skin-rotation] rolled back interrupted transaction ${journal.txId} targeting ${journal.target} (${stateName})`);
  return { recovered: true, reason: stateName === 'none' ? 'nothing-to-roll-back' : 'rolled-back', journal };
}

/* -------------------------------------------------------------------------- */
/* v1-compatible aliases                                                      */
/* -------------------------------------------------------------------------- */

/** @deprecated prefer executeRotation. */
function rotate(context, state, random = Math.random) {
  return executeRotation(context, state, 'manual', { random });
}

/** @deprecated prefer chooseTarget / pickTarget from rotation.js. */
export function pickTarget(pool, currentId, random = Math.random) {
  return pickTargetCore(pool, currentId, random);
}

/* -------------------------------------------------------------------------- */
/* HTTP route                                                                 */
/* -------------------------------------------------------------------------- */

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Host names that all mean "this machine" for origin comparison. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

/**
 * Same-origin guard.
 *
 * The rule is deliberately the one the skin manager uses — reject what the
 * *browser itself* marks as cross-site, accept everything else — because the
 * desktop shell serves the settings page from an opaque origin, which makes it
 * send `Origin: null` on POST. Rejecting `null` (as an earlier revision of this
 * function did) turns every change in the card into a permanent 403 while reads
 * keep working, i.e. the card shows a state it can never edit.
 *
 * A genuinely cross-site page cannot get past the first check: the browser sets
 * `Sec-Fetch-Site: cross-site` and scripts cannot forge it.
 *
 * @param req - the incoming request.
 * @returns {{ ok: boolean, reason: string }} the decision and why, so a refusal
 *   is diagnosable from the response body.
 */
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site === 'cross-site') return { ok: false, reason: 'cross-site-request-rejected' };
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') {
    return { ok: true, reason: 'opaque-origin' };
  }
  const host = req.headers.host;
  if (typeof host !== 'string' || host === '') return { ok: true, reason: 'no-host-header' };
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    return { ok: true, reason: 'unparseable-origin' };
  }
  if (parsed.host === host) return { ok: true, reason: 'origin-match' };
  // The same machine spelled differently: 127.0.0.1 vs localhost vs [::1].
  const hostName = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (LOOPBACK_HOSTS.has(parsed.hostname) && LOOPBACK_HOSTS.has(hostName)) {
    return { ok: true, reason: 'loopback-alias' };
  }
  // The browser already attested the site; trust it over a spelling mismatch.
  if (site === 'same-origin' || site === 'same-site') return { ok: true, reason: 'browser-attested-same-site' };
  return { ok: false, reason: 'origin-mismatch' };
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16384) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolvePromise(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid-json'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Describe the rotation surface for the settings card. Returns only what the
 * UI needs: no absolute paths, no stack traces, no full file contents.
 * @param context - the live rotation context.
 * @returns the JSON payload.
 */
export function describeRotation(context) {
  const { patchPaths, state, bootId } = context;
  const catalog = discoverInstalledSkins(patchPaths[0]);
  const sources = patchPaths.map((path) => (existsSync(path) ? readFileSync(path, 'utf8') : ''));
  const current = activeSkinTarget(sources, catalog);
  const { skins, pool } = classifyPool(catalog, state);
  const pickedThisBoot = state.lastBootId === bootId ? state.lastPicked : null;
  const history = readHistory(context.profileDir, 10);
  const lastEvent = history[0] ?? null;
  return {
    ok: true,
    enabled: state.enabled,
    bootId,
    mode: state.mode,
    recentRule: state.recentRule,
    pickedThisBoot,
    lastPicked: state.lastPicked,
    lastRotatedAt: state.lastRotatedAt,
    current,
    currentBodyAttr: catalog.find((skin) => skin.id === current)?.bodyAttr ?? null,
    pickedBodyAttr: catalog.find((skin) => skin.id === pickedThisBoot)?.bodyAttr ?? null,
    catalogSize: catalog.length,
    poolSize: pool.length,
    fixedSkin: state.fixedSkin,
    sequentialIndex: state.sequentialIndex,
    lastClientReport: state.lastClientReport,
    lastRejection: context.lastRejection ?? null,
    preset: state.preset,
    presets: Object.keys(state.presets ?? {}),
    history: history.slice(0, 5).map((record) => ({
      at: record.at,
      from: record.from,
      to: record.to,
      trigger: record.trigger,
      mode: record.mode,
      ok: record.ok,
      reason: record.reason,
    })),
    skins: skins.map((skin) => ({
      id: skin.id,
      name: skin.name,
      nameEn: skin.nameEn ?? null,
      bodyAttr: skin.bodyAttr,
      active: skin.id === current,
      inPool: skin.status === POOL_STATUS.COMPATIBLE,
      status: skin.status,
      reason: skin.reason,
      weight: state.weights[skin.id] ?? null,
      lastUsedAt: history.find((record) => record.to === skin.id && record.ok)?.at ?? null,
    })),
  };
}

/** Validate one skin id against the catalog; throws on anything else. */
function requireSkinId(catalog, id) {
  if (typeof id !== 'string' || id === '') throw new Error('invalid-skin-id');
  if (!catalog.some((skin) => skin.id === id)) throw new Error('skin-not-installed');
  return id;
}

/**
 * Build the same-origin route the settings card talks to.
 * @param context - the live rotation context.
 * @returns a `webServer.register` route.
 */
export function makeSkinRotationRoute(context) {
  return {
    kind: 'exact',
    path: SKIN_ROTATION_ROUTE,
    async handler(req, res) {
      const verdict = sameOrigin(req);
      if (!verdict.ok) {
        // Keep the refusal diagnosable without leaking request internals to the
        // page: the reason code and whether an Origin was present are enough.
        context.lastRejection = {
          at: Date.now(),
          reason: verdict.reason,
          method: req.method,
          hadOrigin: typeof req.headers.origin === 'string' && req.headers.origin !== '',
          site: typeof req.headers['sec-fetch-site'] === 'string' ? req.headers['sec-fetch-site'] : null,
        };
        json(res, 403, { ok: false, error: verdict.reason });
        return;
      }
      try {
        const state = readState(context.profileDir);
        context.state = state;
        if (req.method === 'GET') {
          json(res, 200, describeRotation({ ...context, state }));
          return;
        }
        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' });
          return;
        }
        const body = await readBody(req);
        const action = typeof body === 'object' && body !== null ? body.action : undefined;
        const catalog = discoverInstalledSkins(context.patchPaths[0]);

        if (action === 'set-enabled') {
          if (typeof body.enabled !== 'boolean') throw new Error('invalid-enabled');
          const next = { ...state, enabled: body.enabled };
          writeState(context.profileDir, next);
          context.state = next;
          json(res, 200, { ...describeRotation({ ...context, state: next }), changed: true });
          return;
        }
        if (action === 'set-mode') {
          if (typeof body.mode !== 'string' || !MODES.includes(body.mode)) throw new Error('invalid-mode');
          const patch = {};
          if (body.mode === 'fixed') {
            patch.fixedSkin = requireSkinId(catalog, body.fixedSkin);
          }
          const next = { ...state, mode: body.mode, ...patch };
          writeState(context.profileDir, next);
          context.state = next;
          json(res, 200, { ...describeRotation({ ...context, state: next }), changed: true });
          return;
        }
        if (action === 'set-recent-rule') {
          const rule = body.rule;
          if (typeof rule !== 'string' || !RECENT_RULES.includes(rule)) throw new Error('invalid-recent-rule');
          const next = { ...state, recentRule: rule };
          writeState(context.profileDir, next);
          context.state = next;
          json(res, 200, { ...describeRotation({ ...context, state: next }), changed: true });
          return;
        }
        if (action === 'set-excluded') {
          const id = requireSkinId(catalog, body.id);
          const excluded = body.excluded === true;
          const exclude = new Set(state.exclude);
          if (excluded) exclude.add(id); else exclude.delete(id);
          const next = { ...state, exclude };
          writeState(context.profileDir, next);
          context.state = next;
          json(res, 200, { ...describeRotation({ ...context, state: next }), changed: true });
          return;
        }
        if (action === 'set-weight') {
          const id = requireSkinId(catalog, body.id);
          const weight = body.weight;
          const valid = weight === null || (typeof weight === 'number' && Number.isFinite(weight) && weight >= 0);
          if (!valid) throw new Error('invalid-weight');
          const weights = { ...state.weights };
          if (weight === null) delete weights[id]; else weights[id] = weight;
          const next = { ...state, weights };
          writeState(context.profileDir, next);
          context.state = next;
          json(res, 200, { ...describeRotation({ ...context, state: next }), changed: true });
          return;
        }
        if (action === 'rotate-now') {
          const result = executeRotation(context, readState(context.profileDir), 'manual');
          json(res, 200, { ...describeRotation({ ...context, state: result.state }), changed: result.rotated, reason: result.reason, target: result.target ?? null });
          return;
        }
        if (action === 'restore-previous') {
          const result = restorePrevious(context, readState(context.profileDir));
          json(res, 200, { ...describeRotation({ ...context, state: result.state }), changed: result.restored, reason: result.reason, target: result.target ?? null });
          return;
        }
        if (action === 'reset-defaults') {
          // Resets this plugin's own preferences only; skin packages and the
          // managed block are left to the next rotation.
          const defaults = defaultState();
          writeState(context.profileDir, defaults);
          context.state = defaults;
          json(res, 200, { ...describeRotation({ ...context, state: defaults }), changed: true });
          return;
        }
        if (action === 'save-preset') {
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (!isValidPresetName(name)) throw new Error('invalid-preset-name');
          const next = { ...state, preset: name, presets: { ...state.presets, [name]: capturePreset(state) } };
          writeState(context.profileDir, next);
          context.state = next;
          json(res, 200, { ...describeRotation({ ...context, state: next }), changed: true });
          return;
        }
        if (action === 'use-preset') {
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (!isValidPresetName(name)) throw new Error('invalid-preset-name');
          const result = applyPreset(state, name);
          if (!result.applied) throw new Error('unknown-preset');
          writeState(context.profileDir, result.state);
          context.state = result.state;
          json(res, 200, { ...describeRotation({ ...context, state: result.state }), changed: true });
          return;
        }
        if (action === 'delete-preset') {
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (!isValidPresetName(name)) throw new Error('invalid-preset-name');
          const presets = { ...state.presets };
          delete presets[name];
          const next = { ...state, presets, preset: state.preset === name ? null : state.preset };
          writeState(context.profileDir, next);
          context.state = next;
          json(res, 200, { ...describeRotation({ ...context, state: next }), changed: true });
          return;
        }
        if (action === 'client-report') {
          const next = {
            ...state,
            lastClientReport: {
              at: Date.now(),
              mounted: body.mounted === true,
              found: body.found === true,
              rendered: body.rendered === true,
            },
          };
          writeState(context.profileDir, next);
          context.state = next;
          json(res, 200, { ok: true, recorded: next.lastClientReport });
          return;
        }
        throw new Error('unknown-action');
      } catch (error) {
        json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* boot identity                                                              */
/* -------------------------------------------------------------------------- */

/** A fresh unpredictable identifier, used when a boot key is not desired. */
function newBootId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Identify the host process this plugin is running in. A hot reload of the
 * plugin entry re-runs `apply` inside the same realm and must not rotate
 * again, while a real restart does.
 * @returns the process identity, created once per JavaScript realm.
 */
export function hostBootKey() {
  const slot = Symbol.for('dsh-skin-rotation.host-boot-key');
  if (typeof globalThis[slot] === 'string') return globalThis[slot];
  const value = `${process.pid}-${newBootId()}`;
  globalThis[slot] = value;
  return value;
}

/* -------------------------------------------------------------------------- */
/* entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Register the boot rotation, recovery, and the settings route; everything
 * the plugin writes stays inside the two patch layers and two local files.
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  const profilePatch = resolveRuntimeProfilePatch(ctx.baseUrl);
  const patchPaths = patchTargetsForProfile(profilePatch);
  const profileDir = dirname(profilePatch);
  const bootId = hostBootKey();
  const context = { patchPaths, profileDir, bootId, logger: ctx.logger, state: readState(profileDir) };

  cleanupJournals(profileDir);

  ctx.effect(() => {
    try {
      const recovered = recoverPendingTransaction(context, context.state);
      if (recovered.recovered) {
        context.state = readState(profileDir);
      }
    } catch (error) {
      ctx.logger?.warn?.('[skin-rotation] transaction recovery failed', error);
    }
  }, 'dsh-skin-rotation: transaction recovery');

  ctx.effect(() => {
    try {
      const state = readState(profileDir);
      const result = rotateOnLaunch(context, state);
      context.state = result.state;
      if (result.rotated) {
        ctx.logger?.info?.(
          `[skin-rotation] launch pick (${state.mode}): ${result.target} (was ${result.previous}); boot ${bootId}`,
        );
      } else if (result.reason === 'disabled') {
        ctx.logger?.info?.('[skin-rotation] disabled by preference; keeping the current skin');
      } else if (result.reason === 'already-rotated') {
        ctx.logger?.info?.(`[skin-rotation] already rotated for launch ${bootId}; keeping ${state.lastPicked}`);
      } else {
        ctx.logger?.info?.(`[skin-rotation] nothing to rotate: ${result.reason ?? 'unknown'}`);
      }
    } catch (error) {
      ctx.logger?.warn?.('[skin-rotation] boot rotation failed', error);
    }
  }, 'dsh-skin-rotation: launch rotation');

  ctx.effect(() => {
    const unregister = ctx.webServer.register(makeSkinRotationRoute(context));
    return () => unregister();
  }, 'dsh-skin-rotation: preference route');
}
