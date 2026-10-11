/**
 * dsh-skin-rotation — patch: the shared `dsh-skin managed` block and a
 * journaled, recoverable multi-file write.
 *
 * The block format and the "keep every foreign YAML record" rules mirror
 * `@smalltailqwq/dsh-client-ui-skin-deep-whale-manager` (MIT) so both plugins
 * own the same block without fighting each other. Everything outside the
 * block — hand-written rows, comments, other plugins' settings — is preserved
 * byte for byte.
 *
 * Recoverable write: enabling one skin must edit the profile patch and the
 * higher-priority home patch, then the state file. A crash between steps must
 * not silently corrupt the user's configuration, so each attempt leaves a
 * short-lived journal (`*.tx.json`) that a later boot can inspect and roll
 * back. This is not a distributed transaction — it is crash safety across
 * local files, with recovery that refuses to overwrite content it cannot
 * explain.
 *
 * @module dsh-skin-rotation/patch
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** The mutually-exclusive block shared with the skin manager. */
export const MANAGED_START = '# --- dsh-skin managed (auto-generated; do not edit) ---';
export const MANAGED_END = '# --- end dsh-skin managed ---';

/** Journal filename suffix; lives beside the state file, removed on success. */
export const TX_SUFFIX = '.tx.json';

export { atomicWrite } from './state.js';

/* -------------------------------------------------------------------------- */
/* block inspection                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Inspect one patch source's managed block without mutating it.
 * @param source - the whole patch file text.
 * @returns { count, hasBeginOnly, hasEndOnly, multiple, intact }.
 */
export function inspectBlock(source) {
  if (typeof source !== 'string') {
    return { count: 0, hasBeginOnly: false, hasEndOnly: false, multiple: false, intact: false };
  }
  const begins = source.split(MANAGED_START).length - 1;
  const ends = source.split(MANAGED_END).length - 1;
  const count = Math.min(begins, ends);
  return {
    count,
    hasBeginOnly: begins > ends,
    hasEndOnly: ends > begins,
    multiple: begins > 1 || ends > 1,
    intact: begins === 1 && ends === 1 && begins === ends,
  };
}

/* -------------------------------------------------------------------------- */
/* block surgery (kept from v1, unchanged semantics)                          */
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
export function stripManagedBlock(source = '', ownedIds = new Set()) {
  const safe = typeof source === 'string' ? source : '';
  const start = safe.indexOf(MANAGED_START);
  if (start < 0) return safe;
  const end = safe.indexOf(MANAGED_END, start);
  if (end < 0) throw new Error('managed-section-is-incomplete');
  return [
    safe.slice(0, start).replace(/[ \t]+$/gm, '').replace(/\s+$/, ''),
    foreignRecords(safe.slice(start + MANAGED_START.length, end), ownsRecord(ownedIds)).join('\n'),
    safe.slice(end + MANAGED_END.length).replace(/^\s+/, ''),
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
 * Missing or unreadable sources are treated as empty so a first rotation can
 * create the patch from scratch.
 * @param source - the current patch text.
 * @param target - the skin to enable.
 * @param catalog - the discovered catalog.
 * @returns the new patch text.
 */
export function switchPatch(source = '', target, catalog) {
  const safe = typeof source === 'string' ? source : '';
  const stripped = stripManagedBlock(safe, new Set(catalog.map((skin) => skin.wiringId))).replace(/\s+$/, '');
  const emptySequence = /^\[\]\s*(?:#.*)?$/;
  const lines = stripped.split(/\r?\n/);
  const unmanaged = lines.some((line) => emptySequence.test(line))
    ? lines.filter((line) => !emptySequence.test(line)).join('\n').replace(/\s+$/, '')
    : stripped;
  return `${unmanaged === '' ? '' : `${unmanaged}\n\n`}${renderManagedBlock(target, catalog)}\n`;
}

/* -------------------------------------------------------------------------- */
/* journaled, recoverable multi-file write                                    */
/* -------------------------------------------------------------------------- */

/**
 * Prune journal files older than `maxAgeMs` (default 24 h). A stale journal
 * is not a live transaction; its backups may already be re-parented.
 */
export function cleanupJournals(directory, maxAgeMs = 86_400_000) {
  try {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(TX_SUFFIX)) continue;
      const path = join(directory, name);
      try {
        if (Date.now() - statSync(path).mtimeMs > maxAgeMs) rmSync(path, { force: true });
      } catch {
        rmSync(path, { force: true });
      }
    }
  } catch {
    /* directory unreadable — nothing to clean */
  }
}

/**
 * Begin a transaction: capture pre-write content so a crash between file
 * writes can be rolled back or reported.
 * @param txDir - directory to hold the journal (the profile dir).
 * @param target - the skin id being enabled.
 * @param originals - [{ path, existed, source }] per patch layer.
 * @returns { txId, journalPath }.
 */
export function beginTransaction(txDir, target, originals) {
  mkdirSync(txDir, { recursive: true });
  const txId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const journal = {
    txId,
    startedAt: new Date().toISOString(),
    target,
    originals: originals.map((original) => ({
      path: original.path,
      existed: original.existed,
      source: original.source,
    })),
  };
  const journalPath = join(txDir, `${txId}${TX_SUFFIX}`);
  writeFileSync(journalPath, JSON.stringify(journal, null, 2), 'utf8');
  return { txId, journalPath };
}

/** Mark a transaction completed and remove its journal. */
export function completeTransaction(journalPath) {
  rmSync(journalPath, { force: true });
}

/**
 * Read a journal's original snapshot. The journal deliberately does not store
 * the full old content; instead callers re-derive it from the originals they
 * captured. `readJournal` returns null when there is no usable journal.
 */
export function readJournal(journalPath) {
  try {
    return JSON.parse(readFileSync(journalPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Find the newest journal in a directory, or null when none is pending. */
export function findPendingJournal(directory) {
  try {
    const files = readdirSync(directory).filter((name) => name.endsWith(TX_SUFFIX));
    if (files.length === 0) return null;
    const withMtime = files
      .map((name) => ({ name, mtimeMs: statSync(join(directory, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    return join(directory, withMtime[0].name);
  } catch {
    return null;
  }
}

/**
 * How far an interrupted write progressed, so recovery can finish or roll
 * back without guessing.
 *   none     — every layer still shows the pre-write target.
 *   partial  — some layers switched, some did not.
 *   complete — every layer switched; only the commit (journal/state/history)
 *              was lost.
 */
export function classifyWriteState(originals, next, journal) {
  const count = originals.length;
  if (count === 0) return 'none';
  let switched = 0;
  let pristine = 0;
  for (let index = 0; index < count; index += 1) {
    const current = existsSync(originals[index].path) ? readFileSync(originals[index].path, 'utf8') : '';
    if (current === next[index]) switched += 1;
    else if (current === originals[index].source) pristine += 1;
  }
  if (switched === count) return 'complete';
  if (pristine === count) return 'none';
  return 'partial';
}

/**
 * Roll back from a pending journal using the caller-provided snapshot of the
 * original file contents. Content is restored verbatim; files that did not
 * exist before are removed again.
 * @param journal - parsed journal from readJournal.
 * @param originals - [{ path, existed, source }] captured before the write.
 */
export function rollbackFromJournal(journal, originals) {
  for (const entry of journal.originals) {
    const original = originals.find((item) => item.path === entry.path);
    if (original === undefined) continue;
    if (entry.existed) {
      writeFileSync(entry.path, original.source, 'utf8');
    } else if (existsSync(entry.path)) {
      rmSync(entry.path, { force: true });
    }
  }
}
