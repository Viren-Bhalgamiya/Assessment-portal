'use strict';
// Question bank and its sections, stored in the database and managed from the admin dashboard.
// On first run it is seeded from questions-data.js. Answers and solutions never go to students.
// The bank is held in memory (loadBank) and reloaded after every change, so reading it is instant.
const { sql } = require('./db');

const LETTERS = ['a', 'b', 'c', 'd'];
// Default marking; every question can override it (marks for a correct answer, negative for a wrong one).
const MARK_CORRECT = 4;
const MARK_WRONG = -1;
const round2 = (n) => Math.round(n * 100) / 100;

const DEFAULT_SECTIONS = [
  { key: 'A', prefix: 'A', name: 'Python Programming' },
  { key: 'B1', prefix: 'ML', name: 'Machine Learning' },
  { key: 'B2', prefix: 'GA', name: 'Generative AI' },
  { key: 'B3', prefix: 'AG', name: 'Agentic AI' },
  { key: 'C', prefix: 'C', name: 'Aptitude & Reasoning' },
];

// First run: create the default sections and fill them from questions-data.js.
async function seed() {
  if ((await sql('SELECT COUNT(*) AS n FROM sections').get()).n === 0) {
    for (const [i, x] of DEFAULT_SECTIONS.entries()) {
      await sql('INSERT INTO sections (key, name, prefix, position) VALUES (?, ?, ?, ?)').run(x.key, x.name, x.prefix, i);
    }
  }
  if ((await sql('SELECT COUNT(*) AS n FROM questions').get()).n === 0) {
    const data = require('./questions-data');
    const bySection = { A: data.secA, B1: data.secML, B2: data.secGA, B3: data.secAG, C: data.secC };
    const insert = sql(`INSERT INTO questions (id, section, position, stem, code, sub, options, answer, solution, updated_at, marks, negative)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let position = 0;
    for (const def of DEFAULT_SECTIONS) {
      for (const q of bySection[def.key] || []) {
        await insert.run(q.id, def.key, position++, q.q, q.code ? JSON.stringify(q.code) : null, q.sub ? JSON.stringify(q.sub) : null,
          JSON.stringify(q.o), LETTERS.indexOf(q.a), JSON.stringify(q.s || []), Date.now(), MARK_CORRECT, -MARK_WRONG);
      }
    }
  }
  await loadBank();
}

const parse = (s) => (s ? JSON.parse(s) : null);

function rowToQuestion(r) {
  return {
    id: r.id, section: r.section, q: r.stem, code: parse(r.code), sub: parse(r.sub),
    o: JSON.parse(r.options), correct: r.answer, a: LETTERS[r.answer], s: parse(r.solution) || [],
    marks: r.marks ?? MARK_CORRECT, negative: r.negative ?? -MARK_WRONG,
  };
}

let cache = null;

// Current bank: sections in their order with their questions, lookup by id, and max score.
function bank() {
  if (!cache) throw new Error('Question bank not loaded');
  return cache;
}

async function loadBank() {
  const SECTIONS = (await sql('SELECT key, name, prefix, minutes FROM sections ORDER BY position, key').all())
    .map((s) => ({ key: s.key, title: s.name, prefix: s.prefix, minutes: s.minutes || null, items: [] }));
  const byKey = new Map(SECTIONS.map((s) => [s.key, s]));
  const BY_ID = new Map();
  for (const r of await sql('SELECT * FROM questions ORDER BY position, id').all()) {
    const section = byKey.get(r.section);
    if (!section) continue;
    const q = rowToQuestion(r);
    section.items.push(q);
    BY_ID.set(q.id, q);
  }
  for (const sec of SECTIONS) sec.maxScore = round2(sec.items.reduce((t, q) => t + q.marks, 0));
  cache = { SECTIONS, BY_ID, MAX_SCORE: round2(SECTIONS.reduce((t, sec) => t + sec.maxScore, 0)) };
  return cache;
}
const invalidate = loadBank;

// ---------- questions ----------
function validate(input) {
  const errors = [];
  const section = String(input?.section || '');
  if (!bank().SECTIONS.some((s) => s.key === section)) errors.push('Choose a section.');
  const stem = String(input?.q || '').trim();
  if (!stem) errors.push('Question text is required.');
  if (stem.length > 4000) errors.push('Question text is too long (max 4000 characters).');
  const options = Array.isArray(input?.options) ? input.options.map((o) => String(o ?? '').trim()) : [];
  if (options.length !== 4 || options.some((o) => !o)) errors.push('All four options (A–D) are required.');
  else if (new Set(options.map((o) => o.toLowerCase())).size !== 4) errors.push('The four options must all be different.');
  if (options.some((o) => o.length > 1000)) errors.push('Each option must be under 1000 characters.');
  const answer = Number(input?.answer);
  if (!Number.isInteger(answer) || answer < 0 || answer > 3) errors.push('Mark which option is correct.');
  const lines = (v) => {
    const text = String(v ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
    return text.trim() ? text.split('\n') : null;
  };
  const code = lines(input?.code);
  const sub = lines(input?.sub)?.map((l) => l.trim()).filter(Boolean) || null;
  const solution = lines(input?.solution)?.map((l) => l.trim()).filter(Boolean) || [];
  const { marks, negative, error: markError } = validMarks(input?.marks, input?.negative);
  if (markError) errors.push(markError);
  if (errors.length) return { errors };
  return { value: { section, stem, code, sub, options, answer, solution, marks, negative } };
}

// Marks for a correct answer: > 0 and at most 100. Negative marks for a wrong answer: 0 to 100.
// Up to 2 decimals (e.g. 0.25, or 1.33 for "one third"). Blank means the default +4 / −1.
function validMarks(rawMarks, rawNegative) {
  const num = (v, dflt) => (v === undefined || v === null || String(v).trim() === '' ? dflt : Number(v));
  const marks = num(rawMarks, MARK_CORRECT);
  const negative = Math.abs(num(rawNegative, -MARK_WRONG));
  if (!Number.isFinite(marks) || marks <= 0 || marks > 100) return { error: 'Marks for a correct answer must be more than 0 and at most 100.' };
  if (!Number.isFinite(negative) || negative > 100) return { error: 'Negative marks must be between 0 and 100.' };
  return { marks: round2(marks), negative: round2(negative) };
}

async function nextQuestionId(sectionKey) {
  const prefix = bank().SECTIONS.find((s) => s.key === sectionKey).prefix;
  const re = new RegExp(`^${prefix}(\\d+)$`);
  let max = 0;
  for (const { id } of await sql('SELECT id FROM questions').all()) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

async function createQuestion(v) {
  const id = await nextQuestionId(v.section);
  const position = ((await sql('SELECT MAX(position) AS p FROM questions').get()).p ?? -1) + 1;
  await sql(`INSERT INTO questions (id, section, position, stem, code, sub, options, answer, solution, updated_at, marks, negative)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, v.section, position, v.stem, v.code ? JSON.stringify(v.code) : null, v.sub ? JSON.stringify(v.sub) : null,
      JSON.stringify(v.options), v.answer, JSON.stringify(v.solution), Date.now(), v.marks, v.negative);
  await invalidate();
  return id;
}

async function updateQuestion(id, v) {
  const r = await sql(`UPDATE questions SET section = ?, stem = ?, code = ?, sub = ?, options = ?, answer = ?, solution = ?, updated_at = ?,
                 marks = ?, negative = ? WHERE id = ?`)
    .run(v.section, v.stem, v.code ? JSON.stringify(v.code) : null, v.sub ? JSON.stringify(v.sub) : null,
      JSON.stringify(v.options), v.answer, JSON.stringify(v.solution), Date.now(), v.marks, v.negative, id);
  await invalidate();
  return r.changes > 0;
}

async function deleteQuestion(id) {
  const r = await sql('DELETE FROM questions WHERE id = ?').run(id);
  await invalidate();
  return r.changes > 0;
}

// ---------- sections ----------
function validSectionName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  if (!n) return { error: 'Enter a section name.' };
  if (n.length > 60) return { error: 'Section name must be under 60 characters.' };
  if (bank().SECTIONS.some((s) => s.title.toLowerCase() === n.toLowerCase())) return { error: 'A section with this name already exists.' };
  return { name: n };
}

// Question-id prefix from the initials of the name, e.g. "Data Structures" -> "DS", kept unique.
async function makePrefix(name) {
  const taken = new Set((await sql('SELECT prefix FROM sections').all()).map((r) => r.prefix));
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  let base = words.length > 1 ? words.map((w) => w[0]).join('').slice(0, 3) : (words[0] || 'S').slice(0, 3);
  if (/^\d/.test(base)) base = `S${base}`;
  let prefix = base;
  for (let i = 2; taken.has(prefix); i++) prefix = `${base}${i}`;
  return prefix;
}

async function createSection(rawName) {
  const { name, error } = validSectionName(rawName);
  if (error) return { error };
  const keys = new Set((await sql('SELECT key FROM sections').all()).map((r) => r.key));
  let n = keys.size + 1;
  while (keys.has(`S${n}`)) n++;
  const key = `S${n}`;
  const position = ((await sql('SELECT MAX(position) AS p FROM sections').get()).p ?? -1) + 1;
  await sql('INSERT INTO sections (key, name, prefix, position) VALUES (?, ?, ?, ?)').run(key, name, await makePrefix(name), position);
  await invalidate();
  return { key };
}

async function renameSection(key, rawName) {
  const current = bank().SECTIONS.find((s) => s.key === key);
  if (!current) return { error: 'Section not found.', status: 404 };
  if (String(rawName || '').trim().toLowerCase() === current.title.toLowerCase()) return { ok: true };
  const { name, error } = validSectionName(rawName);
  if (error) return { error };
  await sql('UPDATE sections SET name = ? WHERE key = ?').run(name, key);
  await invalidate();
  return { ok: true };
}

async function moveSection(key, dir) {
  const list = bank().SECTIONS.map((s) => s.key);
  const i = list.indexOf(key);
  const j = i + (dir < 0 ? -1 : 1);
  if (i < 0) return { error: 'Section not found.', status: 404 };
  if (j < 0 || j >= list.length) return { ok: true };
  [list[i], list[j]] = [list[j], list[i]];
  for (const [pos, k] of list.entries()) await sql('UPDATE sections SET position = ? WHERE key = ?').run(pos, k);
  await invalidate();
  return { ok: true };
}

// Set the same marking for every question in a section.
async function setSectionMarks(key, rawMarks, rawNegative) {
  if (!bank().SECTIONS.some((s) => s.key === key)) return { error: 'Section not found.', status: 404 };
  const { marks, negative, error } = validMarks(rawMarks, rawNegative);
  if (error) return { error };
  const changed = (await sql('UPDATE questions SET marks = ?, negative = ?, updated_at = ? WHERE section = ?').run(marks, negative, Date.now(), key)).changes;
  await invalidate();
  return { ok: true, updated: changed };
}

async function setSectionMinutes(key, minutes) {
  if (!bank().SECTIONS.some((s) => s.key === key)) return { error: 'Section not found.', status: 404 };
  if (minutes !== null && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= 600)) {
    return { error: 'Section time must be a whole number of minutes between 1 and 600.' };
  }
  await sql('UPDATE sections SET minutes = ? WHERE key = ?').run(minutes, key);
  await invalidate();
  return { ok: true };
}

// Deleting a section also deletes its questions.
async function deleteSection(key) {
  if (!bank().SECTIONS.some((s) => s.key === key)) return { error: 'Section not found.', status: 404 };
  const removed = (await sql('DELETE FROM questions WHERE section = ?').run(key)).changes;
  await sql('DELETE FROM sections WHERE key = ?').run(key);
  await invalidate();
  return { ok: true, removedQuestions: removed };
}

module.exports = {
  LETTERS, MARK_CORRECT, MARK_WRONG,
  seed, bank, validate, createQuestion, updateQuestion, deleteQuestion,
  createSection, renameSection, moveSection, deleteSection, setSectionMinutes, setSectionMarks,
};
