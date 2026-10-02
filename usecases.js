'use strict';
// Use-case round: problem statements (with an optional PDF) and each candidate's single timed attempt,
// in which they submit one solution link that the admin evaluates.
const crypto = require('crypto');
const { sql } = require('./db');
const storage = require('./storage');

const pdfKey = (id) => `usecases/${Number(id)}.pdf`;

async function listUseCases() {
  return sql(`SELECT u.*, (SELECT COUNT(*) FROM uc_attempts a WHERE a.usecase_id = u.id) AS assigned
              FROM usecases u ORDER BY u.position, u.id`).all();
}
const countUseCases = async () => (await sql('SELECT COUNT(*) AS n FROM usecases').get()).n;
const getUseCase = async (id) => (Number.isSafeInteger(Number(id)) && (await sql('SELECT * FROM usecases WHERE id = ?').get(Number(id)))) || null;

function validateUseCase(input) {
  const title = String(input?.title || '').trim().replace(/\s+/g, ' ');
  const description = String(input?.description || '').replace(/\r\n/g, '\n').trim();
  if (!title) return { error: 'Enter a title for the use case.' };
  if (title.length > 150) return { error: 'Title must be under 150 characters.' };
  if (description.length > 20000) return { error: 'Description must be under 20,000 characters.' };
  return { value: { title, description } };
}

async function createUseCase(v) {
  const position = ((await sql('SELECT MAX(position) AS p FROM usecases').get()).p ?? -1) + 1;
  return sql('INSERT INTO usecases (title, description, position, created_at) VALUES (?, ?, ?, ?)')
    .insert(v.title, v.description, position, Date.now());
}

const updateUseCase = async (id, v) => (await sql('UPDATE usecases SET title = ?, description = ? WHERE id = ?').run(v.title, v.description, Number(id))).changes > 0;

async function deleteUseCase(id) {
  const uc = await getUseCase(id);
  if (!uc) return { error: 'Use case not found.', status: 404 };
  const assigned = (await sql('SELECT COUNT(*) AS n FROM uc_attempts WHERE usecase_id = ?').get(uc.id)).n;
  if (assigned) return { error: `This use case has been assigned to ${assigned} candidate${assigned === 1 ? '' : 's'} and cannot be deleted.`, status: 409 };
  await sql('DELETE FROM usecases WHERE id = ?').run(uc.id);
  await storage.remove(pdfKey(uc.id));
  return { ok: true };
}

async function savePdf(id, buf, name) {
  const uc = await getUseCase(id);
  if (!uc) return { error: 'Use case not found.', status: 404 };
  if (!Buffer.isBuffer(buf) || buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') return { error: 'The file is not a valid PDF.' };
  await storage.put(pdfKey(uc.id), buf, 'application/pdf');
  const safeName = String(name || 'use-case.pdf').replace(/[^\w .()-]/g, '_').slice(0, 120) || 'use-case.pdf';
  await sql('UPDATE usecases SET pdf_name = ?, pdf_size = ? WHERE id = ?').run(safeName, buf.length, uc.id);
  return { ok: true };
}

async function removePdf(id) {
  const uc = await getUseCase(id);
  if (!uc) return { error: 'Use case not found.', status: 404 };
  await storage.remove(pdfKey(uc.id));
  await sql('UPDATE usecases SET pdf_name = NULL, pdf_size = NULL WHERE id = ?').run(uc.id);
  return { ok: true };
}

// Streams a use case's PDF to the response; false if there is none.
async function sendPdf(res, uc, extraHeaders = {}) {
  if (!uc || !uc.pdf_name) return false;
  return storage.send(res, pdfKey(uc.id), {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${uc.pdf_name.replace(/"/g, '')}"`,
    ...extraHeaders,
  });
}

// Each candidate gets one use case at random.
async function pickUseCase() {
  const ids = (await sql('SELECT id FROM usecases').all()).map((r) => r.id);
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
  listUseCases, countUseCases, getUseCase, validateUseCase, createUseCase, updateUseCase, deleteUseCase,
  savePdf, removePdf, sendPdf, pickUseCase, validUrl,
};
