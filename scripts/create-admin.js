'use strict';
// Usage: npm run create-admin -- <username> <password> "<Full Name>"
// Creates an admin, or resets the password of an existing admin with that username.
const { db } = require('../db');
const { hashPassword } = require('../auth');

(async () => {
  const [username, password, ...nameParts] = process.argv.slice(2);
  if (!username || !password) {
    console.error('Usage: npm run create-admin -- <username> <password> "<Full Name>"');
    process.exit(1);
  }
  const name = nameParts.join(' ') || 'Administrator';

  const existing = db.prepare('SELECT id, role FROM users WHERE username = ?').get(username);
  if (existing && existing.role !== 'admin') {
    console.error(`"${username}" already exists as a student. Choose another admin username.`);
    process.exit(1);
  }
  const hash = await hashPassword(password, { admin: true });
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, name = ? WHERE id = ?').run(hash, name, existing.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(existing.id);
    console.log(`Admin "${username}" updated.`);
  } else {
    db.prepare("INSERT INTO users (username, name, password_hash, role, status, created_at) VALUES (?, ?, ?, 'admin', 'approved', ?)")
      .run(username, name, hash, Date.now());
    console.log(`Admin "${username}" created.`);
  }
})();
