import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import https from 'node:https';
import { generateCertChain, ipSanBytes } from '../src/x509.js';
import { leafCovers, keyMatchesCert, ensureCerts, refreshCaBundle } from '../src/mitm.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  resolveTlsConfig, listenerHosts, ensureListenerCerts, loadListenerCredentials, createTlsListener,
  DEFAULT_TLS_PORT, CA_BUNDLE, LISTENER_CA_CN,
} from '../src/tls-listener.js';

// Every certificate this file causes to exist lands in a throwaway config dir,
// never the operator's ~/.config (the CONNECT test reaches MITM code that
// mints certificates on demand).
import { mkdtempSync, rmSync } from 'node:fs';
import { after } from 'node:test';
import { dirname } from 'node:path';
process.env.TEAMCLAUDE_CONFIG = join(mkdtempSync(join(tmpdir(), 'tc-tls-home-')), 'teamclaude.json');
after(() => rmSync(dirname(/** @type {string} */ (process.env.TEAMCLAUDE_CONFIG)), { recursive: true, force: true }));

// ── config ───────────────────────────────────────────────────────────────────

test('resolveTlsConfig: off unless configured, defaults when on', () => {
  for (const off of [undefined, null, {}, { tls: false }, { tls: null }, { tls: { enabled: false } }]) {
    assert.equal(resolveTlsConfig(off), null, JSON.stringify(off));
  }
  assert.deepEqual(resolveTlsConfig({ tls: true }), { port: DEFAULT_TLS_PORT, host: null, cert: null, key: null, hosts: [] });
  assert.deepEqual(resolveTlsConfig({ port: 3456, tls: { port: 3443, hosts: ['10.0.6.107', 'familiar', 'familiar'] } }),
    { port: 3443, host: null, cert: null, key: null, hosts: ['10.0.6.107', 'familiar'] });
  assert.deepEqual(resolveTlsConfig({ tls: { cert: '/c.pem', key: '/k.pem', host: '0.0.0.0' } }),
    { port: DEFAULT_TLS_PORT, host: '0.0.0.0', cert: '/c.pem', key: '/k.pem', hosts: [] });
});

test('resolveTlsConfig: a malformed block throws instead of silently staying cleartext', () => {
  const bad = [
    { tls: 'yes' }, { tls: [] }, { tls: { port: 0 } }, { tls: { port: 70000 } }, { tls: { port: 'x' } },
    { port: 3456, tls: { port: 3456 } }, { tls: { cert: '/c.pem' } }, { tls: { key: '/k.pem' } },
    { tls: { hosts: 'familiar' } }, { tls: { hosts: [''] } }, { tls: { host: '' } },
  ];
  for (const b of bad) assert.throws(() => resolveTlsConfig(b), undefined, JSON.stringify(b));
});

test('listenerHosts always covers loopback plus the configured names', () => {
  assert.deepEqual(listenerHosts({ hosts: ['10.0.6.107', 'localhost'] }), ['localhost', '127.0.0.1', '10.0.6.107']);
});

// ── IP SANs ──────────────────────────────────────────────────────────────────

test('ipSanBytes packs IPv4 and IPv6 literals and ignores names', () => {
  assert.deepEqual([...ipSanBytes('10.0.6.107')], [10, 0, 6, 107]);
  assert.equal(ipSanBytes('::1').length, 16);
  assert.equal(ipSanBytes('::1')[15], 1);
  assert.deepEqual([...ipSanBytes('fd00::7')].slice(0, 2), [0xfd, 0x00]);
  assert.deepEqual([...ipSanBytes('::ffff:10.0.6.107')].slice(12), [10, 0, 6, 107]);
  assert.equal(ipSanBytes('familiar'), null);
});

test('a leaf issued for an IP carries an iPAddress SAN a client can verify, and leafCovers checks it', () => {
  const chain = generateCertChain(['familiar', '10.0.6.107', '::1']);
  const leaf = new X509Certificate(chain.leafCertPem);
  assert.equal(leaf.checkIP('10.0.6.107'), '10.0.6.107');
  assert.equal(leaf.checkIP('::1'), '::1');
  assert.equal(leaf.checkHost('familiar'), 'familiar');
  assert.equal(leaf.checkIP('10.0.6.108'), undefined);
  assert.equal(leafCovers(chain.caCertPem, chain.leafCertPem, ['familiar', '10.0.6.107']), true);
  assert.equal(leafCovers(chain.caCertPem, chain.leafCertPem, ['10.0.6.108']), false, 'an IP it was not issued for');
});

// ── the listener's own chain ─────────────────────────────────────────────────

test('ensureListenerCerts: own chain, key 0600, bundle holds both CAs, MITM CA untouched, reused until hosts change', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mitm = generateCertChain(['api.anthropic.com']);
  await writeFile(join(dir, 'teamclaude-ca.pem'), mitm.caCertPem);

  const a = await ensureListenerCerts(['localhost', '127.0.0.1', '10.0.6.107'], dir);
  assert.equal(a.regenerated, true);
  assert.equal((await stat(join(dir, 'teamclaude-listener.key'))).mode & 0o777, 0o600);
  const bundle = await readFile(join(dir, CA_BUNDLE), 'utf8');
  assert.ok(bundle.includes(mitm.caCertPem.trim()), 'MITM CA in the bundle');
  assert.ok(bundle.includes((await readFile(a.caPath, 'utf8')).trim()), 'listener CA in the bundle');
  assert.equal(await readFile(join(dir, 'teamclaude-ca.pem'), 'utf8'), mitm.caCertPem, 'the MITM CA is never rewritten');
  assert.ok(new X509Certificate(a.cert).verify(new X509Certificate(await readFile(a.caPath, 'utf8')).publicKey));

  const b = await ensureListenerCerts(['localhost', '127.0.0.1', '10.0.6.107'], dir);
  assert.equal(b.regenerated, false, 'reused while it covers the hosts');
  assert.equal(b.cert, a.cert);

  const c = await ensureListenerCerts(['localhost', '127.0.0.1', '10.0.6.200'], dir);
  assert.equal(c.regenerated, true, 'a new client address means a new certificate');
  assert.equal(await readFile(join(dir, 'teamclaude-ca.pem'), 'utf8'), mitm.caCertPem);
});

test('loadListenerCredentials reads operator files when given', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const chain = generateCertChain(['proxy.example']);
  await writeFile(join(dir, 'c.pem'), chain.leafCertPem);
  await writeFile(join(dir, 'k.pem'), chain.leafKeyPem);
  const creds = await loadListenerCredentials(resolveTlsConfig({ tls: { cert: join(dir, 'c.pem'), key: join(dir, 'k.pem') } }), dir);
  assert.equal(creds.source, 'files');
  assert.equal(creds.cert, chain.leafCertPem);
});

// ── end to end: the same handlers over TLS ───────────────────────────────────

async function withTlsProxy(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'tc-tls-'));
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  const config = { proxy: { apiKey: 'tc-secret' }, upstream: 'http://127.0.0.1:9' };
  const server = createProxyServer(am, config, {});
  const creds = await ensureListenerCerts(listenerHosts({ hosts: [] }), dir);
  const ca = await readFile(creds.caPath, 'utf8');
  const tlsSrv = createTlsListener(server, creds, () => {});
  const port = await new Promise(r => tlsSrv.listen(0, '127.0.0.1', () => r(tlsSrv.address().port)));
  try { await fn({ port, ca }); } finally { tlsSrv.close(); server.close(); await rm(dir, { recursive: true, force: true }); }
}

test('over TLS, the dashboard and the status gate behave exactly as on the plain port', async () => {
  await withTlsProxy(async ({ port, ca }) => {
    const get = (path) => new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, path, ca, servername: 'localhost' }, (res) => {
        let body = ''; res.on('data', d => { body += d; }); res.on('end', () => resolve({ status: res.statusCode, body }));
      }).on('error', reject);
    });
    const ui = await get('/ui');
    assert.equal(ui.status, 200);
    assert.match(ui.body, /TeamClaude/);
    const st = await get('/teamclaude/status');
    assert.equal(st.status, 200, 'loopback over TLS keeps the loopback exemption (peer address is real)');
  });
});

test('over TLS, a CONNECT reaches the proxy\'s connect handler (key travels encrypted)', async () => {
  await withTlsProxy(async ({ port, ca }) => {
    const reply = await new Promise((resolve, reject) => {
      const sock = tls.connect({ host: '127.0.0.1', port, ca, servername: 'localhost' }, () => {
        const auth = Buffer.from('tc-secret:x').toString('base64');
        sock.write(`CONNECT www.example.org:443 HTTP/1.1\r\nHost: www.example.org:443\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
      });
      let buf = '';
      sock.on('data', d => { buf += d; if (buf.includes('\r\n')) { sock.destroy(); resolve(buf.split('\r\n')[0]); } });
      sock.on('error', reject);
      setTimeout(() => { sock.destroy(); resolve(buf || 'no reply'); }, 4000);
    });
    assert.match(reply, /^HTTP\/1\.1 200/, reply);
  });
});

test('a client that does not trust the listener CA is refused at the handshake', async () => {
  await withTlsProxy(async ({ port }) => {
    const err = await new Promise((resolve) => {
      const sock = tls.connect({ host: '127.0.0.1', port, servername: 'localhost' }, () => { sock.destroy(); resolve(null); });
      sock.on('error', resolve);
    });
    assert.ok(err, 'handshake must fail without the CA');
  });
});

// ── review findings (Oracle, PR #14) ─────────────────────────────────────────

test('M1: a torn cert/key pair is treated as stale and regenerated, for the listener and the MITM chain', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await ensureListenerCerts(['localhost'], dir);
  const other = generateCertChain(['localhost']);
  assert.equal(keyMatchesCert(a.cert, a.key), true);
  assert.equal(keyMatchesCert(a.cert, other.leafKeyPem), false);
  // Simulate a crash between the renames: new key on disk, old cert.
  await writeFile(join(dir, 'teamclaude-listener.key'), other.leafKeyPem);
  const b = await ensureListenerCerts(['localhost'], dir);
  assert.equal(b.regenerated, true, 'a mismatched pair must not be reused');
  assert.equal(keyMatchesCert(b.cert, b.key), true);
  tls.createServer({ key: b.key, cert: b.cert }).close(); // would throw on a mismatch

  // MITM chain: same rule (ensureCerts writes under TEAMCLAUDE_CONFIG's dir).
  const home = dirname(/** @type {string} */ (process.env.TEAMCLAUDE_CONFIG));
  const m1 = await ensureCerts(['api.anthropic.com']);
  await writeFile(join(home, 'teamclaude-leaf.key'), other.leafKeyPem);
  const m2 = await ensureCerts(['api.anthropic.com']);
  assert.notEqual(m2.leafCertPem, m1.leafCertPem, 'regenerated');
  assert.equal(keyMatchesCert(m2.leafCertPem, m2.leafKeyPem), true);
});

test('M2: the CA bundle follows the MITM chain when it is minted after the listener started', async () => {
  const home = dirname(/** @type {string} */ (process.env.TEAMCLAUDE_CONFIG));
  for (const f of ['teamclaude-ca.pem', 'teamclaude-leaf.pem', 'teamclaude-leaf.key']) await rm(join(home, f), { force: true });
  const l = await ensureListenerCerts(['localhost'], home);
  let bundle = await readFile(l.bundlePath, 'utf8');
  assert.equal((bundle.match(/BEGIN CERTIFICATE/g) || []).length, 1, 'only the listener CA before any MITM chain exists');
  const m = await ensureCerts(['api.anthropic.com']); // lazily minted, as on a first intercepted CONNECT
  bundle = await readFile(l.bundlePath, 'utf8');
  assert.ok(bundle.includes(m.caCertPem.trim()), 'the MITM CA joined the bundle');
  assert.ok(bundle.includes((await readFile(l.caPath, 'utf8')).trim()), 'the listener CA is still there');
});

test('N1: concurrent bundle refreshes in one process never fail on a shared temp file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await ensureListenerCerts(['localhost'], dir);
  await writeFile(join(dir, 'teamclaude-ca.pem'), generateCertChain(['api.anthropic.com']).caCertPem);
  await rm(join(dir, CA_BUNDLE), { force: true });
  const results = await Promise.allSettled(Array.from({ length: 60 }, () => refreshCaBundle(dir)));
  assert.equal(results.filter(r => r.status === 'rejected').length, 0);
  assert.equal(((await readFile(join(dir, CA_BUNDLE), 'utf8')).match(/BEGIN CERTIFICATE/g) || []).length, 2);
});

// ── the CA-name collision (2026-10-02, found in the live deploy) ─────────────

test('a client trusting the BUNDLE (both CAs) completes the handshake — the listener CA has its own name', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A real MITM CA in the dir, as on any host that has intercepted once.
  await writeFile(join(dir, 'teamclaude-ca.pem'), generateCertChain(['api.anthropic.com']).caCertPem);
  const creds = await ensureListenerCerts(listenerHosts({ hosts: [] }), dir);
  assert.match(new X509Certificate(await readFile(creds.caPath, 'utf8')).subject, new RegExp(`CN=${LISTENER_CA_CN}`));
  const bundle = await readFile(join(dir, CA_BUNDLE), 'utf8');
  assert.equal((bundle.match(/BEGIN CERTIFICATE/g) || []).length, 2);
  const am = new AccountManager([{ name: 'a', type: 'apikey', apiKey: 'k1' }], 0.98);
  const server = createProxyServer(am, { proxy: { apiKey: 'tc' }, upstream: 'http://127.0.0.1:9' }, {});
  const srv = createTlsListener(server, creds, () => {});
  const port = await new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  try {
    for (const ca of [bundle, bundle.split(/(?=-----BEGIN CERTIFICATE-----)/).reverse().join('')]) {
      const ok = await new Promise((resolve) => {
        const sock = tls.connect({ host: '127.0.0.1', port, ca, servername: 'localhost' }, () => { sock.destroy(); resolve(true); });
        sock.on('error', (e) => resolve(e.code || e.message));
      });
      assert.equal(ok, true, 'handshake with the bundle, in either CA order');
    }
  } finally { srv.close(); server.close(); }
});

test('the MITM leaf also verifies through the bundle, in either CA order (the other half of a shared name)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mitm = generateCertChain(['api.anthropic.com']); // MITM chain, default CA name
  await writeFile(join(dir, 'teamclaude-ca.pem'), mitm.caCertPem);
  await ensureListenerCerts(['localhost'], dir);
  const bundle = await readFile(join(dir, CA_BUNDLE), 'utf8');
  const srv = tls.createServer({ key: mitm.leafKeyPem, cert: mitm.leafCertPem }, (s) => s.end());
  const port = await new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  try {
    for (const ca of [bundle, bundle.split(/(?=-----BEGIN CERTIFICATE-----)/).reverse().join('')]) {
      const ok = await new Promise((resolve) => {
        const sock = tls.connect({ host: '127.0.0.1', port, ca, servername: 'api.anthropic.com' }, () => { sock.destroy(); resolve(true); });
        sock.on('error', (e) => resolve(e.code || e.message));
      });
      assert.equal(ok, true, 'MITM handshake with the bundle, in either CA order');
    }
  } finally { srv.close(); }
});

test('a listener chain from before the rename (MITM CA name) is regenerated', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-tls-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = generateCertChain(['localhost', '127.0.0.1']); // default name, as shipped in #14
  await writeFile(join(dir, 'teamclaude-listener-ca.pem'), old.caCertPem);
  await writeFile(join(dir, 'teamclaude-listener.pem'), old.leafCertPem);
  await writeFile(join(dir, 'teamclaude-listener.key'), old.leafKeyPem);
  const c = await ensureListenerCerts(['localhost', '127.0.0.1'], dir);
  assert.equal(c.regenerated, true);
  assert.match(new X509Certificate(await readFile(c.caPath, 'utf8')).subject, new RegExp(`CN=${LISTENER_CA_CN}`));
});
