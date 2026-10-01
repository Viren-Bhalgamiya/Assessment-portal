'use strict';
// Use-case round: problem statements (with an optional PDF) and each candidate's single timed attempt,
// in which they submit one solution link that the admin evaluates.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, sql, DATA_DIR } = require('./db');

const UC_DIR = path.join(DATA_DIR, 'usecases');
fs.mkdirSync(UC_DIR, { recursive: true });

db.exec(`
  CREATE TABLE IF NOT EXISTS usecases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    pdf_name    TEXT,            -- original file name of the attached PDF, or NULL
    pdf_size    INTEGER,
    position    INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS uc_attempts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    usecase_id    INTEGER REFERENCES usecases(id),
    status        TEXT NOT NULL CHECK (status IN ('in_progress', 'submitted')),
    started_at    INTEGER NOT NULL,
    deadline      INTEGER NOT NULL,
    submitted_at  INTEGER,
    submit_reason TEXT,
    url           TEXT,
    marks         REAL,
    remarks       TEXT,
    evaluated_at  INTEGER,
    ip            TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_uc_attempts_status ON uc_attempts(status, deadline);
`);

const pdfPath = (id) => path.join(UC_DIR, `${Number(id)}.pdf`);

function listUseCases() {
  return sql(`SELECT u.*, (SELECT COUNT(*) FROM uc_attempts a WHERE a.usecase_id = u.id) AS assigned
              FROM usecases u ORDER BY u.position, u.id`).all();
}
const getUseCase = (id) => sql('SELECT * FROM usecases WHERE id = ?').get(Number(id)) || null;

function validateUseCase(input) {
  const title = String(input?.title || '').trim().replace(/\s+/g, ' ');
  const description = String(input?.description || '').replace(/\r\n/g, '\n').trim();
  if (!title) return { error: 'Enter a title for the use case.' };
  if (title.length > 150) return { error: 'Title must be under 150 characters.' };
  if (description.length > 20000) return { error: 'Description must be under 20,000 characters.' };
  return { value: { title, description } };
}

function createUseCase(v) {
  const position = (sql('SELECT MAX(position) AS p FROM usecases').get().p ?? -1) + 1;
  return Number(sql('INSERT INTO usecases (title, description, position, created_at) VALUES (?, ?, ?, ?)')
    .run(v.title, v.description, position, Date.now()).lastInsertRowid);
}

const updateUseCase = (id, v) => sql('UPDATE usecases SET title = ?, description = ? WHERE id = ?').run(v.title, v.description, Number(id)).changes > 0;

function deleteUseCase(id) {
  const uc = getUseCase(id);
  if (!uc) return { error: 'Use case not found.', status: 404 };
  const assigned = sql('SELECT COUNT(*) AS n FROM uc_attempts WHERE usecase_id = ?').get(uc.id).n;
  if (assigned) return { error: `This use case has been assigned to ${assigned} candidate${assigned === 1 ? '' : 's'} and cannot be deleted.`, status: 409 };
  sql('DELETE FROM usecases WHERE id = ?').run(uc.id);
  fs.rmSync(pdfPath(uc.id), { force: true });
  return { ok: true };
}

function savePdf(id, buf, name) {
  const uc = getUseCase(id);
  if (!uc) return { error: 'Use case not found.', status: 404 };
  if (!Buffer.isBuffer(buf) || buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') return { error: 'The file is not a valid PDF.' };
  fs.writeFileSync(pdfPath(uc.id), buf);
  const safeName = String(name || 'use-case.pdf').replace(/[^\w .()-]/g, '_').slice(0, 120) || 'use-case.pdf';
  sql('UPDATE usecases SET pdf_name = ?, pdf_size = ? WHERE id = ?').run(safeName, buf.length, uc.id);
  return { ok: true };
}

function removePdf(id) {
  const uc = getUseCase(id);
  if (!uc) return { error: 'Use case not found.', status: 404 };
  fs.rmSync(pdfPath(uc.id), { force: true });
  sql('UPDATE usecases SET pdf_name = NULL, pdf_size = NULL WHERE id = ?').run(uc.id);
  return { ok: true };
}

// Each candidate gets one use case at random.
function pickUseCase() {
  const ids = sql('SELECT id FROM usecases').all().map((r) => r.id);
  return ids.length ? ids[crypto.randomInt(ids.length)] : null;
}

// A valid http(s) link, at most 2000 characters.
function validUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return { error: 'Enter the link to your solution.' };
  if (s.length > 2000) return { error: 'The link is too long.' };
  let u;
  try { u = new URL(s); } catch { return { error: 'Enter a complete link starting with https:// (for example https://drive.google.com/...).' }; }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname.includes('.')) return { error: 'Enter a complete link starting with https://.' };
  return { url: u.toString() };
}

module.exports = {
  UC_DIR, pdfPath, listUseCases, getUseCase, validateUseCase, createUseCase, updateUseCase, deleteUseCase,
  savePdf, removePdf, pickUseCase, validUrl,
};
