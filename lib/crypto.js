'use strict';
const crypto = require('crypto');
const { getConfig } = require('../config/env');

// Encryption for secrets at rest (GitHub tokens, TOTP secrets).
//
// v2 format:  v2.<iv>.<tag>.<ciphertext>   (base64url)
//   - AES-256-GCM, fresh random 96-bit IV per value
//   - the key is derived per *purpose* with HKDF, so a GitHub-token key can never
//     decrypt a TOTP secret (and vice versa), and the purpose is also bound in as
//     authenticated data
// v1 values (written by the previous version: key = SHA-256(secret), no AAD) are
// still readable, so existing connected GitHub users keep working. New writes are v2.

const keyCache = new Map();

function secret() {
  return getConfig().sessionSecret;
}

function deriveKey(purpose) {
  const cacheKey = `${secret().length}:${purpose}`;
  const hit = keyCache.get(cacheKey);
  if (hit && hit.secret === secret()) return hit.key;
  const key = Buffer.from(crypto.hkdfSync('sha256', secret(), 'ai-code-reviewer/v2', purpose, 32));
  keyCache.set(cacheKey, { secret: secret(), key });
  return key;
}

function legacyKey() {
  return crypto.createHash('sha256').update(secret()).digest();
}

function encrypt(plain, purpose = 'github-token') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(purpose), iv);
  cipher.setAAD(Buffer.from(purpose));
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v2', iv, tag, data].map((p) => (Buffer.isBuffer(p) ? p.toString('base64url') : p)).join('.');
}

function decrypt(payload, purpose = 'github-token') {
  const [version, iv, tag, data] = String(payload).split('.');
  if (!iv || !tag || !data) throw new Error('Unrecognised encrypted value');
  let key;
  let aad = null;
  if (version === 'v2') {
    key = deriveKey(purpose);
    aad = Buffer.from(purpose);
  } else if (version === 'v1' && purpose === 'github-token') {
    key = legacyKey();
  } else {
    throw new Error('Unrecognised encrypted value');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Keyed hash for values we must be able to look up but never reveal (recovery codes).
function hmacHex(purpose, value) {
  return crypto.createHmac('sha256', deriveKey(`hmac:${purpose}`)).update(String(value)).digest('hex');
}

function hmacBase64url(purpose, value) {
  return crypto.createHmac('sha256', deriveKey(`hmac:${purpose}`)).update(String(value)).digest('base64url');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

// Constant-time string comparison that tolerates different lengths.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) {
    crypto.timingSafeEqual(ba, ba); // keep timing roughly uniform
    return false;
  }
  return crypto.timingSafeEqual(ba, bb);
}

module.exports = { encrypt, decrypt, sha256, hmacHex, hmacBase64url, randomToken, safeEqual, deriveKey };
