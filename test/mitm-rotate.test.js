import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import tls from 'node:tls';

// MITM CA rotation (2026-10-27): Python >= 3.13 verifies in strict X.509 mode
// and rejected the 2026-06 chain, which has no key identifiers. The rotation
// mints a new chain beside the live one, lets every client trust both, and
// switches only when told to.

const home = mkdtempSync(join(tmpdir(), 'tc-rotate-home-'));
process.env.TEAMCLAUDE_CONFIG = join(home, 'teamclaude.json');
after(() => rmSync(dirname(/** @type {string} */ (process.env.TEAMCLAUDE_CONFIG)), { recursive: true, force: true }));

const { ensureCerts, rotateMitm, MITM_CA_CN, MITM_TRUST, CA_BUNDLE, LISTENER_CA } = await import('../src/mitm.js');
const { generateCertChain } = await import('../src/x509.js');

const HOSTS = ['api.anthropic.com'];
const SKI_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0e]);
const AKI_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x23]);
const has = (pem, oid) => new X509Certificate(pem).raw.includes(oid);
const read = (n) => (existsSync(join(home, n)) ? readFileSync(join(home, n), 'utf8') : null);
const fp = (pem) => new X509Certificate(pem).fingerprint256;
const certsIn = (pem) => (pem || '').match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)?.map(fp) || [];
const reset = () => { for (const n of ['teamclaude-ca.pem', 'teamclaude-leaf.pem', 'teamclaude-leaf.key', 'teamclaude-ca.next.pem', 'teamclaude-leaf.next.pem', 'teamclaude-leaf.next.key', 'teamclaude-ca.prev.pem', 'teamclaude-leaf.prev.pem', 'teamclaude-leaf.prev.key', MITM_TRUST, CA_BUNDLE, LISTENER_CA, 'teamclaude-rotation.json', 'teamclaude-certs.lock']) rmSync(join(home, n), { force: true }); };

test('a new MITM chain has a per-generation CA name and key identifiers', async () => {
  reset();
  const c = await ensureCerts(HOSTS);
  assert.match(new X509Certificate(c.caCertPem).subject, new RegExp(`CN=${MITM_CA_CN} [0-9a-f]{12}$`));
  assert.ok(has(c.caCertPem, SKI_OID), 'CA SKI');
  assert.ok(has(c.leafCertPem, AKI_OID), 'leaf AKI');
  const again = (await rotateMitm('stage', HOSTS)).next.cn;
  assert.notEqual(again, (await rotateMitm('status', HOSTS)).live.cn, 'each generation is named apart');
});

test('stage → commit → rollback → commit → finish, with every CA in play trusted at each step', async () => {
  reset();
  const old = await ensureCerts(HOSTS);
  writeFileSync(join(home, LISTENER_CA), generateCertChain(['x.test']).caCertPem);
  const oldFp = fp(old.caCertPem);
  const listenerFp = fp(read(LISTENER_CA));

  let v = await rotateMitm('stage', HOSTS);
  const newFp = v.next.fingerprint256;
  assert.equal(v.live.fingerprint256, oldFp, 'staging leaves the live chain alone');
  assert.deepEqual(new Set(certsIn(read(MITM_TRUST))), new Set([oldFp, newFp]));
  assert.deepEqual(new Set(certsIn(read(CA_BUNDLE))), new Set([oldFp, newFp, listenerFp]));
  assert.equal((await rotateMitm('stage', HOSTS)).next.fingerprint256, newFp, 'staging twice keeps the first staged chain');

  v = await rotateMitm('commit', HOSTS, { proxyRunning: false });
  assert.equal(v.live.fingerprint256, newFp);
  assert.equal(v.prev.fingerprint256, oldFp);
  assert.equal(v.next, null);
  assert.deepEqual(new Set(certsIn(read(MITM_TRUST))), new Set([oldFp, newFp]), 'still both after the switch');
  assert.equal(fp(read('teamclaude-ca.pem')), newFp, 'the live CA file is one cert, the new one');

  v = await rotateMitm('rollback', HOSTS, { proxyRunning: false });
  assert.equal(v.live.fingerprint256, oldFp);
  assert.equal(v.next.fingerprint256, newFp, 'the rolled-back chain is staged again');
  assert.equal(v.prev, null);

  await rotateMitm('commit', HOSTS, { proxyRunning: false });
  v = await rotateMitm('finish', HOSTS, { proxyRunning: false });
  assert.equal(v.prev, null);
  assert.deepEqual(certsIn(read(MITM_TRUST)), [newFp], 'after finish clients need only the new CA');
  assert.deepEqual(new Set(certsIn(read(CA_BUNDLE))), new Set([newFp, listenerFp]));
  // The proxy's own start path accepts the committed chain as is.
  assert.equal(fp((await ensureCerts(HOSTS)).caCertPem), newFp);
});

test('commit, rollback and finish refuse when there is nothing safe to do', async () => {
  reset();
  await ensureCerts(HOSTS);
  await assert.rejects(rotateMitm('commit', HOSTS, { proxyRunning: false }), /nothing to commit/);
  await assert.rejects(rotateMitm('rollback', HOSTS, { proxyRunning: false }), /nothing to roll back/);
  // A finish with nothing left still repairs a stale trust file.
  writeFileSync(join(home, MITM_TRUST), read(MITM_TRUST) + generateCertChain(['stale.test']).caCertPem);
  assert.equal(certsIn(read(MITM_TRUST)).length, 2);
  assert.match((await rotateMitm('finish', HOSTS, { proxyRunning: false })).note, /nothing to finish/);
  assert.deepEqual(certsIn(read(MITM_TRUST)), [fp(read('teamclaude-ca.pem'))], 'the stale entry is gone');
  // A staged chain whose key is not its leaf's (a crash mid-write) is not committed.
  await rotateMitm('stage', HOSTS);
  writeFileSync(join(home, 'teamclaude-leaf.next.key'), generateCertChain(['y.test']).leafKeyPem);
  const before = fp(read('teamclaude-ca.pem'));
  await assert.rejects(rotateMitm('commit', HOSTS, { proxyRunning: false }), /key that is not its leaf/);
  assert.equal(fp(read('teamclaude-ca.pem')), before, 'the live chain is untouched');
});

/** A TLS handshake to a server presenting `leaf`, trusting `ca`: true, or the error code. */
async function handshake(leafCertPem, leafKeyPem, ca) {
  const srv = tls.createServer({ key: leafKeyPem, cert: leafCertPem }, (s) => s.end());
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  try {
    return await new Promise((resolve) => {
      const sock = tls.connect({ host: '127.0.0.1', port, ca, servername: 'api.anthropic.com' }, () => { sock.destroy(); resolve(true); });
      sock.on('error', (e) => resolve(e.code || e.message));
    });
  } finally { srv.close(); }
}

test('dual trust: a client holding the trust file completes handshakes with the old and the new leaf', async () => {
  reset();
  const old = await ensureCerts(HOSTS);
  await rotateMitm('stage', HOSTS);
  const trust = read(MITM_TRUST);
  const next = { cert: read('teamclaude-leaf.next.pem'), key: read('teamclaude-leaf.next.key') };
  assert.equal(await handshake(next.cert, next.key, old.caCertPem) === true, false, 'positive control: the old CA alone does not trust the new leaf');
  assert.equal(await handshake(old.leafCertPem, old.leafKeyPem, trust), true, 'old leaf');
  assert.equal(await handshake(next.cert, next.key, trust), true, 'new leaf');
});

/** Python's strict handshake against a server presenting `leaf`: { code, out, err }. */
async function pythonStrict(leafCertPem, leafKeyPem, caPem) {
  const srv = tls.createServer({ key: leafKeyPem, cert: leafCertPem }, (s) => s.end());
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  const caFile = join(home, 'strict-ca.pem');
  writeFileSync(caFile, caPem);
  const script = [
    'import socket, ssl, sys',
    'ctx = ssl.create_default_context(cafile=sys.argv[1])',
    'ctx.verify_flags |= ssl.VERIFY_X509_STRICT',
    'with socket.create_connection(("127.0.0.1", int(sys.argv[2]))) as s:',
    '    with ctx.wrap_socket(s, server_hostname="api.anthropic.com"):',
    '        print("ok")',
  ].join('\n');
  try {
    return await new Promise((resolve) => {
      const p = spawn('python3', ['-c', script, caFile, String(port)]);
      let out = ''; let err = '';
      p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => resolve({ code, out, err }));
    });
  } finally { srv.close(); }
}

/**
 * An old-style chain like the 2026-06 one — strict-valid in every other way
 * (CA basicConstraints + keyUsage, leaf SAN) — with or without key identifiers,
 * built with the openssl CLI. null when openssl is absent; a construction
 * failure throws, so it cannot pass as a skip.
 */
function opensslChain({ keyIds }) {
  if (spawnSync('openssl', ['version']).status !== 0) return null;
  const d = mkdtempSync(join(home, 'ossl-'));
  const run = (args) => {
    const r = spawnSync('openssl', args, { cwd: d, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr}`);
  };
  const ski = keyIds ? 'hash' : 'none';
  const aki = keyIds ? 'keyid:always' : 'none';
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=Strict Control CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-addext', `subjectKeyIdentifier=${ski}`, '-addext', 'authorityKeyIdentifier=none', '-keyout', 'ca.key', '-out', 'ca.pem']);
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=api.anthropic.com', '-keyout', 'leaf.key', '-out', 'leaf.csr']);
  writeFileSync(join(d, 'ext.cnf'), `subjectAltName=DNS:api.anthropic.com\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=${ski}\nauthorityKeyIdentifier=${aki}\n`);
  run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '30', '-extfile', 'ext.cnf', '-out', 'leaf.pem']);
  const r = (n) => readFileSync(join(d, n), 'utf8');
  return { caCertPem: r('ca.pem'), leafCertPem: r('leaf.pem'), leafKeyPem: r('leaf.key') };
}

test('Python strict X.509 verification rejects an old-style chain and accepts the new one', async (t) => {
  const py = spawnSync('python3', ['-c', 'import ssl,sys; sys.exit(0 if hasattr(ssl, "VERIFY_X509_STRICT") else 3)']);
  if (py.status !== 0) { t.skip('no python3 with ssl.VERIFY_X509_STRICT'); return; }
  const old = opensslChain({ keyIds: false });
  if (!old) { t.skip('no openssl to build the controls'); return; }
  assert.equal(has(old.caCertPem, SKI_OID) || has(old.leafCertPem, AKI_OID), false, 'the control really lacks key identifiers');
  const control = await pythonStrict(old.leafCertPem, old.leafKeyPem, old.caCertPem);
  assert.notEqual(control.code, 0, 'positive control: strict mode rejects the chain without key identifiers');
  assert.match(control.err, /Key Identifier/i, 'rejected for the missing identifier, not something else');
  // The same construction with identifiers passes: they were the only difference.
  const fixed = opensslChain({ keyIds: true });
  const fixedRun = await pythonStrict(fixed.leafCertPem, fixed.leafKeyPem, fixed.caCertPem);
  assert.equal(fixedRun.code, 0, fixedRun.err);
  reset();
  const c = await ensureCerts(HOSTS);
  const r = await pythonStrict(c.leafCertPem, c.leafKeyPem, c.caCertPem);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ok/);
});

test('a crash part-way through commit or rollback is safe to retry: the recovery copy survives', async () => {
  reset();
  const old = await ensureCerts(HOSTS);
  await rotateMitm('stage', HOSTS);
  const staged = { ca: read('teamclaude-ca.next.pem'), leaf: read('teamclaude-leaf.next.pem'), key: read('teamclaude-leaf.next.key') };
  // Commit crashed after saving .prev and writing the live key only: live is a mismatched set.
  writeFileSync(join(home, 'teamclaude-ca.prev.pem'), old.caCertPem);
  writeFileSync(join(home, 'teamclaude-leaf.prev.pem'), old.leafCertPem);
  writeFileSync(join(home, 'teamclaude-leaf.prev.key'), old.leafKeyPem);
  writeFileSync(join(home, 'teamclaude-leaf.key'), staged.key);
  let v = await rotateMitm('commit', HOSTS, { proxyRunning: false });
  assert.equal(v.prev.fingerprint256, fp(old.caCertPem), 'the retry kept the real previous chain');
  assert.equal(v.live.fingerprint256, fp(staged.ca));
  // Commit crashed after live was fully written, before .next was cleared.
  writeFileSync(join(home, 'teamclaude-ca.next.pem'), staged.ca);
  writeFileSync(join(home, 'teamclaude-leaf.next.pem'), staged.leaf);
  writeFileSync(join(home, 'teamclaude-leaf.next.key'), staged.key);
  v = await rotateMitm('commit', HOSTS, { proxyRunning: false });
  assert.equal(v.prev.fingerprint256, fp(old.caCertPem), 'not overwritten by the (already live) new chain');
  assert.equal(v.next, null);
  // Rollback crashed after restaging, with live half-written back to the old chain.
  writeFileSync(join(home, 'teamclaude-ca.next.pem'), staged.ca);
  writeFileSync(join(home, 'teamclaude-leaf.next.pem'), staged.leaf);
  writeFileSync(join(home, 'teamclaude-leaf.next.key'), staged.key);
  writeFileSync(join(home, 'teamclaude-leaf.key'), old.leafKeyPem);
  v = await rotateMitm('rollback', HOSTS, { proxyRunning: false });
  assert.equal(v.live.fingerprint256, fp(old.caCertPem));
  assert.equal(v.next.fingerprint256, fp(staged.ca), 'the new chain stays staged, not overwritten by the broken live set');
  // …and it is the whole good chain (the broken set shared its CA, not its key): it commits again.
  assert.equal((await rotateMitm('commit', HOSTS, { proxyRunning: false })).live.fingerprint256, fp(staged.ca));
});

test('commit, rollback and finish run only with the proxy stopped; finish needs a good live chain and nothing staged', async () => {
  reset();
  await ensureCerts(HOSTS);
  await rotateMitm('stage', HOSTS);
  for (const step of ['commit', 'rollback', 'finish']) {
    await assert.rejects(rotateMitm(step, HOSTS, { proxyRunning: true }), /stop the proxy first/, step);
    await assert.rejects(rotateMitm(step, HOSTS, { proxyRunning: null }), /cannot tell whether the proxy is running/, step);
  }
  assert.ok((await rotateMitm('stage', HOSTS, { proxyRunning: true })).next, 'staging runs with the proxy up');
  await rotateMitm('commit', HOSTS, { proxyRunning: false });
  // A broken live chain: finish would delete the only good one.
  const key = read('teamclaude-leaf.key');
  writeFileSync(join(home, 'teamclaude-leaf.key'), generateCertChain(['z.test']).leafKeyPem);
  await assert.rejects(rotateMitm('finish', HOSTS, { proxyRunning: false }), /--rollback, not --finish/);
  writeFileSync(join(home, 'teamclaude-leaf.key'), key);
  await rotateMitm('stage', HOSTS);
  await assert.rejects(rotateMitm('finish', HOSTS, { proxyRunning: false }), /still staged/);
  await assert.rejects(rotateMitm('commit', HOSTS, { proxyRunning: false }), /previous rotation is not finished/);
  rmSync(join(home, 'teamclaude-ca.next.pem')); rmSync(join(home, 'teamclaude-leaf.next.pem')); rmSync(join(home, 'teamclaude-leaf.next.key'));
  const liveFp = fp(read('teamclaude-ca.pem'));
  assert.equal((await rotateMitm('finish', HOSTS, { proxyRunning: false })).prev, null);
  assert.deepEqual(certsIn(read(MITM_TRUST)), [liveFp]);
});

test('an interrupted finish resumes: the retired CA is never left advertised', async () => {
  reset();
  const old = await ensureCerts(HOSTS);
  await rotateMitm('stage', HOSTS);
  await rotateMitm('commit', HOSTS, { proxyRunning: false });
  // Finish died after removing the previous CA, before the trust refresh and the leaf/key.
  rmSync(join(home, 'teamclaude-ca.prev.pem'));
  assert.ok(certsIn(read(MITM_TRUST)).includes(fp(old.caCertPem)), 'the stale trust file still lists it');
  const v = await rotateMitm('finish', HOSTS, { proxyRunning: false });
  assert.equal(v.prev, null);
  assert.ok(!certsIn(read(MITM_TRUST)).includes(fp(old.caCertPem)), 'the retry refreshed the trust files');
  assert.equal(existsSync(join(home, 'teamclaude-leaf.prev.key')), false, 'and removed what was left');
});

test('one step at a time; a leftover lock is reported, never taken over, and never stops the proxy starting', async () => {
  reset();
  await ensureCerts(HOSTS);
  const lock = join(home, 'teamclaude-certs.lock');
  writeFileSync(lock, '999999:dead');
  await assert.rejects(rotateMitm('stage', HOSTS), /delete that file and retry/);
  assert.equal(read('teamclaude-certs.lock'), '999999:dead', 'not taken over');
  assert.ok((await ensureCerts(HOSTS)).leafCertPem, 'the proxy still loads its chain with the lock present');
  rmSync(lock);
  assert.ok((await rotateMitm('stage', HOSTS)).next);
  assert.equal(existsSync(lock), false, 'released after the step');
  // Mid-rotation with a broken live chain, start-up refuses rather than mint a CA no client trusts.
  writeFileSync(join(home, 'teamclaude-leaf.key'), generateCertChain(['q.test']).leafKeyPem);
  const liveCa = read('teamclaude-ca.pem');
  await assert.rejects(ensureCerts(HOSTS), /rotation is in progress/);
  assert.equal(read('teamclaude-ca.pem'), liveCa, 'nothing was overwritten');
  // Only the journal left (no .next/.prev files): still mid-rotation, still no mint.
  for (const n of ['teamclaude-ca.next.pem', 'teamclaude-leaf.next.pem', 'teamclaude-leaf.next.key']) rmSync(join(home, n), { force: true });
  writeFileSync(join(home, 'teamclaude-rotation.json'), JSON.stringify({ op: 'commit', from: null, to: 'x' }));
  await assert.rejects(ensureCerts(HOSTS), /rotation is in progress/);
  assert.equal(read('teamclaude-ca.pem'), liveCa);
});

test('the journal: a commit that died at any point resumes to the same end state; incomplete staging is not mistaken for it', async () => {
  const STOP = { proxyRunning: false };
  const journal = join(home, 'teamclaude-rotation.json');
  const scenario = async (crash) => {
    reset();
    const a = await ensureCerts(HOSTS);
    await rotateMitm('stage', HOSTS);
    const b = { ca: read('teamclaude-ca.next.pem'), leaf: read('teamclaude-leaf.next.pem'), key: read('teamclaude-leaf.next.key') };
    // Replay a commit by hand up to the crash point, then let --commit resume.
    writeFileSync(journal, JSON.stringify({ op: 'commit', from: fp(a.caCertPem), to: fp(b.ca) }));
    if (crash >= 1) { writeFileSync(join(home, 'teamclaude-leaf.prev.key'), a.leafKeyPem); writeFileSync(join(home, 'teamclaude-leaf.prev.pem'), a.leafCertPem); writeFileSync(join(home, 'teamclaude-ca.prev.pem'), a.caCertPem); }
    if (crash >= 2) writeFileSync(join(home, 'teamclaude-leaf.key'), b.key); // live half-written
    if (crash >= 3) { writeFileSync(join(home, 'teamclaude-leaf.pem'), b.leaf); writeFileSync(join(home, 'teamclaude-ca.pem'), b.ca); }
    if (crash >= 4) rmSync(join(home, 'teamclaude-ca.next.pem')); // clean-up half done
    // Nothing else may run while it is unfinished.
    await assert.rejects(rotateMitm('stage', HOSTS), /interrupted --commit/);
    await assert.rejects(rotateMitm('finish', HOSTS, STOP), /interrupted --commit/);
    const v = await rotateMitm('commit', HOSTS, STOP);
    assert.equal(v.live.fingerprint256, fp(b.ca), `crash ${crash}: new chain live`);
    assert.equal(v.prev.fingerprint256, fp(a.caCertPem), `crash ${crash}: old chain saved`);
    assert.equal(v.next, null, `crash ${crash}: nothing staged`);
    assert.equal(existsSync(journal), false, `crash ${crash}: journal gone`);
    for (const n of ['teamclaude-ca.next.pem', 'teamclaude-leaf.next.pem', 'teamclaude-leaf.next.key']) assert.equal(existsSync(join(home, n)), false, `crash ${crash}: ${n} cleared`);
  };
  for (const crash of [0, 1, 2, 3, 4]) await scenario(crash);
  // Staging that died before writing its CA leaves a partial .next with no
  // journal: commit refuses (no cut-over happened), and --stage redoes it.
  reset();
  const live = await ensureCerts(HOSTS);
  writeFileSync(join(home, 'teamclaude-leaf.next.key'), generateCertChain(['p.test']).leafKeyPem);
  await assert.rejects(rotateMitm('commit', HOSTS, STOP), /nothing to commit/);
  assert.equal(fp(read('teamclaude-ca.pem')), fp(live.caCertPem), 'nothing changed');
  assert.ok((await rotateMitm('stage', HOSTS)).next, 'staging again replaces the partial set');
});

test('a rollback that died part-way resumes too', async () => {
  const STOP = { proxyRunning: false };
  reset();
  const a = await ensureCerts(HOSTS);
  await rotateMitm('stage', HOSTS);
  await rotateMitm('commit', HOSTS, STOP);
  const b = read('teamclaude-ca.pem');
  // Rollback saved the new chain to .next and died after the live key.
  writeFileSync(join(home, 'teamclaude-rotation.json'), JSON.stringify({ op: 'rollback', from: fp(b), to: fp(a.caCertPem) }));
  writeFileSync(join(home, 'teamclaude-leaf.next.key'), read('teamclaude-leaf.key'));
  writeFileSync(join(home, 'teamclaude-leaf.next.pem'), read('teamclaude-leaf.pem'));
  writeFileSync(join(home, 'teamclaude-ca.next.pem'), b);
  writeFileSync(join(home, 'teamclaude-leaf.key'), a.leafKeyPem);
  const v = await rotateMitm('rollback', HOSTS, STOP);
  assert.equal(v.live.fingerprint256, fp(a.caCertPem));
  assert.equal(v.next.fingerprint256, fp(b), 'the new chain is staged again');
  assert.equal(v.prev, null);
});

test('/teamclaude/status reports the MITM CA the process actually serves', async () => {
  reset();
  const { AccountManager } = await import('../src/account-manager.js');
  const { createProxyServer } = await import('../src/server.js');
  const net = await import('node:net');
  const live = await ensureCerts(HOSTS);
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.98);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: 'https://api.anthropic.com' });
  const port = await new Promise((r) => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
  const status = () => fetch(`http://127.0.0.1:${port}/teamclaude/status`, { headers: { 'x-api-key': 'k' } }).then((r) => r.json());
  try {
    assert.equal((await status()).mitm.servedCa, null, 'nothing served yet');
    await new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => s.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nProxy-Authorization: Bearer k\r\n\r\n'));
      s.once('data', () => { s.destroy(); resolve(); }); s.on('error', reject);
    });
    let st = await status();
    for (let i = 0; i < 20 && !st.mitm.servedCa; i++) { await new Promise((r) => setTimeout(r, 50)); st = await status(); }
    assert.equal(st.mitm.servedCa?.fingerprint256, fp(live.caCertPem));
  } finally { proxy.close(); }
});

test('the stopped-probe: listening on either port is running; refused on all is stopped; a wildcard bind probes this host', async () => {
  const { probeProxyListening } = await import('../src/mitm.js');
  const net = await import('node:net');
  const a = net.createServer(); const b = net.createServer();
  const pa = await new Promise((r) => a.listen(0, '127.0.0.1', () => r(a.address().port)));
  const pb = await new Promise((r) => b.listen(0, '127.0.0.1', () => r(b.address().port)));
  await new Promise((r) => b.close(r)); // pb now refuses
  try {
    assert.equal(await probeProxyListening({ bind: '127.0.0.1', ports: [pb, pa] }), true, 'the second (TLS) port alone counts');
    assert.equal(await probeProxyListening({ bind: '0.0.0.0', ports: [pa] }), true, 'wildcard bind → this host');
    assert.equal(await probeProxyListening({ bind: '127.0.0.1', ports: [pb] }), false, 'refused everywhere → stopped');
    assert.equal(await probeProxyListening({ bind: '127.0.0.1', ports: [] }), null, 'nothing probed is not "stopped"');
  } finally { a.close(); }
});
