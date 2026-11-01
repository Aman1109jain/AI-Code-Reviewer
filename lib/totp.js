'use strict';
const crypto = require('crypto');

// Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30 s step) - the
// format every authenticator app (Google Authenticator, Microsoft Authenticator,
// Authy, 1Password ...) understands. Implemented on Node's crypto; verified in the
// tests against the RFC's published test vectors.
const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str).replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160 bits, as recommended by RFC 4226
}

function hotp(secretBuf, counter, digits = DIGITS) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuf).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

function stepFor(timeMs = Date.now()) {
  return Math.floor(timeMs / 1000 / STEP_SECONDS);
}

function totpAt(secretBase32, timeMs = Date.now(), digits = DIGITS) {
  return hotp(base32Decode(secretBase32), stepFor(timeMs), digits);
}

// Checks a code against the current step +/- `window` steps (clock drift).
// `lastUsedStep` blocks replay: a code that was already accepted (or any older one)
// can never be used again. Returns { ok, step }.
function verifyTotp(secretBase32, token, { window = 1, lastUsedStep = null, timeMs = Date.now() } = {}) {
  if (typeof token !== 'string' || !/^\d{6}$/.test(token)) return { ok: false, step: null };
  const secretBuf = base32Decode(secretBase32);
  const current = stepFor(timeMs);
  let matched = null;
  for (let s = current - window; s <= current + window; s += 1) {
    const expected = Buffer.from(hotp(secretBuf, s));
    // No early exit: every candidate is compared, keeping timing independent of which step matched.
    if (crypto.timingSafeEqual(expected, Buffer.from(token)) && (matched === null || s > matched)) matched = s;
  }
  if (matched === null) return { ok: false, step: null };
  if (lastUsedStep !== null && lastUsedStep !== undefined && matched <= Number(lastUsedStep)) {
    return { ok: false, step: matched, replay: true };
  }
  return { ok: true, step: matched };
}

function otpauthUri({ secret, account, issuer }) {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Single-use recovery codes: 80 bits each, shown to the admin once.
function generateRecoveryCodes(count = 10) {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(crypto.randomBytes(10)).toLowerCase(); // 16 chars
    return raw.match(/.{4}/g).join('-');
  });
}

function normalizeRecoveryCode(input) {
  return String(input || '').toLowerCase().replace(/[^a-z2-7]/g, '').match(/.{1,4}/g)?.join('-') || '';
}

module.exports = {
  generateSecret, verifyTotp, totpAt, hotp, base32Encode, base32Decode, otpauthUri,
  generateRecoveryCodes, normalizeRecoveryCode, STEP_SECONDS,
};
