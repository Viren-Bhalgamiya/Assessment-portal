'use strict';
const crypto = require('crypto');

const KEY_LEN = 64;
// scrypt cost. Students use N=4096 (about 4 MB and a few ms per hash), so 1000 simultaneous
// logins finish quickly even on a 1-CPU server. Admin accounts use the stronger N=16384.
const COST_STUDENT = 4096;
const COST_ADMIN = 16384;

// Async scrypt runs on libuv's thread pool, so a login rush doesn't block other requests.
const scrypt = (password, salt, len, N) => new Promise((resolve, reject) =>
  crypto.scrypt(password, salt, len, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => (err ? reject(err) : resolve(key))));

// Format: scrypt$N$salt$hash. Older hashes (scrypt$salt$hash) were made with N=16384.
async function hashPassword(password, { admin = false } = {}) {
  const N = admin ? COST_ADMIN : COST_STUDENT;
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LEN, N);
  return `scrypt$${N}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts[0] !== 'scrypt') return false;
  const [N, saltHex, hashHex] = parts.length === 4 ? [Number(parts[1]), parts[2], parts[3]] : [16384, parts[1], parts[2]];
  if (!N || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, N);
  return crypto.timingSafeEqual(actual, expected);
}

// Readable random password without look-alike characters (0/O, 1/l/I).
function generatePassword(length = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[crypto.randomInt(alphabet.length)];
  return out;
}

module.exports = { hashPassword, verifyPassword, generatePassword };
