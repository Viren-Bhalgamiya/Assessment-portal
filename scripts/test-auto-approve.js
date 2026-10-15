#!/usr/bin/env node
// Test: self-registered students are auto-approved, and admin can still revoke (reject) them.
// Usage: node scripts/test-auto-approve.js
// Requires: server already running on PORT (default 3000), and an admin account exists.
// Provide admin creds via env: ADMIN_USER, ADMIN_PASS. Registration must be open in settings.

const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'Admin@123';

function parseSetCookie(res) {
  const raw = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')].filter(Boolean);
  const jar = {};
  for (const c of raw) {
    const [kv] = c.split(';');
    const [k, v] = kv.split('=');
    if (k && v) jar[k.trim()] = v.trim();
  }
  return jar;
}
function cookieHeader(jar) { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); }

async function req(method, path, { body, cookies } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookies ? { cookie: cookieHeader(cookies) } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data, cookies: parseSetCookie(res) };
}

function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } console.log('PASS:', msg); }

(async () => {
  const email = `autotest_${Date.now()}@example.com`;
  const name = 'Auto Test User';
  const password = 'Secret123';

  // 1. Register a new student.
  const reg = await req('POST', '/api/register', { body: { username: email, name, password } });
  assert(reg.status === 200, `register returns 200 (got ${reg.status}: ${JSON.stringify(reg.data)})`);
  assert(reg.data?.status === 'approved', `register response status === 'approved' (got '${reg.data?.status}')`);

  // 2. /api/me should show approved.
  const me = await req('GET', '/api/me', { cookies: reg.cookies });
  assert(me.status === 200 && me.data?.status === 'approved', `/api/me shows status 'approved' (got '${me.data?.status}')`);

  // 3. /api/exam/status should not return approval: 'pending'.
  const st = await req('GET', '/api/exam/status', { cookies: reg.cookies });
  assert(st.data?.approval !== 'pending', `exam status not pending (got approval='${st.data?.approval}')`);

  // 4. Admin can revoke by rejecting the student.
  const adminLogin = await req('POST', '/api/login', { body: { username: ADMIN_USER, password: ADMIN_PASS } });
  assert(adminLogin.status === 200 && adminLogin.data?.role === 'admin', `admin login works (got ${JSON.stringify(adminLogin.data)})`);

  const list = await req('GET', '/api/admin/summary', { cookies: adminLogin.cookies });
  const student = list.data?.students?.find((s) => s.username === email);
  assert(student && student.approval === 'approved', `admin summary lists new student as approved`);

  const rej = await req('POST', `/api/admin/students/${student.id}/reject`, { cookies: adminLogin.cookies });
  assert(rej.status === 200, `admin reject endpoint still works (got ${rej.status})`);

  const me2 = await req('GET', '/api/me', { cookies: reg.cookies });
  assert(me2.data?.status === 'rejected', `student is now rejected after admin revoke (got '${me2.data?.status}')`);

  console.log('\nAll checks passed.');
})().catch((e) => { console.error(e); process.exit(1); });
