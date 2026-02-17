const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const config = require('../config');

// ---------------------------------------------------------------------------
// Internal CA for mTLS agent authentication
//
// CertKeeper acts as its own Certificate Authority. The CA root cert + key
// are generated once and stored in data/ca/. Agent certificates are signed
// by this CA and verified during the mTLS handshake.
// ---------------------------------------------------------------------------

const CA_DIR = path.join(config.paths.data, 'ca');
const CA_CERT_PATH = path.join(CA_DIR, 'ca.crt');
const CA_KEY_PATH = path.join(CA_DIR, 'ca.key');

// Agent cert lifetime: 45 days (renewed when ≤15 days remain)
const AGENT_CERT_DAYS = 45;

// ---------------------------------------------------------------------------
// ASN.1 / DER helpers (pure Node.js — no openssl dependency)
// ---------------------------------------------------------------------------

/** Encode a length in DER format */
function derLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  if (len < 0x10000) return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
  throw new Error('DER length too large');
}

/** Wrap content bytes with a DER tag */
function derSequence(buffers) {
  const body = Buffer.concat(buffers);
  return Buffer.concat([Buffer.from([0x30]), derLength(body.length), body]);
}

function derSet(buffers) {
  const body = Buffer.concat(buffers);
  return Buffer.concat([Buffer.from([0x31]), derLength(body.length), body]);
}

function derOid(oidStr) {
  const parts = oidStr.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i];
    if (val < 128) {
      bytes.push(val);
    } else {
      const enc = [];
      enc.push(val & 0x7f);
      val >>= 7;
      while (val > 0) {
        enc.push((val & 0x7f) | 0x80);
        val >>= 7;
      }
      enc.reverse();
      bytes.push(...enc);
    }
  }
  const buf = Buffer.from(bytes);
  return Buffer.concat([Buffer.from([0x06]), derLength(buf.length), buf]);
}

function derUtf8String(str) {
  const buf = Buffer.from(str, 'utf-8');
  return Buffer.concat([Buffer.from([0x0c]), derLength(buf.length), buf]);
}

function derPrintableString(str) {
  const buf = Buffer.from(str, 'ascii');
  return Buffer.concat([Buffer.from([0x13]), derLength(buf.length), buf]);
}

function derInteger(num) {
  if (typeof num === 'number') {
    // Small integer
    const hex = num.toString(16);
    const buf = Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex');
    // Ensure positive (add leading 0 if high bit set)
    const padded = (buf[0] & 0x80) ? Buffer.concat([Buffer.from([0]), buf]) : buf;
    return Buffer.concat([Buffer.from([0x02]), derLength(padded.length), padded]);
  }
  // Buffer (for serial numbers)
  const padded = (num[0] & 0x80) ? Buffer.concat([Buffer.from([0]), num]) : num;
  return Buffer.concat([Buffer.from([0x02]), derLength(padded.length), padded]);
}

function derBitString(buf) {
  // Bit string with 0 unused bits
  const body = Buffer.concat([Buffer.from([0x00]), buf]);
  return Buffer.concat([Buffer.from([0x03]), derLength(body.length), body]);
}

function derOctetString(buf) {
  return Buffer.concat([Buffer.from([0x04]), derLength(buf.length), buf]);
}

function derBoolean(val) {
  return Buffer.from([0x01, 0x01, val ? 0xff : 0x00]);
}

function derExplicit(tag, content) {
  return Buffer.concat([Buffer.from([0xa0 | tag]), derLength(content.length), content]);
}

function derUtcTime(date) {
  const y = date.getUTCFullYear() % 100;
  const str = [
    String(y).padStart(2, '0'),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
    String(date.getUTCHours()).padStart(2, '0'),
    String(date.getUTCMinutes()).padStart(2, '0'),
    String(date.getUTCSeconds()).padStart(2, '0'),
    'Z',
  ].join('');
  const buf = Buffer.from(str, 'ascii');
  return Buffer.concat([Buffer.from([0x17]), derLength(buf.length), buf]);
}

function derNull() {
  return Buffer.from([0x05, 0x00]);
}

// OIDs
const OID_SHA256_RSA = '1.2.840.113549.1.1.11';
const OID_RSA_ENCRYPTION = '1.2.840.113549.1.1.1';
const OID_CN = '2.5.4.3';
const OID_O = '2.5.4.10';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXT_KEY_USAGE = '2.5.29.37';
const OID_SUBJECT_KEY_ID = '2.5.29.14';
const OID_AUTHORITY_KEY_ID = '2.5.29.35';
const OID_CLIENT_AUTH = '1.3.6.1.5.5.7.3.2';

// ---------------------------------------------------------------------------
// Certificate construction
// ---------------------------------------------------------------------------

function buildName(cn, org) {
  const rdns = [];
  if (org) {
    rdns.push(derSet([derSequence([derOid(OID_O), derPrintableString(org)])]));
  }
  rdns.push(derSet([derSequence([derOid(OID_CN), derUtf8String(cn)])]));
  return derSequence(rdns);
}

function buildAlgorithmIdentifier() {
  return derSequence([derOid(OID_SHA256_RSA), derNull()]);
}

function extractPublicKeyDer(publicKey) {
  // Export as DER and extract the SubjectPublicKeyInfo
  return publicKey.export({ type: 'spki', format: 'der' });
}

function buildValidity(notBefore, notAfter) {
  return derSequence([derUtcTime(notBefore), derUtcTime(notAfter)]);
}

function keyIdFromSPKI(spkiDer) {
  return crypto.createHash('sha1').update(spkiDer).digest();
}

/**
 * Build and self-sign a CA certificate.
 */
function buildCACert(keyPair) {
  const serialNumber = crypto.randomBytes(16);
  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 10); // 10 year CA

  const issuer = buildName('CertKeeper Agent CA', 'CertKeeper');
  const subject = issuer; // Self-signed
  const spkiDer = extractPublicKeyDer(keyPair.publicKey);
  const keyId = keyIdFromSPKI(spkiDer);

  // Extensions
  const extensions = derSequence([
    // Basic Constraints: CA=true
    derSequence([
      derOid(OID_BASIC_CONSTRAINTS),
      derBoolean(true), // critical
      derOctetString(derSequence([derBoolean(true)])),
    ]),
    // Key Usage: keyCertSign, cRLSign (bits 5,6 → byte 0x06, with 1 unused bit... actually: digital signature + keyCertSign)
    derSequence([
      derOid(OID_KEY_USAGE),
      derBoolean(true), // critical
      derOctetString(derBitString(Buffer.from([0x06]))), // keyCertSign + cRLSign
    ]),
    // Subject Key Identifier
    derSequence([
      derOid(OID_SUBJECT_KEY_ID),
      derOctetString(derOctetString(keyId)),
    ]),
  ]);

  const tbs = derSequence([
    derExplicit(0, derInteger(2)), // v3
    derInteger(serialNumber),
    buildAlgorithmIdentifier(),
    issuer,
    buildValidity(notBefore, notAfter),
    subject,
    spkiDer, // SubjectPublicKeyInfo already in DER
    derExplicit(3, extensions),
  ]);

  const signature = crypto.sign('sha256', tbs, keyPair.privateKey);

  const cert = derSequence([
    tbs,
    buildAlgorithmIdentifier(),
    derBitString(signature),
  ]);

  return cert;
}

/**
 * Build and sign an agent certificate from a CSR.
 */
function buildAgentCert(csrDer, caKeyPair, caCertDer, agentName, days) {
  // Parse enough of the CSR to extract the public key
  // CSR structure: SEQUENCE { CertificationRequestInfo, AlgorithmIdentifier, Signature }
  // CertificationRequestInfo: SEQUENCE { version, subject, subjectPKInfo, attributes }
  // We need the subject and subjectPKInfo

  const csrInfo = parseTLV(csrDer);
  if (csrInfo.tag !== 0x30) throw new Error('Invalid CSR: not a SEQUENCE');

  const csrFields = parseSequenceChildren(csrInfo.value);
  const certReqInfo = csrFields[0]; // CertificationRequestInfo
  const certReqInfoFields = parseSequenceChildren(certReqInfo.value);

  // certReqInfoFields: [version, subject, subjectPKInfo, ...]
  const csrSubjectRaw = certReqInfoFields[1]; // subject Name
  const csrSPKI = certReqInfoFields[2]; // SubjectPublicKeyInfo

  // Reconstruct the SPKI as a full TLV for the certificate
  const spkiDer = Buffer.concat([
    Buffer.from([csrSPKI.tag]),
    derLength(csrSPKI.value.length),
    csrSPKI.value,
  ]);

  // Verify the CSR signature
  const csrTbsRaw = Buffer.concat([
    Buffer.from([certReqInfo.tag]),
    derLength(certReqInfo.value.length),
    certReqInfo.value,
  ]);
  const csrAlgRaw = Buffer.concat([
    Buffer.from([csrFields[1].tag]),
    derLength(csrFields[1].value.length),
    csrFields[1].value,
  ]);
  const csrSigTlv = csrFields[2]; // BIT STRING
  // Extract actual signature bytes (skip the unused-bits byte)
  const csrSigBytes = csrSigTlv.value.slice(1);

  const csrPubKey = crypto.createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
  const csrValid = crypto.verify('sha256', csrTbsRaw, csrPubKey, csrSigBytes);
  if (!csrValid) {
    throw new Error('CSR signature verification failed — the CSR may be corrupted');
  }

  const serialNumber = crypto.randomBytes(16);
  const notBefore = new Date();
  const notAfter = new Date();
  notAfter.setDate(notAfter.getDate() + (days || AGENT_CERT_DAYS));

  // Use the agent name as CN
  const subject = buildName(agentName, 'CertKeeper Agent');

  // Extract CA subject for issuer field from CA cert
  const caCertInfo = parseTLV(caCertDer);
  const caCertFields = parseSequenceChildren(caCertInfo.value);
  const caTbs = caCertFields[0];
  const caTbsFields = parseSequenceChildren(caTbs.value);
  // TBS fields: [explicit version, serial, alg, issuer, validity, subject, spki, ...]
  // Skip explicit context tags
  let issuerField;
  let caSubjectSPKI;
  let fieldIdx = 0;
  for (const f of caTbsFields) {
    if (f.tag === 0xa0) { fieldIdx++; continue; } // skip version
    if (fieldIdx === 1) { fieldIdx++; continue; } // serial
    if (fieldIdx === 2) { fieldIdx++; continue; } // algorithm
    if (fieldIdx === 3) { issuerField = f; fieldIdx++; continue; } // issuer
    if (fieldIdx === 4) { fieldIdx++; continue; } // validity
    if (fieldIdx === 5) { fieldIdx++; continue; } // subject
    if (fieldIdx === 6) { caSubjectSPKI = f; fieldIdx++; continue; } // spki
    fieldIdx++;
  }

  const issuerDer = Buffer.concat([
    Buffer.from([issuerField.tag]),
    derLength(issuerField.value.length),
    issuerField.value,
  ]);

  const caKeyId = keyIdFromSPKI(Buffer.concat([
    Buffer.from([caSubjectSPKI.tag]),
    derLength(caSubjectSPKI.value.length),
    caSubjectSPKI.value,
  ]));

  const clientKeyId = keyIdFromSPKI(spkiDer);

  // Extensions for agent cert
  const extensions = derSequence([
    // Basic Constraints: CA=false
    derSequence([
      derOid(OID_BASIC_CONSTRAINTS),
      derBoolean(true),
      derOctetString(derSequence([])),
    ]),
    // Key Usage: digitalSignature
    derSequence([
      derOid(OID_KEY_USAGE),
      derBoolean(true),
      derOctetString(derBitString(Buffer.from([0x80]))), // digitalSignature
    ]),
    // Extended Key Usage: clientAuth
    derSequence([
      derOid(OID_EXT_KEY_USAGE),
      derOctetString(derSequence([derOid(OID_CLIENT_AUTH)])),
    ]),
    // Subject Key Identifier
    derSequence([
      derOid(OID_SUBJECT_KEY_ID),
      derOctetString(derOctetString(clientKeyId)),
    ]),
    // Authority Key Identifier
    derSequence([
      derOid(OID_AUTHORITY_KEY_ID),
      derOctetString(derSequence([
        // keyIdentifier [0] implicit
        Buffer.concat([Buffer.from([0x80]), derLength(caKeyId.length), caKeyId]),
      ])),
    ]),
  ]);

  const tbs = derSequence([
    derExplicit(0, derInteger(2)), // v3
    derInteger(serialNumber),
    buildAlgorithmIdentifier(),
    issuerDer,
    buildValidity(notBefore, notAfter),
    subject,
    spkiDer,
    derExplicit(3, extensions),
  ]);

  const signature = crypto.sign('sha256', tbs, caKeyPair.privateKey);

  const cert = derSequence([
    tbs,
    buildAlgorithmIdentifier(),
    derBitString(signature),
  ]);

  return { certDer: cert, notBefore, notAfter };
}

// ---------------------------------------------------------------------------
// Minimal ASN.1 TLV parser
// ---------------------------------------------------------------------------

function parseTLV(buf, offset = 0) {
  const tag = buf[offset];
  let lenByte = buf[offset + 1];
  let len, headerLen;

  if (lenByte < 0x80) {
    len = lenByte;
    headerLen = 2;
  } else if (lenByte === 0x81) {
    len = buf[offset + 2];
    headerLen = 3;
  } else if (lenByte === 0x82) {
    len = (buf[offset + 2] << 8) | buf[offset + 3];
    headerLen = 4;
  } else {
    throw new Error(`Unsupported DER length encoding: 0x${lenByte.toString(16)}`);
  }

  const value = buf.slice(offset + headerLen, offset + headerLen + len);
  return { tag, len, headerLen, value, totalLen: headerLen + len };
}

function parseSequenceChildren(buf) {
  const children = [];
  let offset = 0;
  while (offset < buf.length) {
    const tlv = parseTLV(buf, offset);
    children.push(tlv);
    offset += tlv.totalLen;
  }
  return children;
}

// ---------------------------------------------------------------------------
// PEM conversion
// ---------------------------------------------------------------------------

function derToPem(der, label) {
  const b64 = der.toString('base64');
  const lines = [];
  for (let i = 0; i < b64.length; i += 64) {
    lines.push(b64.slice(i, i + 64));
  }
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

function pemToDer(pem, label) {
  const header = `-----BEGIN ${label}-----`;
  const footer = `-----END ${label}-----`;
  const b64 = pem.replace(header, '').replace(footer, '').replace(/[\r\n\s]/g, '');
  return Buffer.from(b64, 'base64');
}

// ---------------------------------------------------------------------------
// CA lifecycle
// ---------------------------------------------------------------------------

/**
 * Ensure the internal CA exists. Generates a new CA if none is found on disk.
 * Returns { caCert (PEM), caKey (PEM) }.
 */
function ensureCA() {
  fs.mkdirSync(CA_DIR, { recursive: true });

  if (fs.existsSync(CA_CERT_PATH) && fs.existsSync(CA_KEY_PATH)) {
    return {
      caCert: fs.readFileSync(CA_CERT_PATH, 'utf-8'),
      caKey: fs.readFileSync(CA_KEY_PATH, 'utf-8'),
    };
  }

  logger.info('Generating internal CA for mTLS agent authentication…');

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
  });

  const certDer = buildCACert({ publicKey, privateKey });
  const certPem = derToPem(certDer, 'CERTIFICATE');
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  fs.writeFileSync(CA_CERT_PATH, certPem, { mode: 0o644 });
  fs.writeFileSync(CA_KEY_PATH, keyPem, { mode: 0o600 });

  logger.info('Internal CA created', { cert: CA_CERT_PATH });

  return { caCert: certPem, caKey: keyPem };
}

/**
 * Get the CA certificate PEM (for agents to trust).
 */
function getCACert() {
  const { caCert } = ensureCA();
  return caCert;
}

/**
 * Get the CA key pair (for signing agent certs).
 */
function getCAKeyPair() {
  const { caCert, caKey } = ensureCA();
  const privateKey = crypto.createPrivateKey(caKey);
  const publicKey = crypto.createPublicKey(privateKey);
  return { privateKey, publicKey, caCertPem: caCert };
}

/**
 * Sign a CSR (PEM) and return an agent certificate (PEM).
 *
 * @param {string} csrPem — PEM-encoded PKCS#10 CSR from the agent
 * @param {string} agentName — Agent name (used as CN in the cert)
 * @param {number} [days] — Cert lifetime in days (default: AGENT_CERT_DAYS)
 * @returns {{ certPem: string, fingerprint: string, expiresAt: Date }}
 */
function signCSR(csrPem, agentName, days) {
  const { privateKey, publicKey, caCertPem } = getCAKeyPair();
  const caCertDer = pemToDer(caCertPem, 'CERTIFICATE');
  const csrDer = pemToDer(csrPem, 'CERTIFICATE REQUEST');

  const { certDer, notAfter } = buildAgentCert(
    csrDer,
    { privateKey, publicKey },
    caCertDer,
    agentName,
    days || AGENT_CERT_DAYS,
  );

  const certPem = derToPem(certDer, 'CERTIFICATE');

  // Compute fingerprint (SHA-256 of the DER cert)
  const fingerprint = crypto.createHash('sha256').update(certDer).digest('hex');

  return { certPem, fingerprint, expiresAt: notAfter };
}

module.exports = {
  ensureCA,
  getCACert,
  signCSR,
  AGENT_CERT_DAYS,
  CA_CERT_PATH,
  CA_DIR,
};
