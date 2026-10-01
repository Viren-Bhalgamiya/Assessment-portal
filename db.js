'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SNAPSHOT_DIR = path.join(DATA_DIR, 'snapshots');
fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'exam.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('student', 'admin')),
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  -- One attempt per student. layout = per-student question order and option permutation.
  -- answers = {questionId: originalOptionIndex}.
  CREATE TABLE IF NOT EXISTS attempts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id        INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    status         TEXT NOT NULL CHECK (status IN ('in_progress', 'submitted')),
    layout         TEXT NOT NULL,
    answers        TEXT NOT NULL DEFAULT '{}',
    started_at     INTEGER NOT NULL,
    deadline       INTEGER NOT NULL,
    submitted_at   INTEGER,
    submit_reason  TEXT,
    score          INTEGER,
    section_scores TEXT,
    violations     INTEGER NOT NULL DEFAULT 0,
    ip             TEXT,
    user_agent     TEXT
  );

  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    type       TEXT NOT NULL,
    detail     TEXT,
    counted    INTEGER NOT NULL DEFAULT 0,
    at         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS snapshots (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL CHECK (kind IN ('camera', 'screen')),
    file       TEXT NOT NULL,
    at         INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_attempt ON events(attempt_id);
  CREATE INDEX IF NOT EXISTS idx_snapshots_attempt ON snapshots(attempt_id);

  -- short microphone recordings, taken when speech or other sound is detected during the MCQ test
  CREATE TABLE IF NOT EXISTS audio_clips (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_id  INTEGER NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    file        TEXT NOT NULL,
    duration_ms INTEGER,
    at          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audio_attempt ON audio_clips(attempt_id);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Students register themselves and wait for admin approval: pending -> approved | rejected.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'status')) {
  db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
}
// Highest client event sequence number processed, so re-sent events are never double-counted.
if (!db.prepare('PRAGMA table_info(attempts)').all().some((c) => c.name === 'last_seq')) {
  db.exec('ALTER TABLE attempts ADD COLUMN last_seq INTEGER NOT NULL DEFAULT 0');
}

// Per-section timing: the plan frozen at start, the current section and when it started.
for (const [col, type] of [['timing', 'TEXT'], ['sec_index', 'INTEGER NOT NULL DEFAULT 0'], ['sec_started_at', 'INTEGER']]) {
  if (!db.prepare('PRAGMA table_info(attempts)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE attempts ADD COLUMN ${col} ${type}`);
}

// Client-side id of each proctoring event, so a re-sent event is recorded only once.
if (!db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'client_seq')) {
  db.exec('ALTER TABLE events ADD COLUMN client_seq INTEGER');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_client ON events(attempt_id, client_seq, type) WHERE client_seq IS NOT NULL');

// Indexes for the hot paths at 1000+ concurrent students.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS idx_attempts_status ON attempts(status, deadline);
  CREATE INDEX IF NOT EXISTS idx_snapshots_attempt_kind_at ON snapshots(attempt_id, kind, at);
`);

const DEFAULT_SETTINGS = {
  exam_open: '0',
  registration_open: '1',
  exam_mode: 'mcq',          // 'mcq' = MCQ test (engineering); 'usecase' = use-case round
  uc_duration_min: '120',
  uc_max_marks: '100',
  org_name: 'Online Examination System',
  exam_name: 'Technical Assessment 2026',
  timing_mode: 'overall',   // 'overall' = one timer; 'section' = a timer per section
  duration_min: '150',
  max_violations: '3',
  snapshot_interval_sec: '60',
};
const insertDefault = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertDefault.run(k, v);

// Warning limit is capped at 3; older databases may still hold a higher value.
db.prepare("UPDATE settings SET value = '3' WHERE key = 'max_violations' AND (CAST(value AS INTEGER) > 3 OR CAST(value AS INTEGER) < 1)").run();

// Settings are read on almost every request, so they are cached in memory (single server process).
let settingsCache = null;

function getSettings() {
  if (settingsCache) return settingsCache;
  const map = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) map[row.key] = row.value;
  settingsCache = Object.freeze({
    examOpen: map.exam_open === '1',
    registrationOpen: map.registration_open === '1',
    examMode: map.exam_mode === 'usecase' ? 'usecase' : 'mcq',
    ucDurationMin: Number(map.uc_duration_min) || 120,
    ucMaxMarks: Number(map.uc_max_marks) || 100,
    orgName: map.org_name || 'Online Examination System',
    examName: map.exam_name || 'Technical Assessment',
    timingMode: map.timing_mode === 'section' ? 'section' : 'overall',
    durationMin: Number(map.duration_min),
    maxViolations: Number(map.max_violations),
    snapshotIntervalSec: Number(map.snapshot_interval_sec),
  });
  return settingsCache;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
  settingsCache = null;
}

// Prepared statements are compiled once and reused: re-preparing on every request
// was the largest CPU cost when 1000 students start at once.
const statements = new Map();
function sql(text) {
  let st = statements.get(text);
  if (!st) statements.set(text, (st = db.prepare(text)));
  return st;
}

module.exports = { db, sql, DATA_DIR, SNAPSHOT_DIR, getSettings, setSetting };
