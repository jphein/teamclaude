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
const reset = () => { for (const n of ['teamclaude-ca.pem', 'teamclaude-leaf.pem', 'teamclaude-leaf.key', 'teamclaude-ca.next.pem', 'teamclaude-leaf.next.pem', 'teamclaude-leaf.next.key', 'teamclaude-ca.prev.pem', 'teamclaude-leaf.prev.pem', 'teamclaude-leaf.prev.key', MITM_TRUST, CA_BUNDLE, LISTENER_CA]) rmSync(join(home, n), { force: true }); };

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

  v = await rotateMitm('commit', HOSTS);
  assert.equal(v.live.fingerprint256, newFp);
  assert.equal(v.prev.fingerprint256, oldFp);
  assert.equal(v.next, null);
  assert.deepEqual(new Set(certsIn(read(MITM_TRUST))), new Set([oldFp, newFp]), 'still both after the switch');
  assert.equal(fp(read('teamclaude-ca.pem')), newFp, 'the live CA file is one cert, the new one');

  v = await rotateMitm('rollback', HOSTS);
  assert.equal(v.live.fingerprint256, oldFp);
  assert.equal(v.next.fingerprint256, newFp, 'the rolled-back chain is staged again');
  assert.equal(v.prev, null);

  await rotateMitm('commit', HOSTS);
  v = await rotateMitm('finish', HOSTS);
  assert.equal(v.prev, null);
  assert.deepEqual(certsIn(read(MITM_TRUST)), [newFp], 'after finish clients need only the new CA');
  assert.deepEqual(new Set(certsIn(read(CA_BUNDLE))), new Set([newFp, listenerFp]));
  // The proxy's own start path accepts the committed chain as is.
  assert.equal(fp((await ensureCerts(HOSTS)).caCertPem), newFp);
});

test('commit, rollback and finish refuse when there is nothing safe to do', async () => {
  reset();
  await ensureCerts(HOSTS);
  await assert.rejects(rotateMitm('commit', HOSTS), /nothing to commit/);
  await assert.rejects(rotateMitm('rollback', HOSTS), /nothing to roll back/);
  await assert.rejects(rotateMitm('finish', HOSTS), /nothing to finish/);
  // A staged chain whose key is not its leaf's (a crash mid-write) is not committed.
  await rotateMitm('stage', HOSTS);
  writeFileSync(join(home, 'teamclaude-leaf.next.key'), generateCertChain(['y.test']).leafKeyPem);
  const before = fp(read('teamclaude-ca.pem'));
  await assert.rejects(rotateMitm('commit', HOSTS), /key that is not its leaf/);
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

/** An old-style chain like the 2026-06 one: no SKI on the CA, no AKI on the leaf (openssl CLI). */
function oldStyleChain() {
  const d = mkdtempSync(join(home, 'old-'));
  const run = (args) => spawnSync('openssl', args, { cwd: d, encoding: 'utf8' });
  const steps = [
    ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=TeamClaude Local CA', '-addext', 'subjectKeyIdentifier=none', '-addext', 'authorityKeyIdentifier=none', '-addext', 'basicConstraints=critical,CA:TRUE', '-keyout', 'ca.key', '-out', 'ca.pem'],
    ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=api.anthropic.com', '-keyout', 'leaf.key', '-out', 'leaf.csr'],
  ];
  for (const a of steps) if (run(a).status !== 0) return null;
  writeFileSync(join(d, 'ext.cnf'), 'subjectAltName=DNS:api.anthropic.com\nsubjectKeyIdentifier=none\nauthorityKeyIdentifier=none\n');
  if (run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '30', '-extfile', 'ext.cnf', '-out', 'leaf.pem']).status !== 0) return null;
  const r = (n) => readFileSync(join(d, n), 'utf8');
  return { caCertPem: r('ca.pem'), leafCertPem: r('leaf.pem'), leafKeyPem: r('leaf.key') };
}

test('Python strict X.509 verification rejects an old-style chain and accepts the new one', async (t) => {
  const py = spawnSync('python3', ['-c', 'import ssl,sys; sys.exit(0 if hasattr(ssl, "VERIFY_X509_STRICT") else 3)']);
  if (py.status !== 0) { t.skip('no python3 with ssl.VERIFY_X509_STRICT'); return; }
  const old = oldStyleChain();
  if (!old) { t.skip('no openssl to build the old-style control'); return; }
  assert.equal(has(old.caCertPem, SKI_OID) || has(old.leafCertPem, AKI_OID), false, 'the control really lacks key identifiers');
  const control = await pythonStrict(old.leafCertPem, old.leafKeyPem, old.caCertPem);
  assert.notEqual(control.code, 0, 'positive control: strict mode rejects the old-style chain');
  assert.match(control.err, /CERTIFICATE_VERIFY_FAILED/);
  reset();
  const c = await ensureCerts(HOSTS);
  const r = await pythonStrict(c.leafCertPem, c.leafKeyPem, c.caCertPem);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /ok/);
});
