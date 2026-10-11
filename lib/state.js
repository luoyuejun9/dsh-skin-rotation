/**
 * dsh-skin-rotation — state: schema-versioned, migrating, atomic persistence.
 *
 * Two local files live beside the profile:
 *   - `.dsh-skin-rotation.json`   the preference and rotation state (host-owned)
 *   - `.dsh-skin-rotation.history.json` bounded rotation history
 *
 * The state file is migrated one step at a time from older shapes, tolerating
 * corrupt or partially-written JSON by falling back to defaults, and is never
 * overwritten by a version newer than this build understands.
 *
 * @module dsh-skin-rotation/state
 */

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
import { basename, dirname, join } from 'node:path';

export const STATE_FILE = '.dsh-skin-rotation.json';
export const HISTORY_FILE = '.dsh-skin-rotation.history.json';
/** The schema this build writes. Bump and add a step to MIGRATIONS on change. */
export const SCHEMA_VERSION = 2;

/** Rotation modes and recent-repeat rules the system understands. */
export const MODES = Object.freeze(['random', 'sequential', 'weighted', 'fixed']);
export const RECENT_RULES = Object.freeze(['disabled', 'recent-2', 'recent-3']);
export const TRIGGERS = Object.freeze(['startup', 'manual', 'restore', 'policy']);

/* -------------------------------------------------------------------------- */
/* normalization                                                              */
/* -------------------------------------------------------------------------- */

function asBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function asFiniteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asFiniteNonNegative(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function asFinitePositiveInt(value, fallback, max) {
  const n = Math.floor(asFiniteNonNegative(value, NaN));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(max, n);
}

function asString(value) {
  return typeof value === 'string' ? value : null;
}

/** Accepts the in-memory Set form and the on-disk array form alike. */
function asIdSet(value) {
  const out = new Set();
  const items = value instanceof Set ? [...value] : Array.isArray(value) ? value : [];
  for (const id of items) if (typeof id === 'string' && id !== '') out.add(id);
  return out;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string' && item !== '');
}

function asIsoOrNull(value) {
  return typeof value === 'string' ? value : null;
}

/** Normalize the optional client-report sub-object. */
function normalizeReport(source) {
  const report = typeof source === 'object' && source !== null ? source : null;
  if (report === null) return null;
  return {
    at: asFiniteNumber(report.at, 0),
    mounted: asBoolean(report.mounted, false),
    found: asBoolean(report.found, false),
    rendered: asBoolean(report.rendered, false),
  };
}

/** Validate a weight map: finite, non-negative numbers, keyed by skin id. */
function normalizeWeights(source) {
  const out = {};
  if (typeof source === 'object' && source !== null) {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value;
    }
  }
  return out;
}

/** Normalize the rotation presets map (name → preset). Invalid members dropped. */
function normalizePresets(source) {
  const out = {};
  if (typeof source === 'object' && source !== null) {
    for (const [name, preset] of Object.entries(source)) {
      const normalized = normalizePreset(preset);
      if (normalized !== null) out[name] = normalized;
    }
  }
  return out;
}

/** One preset: a set of rotation controls. `null` when it is unusable. */
function normalizePreset(source) {
  if (typeof source !== 'object' || source === null) return null;
  return {
    mode: MODES.includes(source.mode) ? source.mode : 'random',
    exclude: asIdSet(source.exclude),
    weights: normalizeWeights(source.weights),
    recentRule: RECENT_RULES.includes(source.recentRule) ? source.recentRule : 'recent-2',
    fixedSkin: asString(source.fixedSkin),
    order: asStringArray(source.order),
    historyLimit: asFinitePositiveInt(source.historyLimit, 100, 1000),
  };
}

/**
 * The complete, normalized state for this build. `version` is the shape the
 * input was at when normalized; `versionUnknown` flags inputs newer than this
 * build (they are then preserved, not written).
 */
function normalizeState(source) {
  const state = typeof source === 'object' && source !== null ? source : {};
  const schemaVersion = asFinitePositiveInt(state.schemaVersion, SCHEMA_VERSION, Number.MAX_SAFE_INTEGER);
  return {
    schemaVersion,
    versionUnknown: schemaVersion > SCHEMA_VERSION,
    enabled: asBoolean(state.enabled, true),
    mode: MODES.includes(state.mode) ? state.mode : 'random',
    exclude: asIdSet(state.exclude),
    weights: normalizeWeights(state.weights),
    recentRule: RECENT_RULES.includes(state.recentRule) ? state.recentRule : 'recent-2',
    fixedSkin: asString(state.fixedSkin),
    order: asStringArray(state.order),
    seed: asFiniteNonNegative(state.seed, null),
    historyLimit: asFinitePositiveInt(state.historyLimit, 100, 1000),
    sequentialIndex: asFiniteNonNegative(state.sequentialIndex, 0),
    currentSkin: asString(state.currentSkin),
    lastPicked: asString(state.lastPicked),
    lastBootId: asString(state.lastBootId),
    lastRotatedAt: asFiniteNumber(state.lastRotatedAt, null),
    lastClientReport: normalizeReport(state.lastClientReport),
    preset: asString(state.preset),
    presets: normalizePresets(state.presets),
    recentHistory: asStringArray(state.recentHistory).slice(0, 8),
  };
}

/* -------------------------------------------------------------------------- */
/* migration                                                                  */
/* -------------------------------------------------------------------------- */

/** normalizeState already does most of the work; this is the versioned entry. */
function migrateV2(raw) {
  return normalizeState(raw);
}

/** Ordered, idempotent migrations: index N upgrades a vN document to vN+1. */
const MIGRATIONS = [
  function toV2(raw) {
    const normalized = migrateV2(raw);
    normalized.schemaVersion = 2;
    return normalized;
  },
];

/**
 * Migrate one parsed state document up to SCHEMA_VERSION. Idempotent: a
 * document already at the current version passes through untouched.
 * @param raw - the parsed JSON, of any known or unknown version.
 * @returns the migrated, normalized state, or the original document when its
 *   version is newer than this build can read.
 */
export function migrateState(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return normalizeState(undefined);
  let version = asFinitePositiveInt(raw.schemaVersion, 1, Number.MAX_SAFE_INTEGER);
  if (version > SCHEMA_VERSION) return { ...raw, __unknownVersion: true };
  let doc = raw;
  while (version < SCHEMA_VERSION) {
    const step = MIGRATIONS[version - 1];
    doc = step === undefined ? doc : { ...step(doc) };
    version += 1;
  }
  const normalized = normalizeState(doc);
  normalized.schemaVersion = SCHEMA_VERSION;
  normalized.versionUnknown = false;
  return normalized;
}

/**
 * Read and migrate the state file beside one profile.
 * @param profileDir - absolute profile directory.
 * @returns the normalized state (defaults when the file is absent or corrupt).
 */
export function readState(profileDir) {
  try {
    return migrateState(JSON.parse(readFileSync(join(profileDir, STATE_FILE), 'utf8')));
  } catch {
    return normalizeState(undefined);
  }
}

/** The default state for this build: enabled, random, recent-2, no weights. */
export function defaultState() {
  return normalizeState(undefined);
}

/* -------------------------------------------------------------------------- */
/* presets                                                                    */
/* -------------------------------------------------------------------------- */

/** A preset name must be short and free of control characters. */
export function isValidPresetName(name) {
  return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 40 && !/[\u0000-\u001f]/.test(name);
}

/**
 * Capture the current rotation controls as a named preset. Presets never
 * reference installed skin *files*: a preset that names an uninstalled skin
 * stays valid, it just falls back to a reported reason at pick time.
 * @param state - normalized state.
 * @returns the preset document.
 */
export function capturePreset(state) {
  return {
    mode: state.mode,
    exclude: [...state.exclude],
    weights: { ...state.weights },
    recentRule: state.recentRule,
    fixedSkin: state.fixedSkin,
    order: [...state.order],
    historyLimit: state.historyLimit,
  };
}

/**
 * Apply one preset onto a state, returning a new state. Unknown or malformed
 * presets leave the state untouched (caller reports the reason).
 * @param state - normalized state.
 * @param name - the preset name.
 * @returns { state, applied } — `applied` is false when the preset is absent.
 */
export function applyPreset(state, name) {
  const preset = state.presets[name];
  if (preset === undefined) return { state, applied: false };
  return {
    applied: true,
    state: {
      ...state,
      mode: preset.mode,
      exclude: new Set(preset.exclude),
      weights: { ...preset.weights },
      recentRule: preset.recentRule,
      fixedSkin: preset.fixedSkin,
      order: [...preset.order],
      historyLimit: preset.historyLimit,
      preset: name,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* atomic writes                                                              */
/* -------------------------------------------------------------------------- */

/** Atomically replace one file, leaving the original intact on failure. */
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
 * Convert the in-memory state into its on-disk JSON form. Sets become sorted
 * arrays so the file is readable and diff-friendly; every other field is
 * already plain JSON.
 */
function toSerializable(state) {
  const presets = {};
  for (const [name, preset] of Object.entries(state.presets ?? {})) {
    presets[name] = { ...preset, exclude: [...preset.exclude] };
  }
  return {
    ...state,
    exclude: [...state.exclude],
    presets,
  };
}

/**
 * Persist the state atomically. A document produced from a newer schema is
 * never written: the caller must handle that case first.
 * @param profileDir - absolute profile directory.
 * @param state - the state to store.
 */
export function writeState(profileDir, state) {
  const normalized = normalizeState({ ...state, schemaVersion: SCHEMA_VERSION });
  delete normalized.versionUnknown;
  atomicWrite(join(profileDir, STATE_FILE), `${JSON.stringify(toSerializable(normalized), null, 2)}\n`);
}

/* -------------------------------------------------------------------------- */
/* history                                                                    */
/* -------------------------------------------------------------------------- */

/** One history entry. `ok` means the skin was actually applied. */
function normalizeRecord(record) {
  if (typeof record !== 'object' || record === null) return null;
  const at = record.at;
  const atMs = typeof at === 'number' && Number.isFinite(at) ? at : Date.parse(at);
  return {
    at: Number.isFinite(atMs) ? new Date(atMs).toISOString() : new Date(0).toISOString(),
    from: asString(record.from),
    to: asString(record.to),
    trigger: TRIGGERS.includes(record.trigger) ? record.trigger : 'policy',
    mode: MODES.includes(record.mode) ? record.mode : 'random',
    ok: asBoolean(record.ok, false),
    stage: asString(record.stage),
    reason: typeof record.reason === 'string' ? record.reason.slice(0, 200) : null,
  };
}

/**
 * Read the rotation history, tolerating a corrupt or missing file.
 * @param profileDir - absolute profile directory.
 * @returns normalized records, newest first, capped at `limit`.
 */
export function readHistory(profileDir, limit = 100) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(profileDir, HISTORY_FILE), 'utf8'));
  } catch {
    return [];
  }
  const raw = Array.isArray(parsed) ? parsed : [];
  return raw
    .map(normalizeRecord)
    .filter((record) => record !== null)
    .slice(0, limit);
}

/**
 * Overwrite the history file with a given (already normalized) list. Used to
 * enforce the configured bound immediately when the limit shrinks.
 */
export function writeHistory(profileDir, records) {
  atomicWrite(join(profileDir, HISTORY_FILE), `${JSON.stringify(records, null, 2)}\n`);
}

/**
 * Append one record to the history, bounded by `limit`. History writes never
 * throw into the caller: a failing write is logged by the caller's flow only.
 * @param profileDir - absolute profile directory.
 * @param record - the new record (normalized before storage).
 * @param limit - maximum records to keep.
 * @returns the records actually stored.
 */
export function appendHistory(profileDir, record, limit = 100) {
  const normalized = normalizeRecord(record);
  const records = readHistory(profileDir, 10000);
  const kept = (normalized === null ? records : [normalized, ...records]).slice(0, limit);
  atomicWrite(join(profileDir, HISTORY_FILE), `${JSON.stringify(kept, null, 2)}\n`);
  return kept;
}
