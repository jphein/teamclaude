// Minimal pure-JS X.509 certificate generation (no external deps).
//
// node:crypto can create keypairs and sign, but cannot issue certificates, so
// we hand-encode the (small) ASN.1 DER cert envelope and sign the TBS with the
// issuer key. Used only to mint a local CA + a leaf for the MITM proxy, which
// the launched claude process trusts via NODE_EXTRA_CA_CERTS. Nothing here is a
// general-purpose ASN.1 library — just what these two certs need.

import { isIP } from 'node:net';
import { generateKeyPairSync, sign as cryptoSign, randomBytes, createHash, createPublicKey } from 'node:crypto';

// ── ASN.1 DER primitives ──────────────────────────────────────

function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  let x = n;
  while (x > 0) { bytes.unshift(x & 0xff); x = Math.floor(x / 256); }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}

const seq = (items) => tlv(0x30, Buffer.concat(items));
const set = (items) => tlv(0x31, Buffer.concat(items));
const NULL = Buffer.from([0x05, 0x00]);
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const octet = (buf) => tlv(0x04, buf);
const bitString = (buf) => tlv(0x03, Buffer.concat([Buffer.from([0]), buf])); // 0 unused bits
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const explicit = (n, content) => tlv(0xa0 | n, content);   // [n] constructed
const ctxPrim = (n, content) => tlv(0x80 | n, content);    // [n] primitive

function integer(buf) {
  let b = Buffer.isBuffer(buf) ? Buffer.from(buf) : Buffer.from([buf]);
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++; // strip leading zeros
  b = b.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]); // keep positive
  return tlv(0x02, b);
}

function oid(dotted) {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const group = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) { group.unshift((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...group);
  }
  return tlv(0x06, Buffer.from(out));
}

function utcTime(date) {
  const z = (n) => String(n).padStart(2, '0');
  const s = `${z(date.getUTCFullYear() % 100)}${z(date.getUTCMonth() + 1)}${z(date.getUTCDate())}` +
            `${z(date.getUTCHours())}${z(date.getUTCMinutes())}${z(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

function pem(der, label) {
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

// ── cert pieces ───────────────────────────────────────────────

const SIG_ALG = seq([oid('1.2.840.113549.1.1.11'), NULL]); // sha256WithRSAEncryption

function nameCN(cn) {
  return seq([set([seq([oid('2.5.4.3'), utf8(cn)])])]); // RDNSequence with one CN
}

function ext(extOid, critical, valueDer) {
  const items = [oid(extOid)];
  if (critical) items.push(bool(true));
  items.push(octet(valueDer));
  return seq(items);
}

// keyUsage BIT STRING from named bit positions (bit 0 = MSB of first byte).
function keyUsage(bits) {
  const max = Math.max(...bits);
  const nbytes = Math.floor(max / 8) + 1;
  const bytes = Buffer.alloc(nbytes);
  for (const b of bits) bytes[Math.floor(b / 8)] |= 0x80 >> (b % 8);
  const unused = nbytes * 8 - (max + 1);
  return tlv(0x03, Buffer.concat([Buffer.from([unused]), bytes]));
}

/** Raw bytes for an iPAddress SAN, or null when `s` is not an IP literal.
 * @param {string} s @returns {Buffer | null} */
export function ipSanBytes(s) {
  const v = isIP(s);
  if (v === 4) return Buffer.from(s.split('.').map(Number));
  if (v === 6) {
    // Expand '::' then pack eight 16-bit groups (an embedded IPv4 tail is
    // folded into the last two groups).
    let str = s;
    const m = str.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (m) {
      const b = m[1].split('.').map(Number);
      str = str.slice(0, -m[1].length) + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16);
    }
    const [head, tail = null] = str.split('::');
    const h = head ? head.split(':') : [];
    const t = tail === null ? [] : (tail ? tail.split(':') : []);
    const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
    const out = Buffer.alloc(16);
    groups.forEach((g, i) => out.writeUInt16BE(parseInt(g || '0', 16), i * 2));
    return out;
  }
  return null;
}

/**
 * Subject Key Identifier for a SubjectPublicKeyInfo (RFC 5280 4.2.1.2, method 1):
 * SHA-1 of the subjectPublicKey BIT STRING's value, without tag, length or the
 * unused-bits byte. Clients match a leaf's Authority Key Identifier against it,
 * so two CAs that share a name no longer shadow each other in one trust store
 * (the 2026-10-02 "certificate signature failure"; Oracle, #15).
 *
 * Input contract: a well-formed SPKI from Node's own `KeyObject.export({ type:
 * 'spki', format: 'der' })`. It is not a general DER parser and is never fed
 * untrusted bytes; a malformed buffer throws or yields a wrong digest.
 * @param {Buffer} spkiDer
 */
export function keyIdentifier(spkiDer) {
  // SPKI = SEQUENCE { algorithm AlgorithmIdentifier, subjectPublicKey BIT STRING }.
  let i = 1 + lenOfLen(spkiDer, 1);                 // into the outer SEQUENCE
  i += 1 + lenOfLen(spkiDer, i + 1) + derContentLength(spkiDer, i + 1); // skip AlgorithmIdentifier
  if (spkiDer[i] !== 0x03) throw new Error('SPKI: expected BIT STRING');
  const bitsLen = derContentLength(spkiDer, i + 1);
  const start = i + 1 + lenOfLen(spkiDer, i + 1) + 1; // + the unused-bits byte
  return createHash('sha1').update(spkiDer.subarray(start, start + bitsLen - 1)).digest();
}

/**
 * The keyIdentifier inside a certificate's Authority Key Identifier extension,
 * or null. Walks the certificate's extensions structurally (no byte search):
 * Certificate > TBSCertificate > [3] Extensions > Extension{2.5.29.35} >
 * extnValue OCTET STRING > SEQUENCE > [0] keyIdentifier.
 * @param {Buffer} certDer
 * @returns {Buffer | null}
 */
export function authorityKeyId(certDer) {
  /** children of the constructed TLV at `at`: [{ tag, start, end }] */
  const kids = (/** @type {number} */ at) => {
    const out = [];
    let p = at + 1 + lenOfLen(certDer, at + 1);
    const end = p + derContentLength(certDer, at + 1);
    while (p < end) {
      const len = derContentLength(certDer, p + 1);
      const start = p + 1 + lenOfLen(certDer, p + 1);
      out.push({ tag: certDer[p], at: p, start, end: start + len });
      p = start + len;
    }
    return out;
  };
  try {
    const tbs = kids(0)[0];
    const exts = kids(tbs.at).find((k) => k.tag === 0xa3);
    if (!exts) return null;
    const seqOfExt = kids(exts.at)[0];
    for (const e of kids(seqOfExt.at)) {
      const parts = kids(e.at);
      const oidTlv = certDer.subarray(parts[0].at, parts[0].end);
      if (!oidTlv.equals(Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x23]))) continue;
      // extnValue is an OCTET STRING whose content is the AKI SEQUENCE; its
      // [0] child (tag 0x80) is the keyIdentifier.
      const value = parts[parts.length - 1];
      const ki = kids(value.start).find((k) => k.tag === 0x80);
      return ki ? Buffer.from(certDer.subarray(ki.start, ki.end)) : null;
    }
    return null;
  } catch { return null; }
}

/** Number of bytes the DER length field at `at` occupies. @param {Buffer} der @param {number} at */
function lenOfLen(der, at) {
  return der[at] & 0x80 ? 1 + (der[at] & 0x7f) : 1;
}

/** The content length encoded by the DER length field at `at`. @param {Buffer} der @param {number} at */
function derContentLength(der, at) {
  if (!(der[at] & 0x80)) return der[at];
  let n = 0;
  for (let k = 1; k <= (der[at] & 0x7f); k++) n = (n * 256) + der[at + k];
  return n;
}

function buildCert({ subjectCN, issuerCN, spkiDer, signKey, isCA, altDnsNames = [], days, issuerKeyId = null }) {
  const now = new Date();
  const notBefore = new Date(now.getTime() - 60 * 60 * 1000);          // 1h back for clock skew
  const notAfter = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const extList = [];
  extList.push(ext('2.5.29.19', true, isCA ? seq([bool(true)]) : seq([]))); // basicConstraints
  extList.push(ext('2.5.29.14', false, octet(keyIdentifier(spkiDer))));       // subjectKeyIdentifier
  // authorityKeyIdentifier { keyIdentifier [0] IMPLICIT } — the issuer's SKI.
  if (issuerKeyId) extList.push(ext('2.5.29.35', false, seq([ctxPrim(0, issuerKeyId)])));
  extList.push(ext('2.5.29.15', true, isCA
    ? keyUsage([0, 5, 6])   // digitalSignature, keyCertSign, cRLSign
    : keyUsage([0, 2])));   // digitalSignature, keyEncipherment
  if (!isCA) {
    extList.push(ext('2.5.29.37', false, seq([oid('1.3.6.1.5.5.7.3.1')]))); // extKeyUsage serverAuth
    if (altDnsNames.length) {
      // dNSName [2] for names, iPAddress [7] (4 or 16 raw bytes) for literal
      // IPs: a client that dials the proxy by address (10.0.6.107) checks the
      // certificate against an IP SAN, never against a DNS name.
      extList.push(ext('2.5.29.17', false, seq(altDnsNames.map((/** @type {string} */ d) => {
        const ip = ipSanBytes(d);
        return ip ? ctxPrim(7, ip) : ctxPrim(2, Buffer.from(d));
      }))));
    }
  }

  const tbs = seq([
    explicit(0, integer(Buffer.from([2]))),  // version v3
    integer(randomBytes(16)),                // serial
    SIG_ALG,
    nameCN(issuerCN),
    seq([utcTime(notBefore), utcTime(notAfter)]),
    nameCN(subjectCN),
    spkiDer,                                  // SubjectPublicKeyInfo (already DER)
    explicit(3, seq(extList)),
  ]);

  const signature = cryptoSign('sha256', tbs, signKey); // RSASSA-PKCS1-v1_5
  return pem(seq([tbs, SIG_ALG, bitString(signature)]), 'CERTIFICATE');
}

// ── public API ────────────────────────────────────────────────

function newRsaKey() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKey,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    spkiDer: publicKey.export({ type: 'spki', format: 'der' }),
  };
}

// Default lifetimes. Callers (tests) may shorten them to exercise renewal.
export const CA_DAYS = 3650;
export const LEAF_DAYS = 825;

export function createCA(cn = 'TeamClaude Local CA', { days = CA_DAYS } = {}) {
  const key = newRsaKey();
  const certPem = buildCert({
    subjectCN: cn, issuerCN: cn, spkiDer: key.spkiDer, signKey: key.privateKey,
    isCA: true, days,
  });
  return { cn, certPem, keyPem: key.keyPem, privateKey: key.privateKey, keyId: keyIdentifier(key.spkiDer) };
}

export function createLeaf(hosts, ca, { days = LEAF_DAYS } = {}) {
  const list = Array.isArray(hosts) ? hosts : [hosts];
  const key = newRsaKey();
  const certPem = buildCert({
    subjectCN: list[0], issuerCN: ca.cn, spkiDer: key.spkiDer, signKey: ca.privateKey,
    // Derived from the CA's own public key, so every leaf carries an AKI even
    // when a caller hands in a CA object built before keyId existed.
    isCA: false, altDnsNames: list, days,
    issuerKeyId: ca.keyId || keyIdentifier(/** @type {Buffer} */ (createPublicKey(ca.privateKey).export({ type: 'spki', format: 'der' }))),
  });
  return { certPem, keyPem: key.keyPem };
}

/**
 * Generate a fresh CA + a leaf covering `hosts` (string or array). Returns PEM
 * strings. `caDays` / `leafDays` override the default lifetimes (tests).
 */
/** @param {string | string[]} hosts
 * @param {{ caDays?: number, leafDays?: number, caCn?: string }} [opts] caCn names the CA (default "TeamClaude Local CA") */
export function generateCertChain(hosts, { caDays = CA_DAYS, leafDays = LEAF_DAYS, caCn = undefined } = {}) {
  const ca = createCA(caCn, { days: caDays });
  const leaf = createLeaf(hosts, ca, { days: leafDays });
  return {
    caCertPem: ca.certPem,
    caKeyPem: ca.keyPem,
    leafCertPem: leaf.certPem,
    leafKeyPem: leaf.keyPem,
  };
}
