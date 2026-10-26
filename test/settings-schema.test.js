import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, writeFile, stat, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  FIELDS, ACCOUNT_FIELDS, ACCOUNT_READONLY, ACCOUNT_DEPRECATED, MASK, ORDER_HELP,
  publicSettings, applySettingsChanges, backupConfig, SettingsError,
} from '../src/settings.js';

// The Settings view must stay complete: every config key the code reads, and
// every key the docs describe, has a row in the schema (2026-10-11, JP: "all
// the settings should be exposed in the web GUI"). These tests are the guard —
// a new key with no Settings entry turns CI red here.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KEYS = new Set(FIELDS.map(f => f.key));

async function documentedKeys() {
  const md = await readFile(join(ROOT, 'docs', 'configuration.md'), 'utf8');
  const section = md.slice(md.indexOf('\n## Fields'), md.indexOf('\n## Environment variables'));
  return [...section.matchAll(/^\| `([^`]+)`/gm)].map(m => m[1]);
}

test('every documented config key has a Settings entry', async () => {
  const docs = await documentedKeys();
  assert.ok(docs.length > 40, `parsed only ${docs.length} documented keys — did the docs table move?`);
  const acctKnown = new Set([...ACCOUNT_FIELDS.map(f => f.key), ...ACCOUNT_READONLY, ...ACCOUNT_DEPRECATED]);
  const missing = docs.filter(k => (k.startsWith('accounts[].') ? !acctKnown.has(k.slice('accounts[].'.length)) : !KEYS.has(k)));
  assert.deepEqual(missing, [], `documented in docs/configuration.md but missing from src/settings.js FIELDS: ${missing.join(', ')}`);
});

test('every Settings entry is documented', async () => {
  const docs = new Set(await documentedKeys());
  const undocumented = [...KEYS].filter(k => !docs.has(k))
    .concat(ACCOUNT_FIELDS.map(f => `accounts[].${f.key}`).filter(k => !docs.has(k)));
  assert.deepEqual(undocumented, [], `in the Settings schema but not in docs/configuration.md: ${undocumented.join(', ')}`);
});

// Words after `config.` / `config.proxy.` etc. that are not config keys.
const NOT_KEYS = new Set(['js', 'json', 'example', 'replace', 'endsWith', 'accounts', 'proxy', 'sx', 'service', 'egress', 'mitm', 'fable', 'mythos', 'failover']);
// Top-level keys of objects whose sub-keys are read under another variable name.
const NESTED = ['proxy', 'egress', 'sx', 'service', 'mitm', 'fable', 'mythos', 'failover'];

test('every config key the code reads has a Settings entry', async () => {
  const dir = join(ROOT, 'src');
  const files = (await readdir(dir)).filter(f => f.endsWith('.js'));
  const seen = new Map();
  for (const f of files) {
    const src = await readFile(join(dir, f), 'utf8');
    // config.X / diskConfig.X (top level) and config.<nested>.X
    for (const m of src.matchAll(/\b(?:config|diskConfig)\??\.([a-zA-Z_$][\w$]*)(?:\??\.([a-zA-Z_$][\w$]*))?/g)) {
      const [, top, sub] = m;
      const key = NESTED.includes(top) && sub ? `${top}.${sub}` : top;
      if (NOT_KEYS.has(key)) continue;
      if (!seen.has(key)) seen.set(key, f);
    }
  }
  assert.ok(seen.size > 25, `scan found only ${seen.size} keys — did the code stop using config.X?`);
  // A nested key matched without its sub-key ("config.proxy" alone) is fine;
  // a nested key's own members are covered by matching the prefix, and so is
  // a section whose fields are listed one by one (proxy.sso → proxy.sso.users …).
  const section = (k) => [...KEYS].some(x => x.startsWith(`${k}.`));
  const missing = [...seen].filter(([k]) => !KEYS.has(k) && !NESTED.includes(k) && !section(k)).map(([k, f]) => `${k} (${f})`);
  assert.deepEqual(missing, [], `read by the code but missing from src/settings.js FIELDS: ${missing.join(', ')}`);
});

test('the scan catches a key with no entry (positive control)', () => {
  const src = 'const v = config.brandNewKnob; const w = diskConfig.proxy.newProxyKnob;';
  const found = [...src.matchAll(/\b(?:config|diskConfig)\??\.([a-zA-Z_$][\w$]*)(?:\??\.([a-zA-Z_$][\w$]*))?/g)]
    .map(([, top, sub]) => (NESTED.includes(top) && sub ? `${top}.${sub}` : top));
  assert.deepEqual(found.filter(k => !KEYS.has(k)), ['brandNewKnob', 'proxy.newProxyKnob']);
});

test('every field has a group, label, one-line help, a type and hot/restart', () => {
  for (const f of [...FIELDS, ...ACCOUNT_FIELDS]) {
    assert.ok(f.label && f.help && f.type, `${f.key}: label/help/type`);
    assert.ok(!f.help.includes('\n'), `${f.key}: help is one line`);
    assert.ok(['hot', 'restart'].includes(f.apply), `${f.key}: apply`);
    assert.ok('def' in f, `${f.key}: default`);
  }
  for (const f of FIELDS) assert.ok(f.group, `${f.key}: group`);
  assert.equal(new Set(FIELDS.map(f => f.key)).size, FIELDS.length, 'no duplicate keys');
});

// Distinctive values so a substring hit is a real leak, not a word in help text.
const SECRETS = { apiKey: 'zzSHAREDzz91', client: 'zzCLIENTzz42', proxyPw: 'zzPROXYPWzz7', sx: 'zzSXKEYzz3', token: 'zzOAUTHzz55', refresh: 'zzREFRESHzz6' };
const fixture = () => ({
  proxy: { port: 3456, apiKey: SECRETS.apiKey, clientKeys: [{ name: 'katana', key: SECRETS.client }] },
  upstreamProxy: `http://user:${SECRETS.proxyPw}@squid:3128`,
  sx: { apiKey: SECRETS.sx, mode: '429' },
  loadBalance: true,
  accounts: [
    { id: 'a1', name: 'first', priority: 0, accessToken: SECRETS.token, refreshToken: SECRETS.refresh },
    { id: 'a2', name: 'second', priority: 1, accessToken: SECRETS.token },
    { id: 'a3', name: 'third', priority: 2 },
  ],
});

test('no secret value ever appears in the public settings', () => {
  const json = JSON.stringify(publicSettings(fixture()));
  for (const [what, v] of Object.entries(SECRETS)) assert.ok(!json.includes(v), `${what} leaked`);
  const p = publicSettings(fixture());
  const val = (k) => p.fields.find(f => f.key === k).value;
  assert.equal(val('proxy.apiKey'), MASK);
  assert.deepEqual(val('proxy.clientKeys'), [{ name: 'katana', key: MASK }]);
  assert.equal(val('upstreamProxy'), `http://${MASK}@squid:3128`);
  assert.equal(val('sx.apiKey'), MASK);
  assert.equal(publicSettings({ accounts: [] }).fields.find(f => f.key === 'proxy.apiKey').value, null, 'unset secret reads as not set');
});

test('public settings: account order, the order help line, and unknown keys', () => {
  const p = publicSettings(fixture());
  assert.equal(p.orderHelp, ORDER_HELP);
  assert.match(ORDER_HELP, /highest account with quota left; when a higher one renews, traffic moves back to it/);
  assert.deepEqual(p.accounts.map(a => [a.id, a.priority]), [['a1', 0], ['a2', 1], ['a3', 2]]);
  assert.deepEqual(p.unknown, ['loadBalance']);
});

test('a masked secret sent back keeps the stored value', () => {
  const c = fixture();
  const shown = publicSettings(c).fields;
  const set = Object.fromEntries(['proxy.apiKey', 'proxy.clientKeys', 'upstreamProxy', 'sx.apiKey'].map(k => [k, shown.find(f => f.key === k).value]));
  const r = applySettingsChanges(c, { set });
  assert.deepEqual(r, { applied: [], needsRestart: [] }, 'nothing changed');
  assert.equal(c.proxy.apiKey, SECRETS.apiKey);
  assert.equal(c.proxy.clientKeys[0].key, SECRETS.client);
  assert.equal(c.upstreamProxy, `http://user:${SECRETS.proxyPw}@squid:3128`);
  assert.equal(c.sx.apiKey, SECRETS.sx);
});

// Cross-model review (gpt-6.1-sol): a masked credential that may follow the
// URL to a new host lets a caller who cannot read it deliver it to a server
// they chose. Reuse needs the same scheme and host; a port or path change is
// a new destination only when the host:port changes.
test('a masked proxy password stays with its host; moving it needs retyping', () => {
  const c = fixture();
  assert.throws(() => applySettingsChanges(c, { set: { upstreamProxy: `http://${MASK}@squid2:3128` } }), /destination changed/);
  assert.throws(() => applySettingsChanges(c, { set: { upstreamProxy: `http://${MASK}@squid:3129` } }), /destination changed/);
  assert.equal(c.upstreamProxy, `http://user:${SECRETS.proxyPw}@squid:3128`);
  applySettingsChanges(c, { set: { upstreamProxy: `http://user:typedNew@squid2:3128` } });
  assert.equal(c.upstreamProxy, 'http://user:typedNew@squid2:3128');
});

test('client keys: keep masked ones, add new ones, refuse a new name with a masked key', () => {
  const c = fixture();
  const r = applySettingsChanges(c, { set: { 'proxy.clientKeys': [{ name: 'katana', key: MASK }, { name: 'phone', key: 'newkey1' }] } });
  assert.deepEqual(c.proxy.clientKeys, [{ name: 'katana', key: SECRETS.client }, { name: 'phone', key: 'newkey1' }]);
  assert.deepEqual(r.applied, ['proxy.clientKeys']);
  assert.throws(() => applySettingsChanges(c, { set: { 'proxy.clientKeys': [{ name: 'renamed', key: MASK }] } }), /no stored key for renamed/);
});

test('the shared key cannot be cleared, only replaced', () => {
  const c = fixture();
  assert.throws(() => applySettingsChanges(c, { set: { 'proxy.apiKey': '' } }), /cannot be cleared/);
  assert.throws(() => applySettingsChanges(c, { set: { 'proxy.apiKey': null } }), /cannot be cleared/);
  applySettingsChanges(c, { set: { 'proxy.apiKey': 'rotated' } });
  assert.equal(c.proxy.apiKey, 'rotated');
});

test('validation matches the loader and rejects the whole save', () => {
  const c = fixture();
  const before = JSON.stringify(c);
  let err;
  try {
    applySettingsChanges(c, { set: {
      'proxy.port': 70000, warmupSeconds: 10, distributeSessions: 'sometimes', switchThreshold: 1.5,
      'proxy.tls': { port: 'x' }, adaptiveDistribution: { burnAlpha: 9 }, warmupSchedule: { resetTime: '25:00' },
      'service.restart': 'reboot', upstream: 'not a url', nope: 1, quotaProbeSeconds: 600,
    } });
  } catch (e) { err = e; }
  assert.ok(err instanceof SettingsError);
  const keys = err.problems.map(p => p.split(':')[0]);
  for (const k of ['proxy.port', 'warmupSeconds', 'distributeSessions', 'switchThreshold', 'proxy.tls', 'adaptiveDistribution', 'warmupSchedule', 'service.restart', 'upstream', 'nope']) {
    assert.ok(keys.includes(k), `${k} should be refused (got ${err.problems.join(' | ')})`);
  }
  assert.ok(!keys.includes('quotaProbeSeconds'), 'a valid change is not reported');
  assert.equal(JSON.stringify(c), before, 'nothing applied when any change is bad');
});

test('hot vs restart is reported per key, and null unsets', () => {
  const c = fixture();
  c.warmupSeconds = 300;
  const r = applySettingsChanges(c, { set: { warmupSeconds: null, 'proxy.port': 3500, eventLogging: 'block', logLevel: 'headers' } });
  assert.deepEqual(r.applied.sort(), ['eventLogging', 'warmupSeconds']);
  assert.deepEqual(r.needsRestart.sort(), ['logLevel', 'proxy.port']);
  assert.ok(!('warmupSeconds' in c));
  assert.equal(c.proxy.port, 3500);
});

test('account order rewrites priority to list position', () => {
  const c = fixture();
  const r = applySettingsChanges(c, { order: ['a3', 'a1', 'a2'] });
  assert.deepEqual(c.accounts.map(a => [a.name, a.priority]), [['first', 1], ['second', 2], ['third', 0]]);
  assert.deepEqual(r.applied, ['accounts.priority']);
  assert.throws(() => applySettingsChanges(c, { order: ['a1', 'a2'] }), /every account exactly once/);
  assert.throws(() => applySettingsChanges(c, { order: ['a1', 'a1', 'a2'] }), /every account exactly once/);
});

test('per-account fields: editable ones apply, tokens and unknown fields are refused', () => {
  const c = fixture();
  const r = applySettingsChanges(c, { accounts: [{ id: 'a2', disabled: true, maxUsage: 0.6 }] });
  assert.equal(c.accounts[1].disabled, true);
  assert.equal(c.accounts[1].maxUsage, 0.6);
  assert.deepEqual(r.applied.sort(), ['accounts.disabled', 'accounts.maxUsage']);
  assert.throws(() => applySettingsChanges(c, { accounts: [{ id: 'a1', accessToken: 'x' }] }), /not an editable field/);
  assert.throws(() => applySettingsChanges(c, { accounts: [{ id: 'nope', disabled: true }] }), /not found/);
});

test('backups: 0600, one per save, newest 20 kept', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-settings-'));
  try {
    const cfg = join(dir, 'teamclaude.json');
    await writeFile(cfg, '{"v":0}', { mode: 0o600 });
    const t0 = Date.UTC(2026, 9, 11, 12, 0, 0);
    const names = [];
    for (let i = 0; i < 23; i++) names.push(await backupConfig(cfg, 20, new Date(t0 + i * 1000)));
    const left = (await readdir(dir)).filter(f => f.includes('.bak-settings-')).sort();
    assert.equal(left.length, 20);
    assert.deepEqual(left, names.slice(3).sort(), 'the oldest three were pruned');
    assert.equal((await stat(join(dir, left[0]))).mode & 0o777, 0o600);
    assert.equal(await readFile(join(dir, left[0]), 'utf8'), '{"v":0}');
    // Two saves in one second get distinct names.
    const a = await backupConfig(cfg, 20, new Date(t0 + 99000));
    const b = await backupConfig(cfg, 20, new Date(t0 + 99000));
    assert.notEqual(a, b);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Masking must find credentials exactly where the loader does. parseProxyUrl
// (WHATWG URL) accepts a scheme-less "user:pass@host", ends the userinfo at
// the LAST "@", and treats a token-only userinfo as the username — a regex that
// disagreed with it showed passwords to every client-key holder.
test('URL credentials are masked wherever the loader would find them', async () => {
  const { parseProxyUrl } = await import('../src/upstream-proxy.js');
  const cases = [
    'http://user:zzPWzz1@squid:3128',
    'user:zzPWzz2@squid:3128',                 // scheme-less, as the docs allow
    'http://user:zz@PWzz3@squid:3128',         // unencoded "@" in the password
    'http://zzTOKENzz4@squid:3128',            // token-only userinfo
    '  http://user:zzPWzz5@squid:3128',        // leading space (the loader trims)
    'http://user:zz%40PWzz6@squid:3128',       // percent-encoded
  ];
  for (const raw of cases) {
    const parsed = parseProxyUrl(raw);
    const secret = parsed.password ?? parsed.username;
    assert.ok(secret, `fixture ${raw} has credentials per the loader`);
    const shown = publicSettings({ upstreamProxy: raw, accounts: [] }).fields.find(f => f.key === 'upstreamProxy').value;
    for (const piece of [secret, encodeURIComponent(secret), 'zzPW', 'zzTOKEN', 'PWzz']) assert.ok(!shown.includes(piece), `${raw} → ${shown} leaks ${piece}`);
    assert.ok(shown.includes(MASK), `${raw} → ${shown} is masked`);
    // And the masked value round-trips to the original.
    const c = { upstreamProxy: raw, accounts: [] };
    applySettingsChanges(c, { set: { upstreamProxy: shown } });
    assert.equal(c.upstreamProxy, raw.trim(), "round-trips (trimmed, as the loader trims)");
  }
});

test('credentials in upstream, egress.checkUrl and an account upstream are masked too', () => {
  const c = {
    upstream: 'https://ak:zzUPzz1@gateway.example/anthropic',
    egress: { checkUrl: 'https://zzIPTOKzz2@ip.example/' },
    accounts: [{ id: 'd1', name: 'deepseek', upstream: 'https://k:zzACCTzz3@api.deepseek.example/anthropic' }],
  };
  const json = JSON.stringify(publicSettings(c));
  for (const s of ['zzUPzz1', 'zzIPTOKzz2', 'zzACCTzz3']) assert.ok(!json.includes(s), `${s} leaked`);
  const p = publicSettings(c);
  // A path change on the same host keeps the stored credentials; a new host does not.
  applySettingsChanges(c, { accounts: [{ id: 'd1', upstream: p.accounts[0].upstream.replace('/anthropic', '/v2') }] });
  assert.equal(c.accounts[0].upstream, 'https://k:zzACCTzz3@api.deepseek.example/v2');
  assert.throws(() => applySettingsChanges(c, { accounts: [{ id: 'd1', upstream: `https://${MASK}@evil.example/v2` }] }), /destination changed/);
});

test('the mask cannot be moved out of the userinfo position', () => {
  const c = { upstreamProxy: 'http://user:zzPWzz1@squid:3128', accounts: [] };
  for (const v of [`http://evil.example/${MASK}@x`, `http://squid:3128/?p=${MASK}`, `http://user:${MASK}@squid:3128`]) {
    assert.throws(() => applySettingsChanges(JSON.parse(JSON.stringify(c)), { set: { upstreamProxy: v } }), /retype the credentials/, v);
  }
  // No stored credentials: a mask stands for nothing.
  assert.throws(() => applySettingsChanges({ upstreamProxy: 'http://squid:3128', accounts: [] }, { set: { upstreamProxy: `http://${MASK}@squid:3128` } }), /no stored credentials/);
});

test('a refused URL change never quotes the stored credentials back', () => {
  const c = { upstreamProxy: 'http://user:zzPWzz9@squid:3128', accounts: [{ id: 'a', name: 'acct', upstream: 'https://k:zzACCTzz8@be.example' }] };
  let err;
  try {
    applySettingsChanges(c, {
      set: { upstreamProxy: `socks5://${MASK}@squid:3128` },
      accounts: [{ id: 'a', upstream: `ftp://${MASK}@be.example` }],
    });
  } catch (e) { err = e; }
  assert.ok(err instanceof SettingsError, 'refused');
  const text = err.problems.join(' | ');
  assert.ok(!text.includes('zzPWzz9') && !text.includes('zzACCTzz8'), text);
});

test('clearing switchThreshold writes its default; priority cannot be emptied', () => {
  const c = { switchThreshold: 0.9, accounts: [{ id: 'a', name: 'a', priority: 2 }] };
  const r = applySettingsChanges(c, { set: { switchThreshold: null } });
  assert.equal(c.switchThreshold, 0.98, 'the reload path ignores an absent value, so the default is written');
  assert.deepEqual(r.applied, ['switchThreshold']);
  assert.throws(() => applySettingsChanges(c, { accounts: [{ id: 'a', priority: null }] }), /cannot be empty/);
});

test('typing false for the outbound proxy stores false, not the text "false"', () => {
  const c = { accounts: [] };
  applySettingsChanges(c, { set: { upstreamProxy: 'false' } });
  assert.equal(c.upstreamProxy, false);
  assert.equal(publicSettings(c).fields.find(f => f.key === 'upstreamProxy').value, false);
  assert.throws(() => applySettingsChanges({ accounts: [] }, { set: { upstream: 'false' } }), /upstream:/, 'only fields that accept false do');
});

test('client keys: duplicate names are refused, extra properties are dropped', () => {
  const c = { proxy: { clientKeys: [{ name: 'x', key: 'k1' }, { name: 'y', key: 'k2' }] }, accounts: [] };
  assert.throws(() => applySettingsChanges(c, { set: { 'proxy.clientKeys': [{ name: 'x', key: MASK }, { name: 'x', key: MASK }] } }), /each name may appear once/);
  applySettingsChanges(c, { set: { 'proxy.clientKeys': [{ name: ' x ', key: MASK, admin: true }, { name: 'y', key: MASK }, { name: 'z', key: 'k3' }] } });
  assert.deepEqual(c.proxy.clientKeys, [{ name: 'x', key: 'k1' }, { name: 'y', key: 'k2' }, { name: 'z', key: 'k3' }]);
});

test('an account change without an id matches nothing', () => {
  const c = { accounts: [{ name: 'legacy', priority: 0 }] };
  assert.throws(() => applySettingsChanges(c, { accounts: [{ disabled: true }] }), /not found/);
  assert.equal(c.accounts[0].disabled, undefined);
});

test('masking fails closed: a backslash or odd scheme never leaves part of a password showing', () => {
  for (const raw of [
    'socks5://alice:zzP@decoy\\zzSECRETzz@proxy.example:1080',  // backslash ends http authorities, not socks5
    'http://alice:zzP\\zzSECRETzz@proxy.example:3128',
    'http://alice:zz/zzSECRETzz@proxy.example:3128',           // a raw slash in the password
  ]) {
    const shown = publicSettings({ upstreamProxy: raw, accounts: [] }).fields.find(f => f.key === 'upstreamProxy').value;
    assert.ok(!shown.includes('zzSECRET') && !shown.includes('zzP'), `${raw} → ${shown}`);
  }
});

test('GET never echoes a stored value of the wrong shape', () => {
  const p = publicSettings({
    upstreamProxy: { host: 'x', password: 'zzOBJPWzz1' },
    upstream: ['https://u:zzARRzz2@h'],
    proxy: { apiKey: { nested: 'zzKEYOBJzz3' }, clientKeys: [{ name: { n: 'zzNAMEzz4' }, key: 'zzCKzz5' }] },
    accounts: [{ id: 'a', name: 'a', upstream: { password: 'zzACCOBJzz6' } }],
  });
  const json = JSON.stringify(p);
  for (const s of ['zzOBJPWzz1', 'zzARRzz2', 'zzKEYOBJzz3', 'zzNAMEzz4', 'zzCKzz5', 'zzACCOBJzz6']) assert.ok(!json.includes(s), `${s} leaked`);
});

test('a refused URL is explained without the credentials ever reaching the message', () => {
  const c = { upstreamProxy: 'http://user:zzPWzz7@squid:3128', accounts: [] };
  // The real value and the credential-free copy fail alike: the message is the copy's, masked.
  let e1; try { applySettingsChanges(c, { set: { upstreamProxy: 'https://user:zzNEWzz8@squid:3128' } }); } catch (e) { e1 = e; }
  assert.match(e1.problems[0], /unsupported proxy protocol "https"/);
  assert.ok(!e1.problems[0].includes('zzNEWzz8'), e1.problems[0]);
  // Only the credentials are invalid: a fixed message, no echo.
  let e2; try { applySettingsChanges(c, { set: { upstreamProxy: 'http://user:zz%zzBADzz9@squid:3128' } }); } catch (e) { e2 = e; }
  assert.ok(!e2.problems[0].includes('BADzz9'), e2.problems[0]);
  assert.match(e2.problems[0], /user:password part is not valid/);
});

test('account upstream and the exit-IP check URL must be http(s) URLs', () => {
  const c = { accounts: [{ id: 'a', name: 'a', upstream: 'https://k:zzS@be.example' }] };
  assert.throws(() => applySettingsChanges(c, { accounts: [{ id: 'a', upstream: `ftp://${MASK}@be.example` }] }), /http\(s\) URL|destination changed/);
  assert.throws(() => applySettingsChanges(c, { accounts: [{ id: 'a', upstream: 'not a url' }] }), /must be a URL/);
  assert.throws(() => applySettingsChanges(c, { set: { 'egress.checkUrl': 'file:///etc/passwd' } }), /http\(s\) URL/);
});

test('a client key equal to the shared key is refused (it would lock the admin out)', () => {
  const c = { proxy: { apiKey: 'shared1', clientKeys: [] }, accounts: [] };
  assert.throws(() => applySettingsChanges(c, { set: { 'proxy.clientKeys': [{ name: 'x', key: 'shared1' }] } }), /same as the shared proxy key/);
  const d = { accounts: [] };
  applySettingsChanges(d, { set: { upstreamProxy: ' False ' } });
  assert.equal(d.upstreamProxy, false);
});

test('backups never overwrite or write through something already at the name', async () => {
  const { symlink } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'tc-settings-excl-'));
  try {
    const cfg = join(dir, 'teamclaude.json');
    await writeFile(cfg, '{"v":1}', { mode: 0o600 });
    const now = new Date(Date.UTC(2026, 9, 11, 13, 0, 0));
    const victim = join(dir, 'victim.txt');
    await writeFile(victim, 'untouched');
    // Planted at exactly the name the next backup would take.
    await symlink(victim, join(dir, 'teamclaude.json.bak-settings-20261011T130000'));
    const name = await backupConfig(cfg, 20, now);
    assert.equal(name, 'teamclaude.json.bak-settings-20261011T130000-2');
    assert.equal(await readFile(victim, 'utf8'), 'untouched');
    assert.equal(await readFile(join(dir, name), 'utf8'), '{"v":1}');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('same-destination check uses the URL parser (backslash quirks cannot fake a host)', () => {
  const c = { upstreamProxy: 'socks5://user:zzS@proxy.example\\old', accounts: [] };
  assert.throws(() => applySettingsChanges(c, { set: { upstreamProxy: `socks5://${MASK}@proxy.example\\relay.attacker.example` } }), /destination changed/);
  const h = { upstreamProxy: 'http://user:zzS@squid:3128/a', accounts: [] };
  assert.throws(() => applySettingsChanges(h, { set: { upstreamProxy: `http://${MASK}@squid:3128\\@evil.example` } }), /destination changed|retype/);
});

test('every hot proxy.* setting is re-read by the reload path', async () => {
  // A field marked hot that the reload never copies only applies after a
  // restart while the dashboard says otherwise (proxy.sso, 2026-10-26).
  const { FIELDS } = await import('../src/settings.js');
  const src = await readFile(join(ROOT, 'src', 'index.js'), 'utf8');
  // A lint-style check (it reads the text, not the behaviour); sso.test.js
  // shows the gate honours a replaced proxy.sso on the very next request.
  const code = src.split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const missing = [...new Set(FIELDS.filter(f => f.apply === 'hot' && f.key.startsWith('proxy.')).map(f => f.key.split('.')[1]))]
    .filter(sub => !new RegExp(`config\\.proxy\\.${sub} = diskConfig\\.proxy\\??\\.${sub}`).test(code));
  assert.deepEqual(missing, [], `hot in settings.js but not re-read on reload: ${missing.map(s => 'proxy.' + s).join(', ')}`);
});
