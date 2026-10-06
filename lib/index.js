/**
 * dsh-skin-rotation — host half.
 *
 * Every time the DeepSeek Harness host boots, this plugin picks one installed
 * skin at random and enables exactly that skin by rewriting the shared
 * `dsh-skin managed` block of the profile patch and the higher-priority home
 * patch. DSH's own HMR patch watcher then recomposes the live tree, so the page
 * that opens afterwards already carries the chosen skin.
 *
 * The block format, the "keep every foreign YAML record" rules, and the
 * discovery/validation walk mirror
 * `@smalltailqwq/dsh-client-ui-skin-deep-whale-manager` (MIT), so both plugins
 * can own the same block without fighting each other.
 *
 * The plugin never touches a skin's own files, its `skin.json`, or the skin
 * manager's state. Rotation is a preference stored next to the profile, and the
 * browser half exposes it as a switch inside the 「皮肤」 settings page.
 *
 * @module dsh-skin-rotation
 */

import { createRequire } from 'node:module';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { satisfies } from './semver.js';

export const name = 'dsh-skin-rotation';

/** Re-exported so tests and embedders can check ranges with the same evaluator. */
export { satisfies };

/** The web carrier must be up before the settings route can be registered. */
export const inject = ['webServer'];

/** Same-origin host route used by the settings card. */
export const SKIN_ROTATION_ROUTE = '/api/dsh/skin-rotation';

/** The mutually-exclusive block shared with the skin manager. */
export const MANAGED_START = '# --- dsh-skin managed (auto-generated; do not edit) ---';
export const MANAGED_END = '# --- end dsh-skin managed ---';

/** Profile-local preference file; never read by DSH itself. */
export const STATE_FILE = '.dsh-skin-rotation.json';

/** DSH's own profile-local compatibility grant file. */
const PROFILE_COMPATIBILITY_FILENAME = 'compatibility.json';

/* -------------------------------------------------------------------------- */
/* state                                                                      */
/* -------------------------------------------------------------------------- */

/** The preference shape, with every field defaulted. */
function normalizeState(value) {
  const source = typeof value === 'object' && value !== null ? value : {};
  const report = typeof source.lastClientReport === 'object' && source.lastClientReport !== null
    ? source.lastClientReport
    : null;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
    lastPicked: typeof source.lastPicked === 'string' ? source.lastPicked : null,
    lastBootId: typeof source.lastBootId === 'string' ? source.lastBootId : null,
    lastRotatedAt: typeof source.lastRotatedAt === 'number' ? source.lastRotatedAt : null,
    lastClientReport: report === null
      ? null
      : {
        at: typeof report.at === 'number' ? report.at : 0,
        mounted: report.mounted === true,
        found: report.found === true,
        rendered: report.rendered === true,
      },
  };
}

/**
 * Read the rotation preference beside one profile.
 * @param profileDir - absolute profile directory.
 * @returns the normalized preference, defaulting to enabled.
 */
export function readState(profileDir) {
  try {
    return normalizeState(JSON.parse(readFileSync(join(profileDir, STATE_FILE), 'utf8')));
  } catch {
    return normalizeState(undefined);
  }
}

/**
 * Persist the rotation preference atomically.
 * @param profileDir - absolute profile directory.
 * @param state - the preference to store.
 */
export function writeState(profileDir, state) {
  atomicWrite(join(profileDir, STATE_FILE), `${JSON.stringify(normalizeState(state), null, 2)}\n`);
}

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
    const value = JSON.parse(readFileSync(join(profileDir, PROFILE_COMPATIBILITY_FILENAME), 'utf8'));
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
/* managed block                                                              */
/* -------------------------------------------------------------------------- */

/** Read the direct `id` of one top-level patch record. */
function recordId(record) {
  const head = record.find((line) => /^-(\s|$)/.test(line));
  if (head === undefined) return undefined;
  const idValue = /^id:\s*(['"]?)([^'"#\s]+)\1\s*(?:#.*)?$/;
  const first = head.replace(/^-\s*/, '').match(idValue);
  if (first !== null) return first[2];
  const propertyIndent = head.length - head.replace(/^-\s*/, '').length;
  for (const line of record.slice(record.indexOf(head) + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (line.length - line.trimStart().length !== propertyIndent) continue;
    const property = line.trimStart().match(idValue);
    if (property !== null) return property[2];
  }
  return undefined;
}

/** Split a managed block body into records the manager does not own. */
function foreignRecords(body, isOwned) {
  const records = [];
  let current = [];
  for (const line of body.split(/\r?\n/).map((line) => line.replace(/[ \t]+$/, ''))) {
    if (/^-(\s|$)/.test(line)) {
      let lead = current.length;
      while (lead > 0 && (current[lead - 1] === '' || current[lead - 1].startsWith('#'))) lead -= 1;
      const intro = current.splice(lead).filter((text) => text !== '');
      if (current.length > 0) records.push(current);
      current = [...intro, line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) records.push(current);
  return records
    .filter((record) => {
      if (!record.some((line) => /^-(\s|$)/.test(line))) return false;
      const id = recordId(record);
      return id === undefined || !isOwned(id);
    })
    .map((record) => record.join('\n').replace(/\s+$/, ''));
}

/** A managed row is any discovered wiring id or a `ui-skin-*` row. */
function ownsRecord(ownedIds) {
  return (id) => ownedIds.has(id) || (id.startsWith('ui-skin-') && id !== 'ui-skin-deep-whale-manager');
}

/**
 * Remove exactly one managed block while preserving all user YAML: records
 * inside the block that belong to someone else move in front of it.
 * @param source - the whole patch file.
 * @param ownedIds - wiring ids the block owns.
 * @returns the patch without its managed block.
 */
export function stripManagedBlock(source, ownedIds = new Set()) {
  const start = source.indexOf(MANAGED_START);
  if (start < 0) return source;
  const end = source.indexOf(MANAGED_END, start);
  if (end < 0) throw new Error('managed-section-is-incomplete');
  return [
    source.slice(0, start).replace(/[ \t]+$/gm, '').replace(/\s+$/, ''),
    foreignRecords(source.slice(start + MANAGED_START.length, end), ownsRecord(ownedIds)).join('\n'),
    source.slice(end + MANAGED_END.length).replace(/^\s+/, ''),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Render mutual exclusion for every discovered skin; the target alone is enabled.
 * @param target - the active skin id, or `official` to disable them all.
 * @param catalog - the discovered catalog.
 * @returns the managed block text.
 */
export function renderManagedBlock(target, catalog) {
  const lines = [MANAGED_START];
  for (const skin of catalog) lines.push(`- id: ${skin.wiringId}`, `  disabled: ${skin.id === target ? 'false' : 'true'}`);
  lines.push(MANAGED_END);
  return lines.join('\n');
}

/**
 * Compose a new patch without touching content outside the managed block.
 * @param source - the current patch text.
 * @param target - the skin to enable.
 * @param catalog - the discovered catalog.
 * @returns the new patch text.
 */
export function switchPatch(source, target, catalog) {
  const stripped = stripManagedBlock(source, new Set(catalog.map((skin) => skin.wiringId))).replace(/\s+$/, '');
  const emptySequence = /^\[\]\s*(?:#.*)?$/;
  const lines = stripped.split(/\r?\n/);
  const unmanaged = lines.some((line) => emptySequence.test(line))
    ? lines.filter((line) => !emptySequence.test(line)).join('\n').replace(/\s+$/, '')
    : stripped;
  return `${unmanaged === '' ? '' : `${unmanaged}\n\n`}${renderManagedBlock(target, catalog)}\n`;
}

/** Atomically replace one patch file, leaving the original intact on failure. */
export function atomicWrite(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) rmSync(temporary, { force: true });
  }
}

/**
 * Persist one target in every live layer, rolling back on failure.
 * @param target - the skin id to enable, or `official`.
 * @param patchPaths - the patch layers, lowest priority first.
 * @param catalog - the discovered catalog.
 */
export function useSkin(target, patchPaths, catalog) {
  if (target !== 'official' && !catalog.some((skin) => skin.id === target)) {
    throw new Error(`skin-not-installed: ${target}`);
  }
  const originals = patchPaths.map((path) => ({
    path,
    existed: existsSync(path),
    source: existsSync(path) ? readFileSync(path, 'utf8') : '',
  }));
  const next = originals.map((original) => switchPatch(original.source, target, catalog));
  const written = [];
  try {
    originals.forEach((original, index) => {
      atomicWrite(original.path, next[index]);
      written.push(original);
    });
  } catch (error) {
    for (const original of written.reverse()) {
      if (original.existed) atomicWrite(original.path, original.source);
      else rmSync(original.path, { force: true });
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* patch state                                                                */
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
/* rotation                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Pick the skin for this launch: uniformly at random, never the current skin
 * while another installed skin could be shown instead.
 * @param pool - admissible skins.
 * @param currentId - the skin active before this rotation.
 * @param random - injectable random source in `[0, 1)`.
 * @returns the chosen skin, or null when the pool is empty.
 */
export function pickTarget(pool, currentId, random = Math.random) {
  if (pool.length === 0) return null;
  const candidates = pool.length > 1 ? pool.filter((skin) => skin.id !== currentId) : pool;
  const usable = candidates.length > 0 ? candidates : pool;
  const index = Math.min(usable.length - 1, Math.max(0, Math.floor(random() * usable.length)));
  return usable[index];
}

/* -------------------------------------------------------------------------- */
/* HTTP route                                                                 */
/* -------------------------------------------------------------------------- */

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return true;
  const host = req.headers.host;
  if (typeof host !== 'string' || host === '') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
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
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid-json'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Describe the whole rotation surface for the settings card.
 * @param context - the live rotation context.
 * @returns the JSON payload.
 */
export function describeRotation(context) {
  const { patchPaths, profileDir, state, bootId } = context;
  const catalog = discoverInstalledSkins(patchPaths[0]);
  const admissible = new Set(admissibleSkins(catalog).map((skin) => skin.id));
  const sources = patchPaths.map((path) => (existsSync(path) ? readFileSync(path, 'utf8') : ''));
  const current = activeSkinTarget(sources, catalog);
  const pickedThisBoot = state.lastBootId === bootId ? state.lastPicked : null;
  const activeSkin = catalog.find((skin) => skin.id === current);
  return {
    ok: true,
    enabled: state.enabled,
    bootId,
    pickedThisBoot,
    lastPicked: state.lastPicked,
    lastRotatedAt: state.lastRotatedAt,
    current,
    currentBodyAttr: activeSkin?.bodyAttr ?? null,
    pickedBodyAttr: catalog.find((skin) => skin.id === pickedThisBoot)?.bodyAttr ?? null,
    catalogSize: catalog.length,
    poolSize: admissible.size,
    lastClientReport: state.lastClientReport,
    route: SKIN_ROTATION_ROUTE,
    stateFile: join(profileDir, STATE_FILE),
    skins: catalog.map((skin) => ({
      id: skin.id,
      name: skin.name,
      nameEn: skin.nameEn ?? null,
      bodyAttr: skin.bodyAttr,
      package: skin.package,
      active: skin.id === current,
      admissible: admissible.has(skin.id),
      incompatible: skin.compatibility !== undefined && !skin.compatibility.exempted
        ? { runtimeVersion: skin.compatibility.runtimeVersion, peers: skin.compatibility.peers }
        : null,
    })),
  };
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
      if (!sameOrigin(req)) {
        json(res, 403, { ok: false, error: 'cross-site-request-rejected' });
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
        if (action === 'set-enabled') {
          if (typeof body.enabled !== 'boolean') throw new Error('invalid-enabled');
          const next = { ...state, enabled: body.enabled };
          writeState(context.profileDir, next);
          context.state = next;
          json(res, 200, { ...describeRotation({ ...context, state: next }), changed: true });
          return;
        }
        if (action === 'rotate-now') {
          const result = rotate({ ...context, state }, readState(context.profileDir));
          json(res, 200, { ...describeRotation({ ...context, state: result.state }), changed: result.rotated, target: result.target });
          return;
        }
        if (action === 'client-report') {
          // The browser half reports whether it found the skin page and mounted
          // the card; kept as evidence that the card is live for this profile.
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
/* rotation driver                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Enable one random skin and record the choice for this boot.
 * @param context - the live rotation context.
 * @param state - the current preference.
 * @param random - injectable random source.
 * @returns the resulting preference and what happened.
 */
function rotate(context, state, random = Math.random) {
  const { patchPaths } = context;
  const catalog = discoverInstalledSkins(patchPaths[0]);
  const pool = admissibleSkins(catalog);
  if (pool.length === 0) return { rotated: false, reason: 'no-admissible-skins', state };
  const sources = patchPaths.map((path) => (existsSync(path) ? readFileSync(path, 'utf8') : ''));
  const current = activeSkinTarget(sources, catalog);
  const target = pickTarget(pool, current, random);
  if (target === null) return { rotated: false, reason: 'no-admissible-skins', state };
  useSkin(target.id, patchPaths, catalog);
  const next = { ...state, lastPicked: target.id, lastBootId: context.bootId, lastRotatedAt: Date.now() };
  writeState(context.profileDir, next);
  return { rotated: true, target: target.id, previous: current, state: next };
}

/**
 * Decide and perform this launch's rotation: once per host process, only while
 * the preference is on.
 * @param context - the live rotation context.
 * @param state - the current preference.
 * @param random - injectable random source.
 * @returns what happened plus the resulting preference.
 */
export function rotateOnLaunch(context, state, random = Math.random) {
  if (!state.enabled) return { rotated: false, reason: 'disabled', state };
  if (state.lastBootId === context.bootId) {
    return { rotated: false, reason: 'already-rotated', state };
  }
  return rotate(context, state, random);
}

/** A fresh unpredictable identifier, used when a boot key is not desired. */
function newBootId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Identify the host process this plugin is running in. A hot reload of the
 * plugin entry re-runs `apply` inside the same realm and must not rotate
 * again, while a real restart must.
 * @returns the process identity, created once per JavaScript realm.
 */
export function hostBootKey() {
  const slot = Symbol.for('dsh-skin-rotation.host-boot-key');
  if (typeof globalThis[slot] === 'string') return globalThis[slot];
  const value = `${process.pid}-${newBootId()}`;
  globalThis[slot] = value;
  return value;
}

/**
 * Register the boot rotation and the settings route; everything the plugin
 * writes stays inside the two patch layers and one preference file.
 * @param ctx - the plugin's Cordis context.
 */
export function apply(ctx) {
  const profilePatch = resolveRuntimeProfilePatch(ctx.baseUrl);
  const patchPaths = patchTargetsForProfile(profilePatch);
  const profileDir = dirname(profilePatch);
  const bootId = hostBootKey();
  const context = { patchPaths, profileDir, bootId, state: readState(profileDir) };

  ctx.effect(() => {
    try {
      const state = readState(profileDir);
      const result = rotateOnLaunch(context, state);
      context.state = result.state;
      if (result.rotated) {
        ctx.logger?.info?.(
          `[skin-rotation] launch pick: ${result.target} (was ${result.previous}); boot ${bootId}`,
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
