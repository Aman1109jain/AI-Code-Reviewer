'use strict';
const crypto = require('crypto');
const { promisify } = require('util');

// Password hashing with scrypt (built into Node - no native add-on to install).
// Parameters follow the OWASP Password Storage Cheat Sheet guidance for scrypt
// (N=2^15, r=8, p=3 is one of the listed equivalent-strength combinations).
// The parameters are stored with each hash, so they can be raised later and old
// hashes still verify (see needsRehash).
const scrypt = promisify(crypto.scrypt);
const PARAMS = { N: 2 ** 15, r: 8, p: 3, keylen: 64 };
const MAX_PASSWORD_LENGTH = 128; // stops "hash a 10 MB password" denial of service
const MIN_PASSWORD_LENGTH = 12;

const maxmem = (p) => 128 * p.N * p.r * 2 + 1024 * 1024;

function normalize(password) {
  return String(password).normalize('NFKC');
}

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error('Invalid password length');
  }
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(normalize(password), salt, PARAMS.keylen, {
    N: PARAMS.N, r: PARAMS.r, p: PARAMS.p, maxmem: maxmem(PARAMS),
  });
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), derived.toString('base64')].join('$');
}

function parseHash(stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [, N, r, p, salt, hash] = parts;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  const valid =
    Number.isInteger(params.N) && params.N >= 2 ** 14 && params.N <= 2 ** 20 && (params.N & (params.N - 1)) === 0 &&
    Number.isInteger(params.r) && params.r >= 1 && params.r <= 32 &&
    Number.isInteger(params.p) && params.p >= 1 && params.p <= 16;
  if (!valid) return null;
  return { ...params, salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') };
}

async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed || typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
  const derived = await scrypt(normalize(password), parsed.salt, parsed.hash.length, {
    N: parsed.N, r: parsed.r, p: parsed.p, maxmem: maxmem(parsed),
  });
  return derived.length === parsed.hash.length && crypto.timingSafeEqual(derived, parsed.hash);
}

function needsRehash(stored) {
  const parsed = parseHash(stored);
  return !parsed || parsed.N !== PARAMS.N || parsed.r !== PARAMS.r || parsed.p !== PARAMS.p;
}

// Verifying against this when the account doesn't exist keeps response times the
// same for "wrong user" and "wrong password" (no user enumeration by timing).
let dummyHash = null;
async function burnTime(password) {
  if (!dummyHash) dummyHash = await hashPassword(crypto.randomBytes(18).toString('base64'));
  await verifyPassword(typeof password === 'string' ? password : '', dummyHash);
}

const COMMON = new Set(
  ('password,password1,password123,passw0rd,123456,12345678,123456789,1234567890,qwerty,qwerty123,qwertyuiop,' +
    'letmein,welcome,welcome1,admin,admin123,administrator,iloveyou,abc123,monkey,dragon,football,baseball,' +
    'sunshine,princess,master,shadow,superman,trustno1,changeme,changeme123,default,login,secret,google,' +
    'india123,india@123,pass@123,test1234,000000,111111,aaaaaa,zaq12wsx,1q2w3e4r,1qaz2wsx,qazwsxedc')
    .split(',')
);

// Returns a list of human-readable problems ([] = acceptable).
function checkPasswordPolicy(password, { username = '', email = '' } = {}) {
  const problems = [];
  const pw = typeof password === 'string' ? password : '';
  if (pw.length < MIN_PASSWORD_LENGTH) problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  if (pw.length > MAX_PASSWORD_LENGTH) problems.push(`Use at most ${MAX_PASSWORD_LENGTH} characters.`);
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) problems.push('That password is too common.');
  if (new Set(lower).size < 5 && pw.length >= MIN_PASSWORD_LENGTH) problems.push('Use a wider mix of characters.');
  const u = String(username).toLowerCase();
  const local = String(email).toLowerCase().split('@')[0];
  if (u.length >= 3 && lower.includes(u)) problems.push('The password must not contain your username.');
  if (local.length >= 4 && lower.includes(local)) problems.push('The password must not contain your email name.');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  if (pw.length < 16 && classes < 3) problems.push('Mix at least three of: lowercase, uppercase, digits, symbols (or use 16+ characters).');
  return problems;
}

// Random password for accounts created by another admin / password resets.
function generateTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < 20; i += 1) out += alphabet[crypto.randomInt(alphabet.length)];
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15)}!9`;
}

module.exports = {
  hashPassword, verifyPassword, needsRehash, burnTime, checkPasswordPolicy, generateTemporaryPassword,
  MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH,
};
