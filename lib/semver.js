/**
 * Minimal SemVer range evaluator.
 *
 * DSH's plugin admission compares every `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`
 * peer range against the running runtime version with
 * `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`.
 * This module reproduces that decision without depending on node-semver: it
 * expands a range into plain comparators exactly the way node-semver does for
 * `includePrerelease: true` (caret and tilde upper bounds carry `-0`, partial
 * `>=`/`<=` bounds carry `-0`, hyphen upper bounds become `<next-0`), then
 * compares versions with full SemVer 2.0.0 ordering.
 *
 * `test/semver-oracle.test.mjs` compares this implementation against the real
 * node-semver whenever one is installed next to the profile.
 *
 * @module dsh-skin-rotation/semver
 */

const IDENTIFIER = /^[0-9A-Za-z-]+$/;
const COMPONENT = '\\d+|[xX*]';
const PARTIAL = `(${COMPONENT})(?:\\.(${COMPONENT})(?:\\.(${COMPONENT})(?:-([0-9A-Za-z-.]+))?)?)?`;
const GTLT = '((?:<|>)?=?)';
const CARET = new RegExp(`^\\^${PARTIAL}$`);
const TILDE = new RegExp(`^(?:~>?)${PARTIAL}$`);
const XRANGE = new RegExp(`^${GTLT}\\s*${PARTIAL}$`);
const HYPHEN = new RegExp(`^\\s*${PARTIAL}\\s+-\\s+${PARTIAL}\\s*$`);
const STAR = /(<|>)?=?\s*\*/g;
const GTE0PRE = /^\s*>=\s*0\.0\.0-0\s*$/;

/** Whether a range component means "any". */
function isX(component) {
  return component === undefined || component === null || component === 'x' || component === 'X' || component === '*';
}

/**
 * Parse a full version, optionally prefixed with `v` and optionally carrying
 * prerelease or build metadata.
 * @param text - candidate version text.
 * @returns the parsed version, or null when the text is not a version.
 */
export function parseVersion(text) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(text).trim());
  if (match === null) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  if (!prerelease.every((part) => part !== '' && IDENTIFIER.test(part))) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

/**
 * Compare two prerelease identifier lists the way SemVer 2.0.0 orders them.
 * @param left - prerelease identifiers of the left version.
 * @param right - prerelease identifiers of the right version.
 * @returns negative, zero, or positive.
 */
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const numericA = /^\d+$/.test(a);
    const numericB = /^\d+$/.test(b);
    if (numericA && numericB) {
      const difference = Number(a) - Number(b);
      if (difference !== 0) return difference < 0 ? -1 : 1;
      continue;
    }
    if (numericA !== numericB) return numericA ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** The zero-released sentinel node-semver appends as `-0`. */
const ZERO = '-0';

/**
 * Expand one `^` token the way node-semver does with `includePrerelease: true`.
 * @param token - a whitespace-free comparator.
 * @returns the expanded comparators.
 */
function expandCaret(token) {
  const match = CARET.exec(token);
  if (match === null) return token;
  const [, major, minor, patch, prerelease] = match;
  if (isX(major)) return '';
  if (isX(minor)) return `>=${major}.0.0${ZERO} <${Number(major) + 1}.0.0-0`;
  if (isX(patch)) {
    return major === '0'
      ? `>=${major}.${minor}.0${ZERO} <${major}.${Number(minor) + 1}.0-0`
      : `>=${major}.${minor}.0${ZERO} <${Number(major) + 1}.0.0-0`;
  }
  const lower = prerelease === undefined ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch}-${prerelease}`;
  if (major === '0') {
    return minor === '0'
      ? `>=${lower} <${major}.${minor}.${Number(patch) + 1}-0`
      : `>=${lower} <${major}.${Number(minor) + 1}.0-0`;
  }
  return `>=${lower} <${Number(major) + 1}.0.0-0`;
}

/**
 * Expand one `~` token the way node-semver does with `includePrerelease: true`.
 * @param token - a whitespace-free comparator.
 * @returns the expanded comparators.
 */
function expandTilde(token) {
  const match = TILDE.exec(token);
  if (match === null) return token;
  const [, major, minor, patch, prerelease] = match;
  if (isX(major)) return '';
  if (isX(minor)) return `>=${major}.0.0${ZERO} <${Number(major) + 1}.0.0-0`;
  if (isX(patch)) return `>=${major}.${minor}.0${ZERO} <${major}.${Number(minor) + 1}.0-0`;
  const lower = prerelease === undefined ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch}-${prerelease}`;
  return `>=${lower} <${major}.${Number(minor) + 1}.0-0`;
}

/**
 * Expand one x-range or partial comparator the way node-semver does.
 * @param token - a whitespace-free comparator.
 * @returns the expanded comparators.
 */
function expandXRange(token) {
  const match = XRANGE.exec(token.trim());
  if (match === null) return token;
  let [, operator, major, minor, patch, prerelease] = match;
  if (operator === undefined) operator = '';
  const xMajor = isX(major);
  const xMinor = xMajor || isX(minor);
  const xPatch = xMinor || isX(patch);
  if (!xMajor && !xMinor && !xPatch) {
    // A complete version with an operator (or none) stays as it is.
    if (prerelease !== undefined) return operator === '=' || operator === '' ? `=${major}.${minor}.${patch}-${prerelease}` : `${operator}${major}.${minor}.${patch}-${prerelease}`;
    return operator === '=' || operator === '' ? `=${major}.${minor}.${patch}` : `${operator}${major}.${minor}.${patch}`;
  }
  if (operator === '=') operator = '';
  let suffix = prerelease === undefined ? ZERO : `-${prerelease}`;
  if (xMajor) {
    if (operator === '>' || operator === '<') return '<0.0.0-0';
    return '*';
  }
  if (operator !== '') {
    if (xMinor) minor = '0';
    patch = '0';
    if (operator === '>') {
      operator = '>=';
      if (xMinor) {
        major = String(Number(major) + 1);
        minor = '0';
        patch = '0';
      } else {
        minor = String(Number(minor) + 1);
        patch = '0';
      }
    } else if (operator === '<=') {
      operator = '<';
      if (xMinor) major = String(Number(major) + 1);
      else minor = String(Number(minor) + 1);
    }
    if (operator === '<') suffix = ZERO;
    return `${operator}${major}.${minor}.${patch}${suffix}`;
  }
  if (xMinor) return `>=${major}.0.0${suffix} <${Number(major) + 1}.0.0-0`;
  return `>=${major}.${minor}.0${suffix} <${major}.${Number(minor) + 1}.0-0`;
}

/**
 * Expand a hyphen range the way node-semver does with `includePrerelease: true`.
 * @param alternative - one `||` alternative.
 * @returns the expanded alternative, or the input when it is not a hyphen range.
 */
function expandHyphen(alternative) {
  const match = HYPHEN.exec(alternative);
  if (match === null) return alternative;
  const [, fromMajor, fromMinor, fromPatch, fromPre, toMajor, toMinor, toPatch, toPre] = match;
  let from;
  if (isX(fromMajor)) from = '';
  else if (isX(fromMinor)) from = `>=${fromMajor}.0.0-0`;
  else if (isX(fromPatch)) from = `>=${fromMajor}.${fromMinor}.0-0`;
  else if (fromPre !== undefined) from = `>=${fromMajor}.${fromMinor}.${fromPatch}-${fromPre}`;
  else from = `>=${fromMajor}.${fromMinor}.${fromPatch}-0`;
  let to;
  if (isX(toMajor)) to = '';
  else if (isX(toMinor)) to = `<${Number(toMajor) + 1}.0.0-0`;
  else if (isX(toPatch)) to = `<${toMajor}.${Number(toMinor) + 1}.0-0`;
  else if (toPre !== undefined) to = `<=${toMajor}.${toMinor}.${toPatch}-${toPre}`;
  else to = `<${toMajor}.${toMinor}.${Number(toPatch) + 1}-0`;
  return `${from} ${to}`.trim();
}

/**
 * Expand one `||` alternative into whitespace-separated comparators.
 * @param alternative - one alternative of a range expression.
 * @returns the comparator strings, `[]` meaning "any version".
 */
export function expandRange(alternative) {
  let text = expandHyphen(alternative.trim());
  text = text.trim().split(/\s+/).map(expandCaret).join(' ');
  text = text.trim().split(/\s+/).map(expandTilde).join(' ');
  text = text.trim().split(/\s+/).map(expandXRange).join(' ');
  text = text.replace(STAR, '').trim();
  if (GTE0PRE.test(text)) return [];
  return text.split(/\s+/).filter((token) => token !== '' && token !== '*');
}

/**
 * Evaluate one comparator against a parsed version.
 * @param version - the parsed version under test.
 * @param comparator - a comparator such as `>=1.2.0` or `<2.0.0-0`.
 * @returns whether the comparator holds, or null when it cannot be parsed.
 */
function testComparator(version, comparator) {
  const match = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(comparator);
  if (match === null) return null;
  const operator = match[1] === undefined ? '=' : match[1];
  const expected = parseVersion(match[2]);
  if (expected === null) return null;
  const order = compareVersions(version, expected);
  switch (operator) {
    case '=':
      return order === 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    default:
      return null;
  }
}

/**
 * Decide whether a version satisfies a range expression.
 * @param version - version text such as `0.2.0-rc.2`.
 * @param range - range expression such as `>=0.1.7-rc.1 <0.3.0-0`.
 * @returns whether the range accepts the version.
 */
export function satisfies(version, range) {
  const parsed = parseVersion(version);
  if (parsed === null) return false;
  const text = String(range).trim();
  if (text === '') return false;
  for (const alternative of text.split('||')) {
    const comparators = expandRange(alternative);
    let ok = true;
    for (const comparator of comparators) {
      const result = testComparator(parsed, comparator);
      if (result === null) {
        ok = false;
        break;
      }
      if (result === false) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Total order over parsed versions.
 * @param left - left version.
 * @param right - right version.
 * @returns negative, zero, or positive.
 */
export function compareVersions(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}
