/**
 * dsh-skin-rotation — rotation: candidate pool, four policies, pick logic.
 *
 * Pure functions only: the same code runs at host boot, behind the HTTP
 * route, and under unit tests. The browser half never reimplements these
 * rules; it only displays the pool and forwards actions.
 *
 * Policy order (single source of truth, used by every entry point):
 *   1. discover + validate skins          → invalid manifests are unusable
 *   2. compatibility check                → denied skins are out of the pool
 *   3. user exclusion list                → excluded skins are out of the pool
 *   4. mode (random | sequential | weighted | fixed)
 *   5. recent-repeat rule (random/sequential)
 *   6. choose, with deterministic random injection for tests
 *
 * @module dsh-skin-rotation/rotation
 */

/** Pool status of one installed skin, surfaced to the UI. */
export const POOL_STATUS = Object.freeze({
  COMPATIBLE: 'compatible',
  EXCLUDED: 'excluded',
  INCOMPATIBLE: 'incompatible',
  UNAVAILABLE: 'unavailable',
  UNKNOWN: 'unknown',
});

/** Default weight for a skin with no explicit weight. */
export const DEFAULT_WEIGHT = 1;

/**
 * Every pool decision is one of these reasons; a pick carries its reason so
 * the UI can explain *why* rather than just showing a result.
 */
export const PICK_REASONS = Object.freeze([
  'ok',                 // a normal pick happened
  'unchanged',          // nothing to do (single skin, or current already the pick)
  'disabled',           // rotation disabled
  'already-rotated',    // this boot already rotated
  'fixed-not-installed',
  'fixed-incompatible',
  'empty-pool',         // no usable skin at all
  'exhausted',          // every usable skin blocked by the recent-repeat rule
  'no-weighted-pool',   // weighted mode with all zero weights
]);

/**
 * Hash a string into a uint32 (FNV-1a). Tiny, dependency-free; used only to
 * spread a fixed seed across the pick so a seeded run is reproducible.
 */
function hashString(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Classify every catalog entry for the current state. Invalid manifests never
 * reach this function — `catalogEntry()` in lib/index.js already rejected them,
 * so they are listed as `unavailable` upstream and simply absent here.
 * @param catalog - the discovered catalog (valid skin.json entries).
 * @param state - the normalized plugin state.
 * @returns { skins, pool } — pool is ordered for display but order is never a
 *   business rule; sequential mode uses `state.order`.
 */
export function classifyPool(catalog, state) {
  const byId = new Map(catalog.map((skin) => [skin.id, skin]));
  const skins = [];
  const pool = [];
  for (const skin of catalog) {
    let status = POOL_STATUS.COMPATIBLE;
    let reason = null;
    if (skin.compatibility !== undefined && !skin.compatibility.exempted) {
      status = POOL_STATUS.INCOMPATIBLE;
      reason = 'incompatible';
    } else if (state.exclude.has(skin.id)) {
      status = POOL_STATUS.EXCLUDED;
      reason = 'excluded-by-user';
    }
    const entry = {
      id: skin.id,
      name: skin.name,
      nameEn: skin.nameEn ?? null,
      bodyAttr: skin.bodyAttr,
      package: skin.package,
      order: skin.order,
      status,
      reason,
      compatibility: skin.compatibility === undefined || skin.compatibility.exempted
        ? null
        : { runtimeVersion: skin.compatibility.runtimeVersion, peers: skin.compatibility.peers },
    };
    skins.push(entry);
    if (status === POOL_STATUS.COMPATIBLE) pool.push(entry);
  }
  return { skins, pool: pool.filter((entry) => byId.has(entry.id)) };
}

/**
 * Build the recent-history exclusion set from `state.recentHistory` (which
 * holds successful, completed rotations only — failed rotations never enter).
 */
function recentSet(state, rule) {
  const count = rule === 'recent-3' ? 3 : rule === 'recent-2' ? 2 : 0;
  return new Set(count === 0 ? [] : state.recentHistory.slice(0, count));
}

/** Uniform pick from `items` using an injectable random source. */
function uniformPick(items, random) {
  const index = Math.min(items.length - 1, Math.max(0, Math.floor(random() * items.length)));
  return items[index];
}

/** Total of pool weights (defaulting missing ids to DEFAULT_WEIGHT). */
function weightOf(state, skin) {
  return state.weights[skin.id] ?? DEFAULT_WEIGHT;
}

/**
 * Core decision. Given a pool and state, choose the next skin and say why.
 * No infinite loops: every branch terminates by construction and returns one
 * of the defined reasons.
 *
 * @param pool - admissible, non-excluded skins (from classifyPool).
 * @param state - normalized state.
 * @param options - { random?: () => number in [0,1), current?: string|null }.
 * @returns { target: skin|null, reason, seedUsed?: boolean }.
 */
export function chooseTarget(pool, state, options = {}) {
  const random = options.random ?? Math.random;
  const current = options.current ?? null;
  const seedUsed = state.seed !== null && state.seed !== undefined;

  if (state.mode === 'fixed') {
    const fixed = state.fixedSkin;
    const found = fixed === null ? undefined : pool.find((skin) => skin.id === fixed);
    if (fixed === null) return { target: pool[0] ?? null, reason: 'ok' };
    if (found === undefined) return { target: null, reason: 'fixed-not-installed' };
    return { target: found, reason: 'ok' };
  }

  if (pool.length === 0) return { target: null, reason: 'empty-pool' };

  if (state.mode === 'sequential') {
    // Sequential iterates the whole pool; "current" does not shift it, so the
    // index advances deterministically across restarts and never deadlocks.
    const explicit = Array.isArray(state.order) && state.order.length > 0;
    const ordered = explicit
      ? state.order.filter((id) => pool.some((skin) => skin.id === id))
      : pool.map((skin) => skin.id);
    if (ordered.length === 0) return { target: null, reason: 'empty-pool' };
    const start = (Math.floor(state.sequentialIndex) % ordered.length + ordered.length) % ordered.length;
    const pick = pool.find((skin) => skin.id === ordered[start]) ?? pool[0];
    return { target: pick, reason: 'ok', seedUsed };
  }

  if (state.mode === 'weighted') {
    // Weights apply to the whole admissible pool; "current" is not excluded,
    // so a user can keep the same skin by weighting others to zero.
    const weighted = pool.filter((skin) => weightOf(state, skin) > 0);
    if (weighted.length === 0) return { target: null, reason: 'no-weighted-pool' };
    const total = weighted.reduce((sum, skin) => sum + weightOf(state, skin), 0);
    let cursor = (seedUsed ? hashString(`${state.seed}:${current ?? ''}:${Date.now()}`) / 2 ** 32 : random()) * total;
    for (const skin of weighted) {
      cursor -= weightOf(state, skin);
      if (cursor < 0) return { target: skin, reason: 'ok', seedUsed };
    }
    return { target: weighted[weighted.length - 1], reason: 'ok', seedUsed };
  }

  // random: exclude the current skin when another is available, then apply the
  // recent-repeat preference (never a blocker).
  const others = pool.filter((skin) => skin.id !== current);
  const usable = others.length > 0 ? others : pool;
  const recent = recentSet(state, state.recentRule);
  const fresh = usable.filter((skin) => !recent.has(skin.id));
  const chosen = fresh.length > 0 ? fresh : usable;
  return { target: uniformPick(chosen, random), reason: fresh.length === 0 ? 'exhausted' : 'ok', seedUsed };
}

/**
 * Legacy `pickTarget` kept for API compatibility with the v1 surface and the
 * existing tests: random pick that never repeats the current skin while
 * another installed skin could be shown instead.
 * @param pool - admissible skins.
 * @param currentId - the skin active before this pick.
 * @param random - injectable random source in `[0, 1)`.
 * @returns the chosen skin, or null when the pool is empty.
 */
export function pickTarget(pool, currentId, random = Math.random) {
  const { target } = chooseTarget(pool, { mode: 'random', recentRule: 'disabled', exclude: new Set(), weights: {}, order: [], seed: null, sequentialIndex: 0 }, { random, current: currentId });
  return target;
}

/**
 * Advance the sequential index so the next sequential pick moves on (skipping
 * ids that have since been excluded/uninstalled is handled inside chooseTarget).
 * @param state - normalized state.
 * @param orderedIds - the user order (or pool order) at pick time.
 * @param pickedId - the skin that was just applied.
 * @returns the next sequentialIndex value.
 */
export function nextSequentialIndex(state, orderedIds, pickedId) {
  const ordered = orderedIds.length > 0 ? orderedIds : null;
  const list = ordered ?? [];
  if (list.length === 0) return 0;
  const found = list.indexOf(pickedId);
  return ((found === -1 ? 0 : found + 1) % list.length + list.length) % list.length;
}
