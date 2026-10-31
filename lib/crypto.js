const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Encrypts/decrypts GitHub access tokens before they touch the database.
// AES-256-GCM, key derived from SESSION_SECRET. Format: v1.<iv>.<tag>.<data> (base64url).

// The encryption secret needs no setup: if SESSION_SECRET isn't in .env, a random
// one is generated on first run and kept in .data/session-secret (git-ignored).
// (If that file is lost, people simply connect GitHub again.)
let cachedSecret = null;
function getSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) return process.env.SESSION_SECRET;
  if (cachedSecret) return cachedSecret;
  const file = process.env.SESSION_SECRET_FILE || path.join(__dirname, '..', '.data', 'session-secret');
  try {
    cachedSecret = fs.readFileSync(file, 'utf8').trim();
  } catch {
    cachedSecret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cachedSecret, { mode: 0o600 });
  }
  return cachedSecret;
}

function getKey() {
  return crypto.createHash('sha256').update(getSecret()).digest();
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv, tag, data].map((p) => (Buffer.isBuffer(p) ? p.toString('base64url') : p)).join('.');
}

function decrypt(payload) {
  const [version, iv, tag, data] = String(payload).split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('Unrecognised encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = { encrypt, decrypt, sha256, randomToken };
