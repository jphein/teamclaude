import { test } from 'node:test';
import assert from 'node:assert/strict';
import { X509Certificate, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { generateCertChain, keyIdentifier, authorityKeyId, createCA, createLeaf } from '../src/x509.js';
import { ensureCerts } from '../src/mitm.js';
import { ensureListenerCerts, LISTENER_CA_CN } from '../src/tls-listener.js';

// Same-name CAs in one trust store shadowed each other: a client picks an
// issuer by NAME and took the first match ("certificate signature failure",
// familiar 2026-10-02). A Subject Key Identifier on every cert and an
// Authority Key Identifier on every leaf let clients match by KEY instead.

// Raw DER contains each extension's OID; 2.5.29.14 = 06 03 55 1d 0e, 2.5.29.35 = 06 03 55 1d 23.
const SKI_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x0e]);
const AKI_OID = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x23]);
const has = (pem, oid) => new X509Certificate(pem).raw.includes(oid);

test('every CA carries an SKI, every leaf an AKI equal to its CA\'s SKI', () => {
  const c = generateCertChain(['localhost', '10.0.6.145']);
  assert.ok(has(c.caCertPem, SKI_OID), 'CA SKI');
  assert.ok(has(c.leafCertPem, SKI_OID), 'leaf SKI');
  assert.ok(has(c.leafCertPem, AKI_OID), 'leaf AKI');
  const caKeyId = keyIdentifier(new X509Certificate(c.caCertPem).publicKey.export({ type: 'spki', format: 'der' }));
  assert.ok(new X509Certificate(c.leafCertPem).raw.includes(caKeyId), 'the leaf names its CA\'s key');
  assert.equal(new X509Certificate(c.leafCertPem).verify(new X509Certificate(c.caCertPem).publicKey), true);
});

// A real handshake is the instrument: Node's tls uses OpenSSL's chain builder,
// which is what picked the wrong same-name CA in the field.
async function handshake(leaf, ca, servername) {
  const srv = tls.createServer({ key: leaf.keyPem, cert: leaf.certPem }, (s) => s.end());
  const port = await new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  try {
    return await new Promise((resolve) => {
      const sock = tls.connect({ host: '127.0.0.1', port, ca, servername }, () => { sock.destroy(); resolve(true); });
      sock.on('error', (e) => resolve(e.code || e.message));
    });
  } finally { srv.close(); }
}

test('two CAs with the SAME name in one bundle: each leaf still verifies, in either order', async () => {
  const a = generateCertChain(['a.test'], { caCn: 'Same Name CA' });
  const b = generateCertChain(['b.test'], { caCn: 'Same Name CA' });
  for (const bundle of [a.caCertPem + b.caCertPem, b.caCertPem + a.caCertPem]) {
    assert.equal(await handshake({ keyPem: a.leafKeyPem, certPem: a.leafCertPem }, bundle, 'a.test'), true);
    assert.equal(await handshake({ keyPem: b.leafKeyPem, certPem: b.leafCertPem }, bundle, 'b.test'), true);
  }
});

test('listener CAs get a unique per-generation name; a pre-SKI chain is reissued', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-ski-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A chain exactly as #15 wrote it (fixed name, NO key identifiers), generated
  // by the pre-SKI x509.js and committed as a fixture.
  const fx = (f) => readFile(new URL(`./fixtures/pre-ski-listener/${f}`, import.meta.url), 'utf8');
  const oldCa = await fx('ca.pem');
  assert.ok(!has(oldCa, SKI_OID), 'fixture really predates key identifiers');
  await writeFile(join(dir, 'teamclaude-listener-ca.pem'), oldCa);
  await writeFile(join(dir, 'teamclaude-listener.pem'), await fx('leaf.pem'));
  await writeFile(join(dir, 'teamclaude-listener.key'), await fx('leaf.TEST-ONLY-key.pem'));
  const c = await ensureListenerCerts(['localhost'], dir);
  assert.equal(c.regenerated, true, 'the fixed-name chain is reissued');
  const subject = new X509Certificate(await readFile(c.caPath, 'utf8')).subject;
  assert.match(subject, new RegExp(`CN=${LISTENER_CA_CN} [0-9a-f]{12}`));
  assert.ok(has(c.cert, AKI_OID));
  // Two generations never share a name.
  const dir2 = await mkdtemp(join(tmpdir(), 'tc-ski-'));
  t.after(() => rm(dir2, { recursive: true, force: true }));
  const c2 = await ensureListenerCerts(['localhost'], dir2);
  assert.notEqual(new X509Certificate(await readFile(c2.caPath, 'utf8')).subject, subject);
  // And a current chain is reused, not reissued every start.
  assert.equal((await ensureListenerCerts(['localhost'], dir)).regenerated, false);
});

test('the MITM chain is NOT force-renewed by this change: an existing valid pair is reused', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'tc-ski-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const prev = process.env.TEAMCLAUDE_CONFIG;
  process.env.TEAMCLAUDE_CONFIG = join(home, 'teamclaude.json');
  t.after(() => { if (prev === undefined) delete process.env.TEAMCLAUDE_CONFIG; else process.env.TEAMCLAUDE_CONFIG = prev; });
  // A MITM chain with no key identifiers, as every running client trusts today.
  const legacy = generateCertChain(['api.anthropic.com', 'www.example.org']);
  await writeFile(join(home, 'teamclaude-ca.pem'), legacy.caCertPem);
  await writeFile(join(home, 'teamclaude-leaf.pem'), legacy.leafCertPem);
  await writeFile(join(home, 'teamclaude-leaf.key'), legacy.leafKeyPem);
  const m = await ensureCerts(['api.anthropic.com']);
  assert.equal(m.caCertPem, legacy.caCertPem, 'the MITM CA every running client trusts is left alone');
});

test('a chain with a unique name but NO key identifiers is still reissued', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-ski-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fx = (f) => readFile(new URL(`./fixtures/pre-ski-listener-named/${f}`, import.meta.url), 'utf8');
  await writeFile(join(dir, 'teamclaude-listener-ca.pem'), await fx('ca.pem'));
  await writeFile(join(dir, 'teamclaude-listener.pem'), await fx('leaf.pem'));
  await writeFile(join(dir, 'teamclaude-listener.key'), await fx('leaf.TEST-ONLY-key.pem'));
  assert.equal((await ensureListenerCerts(['localhost'], dir)).regenerated, true);
});

test('a chain WITH key identifiers but the old fixed name is still reissued (name rule, Oracle #19)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'tc-ski-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // Current generator (so the leaf HAS an AKI), but the pre-#19 fixed CA name.
  const c = generateCertChain(['localhost'], { caCn: LISTENER_CA_CN });
  assert.ok(has(c.leafCertPem, AKI_OID), 'precondition: the leaf carries an AKI');
  await writeFile(join(dir, 'teamclaude-listener-ca.pem'), c.caCertPem);
  await writeFile(join(dir, 'teamclaude-listener.pem'), c.leafCertPem);
  await writeFile(join(dir, 'teamclaude-listener.key'), c.leafKeyPem);
  assert.equal((await ensureListenerCerts(['localhost'], dir)).regenerated, true);
});

// ── cross-model review (gpt-6.1-sol) findings on #19 ─────────────────────────

test('M1: a leaf always carries an AKI, even from a CA object that has no keyId', () => {
  const ca = createCA('Legacy-shaped CA');
  delete ca.keyId; // the shape a pre-SKI caller would hand in
  const leaf = createLeaf(['a.test'], ca);
  const aki = authorityKeyId(new X509Certificate(leaf.certPem).raw);
  const caSki = keyIdentifier(/** @type {Buffer} */ (new X509Certificate(ca.certPem).publicKey.export({ type: 'spki', format: 'der' })));
  assert.ok(aki && aki.equals(caSki), 'AKI derived from the CA key');
});

test('M2: authorityKeyId parses the AKI structurally and returns exactly the issuer\'s key id', () => {
  const c = generateCertChain(['localhost']);
  assert.equal(authorityKeyId(new X509Certificate(c.caCertPem).raw), null, 'a self-signed CA has no AKI');
  const aki = authorityKeyId(new X509Certificate(c.leafCertPem).raw);
  const caSki = keyIdentifier(/** @type {Buffer} */ (new X509Certificate(c.caCertPem).publicKey.export({ type: 'spki', format: 'der' })));
  assert.ok(aki && aki.equals(caSki));
  // Garbage never throws, it just has no AKI.
  assert.equal(authorityKeyId(Buffer.from([0x30, 0x03, 0x02, 0x01, 0x00])), null);
  assert.equal(authorityKeyId(Buffer.alloc(0)), null);
});

test('a leaf signed by the right CA but carrying a WRONG AKI is reissued (AKI must equal the CA SKI)', async (t) => {
  // leafCovers checks only the signature, so this leaf passes it: the AKI==SKI
  // clause is what rejects it (Oracle re-verify of #19 refuted the claim that
  // the clause was unreachable). Reachable when teamclaude itself writes a
  // stale keyId, so it guards regressions rather than attacks.
  const dir = await mkdtemp(join(tmpdir(), 'tc-ski-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const ca = createCA(`${LISTENER_CA_CN} 0123456789ab`);
  ca.keyId = randomBytes(20);                 // wrong key id, right signing key
  const leaf = createLeaf(['localhost'], ca);
  await writeFile(join(dir, 'teamclaude-listener-ca.pem'), ca.certPem);
  await writeFile(join(dir, 'teamclaude-listener.pem'), leaf.certPem);
  await writeFile(join(dir, 'teamclaude-listener.key'), leaf.keyPem);
  assert.equal((await ensureListenerCerts(['localhost'], dir)).regenerated, true);
});
