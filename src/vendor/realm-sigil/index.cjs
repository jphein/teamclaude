/**
 * realm-sigil: Deterministic magical version name generation.
 *
 * Usage:
 *   const { generateName, versionObject } = require('realm-sigil');
 *   generateName('e4f5a6b', 'fantasy') // → "Blazing Crown · e4f5a6b"
 */

const { REALMS } = require('./realms.cjs');

/**
 * Generate a deterministic magical name from a git hash and realm.
 * Same hash + realm always produces the same name.
 */
function generateName(hash, realm = 'fantasy') {
  const r = REALMS[realm] || REALMS.fantasy;
  const seed = parseHex(hash);

  const adj = r.adjectives[Number(seed % BigInt(r.adjectives.length))];
  const noun = r.nouns[Number((seed >> 8n) % BigInt(r.nouns.length))];

  return `${adj} ${noun} · ${hash}`;
}

/**
 * Parse a hex string to a 64-bit seed, matching Go's `parseHex` exactly: accumulate hex
 * digits, skip anything else, wrap at 64 bits.
 *
 * ⚠️ This used to be `parseInt(hash, 16) || 0` followed by `seed >> 8`, and that was BROKEN for
 * any seed >= 2^31. JS `>>` coerces its operand to **int32**, so the shift went negative, and
 * JS `%` keeps the dividend's sign — yielding a negative array index and an `undefined` noun.
 * `generateName('9e3779b1', 'fantasy')` returned literally "Blazing undefined · 9e3779b1".
 *
 * It stayed invisible because sigil's own use is 7-hex-char git hashes (< 2^28), where the sign
 * bit is never set. It bites any consumer seeding with a full u32 — which is exactly what smol
 * does (`id * 2654435761`), and 8 of 10 of its node ids produced `undefined` here while Go,
 * Python and the Rust binding all agreed on the right answer.
 *
 * BigInt rather than `>>> 8`: an unsigned shift would fix the sign bug but still truncate to 32
 * bits, so a hash longer than 8 hex chars would diverge from Go's uint64. `BigInt.asUintN(64,…)`
 * reproduces Go's overflow semantics precisely.
 *
 * Python used to `int(hash, 16)` and THROW on a non-hex character, special-casing only "dev"
 * (to seed 0, not 0xde). Since issue #9 it ports this parser, so all four bindings agree on
 * every input: "dev" is seed 0xde, "" is seed 0, nothing raises.
 */
function parseHex(s) {
  let result = 0n;
  for (const c of String(s ?? '')) {
    let v;
    if (c >= '0' && c <= '9') v = BigInt(c.charCodeAt(0) - 48);
    else if (c >= 'a' && c <= 'f') v = BigInt(c.charCodeAt(0) - 87);
    else if (c >= 'A' && c <= 'F') v = BigInt(c.charCodeAt(0) - 55);
    else continue;
    result = BigInt.asUintN(64, result * 16n + v);
  }
  return result;
}

/**
 * Build a version response object conforming to the realm-sigil contract.
 * For static/build-time use. Server handlers add runtime fields automatically.
 */
// git describe --tags --match 'v[0-9]*.[0-9]*.[0-9]*' --long, as passed to parseDescribe (issue #3).
// JS RegExp without the m flag anchors $ at the true end of input (no final-newline allowance, unlike Python's $),
// so these agree with Python's fullmatch and Go's regexp; the vectors hold \n, \r and U+2028 in every piece.
const DESCRIBE_ARGS = ['describe', '--tags', '--match', 'v[0-9]*.[0-9]*.[0-9]*', '--long'];
const PRE_ID = '(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'; // semver 2.0: no leading zero in a numeric id
const SEMVER_TAG = new RegExp(`^v(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-${PRE_ID}(\\.${PRE_ID})*)?$`);
const DISTANCE = /^[0-9]+$/;
const GHASH = /^g([0-9a-f]{4,64})$/; // 64: a SHA-256 repository's full hash

/**
 * [semver, build] from `git describe --tags --match 'v[0-9]*.[0-9]*.[0-9]*' --long` output (issue #3). Split at the LAST
 * two '-' (distance and g<hex> never contain one); the tag must be v<MAJOR>.<MINOR>.<PATCH>[-<prerelease>]
 * per semver 2.0 (no leading zeros, no '+'); anything else is ['', '']. build = semver when distance is 0 and the tree is
 * clean, else <semver>+<hex>[.dirty] (semver build metadata, not describe's prerelease-shaped form).
 * Same contract as Python's parse_describe and Go's ParseDescribe; tools/describe-vectors.json is the truth.
 */
function parseDescribe(describe, dirty = false) {
  if (typeof describe !== 'string') return ['', ''];
  const b = describe.lastIndexOf('-');
  const a = b > 0 ? describe.lastIndexOf('-', b - 1) : -1;
  if (a < 0) return ['', ''];
  const tag = describe.slice(0, a);
  const distance = describe.slice(a + 1, b);
  const m = GHASH.exec(describe.slice(b + 1));
  if (!m || !SEMVER_TAG.test(tag) || !DISTANCE.test(distance)) return ['', ''];
  if (/^0+$/.test(distance) && !dirty) return [tag, tag];
  return [tag, `${tag}+${m[1]}` + (dirty ? '.dirty' : '')];
}

function versionObject(opts) {
  const {
    name, description, realm, repo,
    hash = 'dev', branch = 'unknown', dirty = false, built = 'unknown', describe = '',
    started, uptime, runtime, os, host, pid,
  } = opts;

  const commitUrl = repo && hash !== 'dev' ? `${repo}/commit/${hash}` : '';

  const obj = {
    name,
    description,
    version: generateName(hash, realm),
    hash,
    branch,
    dirty,
    built,
    realm,
    repo,
    commit_url: commitUrl,
  };
  // Always present, '' when the project has no version tag (issue #3); see parseDescribe.
  [obj.semver, obj.build] = parseDescribe(describe, dirty);

  // Optional server-only fields
  if (started !== undefined) obj.started = started;
  if (uptime !== undefined) obj.uptime = uptime;
  if (runtime !== undefined) obj.runtime = runtime;
  if (os !== undefined) obj.os = os;
  if (host !== undefined) obj.host = host;
  if (pid !== undefined) obj.pid = pid;

  return obj;
}

module.exports = { generateName, versionObject, parseDescribe, DESCRIBE_ARGS, REALMS };
