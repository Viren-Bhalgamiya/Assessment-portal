#!/usr/bin/env node
/**
 * Bulk-delete all candidates (students) by calling the existing
 * single-delete admin endpoint. No server-side changes required.
 *
 * Usage:
 *   BASE_URL=https://your-app.example.com \
 *   ADMIN_USER=admin@example.com \
 *   ADMIN_PASS='yourPassword' \
 *   node scripts/delete-all-candidates.js [--yes] [--concurrency=5] [--dry-run]
 *
 * Or pass as flags:
 *   node scripts/delete-all-candidates.js \
 *     --url=https://your-app.example.com \
 *     --user=admin@example.com --pass='yourPassword'
 *
 * Flags:
 *   --yes            Skip the interactive confirmation prompt.
 *   --dry-run        Only show which candidates would be deleted.
 *   --concurrency=N  Parallel delete requests (default 5).
 */

'use strict';

const readline = require('readline');

function arg(name, fallback) {
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  if (hit) return hit.slice(pref.length);
  if (process.argv.includes(`--${name}`)) return true;
  return fallback;
}

const BASE_URL  = (arg('url')  || process.env.BASE_URL  || '').replace(/\/+$/, '');
const ADMIN_USER = arg('user') || process.env.ADMIN_USER;
const ADMIN_PASS = arg('pass') || process.env.ADMIN_PASS;
const DRY_RUN   = Boolean(arg('dry-run', false));
const AUTO_YES  = Boolean(arg('yes', false));
const CONCURRENCY = Math.max(1, parseInt(arg('concurrency', '5'), 10) || 5);

if (!BASE_URL || !ADMIN_USER || !ADMIN_PASS) {
  console.error('Missing required config. Provide BASE_URL, ADMIN_USER, ADMIN_PASS (env or --url/--user/--pass).');
  process.exit(2);
}

function extractCookie(setCookie) {
  if (!setCookie) return null;
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const h of headers) {
    const m = /(?:^|,\s*)sid=([^;]+)/.exec(h);
    if (m) return `sid=${m[1]}`;
  }
  return null;
}

async function login() {
  const res = await fetch(`${BASE_URL}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Login failed (${res.status}): ${text}`);
  // Node 18+ fetch exposes raw set-cookie via headers.getSetCookie()
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : res.headers.get('set-cookie');
  const cookie = extractCookie(raw);
  if (!cookie) throw new Error('Login succeeded but no sid cookie was returned.');
  try {
    const info = JSON.parse(text);
    if (info?.user?.role && info.user.role !== 'admin') {
      throw new Error(`Logged-in user is not an admin (role=${info.user.role}).`);
    }
  } catch (_) { /* body may not be JSON; ignore */ }
  return cookie;
}

async function fetchStudents(cookie) {
  const res = await fetch(`${BASE_URL}/api/admin/summary`, { headers: { cookie } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Fetching students failed (${res.status}): ${text}`);
  const data = JSON.parse(text);
  return data.students || [];
}

async function deleteOne(cookie, id) {
  const res = await fetch(`${BASE_URL}/api/admin/students/${id}`, {
    method: 'DELETE',
    headers: { cookie },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body}`);
  }
}

async function confirm(message) {
  if (AUTO_YES) return true;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 'yes');
    });
  });
}

async function runPool(items, worker, concurrency) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) break;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return results;
}

(async () => {
  console.log(`Target: ${BASE_URL}`);
  console.log(`Admin : ${ADMIN_USER}`);
  console.log('Logging in...');
  const cookie = await login();

  console.log('Fetching candidate list...');
  const students = await fetchStudents(cookie);
  if (!students.length) {
    console.log('No candidates found. Nothing to delete.');
    return;
  }

  console.log(`\nCandidates found: ${students.length}`);
  console.log('----------------------------------------------------');
  for (const s of students) {
    console.log(`  #${s.id}\t${s.username}\t(${s.name || '-'})\tstatus=${s.status}\tapproval=${s.approval}`);
  }
  console.log('----------------------------------------------------');

  if (DRY_RUN) {
    console.log('\n--dry-run set; no deletions performed.');
    return;
  }

  const ok = await confirm(`\nDelete ALL ${students.length} candidates from ${BASE_URL}? Type "yes" to proceed: `);
  if (!ok) {
    console.log('Aborted.');
    return;
  }

  let done = 0, failed = 0;
  const failures = [];
  await runPool(students, async (s) => {
    try {
      await deleteOne(cookie, s.id);
      done++;
      process.stdout.write(`\rDeleted ${done}/${students.length}...`);
    } catch (e) {
      failed++;
      failures.push({ id: s.id, username: s.username, error: e.message });
    }
  }, CONCURRENCY);

  process.stdout.write('\n');
  console.log(`\nDone. Deleted: ${done}, Failed: ${failed}`);
  if (failures.length) {
    console.log('Failures:');
    for (const f of failures) console.log(`  #${f.id} ${f.username} -> ${f.error}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error('\nError:', e.message);
  process.exit(1);
});
