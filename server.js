'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { monitorEventLoopDelay } = require('perf_hooks');
const express = require('express');
const compression = require('compression');

const { db, sql, SNAPSHOT_DIR, getSettings, setSetting } = require('./db');
const {
  LETTERS, MARK_CORRECT, MARK_WRONG, bank, validate, createQuestion, updateQuestion, deleteQuestion,
  createSection, renameSection, moveSection, deleteSection, setSectionMinutes, setSectionMarks,
} = require('./questions');
const { hashPassword, verifyPassword, generatePassword } = require('./auth');
const uc = require('./usecases');

const PORT = Number(process.env.PORT) || 3000;
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
const SESSION_MS = 12 * 3600 * 1000;
const GRACE_MS = 60 * 1000; // late answer saves accepted this long after the deadline (network lag)
const LOGIN_MAX_FAILURES = 8;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const MAX_WARNINGS = 3; // the exam never allows more than 3 warnings before auto-submitting

// Events a student's browser may report. Counted ones are warnings that lead to auto-submit.
const COUNTED_EVENTS = new Set(['focus_lost', 'fullscreen_exit', 'screen_share_stopped', 'camera_stopped', 'microphone_stopped', 'multiple_monitors', 'copy_attempt']);
// voice_detected / microphone_silent are logged for the examiner (with an audio clip) but are not warnings,
// so background noise can never auto-submit a test.
const CLIENT_EVENTS = new Set([...COUNTED_EVENTS, 'blocked_action', 'voice_detected', 'microphone_silent']);

const SUBMIT_REASONS = {
  submitted: 'Submitted by student',
  time_up: 'Time up (auto-submitted)',
  violations: 'Warning limit reached (auto-submitted)',
  admin: 'Force-submitted by admin',
};

const app = express();
app.disable('x-powered-by');
// Number of proxies in front of the app: 1 on Render alone, 2 when Vercel forwards /api to Render.
if (Number(process.env.TRUST_PROXY) > 0) app.set('trust proxy', Number(process.env.TRUST_PROXY));
// Server-side timing per route plus event-loop delay, exposed to admins at /api/admin/metrics.
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
const routeTimes = new Map(); // "METHOD /route" -> recent durations in ms (ring buffer)
const conn = { opened: 0, open: 0 };
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const key = `${req.method} ${req.baseUrl || ''}${req.route?.path || (req.path.startsWith('/static') ? '/static' : req.path)}`;
    let arr = routeTimes.get(key);
    if (!arr) routeTimes.set(key, (arr = []));
    if (arr.length >= 20000) arr.shift();
    arr.push(ms);
  });
  next();
});
app.use(compression());
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self)');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// ---------- helpers ----------
const now = () => Date.now();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const parseJSON = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSessionCookie(res, token, maxAgeSec) {
  res.setHeader('Set-Cookie',
    `sid=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAgeSec}${COOKIE_SECURE ? '; Secure' : ''}`);
}

function sessionUser(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  return sql(`
    SELECT u.id, u.username, u.name, u.role, u.status FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(sha256(token), now()) || null;
}

const requireRole = (role) => (req, res, next) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  if (user.role !== role) return res.status(403).json({ error: 'You do not have access to this.' });
  req.user = user;
  next();
};

// Students can sign in while their registration is pending, but can't touch the exam until approved.
// Token bucket per student: normal use is a request every few seconds; a script flooding the
// server gets 429s instead of slowing everyone else down.
const RATE = { capacity: 60, perSec: 6 };
const buckets = new Map(); // userId -> { tokens, at }
function rateLimited(userId) {
  const t = now();
  const b = buckets.get(userId) || { tokens: RATE.capacity, at: t };
  b.tokens = Math.min(RATE.capacity, b.tokens + ((t - b.at) / 1000) * RATE.perSec);
  b.at = t;
  const limited = b.tokens < 1;
  if (!limited) b.tokens -= 1;
  buckets.set(userId, b);
  return limited;
}

const requireApprovedStudent = [requireRole('student'), (req, res, next) => {
  if (req.user.status !== 'approved') {
    return res.status(403).json({ error: 'Your registration has not been approved yet.', approval: req.user.status });
  }
  if (rateLimited(req.user.id)) return res.status(429).json({ error: 'Too many requests. Slow down.' });
  next();
}];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Sections keep their order; questions within a section and the options of every question are shuffled per student.
function buildLayout() {
  return bank().SECTIONS.flatMap((s) => shuffle(s.items.map((q) => q.id)).map((id) => ({ id, perm: shuffle([0, 1, 2, 3]) })));
}

function logEvent(attemptId, type, detail, counted, clientSeq = null) {
  sql('INSERT INTO events (attempt_id, type, detail, counted, at, client_seq) VALUES (?, ?, ?, ?, ?, ?)')
    .run(attemptId, type, detail || null, counted ? 1 : 0, now(), clientSeq);
}

// Records a warning and auto-submits the attempt once the limit is reached.
function addViolation(att, type, detail, clientSeq = null) {
  logEvent(att.id, type, detail, true, clientSeq);
  sql('UPDATE attempts SET violations = violations + 1 WHERE id = ?').run(att.id);
  const violations = att.violations + 1;
  const { maxViolations } = getSettings();
  const terminated = maxViolations > 0 && violations >= maxViolations;
  if (terminated) finalize(att.id, 'violations');
  return { violations, maxViolations, terminated };
}

function scoreAnswers(answers) {
  const sections = {};
  for (const s of bank().SECTIONS) sections[s.key] = { score: 0, correct: 0, wrong: 0, unattempted: 0 };
  let total = 0;
  for (const [id, q] of bank().BY_ID) {
    const r = sections[q.section];
    const a = answers[id];
    if (a === undefined || a === null) r.unattempted++;
    else if (a === q.correct) { r.correct++; r.score += q.marks; total += q.marks; }
    else { r.wrong++; r.score -= q.negative; total -= q.negative; }
  }
  // Marks can be fractional (e.g. 0.25 negative), so keep 2 decimals.
  const round2 = (n) => Math.round(n * 100) / 100;
  for (const r of Object.values(sections)) r.score = round2(r.score);
  return { total: round2(total), sections };
}

function finalize(attemptId, reason) {
  const att = sql('SELECT * FROM attempts WHERE id = ?').get(attemptId);
  if (!att || att.status !== 'in_progress') return;
  const { total, sections } = scoreAnswers(parseJSON(att.answers, {}));
  sql(`UPDATE attempts SET status = 'submitted', submitted_at = ?, submit_reason = ?, score = ?, section_scores = ?
              WHERE id = ? AND status = 'in_progress'`)
    .run(now(), reason, total, JSON.stringify(sections), attemptId);
  logEvent(attemptId, 'submitted', SUBMIT_REASONS[reason] || reason, false);
}

// Returns the student's attempt, auto-submitting it first if the deadline (plus grace) has passed.
// ---------- per-section timing ----------
// In section mode the order and length of every section are frozen when the attempt starts. Only the
// current section can be answered. When its time ends (or the student finishes it early) the next one
// starts and the previous one is locked for good. attempts.deadline always equals
// (current section start + remaining sections' time), so the normal deadline sweep auto-submits.
const SECTION_GRACE_MS = 15 * 1000; // late saves for the section just closed (network lag)

const nonEmptySections = () => bank().SECTIONS.filter((x) => x.items.length);
// "+4 / −1" when every question uses the same marking, otherwise null (marks vary by question).
function uniformMarking() {
  const qs = [...bank().BY_ID.values()];
  if (!qs.length) return null;
  const same = qs.every((q) => q.marks === qs[0].marks && q.negative === qs[0].negative);
  return same ? { marks: qs[0].marks, negative: qs[0].negative } : null;
}
const sectionTimesMissing = () => nonEmptySections().filter((x) => !(x.minutes > 0)).map((x) => x.title);
function effectiveDurationMin() {
  if (getSettings().timingMode !== 'section') return getSettings().durationMin;
  return nonEmptySections().reduce((t, x) => t + (x.minutes || 0), 0);
}

function syncSections(att) {
  const timing = parseJSON(att.timing, null);
  if (!timing || timing.mode !== 'section' || att.status !== 'in_progress') return null;
  const plan = timing.plan;
  let i = att.sec_index;
  let started = att.sec_started_at;
  let moved = false;
  while (i < plan.length - 1 && now() > started + plan[i].sec * 1000) {
    logEvent(att.id, 'section_time_up', `Time ended for "${plan[i].title}"`, false);
    started += plan[i].sec * 1000;
    i++;
    moved = true;
  }
  if (moved) {
    sql('UPDATE attempts SET sec_index = ?, sec_started_at = ? WHERE id = ?').run(i, started, att.id);
    att.sec_index = i;
    att.sec_started_at = started;
  }
  const endsAt = started + plan[i].sec * 1000;
  return { plan, index: i, key: plan[i].key, startedAt: started, endsAt, remainingSec: Math.max(0, Math.ceil((endsAt - now()) / 1000)) };
}

function publicSection(sec) {
  if (!sec) return null;
  return {
    index: sec.index, key: sec.key, remainingSec: sec.remainingSec,
    plan: sec.plan.map((p) => ({ key: p.key, title: p.title, sec: p.sec })),
  };
}

function currentAttempt(userId) {
  let att = sql('SELECT * FROM attempts WHERE user_id = ?').get(userId);
  if (att && att.status === 'in_progress') att._sec = syncSections(att);
  if (att && att.status === 'in_progress' && now() > att.deadline + GRACE_MS) {
    finalize(att.id, 'time_up');
    att = sql('SELECT * FROM attempts WHERE id = ?').get(att.id);
  }
  return att || null;
}

function activeAttemptOr409(req, res) {
  const att = currentAttempt(req.user.id);
  if (!att) { res.status(404).json({ error: 'You have not started the exam.' }); return null; }
  if (att.status !== 'in_progress') { res.status(409).json({ error: 'Your exam has already been submitted.', submitted: true }); return null; }
  return att;
}

const remainingSec = (att) => Math.max(0, Math.ceil((att.deadline - now()) / 1000));

function studentState(att) {
  const s = getSettings();
  return {
    status: att.status,
    timingMode: att._sec ? 'section' : 'overall',
    section: publicSection(att._sec),
    remainingSec: remainingSec(att),
    violations: att.violations,
    maxViolations: s.maxViolations,
    snapshotIntervalSec: s.snapshotIntervalSec,
    lastSeq: att.last_seq,
  };
}

function removeSnapshotDir(attemptId) {
  const dir = path.join(SNAPSHOT_DIR, String(attemptId));
  snapshotDirs.delete(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

// Sweep: auto-submit attempts whose time has run out even if the student's browser is gone,
// and flag attempts whose camera/screen snapshots stopped arriving (e.g. monitoring was tampered with).
const gapFlagged = new Map(); // `${attemptId}:${kind}` -> timestamp of the last snapshot already flagged
setInterval(() => {
  sql(`UPDATE uc_attempts SET status = 'submitted', submitted_at = deadline, submit_reason = 'time_up'
       WHERE status = 'in_progress' AND deadline < ?`).run(now() - GRACE_MS);
  const expired = sql("SELECT id FROM attempts WHERE status = 'in_progress' AND deadline < ?").all(now() - GRACE_MS);
  for (const { id } of expired) finalize(id, 'time_up');
  sql('DELETE FROM sessions WHERE expires_at < ?').run(now());

  const gapMs = Math.max(90 * 1000, getSettings().snapshotIntervalSec * 3000);
  const active = sql("SELECT id, started_at FROM attempts WHERE status = 'in_progress' AND started_at < ?").all(now() - gapMs);
  const lastSnaps = new Map();
  for (const r of sql(`SELECT s.attempt_id, s.kind, MAX(s.at) AS t FROM snapshots s JOIN attempts a ON a.id = s.attempt_id
                              WHERE a.status = 'in_progress' GROUP BY s.attempt_id, s.kind`).all()) {
    lastSnaps.set(`${r.attempt_id}:${r.kind}`, r.t);
  }
  for (const att of active) {
    for (const kind of ['camera', 'screen']) {
      const key = `${att.id}:${kind}`;
      const last = lastSnaps.get(key) || att.started_at;
      if (now() - last > gapMs && gapFlagged.get(key) !== last) {
        gapFlagged.set(key, last);
        logEvent(att.id, 'monitoring_gap', `No ${kind} snapshot received for over ${Math.round(gapMs / 1000)} s`, false);
      }
    }
  }
}, 15 * 1000).unref();

// ---------- pages ----------
// Pages are served with a per-start version on every /static URL, so after an update browsers
// load the new scripts immediately instead of reusing cached old ones.
const ASSET_VERSION = Date.now().toString(36);
const pageCache = new Map();
function sendPage(res, name) {
  let html = pageCache.get(name);
  if (!html) {
    html = fs.readFileSync(path.join(__dirname, 'public', name), 'utf8')
      .replace(/(href|src)="\/static\/([^"?]+)"/g, `$1="/static/$2?v=${ASSET_VERSION}"`);
    pageCache.set(name, html);
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.type('html').send(html);
}
// Scripts and styles are revalidated on each load (cheap 304 when unchanged).
app.use('/static', express.static(path.join(__dirname, 'public', 'static'), { cacheControl: false, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

app.get('/favicon.ico', (req, res) => res.status(204).end());
app.get('/', (req, res) => {
  const user = sessionUser(req);
  if (user) return res.redirect(user.role === 'admin' ? '/admin' : '/exam');
  sendPage(res, 'login.html');
});
app.get('/exam', (req, res) => {
  const user = sessionUser(req);
  if (!user || user.role !== 'student') return res.redirect('/');
  sendPage(res, 'exam.html');
});
app.get('/admin', (req, res) => {
  const user = sessionUser(req);
  if (!user || user.role !== 'admin') return res.redirect('/');
  sendPage(res, 'admin.html');
});

// ---------- auth ----------
const loginFailures = new Map(); // `${ip}|${username}` -> { count, until }

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Express 4 does not catch rejected promises, so async handlers are wrapped.
const safe = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.post('/api/login', safe(async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const key = `${req.ip}|${username.toLowerCase()}`;
  const f = loginFailures.get(key);
  if (f && f.until > now() && f.count >= LOGIN_MAX_FAILURES) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const user = username && sql('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    const count = (f && f.until > now() ? f.count : 0) + 1;
    loginFailures.set(key, { count, until: now() + LOGIN_LOCK_MS });
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  loginFailures.delete(key);
  if (user.status === 'rejected') {
    return res.status(403).json({ error: 'Your registration was rejected. Contact the examiner.' });
  }

  // A student may be logged in on only one device at a time; a new login closes the old session.
  if (user.role === 'student') {
    const hadSession = sql('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ? AND expires_at > ?').get(user.id, now()).n > 0;
    sql('DELETE FROM sessions WHERE user_id = ?').run(user.id);
    const att = sql("SELECT id FROM attempts WHERE user_id = ? AND status = 'in_progress'").get(user.id);
    if (att && hadSession) logEvent(att.id, 'new_login', `Logged in again from ${req.ip}; the previous session was closed`, false);
  }

  const token = crypto.randomBytes(32).toString('hex');
  sql('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), user.id, now() + SESSION_MS);
  setSessionCookie(res, token, SESSION_MS / 1000);
  res.json({ role: user.role });
}));

const USERNAME_RE = /^[A-Za-z0-9._-]{2,40}$/;
const registrations = new Map(); // ip -> { count, until }

// A whole college lab usually shares one public IP, so the per-IP cap is generous; the admin approves every registration anyway.
const REGISTRATIONS_PER_IP_PER_HOUR = 2000;

app.post('/api/register', safe(async (req, res) => {
  if (!getSettings().registrationOpen) return res.status(403).json({ error: 'Registration is closed. Contact the examiner.' });
  const r = registrations.get(req.ip);
  if (r && r.until > now() && r.count >= REGISTRATIONS_PER_IP_PER_HOUR) return res.status(429).json({ error: 'Too many registrations from this network. Try again later.' });

  const username = String(req.body?.username || '').trim();
  const name = String(req.body?.name || '').trim().replace(/\s+/g, ' ');
  const password = String(req.body?.password || '');
  if (!USERNAME_RE.test(username)) return res.status(400).json({ error: 'Enter your roll number (2–40 letters or digits; . _ - allowed).' });
  if (name.length < 2 || name.length > 100) return res.status(400).json({ error: 'Enter your full name.' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (sql('SELECT 1 FROM users WHERE username = ?').get(username)) {
    return res.status(409).json({ error: 'This roll number is already registered. Sign in instead, or contact the examiner.' });
  }

  const passwordHash = await hashPassword(password);
  let created;
  try {
    created = sql("INSERT INTO users (username, name, password_hash, role, status, created_at) VALUES (?, ?, ?, 'student', 'pending', ?)")
      .run(username, name, passwordHash, now());
  } catch (e) {
    if (/UNIQUE/.test(e.message)) return res.status(409).json({ error: 'This roll number is already registered. Sign in instead, or contact the examiner.' });
    throw e;
  }
  registrations.set(req.ip, { count: (r && r.until > now() ? r.count : 0) + 1, until: now() + 3600 * 1000 });

  const token = crypto.randomBytes(32).toString('hex');
  sql('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), created.lastInsertRowid, now() + SESSION_MS);
  setSessionCookie(res, token, SESSION_MS / 1000);
  res.json({ role: 'student', status: 'pending' });
}));

app.get('/api/registration', (req, res) => {
  const st = getSettings();
  const { SECTIONS, BY_ID } = bank();
  res.json({
    orgName: st.orgName, examName: st.examName,
    mode: st.examMode, useCaseMaxMarks: st.ucMaxMarks,
    open: st.registrationOpen, examOpen: st.examOpen, questionCount: BY_ID.size,
    durationMin: st.examMode === 'usecase' ? st.ucDurationMin : effectiveDurationMin(), maxWarnings: st.maxViolations,
    marking: uniformMarking(), maxScore: bank().MAX_SCORE,
    subjects: SECTIONS.filter((x) => x.items.length).map((x) => x.title.replace(/^Section [A-Z0-9]+: /, '')),
  });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) sql('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const user = sessionUser(req);
  if (!user) return res.status(401).json({ error: 'Please log in.' });
  res.json({ username: user.username, name: user.name, role: user.role, status: user.status });
});

// ---------- student exam API (never returns scores or answer keys) ----------
app.get('/api/exam/status', requireRole('student'), (req, res) => {
  const s = getSettings();
  if (req.user.status !== 'approved') return res.json({ approval: req.user.status });
  if (s.examMode === 'usecase') return res.json({ approval: 'approved', mode: 'usecase' });
  let att = currentAttempt(req.user.id);
  // Opening the exam page again mid-exam (reload, closed tab, crash) is a warning: otherwise a
  // student could reload to escape monitoring and browse freely on the pre-exam screen.
  if (att && att.status === 'in_progress') {
    const detail = `Exam page was reloaded or reopened from ${req.ip}`;
    // If a warning was just recorded (e.g. leaving fullscreen right before reloading), it's the same incident.
    const recent = sql('SELECT 1 FROM events WHERE attempt_id = ? AND counted = 1 AND at > ?').get(att.id, now() - 10 * 1000);
    if (recent) logEvent(att.id, 'page_reloaded', detail, false);
    else {
      const v = addViolation(att, 'page_reloaded', detail);
      if (v.terminated) att = currentAttempt(req.user.id);
      else att.violations = v.violations;
    }
  }
  res.json({
    approval: 'approved',
    violations: att ? att.violations : 0,
    lastSeq: att ? att.last_seq : 0,
    examOpen: s.examOpen,
    durationMin: effectiveDurationMin(),
    timingMode: s.timingMode,
    sectionTimes: nonEmptySections().map((x) => ({ title: x.title, minutes: x.minutes })),
    marking: uniformMarking(),
    maxViolations: s.maxViolations,
    questionCount: bank().BY_ID.size,
    status: att ? att.status : 'none',
    remainingSec: att && att.status === 'in_progress' ? remainingSec(att) : null,
  });
});

app.post('/api/exam/start', requireApprovedStudent, (req, res) => {
  const s = getSettings();
  let att = currentAttempt(req.user.id);
  if (att && att.status === 'submitted') return res.status(409).json({ error: 'Your exam has already been submitted.', submitted: true });

  if (!att) {
    if (!s.examOpen) return res.status(403).json({ error: 'The exam is not open yet.' });
    if (s.examMode !== 'mcq') return res.status(409).json({ error: 'The MCQ test is not active.' });
    if (!bank().BY_ID.size) return res.status(409).json({ error: 'The exam has no questions yet. Contact the examiner.' });
    let timing = null;
    let totalMs = s.durationMin * 60 * 1000;
    if (s.timingMode === 'section') {
      if (sectionTimesMissing().length) return res.status(409).json({ error: 'The exam is not ready yet (section times are not set). Contact the examiner.' });
      const plan = nonEmptySections().map((x) => ({ key: x.key, title: x.title, sec: x.minutes * 60 }));
      timing = JSON.stringify({ mode: 'section', plan });
      totalMs = plan.reduce((t2, p2) => t2 + p2.sec, 0) * 1000;
    }
    const t = now();
    const r = sql(`INSERT INTO attempts (user_id, status, layout, started_at, deadline, ip, user_agent, timing, sec_index, sec_started_at)
                          VALUES (?, 'in_progress', ?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(req.user.id, JSON.stringify(buildLayout()), t, t + totalMs, req.ip,
        String(req.headers['user-agent'] || '').slice(0, 300), timing, t);
    att = sql('SELECT * FROM attempts WHERE id = ?').get(r.lastInsertRowid);
    att._sec = syncSections(att);
    logEvent(att.id, 'started', `Started from ${req.ip}`, false);
  } else {
    logEvent(att.id, 'resumed', `Exam page reopened from ${req.ip}`, false);
  }

  const layout = parseJSON(att.layout, []);
  const answers = parseJSON(att.answers, {});
  // Questions deleted by the admin after this attempt started are skipped.
  const questions = layout.filter(({ id }) => bank().BY_ID.has(id)).map(({ id, perm }) => {
    const q = bank().BY_ID.get(id);
    return { id, section: q.section, q: q.q, code: q.code || null, sub: q.sub || null, options: perm.map((i) => q.o[i]), marks: q.marks, negative: q.negative };
  });
  const shownAnswers = {};
  for (const { id, perm } of layout) {
    if (answers[id] !== undefined && answers[id] !== null) shownAnswers[id] = perm.indexOf(answers[id]);
  }
  res.json({
    ...studentState(att),
    sections: bank().SECTIONS.map((x) => ({ key: x.key, title: x.title })),
    questions,
    answers: shownAnswers,
  });
});

const lastMinorEvent = new Map(); // attemptId -> time of last non-counted event (throttle)

// Proctoring events carry a client-generated id (seq). The browser re-sends unacknowledged events with
// every event call, answer save and heartbeat, so blocking one endpoint doesn't hide warnings.
// De-duplication is per (seq, type), never a "highest seq seen" mark: a forged request with a huge seq
// cannot make later real warnings look like duplicates, and pre-sending ids with a warning type only
// adds warnings.
function processEvents(att, events) {
  const { maxViolations } = getSettings();
  let result = { violations: att.violations, maxViolations, terminated: false };
  const acked = [];
  if (!Array.isArray(events)) return { ...result, acked };
  for (const e of events.slice(0, 50)) {
    if (!e || !Number.isSafeInteger(e.seq) || e.seq < 1) continue;
    acked.push(e.seq);
    const type = String(e.type || '');
    if (!CLIENT_EVENTS.has(type)) continue;
    if (sql('SELECT 1 FROM events WHERE attempt_id = ? AND client_seq = ? AND type = ?').get(att.id, e.seq, type)) continue;
    const detail = String(e.detail || '').slice(0, 300);
    if (COUNTED_EVENTS.has(type)) {
      result = addViolation(att, type, detail, e.seq);
      att.violations = result.violations;
      if (result.terminated) break;
    } else if ((lastMinorEvent.get(att.id) || 0) <= now() - 2000) {
      lastMinorEvent.set(att.id, now());
      logEvent(att.id, type, detail, false, e.seq);
    }
  }
  return { ...result, acked };
}

app.post('/api/exam/heartbeat', requireApprovedStudent, (req, res) => {
  const att = currentAttempt(req.user.id);
  if (!att) return res.json({ status: 'none' });
  if (att.status !== 'in_progress') return res.json({ status: att.status });
  const ev = processEvents(att, req.body?.events);
  if (ev.terminated) return res.json({ status: 'submitted', ...ev });
  res.json({ ...studentState(att), ...ev });
});

app.post('/api/exam/event', requireApprovedStudent, (req, res) => {
  const att = activeAttemptOr409(req, res);
  if (!att) return;
  res.json(processEvents(att, req.body?.events));
});

app.put('/api/exam/answer', requireApprovedStudent, (req, res) => {
  const att = activeAttemptOr409(req, res);
  if (!att) return;
  const ev = processEvents(att, req.body?.events);
  if (ev.terminated) return res.status(409).json({ error: 'Your exam has already been submitted.', submitted: true, ...ev });
  const { qid, choice } = req.body || {};
  const entry = parseJSON(att.layout, []).find((e) => e.id === qid);
  if (!entry) return res.status(400).json({ error: 'Unknown question.', ...ev });
  const sec = att._sec;
  if (sec) {
    const qSection = bank().BY_ID.get(qid)?.section;
    const inCurrent = qSection === sec.key;
    const justClosed = sec.index > 0 && qSection === sec.plan[sec.index - 1].key && now() <= sec.startedAt + SECTION_GRACE_MS;
    if (!inCurrent && !justClosed) return res.status(409).json({ error: 'This section is closed.', sectionLocked: true, ...ev });
  }
  const answers = parseJSON(att.answers, {});
  if (choice === null) delete answers[qid];
  else if (Number.isInteger(choice) && choice >= 0 && choice < 4) answers[qid] = entry.perm[choice];
  else return res.status(400).json({ error: 'Invalid choice.', ...ev });
  sql('UPDATE attempts SET answers = ? WHERE id = ?').run(JSON.stringify(answers), att.id);
  res.json({ ok: true, remainingSec: remainingSec(att), ...ev });
});

// Finish the current section early and move to the next one (the finished section is locked).
app.post('/api/exam/next-section', requireApprovedStudent, (req, res) => {
  const att = activeAttemptOr409(req, res);
  if (!att) return;
  const sec = att._sec;
  if (!sec) return res.status(400).json({ error: 'This exam does not use section timers.' });
  if (Number(req.body?.from) === sec.index && sec.index < sec.plan.length - 1) {
    const i = sec.index + 1;
    const t = now();
    const restMs = sec.plan.slice(i).reduce((sum, p2) => sum + p2.sec, 0) * 1000;
    sql('UPDATE attempts SET sec_index = ?, sec_started_at = ?, deadline = ? WHERE id = ?').run(i, t, t + restMs, att.id);
    logEvent(att.id, 'section_finished', `Finished "${sec.plan[sec.index].title}" and moved to "${sec.plan[i].title}"`, false);
    const fresh = currentAttempt(req.user.id);
    return res.json(studentState(fresh));
  }
  res.json(studentState(att)); // already moved on (e.g. time ran out) or last section
});

const lastSnapshot = new Map(); // `${attemptId}:${kind}` -> time

const JPEG_PREFIX = 'data:image/jpeg;base64,';
const snapshotDirs = new Set(); // attempt folders already created

app.post('/api/exam/snapshot', requireApprovedStudent, safe(async (req, res) => {
  const att = activeAttemptOr409(req, res);
  if (!att) return;
  const kind = req.body?.kind;
  if (kind !== 'camera' && kind !== 'screen') return res.status(400).json({ error: 'Invalid kind.' });
  const image = req.body?.image;
  if (typeof image !== 'string' || !image.startsWith(JPEG_PREFIX)) return res.status(400).json({ error: 'Invalid image.' });

  const key = `${att.id}:${kind}`;
  if ((lastSnapshot.get(key) || 0) > now() - 8000) return res.json({ ok: true, skipped: true });
  const buf = Buffer.from(image.slice(JPEG_PREFIX.length), 'base64');
  if (buf.length > 1.5 * 1024 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ error: 'Invalid image.' });
  lastSnapshot.set(key, now());

  // Disk writes go through the thread pool so they never pause other students' requests.
  const dir = path.join(SNAPSHOT_DIR, String(att.id));
  if (!snapshotDirs.has(dir)) { await fs.promises.mkdir(dir, { recursive: true }); snapshotDirs.add(dir); }
  const file = `${now()}-${kind}.jpg`;
  await fs.promises.writeFile(path.join(dir, file), buf);
  sql('INSERT INTO snapshots (attempt_id, kind, file, at) VALUES (?, ?, ?, ?)').run(att.id, kind, file, now());
  res.json({ ok: true });
}));

// Microphone clips (webm/ogg, a few seconds long) recorded when the browser detects speech or sound.
const AUDIO_MAX_PER_ATTEMPT = 120;
const lastAudio = new Map(); // attemptId -> time
app.post('/api/exam/audio', requireApprovedStudent, express.raw({ type: ['audio/webm', 'audio/ogg'], limit: '1mb' }), safe(async (req, res) => {
  const att = activeAttemptOr409(req, res);
  if (!att) return;
  const buf = req.body;
  const isWebm = Buffer.isBuffer(buf) && buf.length > 100 && buf.readUInt32BE(0) === 0x1a45dfa3;
  const isOgg = Buffer.isBuffer(buf) && buf.length > 100 && buf.subarray(0, 4).toString('latin1') === 'OggS';
  if (!isWebm && !isOgg) return res.status(400).json({ error: 'Invalid audio.' });
  if ((lastAudio.get(att.id) || 0) > now() - 10000) return res.json({ ok: true, skipped: true });
  if (sql('SELECT COUNT(*) AS n FROM audio_clips WHERE attempt_id = ?').get(att.id).n >= AUDIO_MAX_PER_ATTEMPT) return res.json({ ok: true, skipped: true });
  lastAudio.set(att.id, now());
  const dir = path.join(SNAPSHOT_DIR, String(att.id));
  if (!snapshotDirs.has(dir)) { await fs.promises.mkdir(dir, { recursive: true }); snapshotDirs.add(dir); }
  const file = `${now()}-audio.${isWebm ? 'webm' : 'ogg'}`;
  await fs.promises.writeFile(path.join(dir, file), buf);
  const ms = Math.min(60000, Math.max(0, Number(req.get('X-Duration-Ms')) || 0)) || null;
  sql('INSERT INTO audio_clips (attempt_id, file, duration_ms, at) VALUES (?, ?, ?, ?)').run(att.id, file, ms, now());
  res.json({ ok: true });
}));

app.post('/api/exam/submit', requireApprovedStudent, (req, res) => {
  const att = currentAttempt(req.user.id);
  if (!att) return res.status(404).json({ error: 'You have not started the exam.' });
  if (att.status === 'in_progress' && !processEvents(att, req.body?.events).terminated) {
    finalize(att.id, req.body?.reason === 'time_up' ? 'time_up' : 'submitted');
  }
  res.json({ ok: true });
});

// ---------- admin API ----------
// ---------- use-case round (candidate) ----------
function currentUcAttempt(userId) {
  let att = sql('SELECT * FROM uc_attempts WHERE user_id = ?').get(userId);
  if (att && att.status === 'in_progress' && now() > att.deadline + GRACE_MS) {
    sql("UPDATE uc_attempts SET status = 'submitted', submitted_at = deadline, submit_reason = 'time_up' WHERE id = ? AND status = 'in_progress'").run(att.id);
    att = sql('SELECT * FROM uc_attempts WHERE id = ?').get(att.id);
  }
  return att || null;
}

function ucState(userId) {
  const s = getSettings();
  const att = currentUcAttempt(userId);
  const u = att && att.status === 'in_progress' && att.usecase_id ? uc.getUseCase(att.usecase_id) : null;
  return {
    mode: s.examMode, examOpen: s.examOpen, durationMin: s.ucDurationMin, maxMarks: s.ucMaxMarks,
    useCaseCount: uc.listUseCases().length,
    status: att ? att.status : 'none',
    remainingSec: att && att.status === 'in_progress' ? Math.max(0, Math.ceil((att.deadline - now()) / 1000)) : null,
    submittedAt: att?.submitted_at || null,
    url: att?.url || null,
    usecase: u ? { title: u.title, description: u.description, hasPdf: !!u.pdf_name, pdfName: u.pdf_name } : null,
  };
}

app.get('/api/usecase/state', requireApprovedStudent, (req, res) => res.json(ucState(req.user.id)));

app.post('/api/usecase/start', requireApprovedStudent, (req, res) => {
  const s = getSettings();
  if (s.examMode !== 'usecase') return res.status(409).json({ error: 'The use-case round is not active.' });
  const existing = currentUcAttempt(req.user.id);
  if (existing?.status === 'submitted') return res.status(409).json({ error: 'You have already submitted your solution.', submitted: true });
  if (!existing) {
    if (!s.examOpen) return res.status(403).json({ error: 'The test has not been opened yet.' });
    const pick = uc.pickUseCase();
    if (!pick) return res.status(409).json({ error: 'No use cases are available yet. Please contact the examination authority.' });
    const t = now();
    try {
      sql("INSERT INTO uc_attempts (user_id, usecase_id, status, started_at, deadline, ip) VALUES (?, ?, 'in_progress', ?, ?, ?)")
        .run(req.user.id, pick, t, t + s.ucDurationMin * 60 * 1000, req.ip);
    } catch (e) {
      if (!/UNIQUE/.test(e.message)) throw e; // double click: the first request already created it
    }
  }
  res.json(ucState(req.user.id));
});

// The assigned PDF, shown inside the test page (same-origin framing allowed for this response only).
app.get('/api/usecase/pdf', requireApprovedStudent, (req, res) => {
  const att = currentUcAttempt(req.user.id);
  const u = att && att.usecase_id ? uc.getUseCase(att.usecase_id) : null;
  if (!u || !u.pdf_name || !fs.existsSync(uc.pdfPath(u.id))) return res.status(404).json({ error: 'No document is attached.' });
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${u.pdf_name.replace(/"/g, '')}"`);
  res.sendFile(uc.pdfPath(u.id));
});

app.post('/api/usecase/submit', requireApprovedStudent, (req, res) => {
  const att = currentUcAttempt(req.user.id);
  if (!att) return res.status(404).json({ error: 'You have not started the test.' });
  if (att.status === 'submitted') return res.status(409).json({ error: 'You have already submitted your solution.', submitted: true });
  // Without a link, the attempt can only be closed once the time is (almost) over.
  if (req.body?.url === null && req.body?.reason === 'time_up' && now() >= att.deadline - 5000) {
    sql("UPDATE uc_attempts SET status = 'submitted', submitted_at = ?, submit_reason = 'time_up' WHERE id = ? AND status = 'in_progress'").run(now(), att.id);
    return res.json(ucState(req.user.id));
  }
  const { url, error } = uc.validUrl(req.body?.url);
  if (error) return res.status(400).json({ error });
  sql("UPDATE uc_attempts SET status = 'submitted', submitted_at = ?, submit_reason = ?, url = ? WHERE id = ? AND status = 'in_progress'")
    .run(now(), req.body?.reason === 'time_up' ? 'time_up' : 'submitted', url, att.id);
  res.json(ucState(req.user.id));
});

const admin = express.Router();
admin.use(requireRole('admin'));

admin.get('/summary', (req, res) => {
  const rows = sql(`
    SELECT u.id, u.username, u.name, u.status AS approval, u.created_at,
           a.id AS attempt_id, a.status, a.score, a.section_scores, a.violations,
           a.started_at, a.submitted_at, a.submit_reason, a.deadline,
           (SELECT COUNT(*) FROM snapshots s WHERE s.attempt_id = a.id) AS snapshot_count,
           ua.status AS uc_status
    FROM users u LEFT JOIN attempts a ON a.user_id = u.id LEFT JOIN uc_attempts ua ON ua.user_id = u.id
    WHERE u.role = 'student' ORDER BY u.username`).all();
  res.json({
    settings: getSettings(),
    maxScore: bank().MAX_SCORE,
    sections: bank().SECTIONS.map((s) => ({ key: s.key, title: s.title, maxScore: s.maxScore })),
    students: rows.map((r) => ({
      id: r.id, username: r.username, name: r.name,
      approval: r.approval, registeredAt: r.created_at,
      status: r.status || 'not_started',
      ucStatus: r.uc_status || 'not_started',
      score: r.score, sectionScores: parseJSON(r.section_scores, null),
      violations: r.violations || 0, snapshotCount: r.snapshot_count || 0,
      startedAt: r.started_at, submittedAt: r.submitted_at,
      submitReason: r.submit_reason ? (SUBMIT_REASONS[r.submit_reason] || r.submit_reason) : null,
      remainingSec: r.status === 'in_progress' ? Math.max(0, Math.ceil((r.deadline - now()) / 1000)) : null,
    })),
  });
});

admin.get('/students/:id', (req, res) => {
  const user = sql("SELECT id, username, name FROM users WHERE id = ? AND role = 'student'").get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Student not found.' });
  const att = currentAttempt(user.id);
  if (!att) return res.json({ user, attempt: null });

  const answers = parseJSON(att.answers, {});
  const review = bank().SECTIONS.flatMap((s) => s.items.map((item) => {
    const q = bank().BY_ID.get(item.id);
    const chosen = answers[item.id] ?? null;
    return {
      id: q.id, section: q.section, q: q.q, code: q.code || null, sub: q.sub || null, options: q.o,
      correct: q.correct, chosen, result: chosen === null ? 'unattempted' : chosen === q.correct ? 'correct' : 'wrong',
    };
  }));
  const live = att.status === 'in_progress' ? scoreAnswers(answers) : null;

  res.json({
    user,
    attempt: {
      status: att.status, startedAt: att.started_at, submittedAt: att.submitted_at, deadline: att.deadline,
      submitReason: att.submit_reason ? (SUBMIT_REASONS[att.submit_reason] || att.submit_reason) : null,
      score: att.score ?? live?.total ?? null,
      sectionScores: parseJSON(att.section_scores, null) || live?.sections || null,
      provisional: att.status === 'in_progress',
      violations: att.violations, ip: att.ip, userAgent: att.user_agent,
      remainingSec: att.status === 'in_progress' ? remainingSec(att) : null,
      section: att._sec ? { number: att._sec.index + 1, of: att._sec.plan.length, title: att._sec.plan[att._sec.index].title, remainingSec: att._sec.remainingSec } : null,
    },
    letters: LETTERS,
    review,
    events: sql('SELECT type, detail, counted, at FROM events WHERE attempt_id = ? ORDER BY at').all(att.id),
    snapshots: sql('SELECT id, kind, at FROM snapshots WHERE attempt_id = ? ORDER BY at').all(att.id),
    audio: sql('SELECT id, duration_ms AS durationMs, at FROM audio_clips WHERE attempt_id = ? ORDER BY at').all(att.id),
  });
});

admin.get('/audio/:id', (req, res) => {
  const clip = sql('SELECT attempt_id, file FROM audio_clips WHERE id = ?').get(Number(req.params.id));
  if (!clip) return res.status(404).end();
  const file = path.join(SNAPSHOT_DIR, String(clip.attempt_id), path.basename(clip.file));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Content-Type', clip.file.endsWith('.ogg') ? 'audio/ogg' : 'audio/webm');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(file);
});

admin.get('/snapshots/:id', (req, res) => {
  const snap = sql('SELECT attempt_id, file FROM snapshots WHERE id = ?').get(Number(req.params.id));
  if (!snap) return res.status(404).end();
  const file = path.join(SNAPSHOT_DIR, String(snap.attempt_id), path.basename(snap.file));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(file);
});

// Admin-created students are approved immediately. A blank password gets a generated one,
// which is returned once so the admin can hand it out.
admin.post('/students', safe(async (req, res) => {
  const list = Array.isArray(req.body?.students) ? req.body.students : [];
  if (!list.length) return res.status(400).json({ error: 'No students provided.' });
  if (list.length > 2000) return res.status(400).json({ error: 'At most 2000 students at a time.' });
  const created = [];
  const skipped = [];
  const seen = new Set();
  for (const raw of list) {
    const username = String(raw?.username || '').trim();
    const name = String(raw?.name || '').trim().replace(/\s+/g, ' ').slice(0, 100);
    let password = String(raw?.password || '').trim();
    if (!USERNAME_RE.test(username)) { skipped.push({ username, reason: 'Invalid roll number (2–40 letters, digits, . _ -)' }); continue; }
    if (name.length < 2) { skipped.push({ username, reason: 'Name is required' }); continue; }
    if (password && password.length < 6) { skipped.push({ username, reason: 'Password must be at least 6 characters' }); continue; }
    if (seen.has(username.toLowerCase()) || sql('SELECT 1 FROM users WHERE username = ?').get(username)) {
      skipped.push({ username, reason: 'Roll number already exists' });
      continue;
    }
    seen.add(username.toLowerCase());
    if (!password) password = generatePassword();
    try {
      sql("INSERT INTO users (username, name, password_hash, role, status, created_at) VALUES (?, ?, ?, 'student', 'approved', ?)")
        .run(username, name, await hashPassword(password), now());
      created.push({ username, name, password });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) skipped.push({ username, reason: 'Roll number already exists' });
      else throw e;
    }
  }
  res.json({ created, skipped });
}));

// Approve or reject self-registered students.
function setApproval(ids, status) {
  const upd = sql("UPDATE users SET status = ? WHERE id = ? AND role = 'student'");
  let changed = 0;
  for (const id of ids) changed += upd.run(status, id).changes;
  if (status === 'rejected') {
    const del = sql('DELETE FROM sessions WHERE user_id = ?');
    for (const id of ids) del.run(id);
  }
  return changed;
}

admin.post('/students/:id/approve', (req, res) => {
  if (!setApproval([Number(req.params.id)], 'approved')) return res.status(404).json({ error: 'Student not found.' });
  res.json({ ok: true });
});

admin.post('/students/:id/reject', (req, res) => {
  if (!setApproval([Number(req.params.id)], 'rejected')) return res.status(404).json({ error: 'Student not found.' });
  res.json({ ok: true });
});

admin.post('/students/approve-all', (req, res) => {
  const ids = sql("SELECT id FROM users WHERE role = 'student' AND status = 'pending'").all().map((r) => r.id);
  res.json({ approved: setApproval(ids, 'approved') });
});

admin.post('/students/:id/password', safe(async (req, res) => {
  const user = sql("SELECT id, username FROM users WHERE id = ? AND role = 'student'").get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Student not found.' });
  let password = String(req.body?.password || '').trim();
  if (password && password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (!password) password = generatePassword();
  sql('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
  sql('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  res.json({ username: user.username, password });
}));

admin.post('/students/:id/reset-attempt', (req, res) => {
  if (getSettings().examMode === 'usecase') {
    const r = sql('DELETE FROM uc_attempts WHERE user_id = ?').run(Number(req.params.id));
    return r.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'This candidate has no use-case attempt.' });
  }
  const att = sql('SELECT id FROM attempts WHERE user_id = ?').get(Number(req.params.id));
  if (!att) return res.status(404).json({ error: 'This student has no attempt.' });
  sql('DELETE FROM attempts WHERE id = ?').run(att.id);
  removeSnapshotDir(att.id);
  res.json({ ok: true });
});

admin.post('/students/:id/force-submit', (req, res) => {
  const att = sql("SELECT id FROM attempts WHERE user_id = ? AND status = 'in_progress'").get(Number(req.params.id));
  if (!att) return res.status(404).json({ error: 'No exam in progress for this student.' });
  finalize(att.id, 'admin');
  res.json({ ok: true });
});

admin.delete('/students/:id', (req, res) => {
  const user = sql("SELECT id FROM users WHERE id = ? AND role = 'student'").get(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'Student not found.' });
  const att = sql('SELECT id FROM attempts WHERE user_id = ?').get(user.id);
  sql('DELETE FROM users WHERE id = ?').run(user.id);
  if (att) removeSnapshotDir(att.id);
  res.json({ ok: true });
});

admin.get('/metrics', (req, res) => {
  const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
  const routes = {};
  for (const [key, arr] of routeTimes) {
    const sorted = [...arr].sort((x, y) => x - y);
    routes[key] = { count: arr.length, p50: +pct(sorted, 0.5).toFixed(1), p95: +pct(sorted, 0.95).toFixed(1), p99: +pct(sorted, 0.99).toFixed(1), max: +sorted[sorted.length - 1].toFixed(1) };
  }
  const ms = (ns) => +(ns / 1e6).toFixed(1);
  const out = {
    uptimeSec: Math.round(process.uptime()),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    liveAttempts: sql("SELECT COUNT(*) AS n FROM attempts WHERE status = 'in_progress'").get().n,
    connections: { ...conn },
    eventLoopDelayMs: { p50: ms(loopDelay.percentile(50)), p99: ms(loopDelay.percentile(99)), max: ms(loopDelay.max) },
    routes,
  };
  if (req.query.reset) { routeTimes.clear(); loopDelay.reset(); conn.opened = 0; }
  res.json(out);
});

admin.get('/settings', (req, res) => res.json(getSettings()));

admin.put('/settings', (req, res) => {
  const b = req.body || {};
  const errors = [];
  const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (b.examOpen !== undefined) setSetting('exam_open', b.examOpen ? '1' : '0');
  if (b.registrationOpen !== undefined) setSetting('registration_open', b.registrationOpen ? '1' : '0');
  if (b.durationMin !== undefined) intIn(b.durationMin, 1, 600) ? setSetting('duration_min', b.durationMin) : errors.push('Duration must be 1–600 minutes.');
  if (b.maxViolations !== undefined) intIn(b.maxViolations, 1, MAX_WARNINGS) ? setSetting('max_violations', b.maxViolations) : errors.push(`Warning limit must be between 1 and ${MAX_WARNINGS}.`);
  if (b.snapshotIntervalSec !== undefined) intIn(b.snapshotIntervalSec, 10, 600) ? setSetting('snapshot_interval_sec', b.snapshotIntervalSec) : errors.push('Snapshot interval must be 10–600 seconds.');
  if (b.timingMode !== undefined) ['overall', 'section'].includes(b.timingMode) ? setSetting('timing_mode', b.timingMode) : errors.push('Unknown timing mode.');
  for (const [field, key, label] of [['orgName', 'org_name', 'Organisation name'], ['examName', 'exam_name', 'Examination name']]) {
    if (b[field] === undefined) continue;
    const v = String(b[field]).trim().replace(/\s+/g, ' ');
    if (!v || v.length > 80) errors.push(`${label} must be 1–80 characters.`);
    else setSetting(key, v);
  }
  const liveTests = () => sql("SELECT (SELECT COUNT(*) FROM attempts WHERE status = 'in_progress') + (SELECT COUNT(*) FROM uc_attempts WHERE status = 'in_progress') AS n").get().n;
  if (b.examMode !== undefined && b.examMode !== getSettings().examMode) {
    if (!['mcq', 'usecase'].includes(b.examMode)) errors.push('Unknown test type.');
    else if (liveTests()) errors.push('Candidates are taking a test right now. The test type can be changed after they finish.');
    else setSetting('exam_mode', b.examMode);
  }
  if (b.ucDurationMin !== undefined) intIn(b.ucDurationMin, 1, 600) ? setSetting('uc_duration_min', b.ucDurationMin) : errors.push('Use-case duration must be 1–600 minutes.');
  if (b.ucMaxMarks !== undefined) intIn(b.ucMaxMarks, 1, 1000) ? setSetting('uc_max_marks', b.ucMaxMarks) : errors.push('Use-case maximum marks must be 1–1000.');
  const st = getSettings();
  if (st.examMode === 'usecase' && st.examOpen && !uc.listUseCases().length) {
    setSetting('exam_open', '0');
    errors.push('Add at least one use case before opening the use-case round. The test was kept closed.');
  }
  if (st.examMode === 'mcq' && st.timingMode === 'section' && st.examOpen && sectionTimesMissing().length) {
    setSetting('exam_open', '0');
    errors.push(`Set a time for every section before opening the exam (missing: ${sectionTimesMissing().join(', ')}). The exam was kept closed.`);
  }
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  res.json(getSettings());
});

// ---------- question bank ----------
// Re-score submitted attempts so results stay correct after the admin edits questions or answers.
function rescoreSubmitted() {
  const upd = sql('UPDATE attempts SET score = ?, section_scores = ? WHERE id = ?');
  for (const att of sql("SELECT id, answers FROM attempts WHERE status = 'submitted'").all()) {
    const { total, sections } = scoreAnswers(parseJSON(att.answers, {}));
    upd.run(total, JSON.stringify(sections), att.id);
  }
}

const liveAttempts = () => sql("SELECT COUNT(*) AS n FROM attempts WHERE status = 'in_progress'").get().n;

admin.get('/questions', (req, res) => {
  const { SECTIONS } = bank();
  res.json({
    sections: bank().SECTIONS.map((sec) => ({ key: sec.key, title: sec.title, prefix: sec.prefix, minutes: sec.minutes, count: sec.items.length, maxScore: sec.maxScore })),
    timingMode: getSettings().timingMode,
    questions: SECTIONS.flatMap((sec) => sec.items.map((q) => ({
      id: q.id, section: q.section, q: q.q, code: q.code, sub: q.sub, options: q.o, answer: q.correct, solution: q.s,
      marks: q.marks, negative: q.negative,
    }))),
    liveAttempts: liveAttempts(),
  });
});

admin.post('/questions', (req, res) => {
  if (liveAttempts()) return res.status(409).json({ error: 'Students are taking the exam right now. Add questions before or after the exam.' });
  const { errors, value } = validate(req.body);
  if (errors) return res.status(400).json({ error: errors.join(' ') });
  const id = createQuestion(value);
  rescoreSubmitted();
  res.json({ id });
});

admin.put('/questions/:id', (req, res) => {
  const { errors, value } = validate(req.body);
  if (errors) return res.status(400).json({ error: errors.join(' ') });
  const current = bank().BY_ID.get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Question not found.' });
  if (current.section !== value.section && liveAttempts()) {
    return res.status(409).json({ error: 'Students are taking the exam right now, so a question cannot move to another section.' });
  }
  if (liveAttempts() && (JSON.stringify(current.o) !== JSON.stringify(value.options) || current.correct !== value.answer)) {
    return res.status(409).json({ error: 'Candidates are taking the exam right now. You can fix typos in the question stem, but options and answer keys cannot be modified during live tests.' });
  }
  updateQuestion(req.params.id, value);
  rescoreSubmitted();
  res.json({ ok: true });
});

// Sections: add, rename, reorder, delete (deleting also removes the section's questions).
const sectionResult = (res, r) => (r.error ? res.status(r.status || 400).json({ error: r.error }) : res.json(r));

admin.post('/sections', (req, res) => {
  if (liveAttempts()) return res.status(409).json({ error: 'Students are taking the exam right now. Add sections before or after the exam.' });
  const r = createSection(req.body?.name);
  if (!r.error) rescoreSubmitted();
  sectionResult(res, r);
});

admin.put('/sections/:key', (req, res) => {
  if (req.body?.marks !== undefined || req.body?.negative !== undefined) {
    const r = setSectionMarks(req.params.key, req.body.marks, req.body.negative);
    if (!r.error) rescoreSubmitted();
    return sectionResult(res, r);
  }
  if (req.body?.minutes !== undefined) {
    const m = req.body.minutes === null || req.body.minutes === '' ? null : Number(req.body.minutes);
    const r = setSectionMinutes(req.params.key, m);
    if (r.error || req.body?.name === undefined) return sectionResult(res, r);
  }
  sectionResult(res, renameSection(req.params.key, req.body?.name));
});

admin.post('/sections/:key/move', (req, res) => sectionResult(res, moveSection(req.params.key, Number(req.body?.dir))));

admin.delete('/sections/:key', (req, res) => {
  if (liveAttempts()) return res.status(409).json({ error: 'Students are taking the exam right now. Delete sections before or after the exam.' });
  const r = deleteSection(req.params.key);
  if (!r.error) rescoreSubmitted();
  sectionResult(res, r);
});

admin.delete('/questions/:id', (req, res) => {
  if (liveAttempts()) return res.status(409).json({ error: 'Students are taking the exam right now. Delete questions before or after the exam.' });
  if (!deleteQuestion(req.params.id)) return res.status(404).json({ error: 'Question not found.' });
  rescoreSubmitted();
  res.json({ ok: true });
});

// ---------- use cases (admin) ----------
const pdfBody = express.raw({ type: 'application/pdf', limit: '25mb' });
const ucPublic = (u) => ({ id: u.id, title: u.title, description: u.description, pdfName: u.pdf_name, pdfSize: u.pdf_size, assigned: u.assigned ?? 0 });

admin.get('/usecases', (req, res) => res.json({ usecases: uc.listUseCases().map(ucPublic), settings: getSettings() }));

admin.post('/usecases', (req, res) => {
  const { value, error } = uc.validateUseCase(req.body);
  if (error) return res.status(400).json({ error });
  res.json({ id: uc.createUseCase(value) });
});

admin.put('/usecases/:id', (req, res) => {
  const { value, error } = uc.validateUseCase(req.body);
  if (error) return res.status(400).json({ error });
  if (!uc.updateUseCase(req.params.id, value)) return res.status(404).json({ error: 'Use case not found.' });
  res.json({ ok: true });
});

admin.delete('/usecases/:id', (req, res) => {
  const r = uc.deleteUseCase(req.params.id);
  r.error ? res.status(r.status || 400).json({ error: r.error }) : res.json(r);
});

admin.put('/usecases/:id/pdf', pdfBody, (req, res) => {
  const r = uc.savePdf(req.params.id, req.body, req.get('X-File-Name') ? decodeURIComponent(req.get('X-File-Name')) : 'use-case.pdf');
  r.error ? res.status(r.status || 400).json({ error: r.error }) : res.json(r);
});

admin.delete('/usecases/:id/pdf', (req, res) => {
  const r = uc.removePdf(req.params.id);
  r.error ? res.status(r.status || 400).json({ error: r.error }) : res.json(r);
});

admin.get('/usecases/:id/pdf', (req, res) => {
  const u = uc.getUseCase(req.params.id);
  if (!u || !u.pdf_name || !fs.existsSync(uc.pdfPath(u.id))) return res.status(404).end();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${u.pdf_name.replace(/"/g, '')}"`);
  res.sendFile(uc.pdfPath(u.id));
});

// Results of the use-case round, with evaluation.
function ucResults() {
  return sql(`
    SELECT u.id, u.username, u.name, ua.status, ua.started_at, ua.deadline, ua.submitted_at, ua.submit_reason,
           ua.url, ua.marks, ua.remarks, ua.evaluated_at, uc.title AS usecase
    FROM users u LEFT JOIN uc_attempts ua ON ua.user_id = u.id LEFT JOIN usecases uc ON uc.id = ua.usecase_id
    WHERE u.role = 'student' AND u.status = 'approved' ORDER BY u.username`).all().map((r) => ({
    id: r.id, username: r.username, name: r.name, status: r.status || 'not_started', usecase: r.usecase || null,
    startedAt: r.started_at, submittedAt: r.submitted_at,
    submitReason: r.submit_reason === 'time_up' ? 'Time over' : r.submit_reason === 'admin' ? 'Force-submitted by admin' : r.submit_reason ? 'Submitted by candidate' : null,
    remainingSec: r.status === 'in_progress' ? Math.max(0, Math.ceil((r.deadline - now()) / 1000)) : null,
    url: r.url, marks: r.marks, remarks: r.remarks, evaluatedAt: r.evaluated_at,
  }));
}

admin.get('/usecase-results', (req, res) => res.json({ settings: getSettings(), results: ucResults() }));

admin.put('/usecase-results/:id', (req, res) => {
  const att = sql('SELECT * FROM uc_attempts WHERE user_id = ?').get(Number(req.params.id));
  if (!att) return res.status(404).json({ error: 'This candidate has not attempted the use-case round.' });
  if (att.status !== 'submitted') return res.status(409).json({ error: 'Marks can be entered after the candidate submits.' });
  const max = getSettings().ucMaxMarks;
  const raw = req.body?.marks;
  const marks = raw === null || raw === '' || raw === undefined ? null : Number(raw);
  if (marks !== null && !(Number.isFinite(marks) && marks >= 0 && marks <= max)) return res.status(400).json({ error: `Marks must be between 0 and ${max}.` });
  const remarks = String(req.body?.remarks || '').trim().slice(0, 1000) || null;
  sql('UPDATE uc_attempts SET marks = ?, remarks = ?, evaluated_at = ? WHERE id = ?')
    .run(marks === null ? null : Math.round(marks * 100) / 100, remarks, marks === null ? null : now(), att.id);
  res.json({ ok: true });
});

admin.post('/usecase-results/:id/force-submit', (req, res) => {
  const r = sql("UPDATE uc_attempts SET status = 'submitted', submitted_at = ?, submit_reason = 'admin' WHERE user_id = ? AND status = 'in_progress'").run(now(), Number(req.params.id));
  r.changes ? res.json({ ok: true }) : res.status(404).json({ error: 'No use-case attempt in progress for this candidate.' });
});

admin.get('/export.csv', (req, res) => {
  const cell = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // block spreadsheet formula injection
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const iso = (t) => (t ? new Date(t).toISOString() : '');
  if (getSettings().examMode === 'usecase') {
    const max = getSettings().ucMaxMarks;
    const lines = [['Roll No', 'Name', 'Status', 'Use Case', 'Solution Link', `Marks (/${max})`, 'Remarks', 'Started (UTC)', 'Submitted (UTC)', 'Submit reason'].map(cell).join(',')];
    for (const r of ucResults()) {
      lines.push([r.username, r.name, r.status, r.usecase || '', r.url || '', r.marks ?? '', r.remarks || '', iso(r.startedAt), iso(r.submittedAt), r.submitReason || ''].map(cell).join(','));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="use-case-results.csv"');
    return res.send('\uFEFF' + lines.join('\r\n'));
  }
  const header = ['Roll No', 'Name', 'Status', `Score (/${bank().MAX_SCORE})`, ...bank().SECTIONS.map((s) => s.title),
    'Correct', 'Wrong', 'Unattempted', 'Warnings', 'Started (UTC)', 'Submitted (UTC)', 'Submit reason'];
  const rows = sql(`
    SELECT u.username, u.name, a.status, a.score, a.section_scores, a.violations, a.started_at, a.submitted_at, a.submit_reason
    FROM users u LEFT JOIN attempts a ON a.user_id = u.id
    WHERE u.role = 'student' AND u.status = 'approved' ORDER BY a.score DESC NULLS LAST, u.username`).all();
  const lines = [header.map(cell).join(',')];
  for (const r of rows) {
    const sec = parseJSON(r.section_scores, null);
    const sum = (k) => (sec ? Object.values(sec).reduce((t, x) => t + x[k], 0) : '');
    lines.push([
      r.username, r.name, r.status || 'not_started', r.score ?? '',
      ...bank().SECTIONS.map((s) => sec?.[s.key]?.score ?? ''),
      sum('correct'), sum('wrong'), sum('unattempted'), r.violations ?? '',
      iso(r.started_at), iso(r.submitted_at), r.submit_reason ? (SUBMIT_REASONS[r.submit_reason] || r.submit_reason) : '',
    ].map(cell).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="exam-results.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

app.use('/api/admin', admin);

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

// On hosts without a shell (e.g. Render), the first admin can be created from ADMIN_USERNAME / ADMIN_PASSWORD.
async function bootstrapAdmin() {
  const admins = sql("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
  const { ADMIN_USERNAME, ADMIN_PASSWORD } = process.env;
  if (!admins && ADMIN_USERNAME && ADMIN_PASSWORD) {
    sql("INSERT INTO users (username, name, password_hash, role, status, created_at) VALUES (?, ?, ?, 'admin', 'approved', ?)")
      .run(ADMIN_USERNAME, 'Administrator', await hashPassword(ADMIN_PASSWORD, { admin: true }), now());
    console.log(`Admin "${ADMIN_USERNAME}" created from environment variables.`);
    return;
  }
  if (!admins) console.log('No admin account yet. Set ADMIN_USERNAME and ADMIN_PASSWORD, or run: npm run create-admin -- <username> <password> "<Full Name>"');
}

bootstrapAdmin().then(() => {
  const server = http.createServer(app);
  // Behind Render's load balancer: keep idle connections open longer than the proxy does.
  server.on('connection', (socket) => { conn.opened++; conn.open++; socket.on('close', () => { conn.open--; }); });
  server.keepAliveTimeout = 65 * 1000;
  server.headersTimeout = 66 * 1000;
  // A large accept backlog absorbs the moment when every student clicks "Start" together.
  server.listen({ port: PORT, backlog: 4096 }, () => console.log(`Assessment portal running on http://localhost:${PORT}`));
});
