// Optional TLS listener (config.proxy.tls).
//
// The plain listener (proxy.port, default 3456) is unchanged: every client on
// the proxy host keeps using http://127.0.0.1. This adds a SECOND port that
// terminates TLS and hands each decrypted socket to the same http.Server, so
// the key gate, CONNECT/MITM, WebSocket upgrades and the dashboards all apply
// unchanged — and an off-box client's proxy key (Proxy-Authorization on every
// CONNECT) no longer crosses the LAN in cleartext.
//
// Client side: Claude Code accepts HTTPS_PROXY=https://<key>@host:<tls port>
// and trusts the listener's CA through NODE_EXTRA_CA_CERTS (verified against
// 2.1.288, 2026-10-02: TLS handshake, then CONNECT with Proxy-Authorization
// inside it).
//
// Certificates: either operator-supplied files (tls.cert + tls.key), or an
// automatic chain of its OWN — a separate CA and leaf, never the MITM chain.
// Regenerating the MITM chain mints a new CA, and every client already running
// with the old one in memory would fail its MITM handshakes; the listener must
// never cause that. Clients trust both CAs through one bundle file
// (teamclaude-ca-bundle.pem), rewritten by either chain's regeneration path
// (refreshCaBundle in mitm.js).

import tls from 'node:tls';
import { randomBytes, X509Certificate } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getConfigPath } from './config.js';
import { generateCertChain } from './x509.js';
import { leafCovers, keyMatchesCert, refreshCaBundle, CA_BUNDLE, LISTENER_CA } from './mitm.js';

export const DEFAULT_TLS_PORT = 3443;
// Must differ from the MITM CA's name ("TeamClaude Local CA"). The certs carry
// no key identifiers, so a client trusting the bundle picks a CA by issuer
// name; two CAs with one name made every listener handshake fail with
// "certificate signature failure" — the first match was the MITM CA
// (measured on familiar, 2026-10-02, OpenSSL and Claude Code alike).
export const LISTENER_CA_CN = 'TeamClaude Listener CA';
const LISTENER_CERT = 'teamclaude-listener.pem';
const LISTENER_KEY = 'teamclaude-listener.key';
export { CA_BUNDLE };

const certDir = () => dirname(getConfigPath());

/**
 * Normalise config.proxy.tls. Returns null when TLS is off (absent, false, or
 * enabled: false). Throws on a malformed value: a typo must fail the start,
 * not silently leave the key on the wire in cleartext.
 * @param {any} proxy
 * @returns {{ port: number, host: string | null, cert: string | null, key: string | null, hosts: string[] } | null}
 */
export function resolveTlsConfig(proxy) {
  const t = proxy?.tls;
  if (t == null || t === false) return null;
  if (t === true) return { port: DEFAULT_TLS_PORT, host: null, cert: null, key: null, hosts: [] };
  if (typeof t !== 'object' || Array.isArray(t)) throw new Error('proxy.tls must be true, false or an object');
  if (t.enabled === false) return null;
  const port = t.port == null ? DEFAULT_TLS_PORT : Number(t.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`proxy.tls.port must be 1-65535 (got ${JSON.stringify(t.port)})`);
  if (proxy?.port != null && Number(proxy.port) === port) throw new Error('proxy.tls.port must differ from proxy.port');
  if ((t.cert == null) !== (t.key == null)) throw new Error('proxy.tls needs both cert and key, or neither (automatic certificate)');
  for (const f of ['cert', 'key', 'host']) {
    if (t[f] != null && (typeof t[f] !== 'string' || !t[f].trim())) throw new Error(`proxy.tls.${f} must be a non-empty string`);
  }
  const hosts = t.hosts == null ? [] : t.hosts;
  if (!Array.isArray(hosts) || hosts.some((h) => typeof h !== 'string' || !h.trim())) throw new Error('proxy.tls.hosts must be an array of names or IP addresses');
  return { port, host: t.host || null, cert: t.cert || null, key: t.key || null, hosts: [...new Set(hosts.map((h) => h.trim()))] };
}

/** Names the automatic listener certificate covers: what clients dial.
 * @param {{ hosts?: string[] } | null} tlsCfg @returns {string[]} */
export function listenerHosts(tlsCfg) {
  return [...new Set(['localhost', '127.0.0.1', ...(tlsCfg?.hosts || [])])];
}

/** @param {string} p @returns {Promise<string | null>} */
async function readIf(p) {
  try { return await readFile(p, 'utf8'); } catch { return null; }
}

/** @param {string} path @param {string} data @param {number} mode */
async function atomicWrite(path, data, mode) {
  // pid alone collides when two writes of one file overlap in this process
  // (two bundle refreshes); the random part keeps each rename its own.
  const tmp = `${path}.tmp${process.pid}.${randomBytes(4).toString('hex')}`;
  await writeFile(tmp, data, { mode });
  await rename(tmp, path);
}

/** Rewrite the trust bundle (MITM CA + listener CA); see refreshCaBundle.
 * @param {string} dir */
export async function writeCaBundle(dir) {
  return /** @type {Promise<string>} */ (refreshCaBundle(dir));
}

/** Was this CA issued under the listener's own name? A chain from before the
 * rename shares the MITM CA's name and is regenerated.
 * @param {string} caPem */
function hasListenerCaName(caPem) {
  try { return new X509Certificate(caPem).subject.includes(`CN=${LISTENER_CA_CN}`); } catch { return false; }
}

/**
 * The listener's own chain, reused while it is valid for `hosts` and has life
 * left (same rule as the MITM leaf), regenerated otherwise.
 * @param {string[]} hosts @param {string} [dir]
 */
export async function ensureListenerCerts(hosts, dir = certDir()) {
  const [caPem, certPem, keyPem] = await Promise.all([
    readIf(join(dir, LISTENER_CA)), readIf(join(dir, LISTENER_CERT)), readIf(join(dir, LISTENER_KEY)),
  ]);
  let regenerated = false;
  /** @type {{ caPem: string | null, certPem: string | null, keyPem: string | null }} */
  let chain = { caPem, certPem, keyPem };
  if (!(caPem && certPem && keyPem && leafCovers(caPem, certPem, hosts) && keyMatchesCert(certPem, keyPem) && hasListenerCaName(caPem))) {
    const g = generateCertChain(hosts, { caCn: LISTENER_CA_CN }); // CA key discarded, as for the MITM chain
    await mkdir(dir, { recursive: true });
    // Key first (see keyMatchesCert): a torn write regenerates next start.
    await atomicWrite(join(dir, LISTENER_KEY), String(g.leafKeyPem), 0o600);
    await atomicWrite(join(dir, LISTENER_CERT), String(g.leafCertPem), 0o644);
    await atomicWrite(join(dir, LISTENER_CA), String(g.caCertPem), 0o644);
    chain = { caPem: String(g.caCertPem), certPem: String(g.leafCertPem), keyPem: String(g.leafKeyPem) };
    regenerated = true;
  }
  const bundlePath = await writeCaBundle(dir);
  return { cert: /** @type {string} */ (chain.certPem), key: /** @type {string} */ (chain.keyPem), caPath: join(dir, LISTENER_CA), bundlePath, regenerated };
}

/**
 * Key and certificate for the listener: the operator's files, or the
 * automatic chain.
 * @param {NonNullable<ReturnType<typeof resolveTlsConfig>>} tlsCfg @param {string} [dir]
 */
export async function loadListenerCredentials(tlsCfg, dir = certDir()) {
  if (tlsCfg.cert && tlsCfg.key) {
    const [cert, key] = await Promise.all([readFile(tlsCfg.cert, 'utf8'), readFile(tlsCfg.key, 'utf8')]);
    return { cert, key, source: 'files', caPath: null, bundlePath: null, regenerated: false };
  }
  const c = await ensureListenerCerts(listenerHosts(tlsCfg), dir);
  return { ...c, source: 'auto' };
}

/**
 * A TLS server whose decrypted sockets are served by `httpServer`.
 * @param {import('node:http').Server} httpServer
 * @param {{ cert: string, key: string }} creds
 * @param {(msg: string) => void} [log]
 */
export function createTlsListener(httpServer, creds, log = console.error) {
  const srv = tls.createServer({ key: creds.key, cert: creds.cert, ALPNProtocols: ['http/1.1'] }, (socket) => {
    httpServer.emit('connection', socket);
  });
  // A client that does not trust the CA, or speaks plain HTTP to the TLS
  // port, fails here; say so once a minute per address, not once per retry.
  const lastLog = new Map();
  srv.on('tlsClientError', (err, socket) => {
    const who = socket?.remoteAddress || '?';
    const now = Date.now();
    if (now - (lastLog.get(who) || 0) < 60_000) return;
    if (lastLog.size > 1000) lastLog.clear(); // bounded: one entry per noisy address
    lastLog.set(who, now);
    log(`[TeamClaude] TLS listener: handshake from ${who} failed: ${/** @type {any} */ (err)?.code || err?.message}`);
  });
  return srv;
}
