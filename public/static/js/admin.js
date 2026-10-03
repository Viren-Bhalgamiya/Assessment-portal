'use strict';
// Admin dashboard: live monitoring, results, student accounts and exam settings.

const A = { summary: null, sort: { key: 'username', dir: 1 }, openId: null, openStatus: null };

const EVENT_LABELS = {
  started: 'Started exam',
  resumed: 'Reopened exam page',
  new_login: 'Logged in again',
  page_reloaded: 'Reloaded / reopened exam page',
  monitoring_gap: 'Snapshots stopped arriving',
  focus_lost: 'Left exam window',
  fullscreen_exit: 'Exited fullscreen',
  screen_share_stopped: 'Screen sharing stopped',
  camera_stopped: 'Camera stopped',
  microphone_stopped: 'Microphone stopped / muted',
  microphone_silent: 'Microphone silent (possibly muted)',
  voice_detected: 'Speech / sound detected',
  multiple_monitors: 'Extra monitor connected',
  copy_attempt: 'Copy / paste attempt',
  blocked_action: 'Blocked action',
  submitted: 'Submitted',
};
const STATUS = {
  not_started: ['Not started', 'neutral'],
  in_progress: ['In progress', 'warn'],
  submitted: ['Submitted', 'ok'],
};

let toastTimer;
function toast(msg, kind = 'info') {
  const t = $('#toast');
  t.replaceChildren(icon(kind === 'warn' ? 'alert' : 'check'), msg);
  t.className = 'toast show' + (kind === 'warn' ? ' warn' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, 3500);
}

const statusBadge = (s) => h('span', { class: `badge ${STATUS[s][1]}` }, STATUS[s][0]);

// ---------- tabs ----------
document.querySelectorAll('.tabs button').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    for (const t of ['results', 'students', 'questions', 'usecases', 'settings']) $('#tab-' + t).hidden = t !== btn.dataset.tab;
    if (btn.dataset.tab === 'questions') loadQuestions().catch((e) => toast(e.message, 'warn'));
    if (btn.dataset.tab === 'usecases') loadUseCases().catch((e) => toast(e.message, 'warn'));
  };
});
$('#btn-logout').onclick = logout;

// ---------- data ----------
async function loadSummary(auto = false) {
  A.summary = await api('GET', '/api/admin/summary');
  A.ucMode = A.summary.settings.examMode === 'usecase';
  // in the use-case round each candidate's status is their use-case status
  for (const s of A.summary.students) { s.mcqStatus = s.mcqStatus || s.status; s.status = A.ucMode ? s.ucStatus : s.mcqStatus; }
  $('#mcq-results').hidden = A.ucMode;
  $('#uc-results').hidden = !A.ucMode;
  if (A.ucMode) await loadUcResults(!auto);
  renderExamState();
  renderStats();
  if (!A.ucMode) renderResults();
  renderStudents();
  $('#last-refresh').textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function renderExamState() {
  const open = A.summary.settings.examOpen;
  const el = $('#exam-state');
  el.replaceChildren(h('span', { class: 'dot' }), `${A.ucMode ? 'Use-Case Round' : 'MCQ Test'} · ${open ? 'Open' : 'Closed'}`);
  el.className = `badge ${open ? 'ok' : 'neutral'}`;
}

function renderStats() {
  if (A.ucMode) return renderUcStats();
  const pending = A.summary.students.filter((s) => s.approval === 'pending').length;
  const st = A.summary.students.filter((s) => s.approval === 'approved');
  const done = st.filter((s) => s.status === 'submitted');
  const avg = done.length ? (done.reduce((t, s) => t + s.score, 0) / done.length).toFixed(1) : '—';
  const top = done.length ? Math.max(...done.map((s) => s.score)) : '—';
  const flagged = st.filter((s) => s.violations > 0).length;
  const stat = (ic, tone, v, k) => h('div', { class: `stat tone-${tone}` },
    h('div', { class: 'ic' }, icon(ic)), h('div', null, h('div', { class: 'v' }, String(v)), h('div', { class: 'k' }, k)));
  $('#stats').replaceChildren(
    stat('users', 'primary', st.length, 'Registered'),
    stat('hourglass', 'warn', pending, 'Pending Approval'),
    stat('clock', 'slate', st.filter((s) => s.status === 'not_started').length, 'Not Started'),
    stat('play', 'violet', st.filter((s) => s.status === 'in_progress').length, 'In Progress'),
    stat('check', 'ok', done.length, 'Submitted'),
    stat('alert', 'danger', flagged, 'With Violations'),
    stat('chart', 'primary', `${avg}`, `Average (of ${A.summary.maxScore})`),
    stat('trophy', 'warn', `${top}`, 'Highest Score'));
}

// ---------- results table ----------
function filteredStudents(query, status, approval = 'approved') {
  const q = query.trim().toLowerCase();
  return A.summary.students.filter((s) =>
    (!approval || s.approval === approval) &&
    (!status || s.status === status) &&
    (!q || s.username.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)));
}

function sortValue(s, key) {
  if (key === 'score') return s.score ?? -Infinity;
  if (key.startsWith('sec:')) return s.sectionScores?.[key.slice(4)]?.score ?? -Infinity;
  if (key === 'violations') return s.violations;
  if (key === 'status') return s.status;
  return s[key]?.toString().toLowerCase() ?? '';
}

function renderResults() {
  const { sections, maxScore } = A.summary;
  const rows = filteredStudents($('#search').value, $('#filter-status').value);
  const { key, dir } = A.sort;
  rows.sort((a, b) => {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });

  const th = (label, sortKey, num) => h('th', {
    class: sortKey ? 'sortable' : null,
    style: num ? 'text-align:right' : null,
    onclick: sortKey ? () => { A.sort = { key: sortKey, dir: A.sort.key === sortKey ? -A.sort.dir : (num ? -1 : 1) }; renderResults(); } : null,
  }, label + (A.sort.key === sortKey ? (A.sort.dir > 0 ? ' ▲' : ' ▼') : ''));

  const head = h('tr', null,
    th('Roll No.', 'username'), th('Candidate Name', 'name'), th('Status', 'status'),
    th(`Score /${maxScore}`, 'score', true),
    sections.map((s) => th(`${s.title} /${s.maxScore}`, `sec:${s.key}`, true)),
    th('Violations', 'violations', true), th('Time Left / Submitted At'), th('Remarks'), th(''));

  const body = rows.map((s) => h('tr', null,
    h('td', null, h('strong', null, s.username)),
    h('td', null, h('span', { class: 'cell-user' }, avatar(s.name, s.username), s.name)),
    h('td', null, statusBadge(s.status)),
    h('td', { class: 'num' }, s.status === 'submitted' ? h('span', { class: 'score-pill' }, String(s.score)) : '—'),
    sections.map((sec) => h('td', { class: 'num' }, s.status === 'submitted' ? String(s.sectionScores?.[sec.key]?.score ?? '—') : '—')),
    h('td', { class: 'num' }, s.violations ? h('span', { class: 'badge danger' }, String(s.violations)) : '0'),
    h('td', null, s.status === 'in_progress' ? `${fmtDuration(s.remainingSec)} left` : s.submittedAt ? fmtTime(s.submittedAt) : '—'),
    h('td', null, s.submitReason || '—'),
    h('td', null, h('button', { class: 'small', onclick: () => openStudent(s.id) }, 'View Details'))));

  $('#results-table').replaceChildren(h('thead', null, head),
    h('tbody', null, body.length ? body : h('tr', null, h('td', { colspan: 20, class: 'empty' }, 'No students match.'))));
}

$('#search').oninput = renderResults;
$('#filter-status').onchange = renderResults;
$('#btn-refresh').onclick = () => loadSummary().catch((e) => toast(e.message, 'warn'));
$('#btn-export').onclick = () => { location.href = '/api/admin/export.csv'; };

// ---------- students tab ----------
const APPROVAL = { pending: ['Pending', 'warn'], approved: ['Approved', 'ok'], rejected: ['Rejected', 'danger'] };
const approvalBadge = (a) => h('span', { class: `badge ${APPROVAL[a][1]}` }, APPROVAL[a][0]);

function renderStudents() {
  const pending = A.summary.students.filter((s) => s.approval === 'pending').sort((a, b) => a.registeredAt - b.registeredAt);
  $('#pending-count').textContent = String(pending.length);
  $('#tab-pending').textContent = String(pending.length);
  $('#tab-pending').hidden = !pending.length;
  $('#btn-approve-all').disabled = !pending.length;
  $('#pending-table').replaceChildren(
    h('thead', null, h('tr', null, h('th', null, 'Roll no'), h('th', null, 'Name'), h('th', null, 'Registered at'), h('th', null, 'Actions'))),
    h('tbody', null, pending.length ? pending.map((s) => h('tr', null,
      h('td', null, h('strong', null, s.username)),
      h('td', null, h('span', { class: 'cell-user' }, avatar(s.name, s.username), s.name)),
      h('td', null, fmtTime(s.registeredAt)),
      h('td', null,
        h('button', { class: 'small primary', onclick: () => setApproval(s, 'approve') }, icon('check'), 'Approve'), ' ',
        h('button', { class: 'small danger', onclick: () => setApproval(s, 'reject') }, icon('x'), 'Reject')))) :
      h('tr', null, h('td', { colspan: 4, class: 'empty' }, 'No pending registrations. New sign-ups appear here automatically.'))));

  const rows = filteredStudents($('#student-search').value, '', '').filter((s) => s.approval !== 'pending');
  $('#students-table').replaceChildren(
    h('thead', null, h('tr', null, h('th', null, 'Roll no'), h('th', null, 'Name'), h('th', null, 'Approval'), h('th', null, 'Exam'), h('th', null, 'Actions'))),
    h('tbody', null, rows.length ? rows.map((s) => h('tr', null,
      h('td', null, h('strong', null, s.username)),
      h('td', null, h('span', { class: 'cell-user' }, avatar(s.name, s.username), s.name)),
      h('td', null, approvalBadge(s.approval)),
      h('td', null, statusBadge(s.status)),
      h('td', null,
        s.approval === 'rejected' && h('button', { class: 'small', onclick: () => setApproval(s, 'approve') }, 'Approve'), ' ',
        s.approval === 'approved' && s.status === 'not_started' && h('button', { class: 'small danger', onclick: () => setApproval(s, 'reject') }, 'Revoke'), ' ',
        h('button', { class: 'small', onclick: () => resetPassword(s) }, 'Reset Password'), ' ',
        s.status !== 'not_started' && h('button', { class: 'small danger', onclick: () => resetAttempt(s) }, 'Allow Re-attempt'), ' ',
        h('button', { class: 'small danger', onclick: () => deleteStudent(s) }, 'Delete')))) :
      h('tr', null, h('td', { colspan: 5, class: 'empty' }, 'No approved or rejected students yet.'))));
}
$('#student-search').oninput = renderStudents;

async function setApproval(s, action) {
  try {
    await api('POST', `/api/admin/students/${s.id}/${action}`);
    toast(`${s.username} ${action === 'approve' ? 'approved' : 'rejected'}.`);
    await loadSummary();
  } catch (err) { toast(err.message, 'warn'); }
}

$('#btn-approve-all').onclick = async () => {
  const n = A.summary.students.filter((s) => s.approval === 'pending').length;
  if (!n || !confirm(`Approve all ${n} pending registration${n === 1 ? '' : 's'}?`)) return;
  try {
    const r = await api('POST', '/api/admin/students/approve-all');
    toast(`Approved ${r.approved} student${r.approved === 1 ? '' : 's'}.`);
    await loadSummary();
  } catch (err) { toast(err.message, 'warn'); }
};

function showCredentials(title, created, skipped = []) {
  const box = $('#create-result');
  const download = () => {
    const esc = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const text = ['Roll No,Name,Password', ...created.map((c) => [c.username, c.name, c.password].map(esc).join(','))].join('\r\n');
    const a = h('a', { href: URL.createObjectURL(new Blob(['\uFEFF' + text], { type: 'text/csv' })), download: 'student-credentials.csv' });
    document.body.append(a);
    a.click();
    a.remove();
  };
  box.replaceChildren(
    h('h3', { class: 'section-title', style: 'margin-bottom:6px' }, title),
    created.length ? h('p', { class: 'muted', style: 'margin:0 0 12px' }, 'Share these sign-in details with the students. Passwords cannot be viewed again later, so download them now.') : null,
    created.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Roll no'), h('th', null, 'Name'), h('th', null, 'Password'))),
      h('tbody', null, created.map((c) => h('tr', null, h('td', null, h('strong', null, c.username)), h('td', null, c.name), h('td', null, h('code', null, c.password))))))) : null,
    skipped.length ? h('div', { class: 'alert warn', style: 'margin:12px 0 0' }, icon('alert'), h('div', null,
      h('strong', null, `Skipped ${skipped.length}:`),
      h('ul', { style: 'margin:4px 0 0;padding-left:18px' }, skipped.map((x) => h('li', null, `${x.username || '(blank roll number)'}: ${x.reason}`))))) : null,
    h('div', { style: 'margin-top:12px;display:flex;gap:10px' },
      created.length ? h('button', { class: 'primary', onclick: download }, icon('download'), 'Download sign-in details (CSV)') : null,
      h('button', { onclick: () => { box.hidden = true; } }, 'Hide')));
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function addStudents(students) {
  const r = await api('POST', '/api/admin/students', { students });
  showCredentials(`Added ${r.created.length} student${r.created.length === 1 ? '' : 's'}`, r.created, r.skipped);
  await loadSummary();
  return r;
}

$('#form-one').onsubmit = async (e) => {
  e.preventDefault();
  const pass = $('#one-pass').value.trim();
  if (pass && pass.length < 6) return toast('Password must be at least 6 characters.', 'warn');
  try {
    const r = await addStudents([{ username: $('#one-roll').value, name: $('#one-name').value, password: pass }]);
    if (r.created.length) e.target.reset();
  } catch (err) { toast(err.message, 'warn'); }
};

$('#btn-bulk').onclick = async () => {
  const students = $('#bulk').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
    const [username = '', name = '', password = ''] = line.split(/\t|,/).map((x) => x.trim());
    return { username, name, password };
  });
  if (!students.length) return toast('Paste at least one line.', 'warn');
  try {
    const r = await addStudents(students);
    if (!r.skipped.length) $('#bulk').value = '';
  } catch (err) { toast(err.message, 'warn'); }
};

async function resetPassword(s) {
  const pw = prompt(`New password for ${s.username} (leave blank to generate one):`, '');
  if (pw === null) return;
  try {
    const r = await api('POST', `/api/admin/students/${s.id}/password`, { password: pw });
    showCredentials(`Password reset for ${s.username}`, [{ username: r.username, name: s.name, password: r.password }]);
  } catch (err) { toast(err.message, 'warn'); }
}

async function resetAttempt(s) {
  const what = A.ucMode ? 'use-case attempt, submitted link and marks' : 'attempt, answers, warnings and snapshots';
  if (!confirm(`Delete ${s.username}'s ${what} so they can take the test again? This cannot be undone.`)) return;
  try {
    await api('POST', `/api/admin/students/${s.id}/reset-attempt`);
    toast(`${s.username} can now retake the exam.`);
    if (A.openId === s.id) closeDrawer();
    await loadSummary();
  } catch (err) { toast(err.message, 'warn'); }
}

async function deleteStudent(s) {
  if (!confirm(`Delete ${s.username} (${s.name}) and all their exam data? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/admin/students/${s.id}`);
    toast(`${s.username} deleted.`);
    if (A.openId === s.id) closeDrawer();
    await loadSummary();
  } catch (err) { toast(err.message, 'warn'); }
}

async function forceSubmit(id, username) {
  if (!confirm(`Submit ${username}'s exam now? They will not be able to continue.`)) return;
  try {
    await api('POST', `/api/admin/students/${id}/force-submit`);
    toast(`${username}'s exam was submitted.`);
    await Promise.all([loadSummary(), refreshDrawer()]);
  } catch (err) { toast(err.message, 'warn'); }
}

// ---------- student detail drawer ----------
async function openStudent(id) {
  A.openId = id;
  $('#drawer').hidden = false;
  $('#drawer-sheet').replaceChildren(h('div', { class: 'center-screen' }, h('div', { class: 'spinner' })));
  await refreshDrawer();
}

function closeDrawer() {
  A.openId = null;
  A.openStatus = null;
  $('#drawer').hidden = true;
}
$('#drawer').onclick = (e) => { if (e.target.id === 'drawer') closeDrawer(); };
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('#lightbox').hidden) $('#lightbox').hidden = true;
  else if (!$('#drawer').hidden) closeDrawer();
});

async function refreshDrawer() {
  const id = A.openId;
  if (!id) return;
  try {
    const d = await api('GET', `/api/admin/students/${id}`);
    if (A.openId !== id) return;
    const sheet = $('#drawer-sheet');
    const scroll = sheet.scrollTop;
    const open = new Set([...sheet.querySelectorAll('details[open]')].map((x) => x.dataset.qid));
    renderDrawer(d, open);
    sheet.scrollTop = scroll;
  } catch (err) { toast(err.message, 'warn'); }
}

function scoreRing(score, max) {
  const pct = Math.max(0, score) / max;
  const r = 70;
  const c = 2 * Math.PI * r;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 170 170');
  const defs = document.createElementNS(ns, 'defs');
  const grad = document.createElementNS(ns, 'linearGradient');
  grad.id = 'ringGrad';
  for (const [off, col] of [['0%', '#0f766e'], ['100%', '#0f766e']]) {
    const st = document.createElementNS(ns, 'stop');
    st.setAttribute('offset', off);
    st.setAttribute('stop-color', col);
    grad.append(st);
  }
  defs.append(grad);
  const circle = (stroke, dash) => {
    const el = document.createElementNS(ns, 'circle');
    Object.entries({ cx: 85, cy: 85, r, fill: 'none', stroke, 'stroke-width': 14, 'stroke-linecap': 'round' }).forEach(([k, v]) => el.setAttribute(k, v));
    if (dash !== undefined) el.setAttribute('stroke-dasharray', `${dash} ${c}`);
    return el;
  };
  svg.append(defs, circle('#f3f4f6'), circle('url(#ringGrad)', c * pct));
  return h('div', { class: 'score-ring' }, svg,
    h('div', { class: 'val' }, h('strong', null, String(score)), h('span', null, `out of ${max}`)));
}

function renderDrawer(d, openQids) {
  const { user, attempt } = d;
  A.openStatus = attempt ? attempt.status : 'not_started';
  const head = h('div', { class: 'head' },
    avatar(user.name, user.username),
    h('div', null, h('h2', null, user.name), h('div', { class: 'muted' }, user.username)),
    statusBadge(A.openStatus),
    h('span', { class: 'spacer' }),
    attempt && attempt.status === 'in_progress' && h('button', { class: 'danger', onclick: () => forceSubmit(user.id, user.username) }, 'Force Submit'),
    attempt && h('button', { class: 'danger', onclick: () => resetAttempt({ id: user.id, username: user.username }) }, 'Allow Re-attempt'),
    h('button', { onclick: closeDrawer }, icon('x'), 'Close'));

  if (!attempt) {
    $('#drawer-sheet').replaceChildren(head, h('div', { class: 'body' }, h('div', { class: 'card empty' }, 'This student has not started the exam.')));
    return;
  }

  const sections = A.summary.sections;
  const kv = (k, v) => [h('div', { class: 'k' }, k), h('div', null, v)];
  const summary = h('section', { class: 'card' },
    h('div', { class: 'score-hero' },
      h('div', null, scoreRing(attempt.score, A.summary.maxScore),
        attempt.provisional ? h('p', { class: 'muted', style: 'text-align:center;font-size:12.5px;margin:8px 0 0' }, 'Provisional: exam in progress') : null),
      h('div', null,
        h('div', { class: 'kv' },
          kv('Warnings', attempt.violations ? h('span', { class: 'badge danger' }, icon('alert'), `${attempt.violations} warning${attempt.violations === 1 ? '' : 's'}`) : h('span', { class: 'badge ok' }, 'None')),
          kv('Started', fmtTime(attempt.startedAt)),
          attempt.status === 'in_progress' ? kv('Time left', fmtDuration(attempt.remainingSec)) : kv('Submitted', fmtTime(attempt.submittedAt)),
          attempt.section ? kv('Current section', `${attempt.section.number} of ${attempt.section.of}: ${attempt.section.title} (${fmtDuration(attempt.section.remainingSec)} left)`) : null,
          attempt.submitReason ? kv('Submit reason', attempt.submitReason) : null,
          kv('IP address', attempt.ip || '—'),
          kv('Browser', h('span', { style: 'font-size:12px;white-space:normal' }, attempt.userAgent || '—'))))));

  const bars = h('section', { class: 'card' },
    h('h3', null, 'Section-wise Score'),
    h('div', { class: 'sec-bars' }, sections.map((s) => {
      const r = attempt.sectionScores?.[s.key] || { score: 0, correct: 0, wrong: 0, unattempted: 0 };
      return h('div', { class: 'sec-bar' },
        h('div', { class: 'top' }, h('strong', null, s.title.replace(/^Section /, '')),
          h('span', null, `${r.score} / ${s.maxScore} · ${r.correct} correct · ${r.wrong} wrong · ${r.unattempted} skipped`)),
        h('div', { class: 'track' }, h('div', { class: 'fill' + (r.score < 0 ? ' neg' : ''), style: `width:${s.maxScore > 0 ? Math.min(100, Math.max(3, (Math.abs(r.score) / s.maxScore) * 100)) : 0}%` })));
    })));

  const counted = d.events.filter((e) => e.counted).length;
  const events = h('section', null,
    h('h3', null, `Proctoring Log (${counted} violation${counted === 1 ? '' : 's'}, ${d.events.length} events)`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'Time'), h('th', null, 'Event'), h('th', null, 'Detail'), h('th', null, ''))),
      h('tbody', null, d.events.map((e) => h('tr', null,
        h('td', null, new Date(e.at).toLocaleTimeString()),
        h('td', null, h('strong', null, EVENT_LABELS[e.type] || e.type)),
        h('td', { class: 'wrap' }, e.detail || ''),
        h('td', null, e.counted ? h('span', { class: 'badge danger' }, 'Violation') : '')))))));

  const gallery = (kind) => {
    const snaps = d.snapshots.filter((s) => s.kind === kind);
    return h('div', null,
      h('h3', null, icon(kind === 'camera' ? 'camera' : 'monitor'), `${kind === 'camera' ? 'Webcam' : 'Screen'} Snapshots (${snaps.length})`),
      snaps.length ? h('div', { class: 'gallery' }, snaps.slice().reverse().map((s) => h('figure', null,
        h('img', { src: `/api/admin/snapshots/${s.id}`, loading: 'lazy', alt: `${kind} snapshot`, onclick: () => openLightbox(`/api/admin/snapshots/${s.id}`) }),
        h('figcaption', null, new Date(s.at).toLocaleTimeString())))) : h('p', { class: 'muted' }, 'None yet.'));
  };
  const clips = d.audio || [];
  const audio = h('div', null,
    h('h3', null, `Audio Recordings (${clips.length})`),
    clips.length ? h('div', { class: 'audio-list' }, clips.slice().reverse().map((c) => h('div', { class: 'clip' },
      h('strong', null, new Date(c.at).toLocaleTimeString()),
      c.durationMs ? h('span', { class: 'muted' }, `${Math.round(c.durationMs / 1000)} s`) : null,
      h('audio', { controls: true, preload: 'none', src: `/api/admin/audio/${c.id}` })))) :
      h('p', { class: 'muted' }, 'None. A clip is recorded whenever speech or sound is detected near the candidate.'));
  const snapshots = h('section', { style: 'display:grid;gap:18px' }, gallery('camera'), audio, gallery('screen'));

  const L = d.letters;
  const review = h('section', null,
    h('h3', null, 'Response Sheet'),
    d.review.map((q) => h('details', { class: 'review-item', dataset: { qid: q.id }, open: openQids.has(q.id) },
      h('summary', null,
        h('strong', { style: 'min-width:44px' }, q.id),
        q.result === 'correct' ? h('span', { class: 'badge ok' }, 'Correct') :
          q.result === 'wrong' ? h('span', { class: 'badge danger' }, 'Wrong') : h('span', { class: 'badge neutral' }, 'Not answered'),
        h('span', { class: 'muted', style: 'font-size:13px' },
          `Chosen: ${q.chosen === null ? '—' : `(${L[q.chosen]})`} · Correct: (${L[q.correct]})`)),
      h('p', null, q.q),
      q.code && h('pre', { class: 'code' }, q.code.map((line) => h('span', { class: 'ln' }, line || ' '))),
      q.sub && h('ul', { class: 'q-sub' }, q.sub.map((s) => h('li', null, s))),
      h('ul', { class: 'opts' }, q.options.map((o, i) => h('li', {
        class: i === q.correct ? 'correct' : i === q.chosen ? 'chosen-wrong' : null,
      }, `(${L[i]}) ${o}`, i === q.correct ? '  ✓' : '', i === q.chosen && i !== q.correct ? '  ✗ chosen' : ''))))));

  $('#drawer-sheet').replaceChildren(head, h('div', { class: 'body' }, summary, bars, events, snapshots, review));
}

function openLightbox(src) {
  $('#lightbox-img').src = src;
  $('#lightbox').hidden = false;
}
$('#lightbox').onclick = () => { $('#lightbox').hidden = true; };

// ---------- question bank ----------
const Q = { data: null };
const shortTitle = (t) => t.replace(/^Section /, '');
const codeBlock = (lines) => h('pre', { class: 'code' }, lines.map((line) => h('span', { class: 'ln' }, line || ' ')));

async function loadQuestions() {
  Q.data = await api('GET', '/api/admin/questions');
  renderQuestions();
}

function renderQuestions() {
  const { sections, questions, liveAttempts } = Q.data;
  const sel = $('#q-section');
  const keep = sections.some((s) => s.key === sel.value) ? sel.value : '';
  sel.replaceChildren(h('option', { value: '' }, 'All sections'), ...sections.map((s) => h('option', { value: s.key }, shortTitle(s.title))));
  sel.value = keep;
  $('#q-count').textContent = `${questions.length} questions · ${fmtNum(questions.reduce((t, q) => t + q.marks, 0))} marks`;
  renderSections();
  const live = $('#q-live');
  live.hidden = !liveAttempts;
  if (liveAttempts) {
    live.replaceChildren(icon('alert'), h('span', null,
      `${liveAttempts} student${liveAttempts === 1 ? ' is' : 's are'} taking the exam right now. You can fix wording or correct answers, but adding and deleting questions is disabled until they finish.`));
  }
  $('#btn-add-q').disabled = liveAttempts > 0;

  const sectionKey = sel.value;
  const term = $('#q-search').value.trim().toLowerCase();
  const titleOf = (key) => shortTitle(sections.find((s) => s.key === key)?.title || key);
  const list = questions.filter((q) => (!sectionKey || q.section === sectionKey) &&
    (!term || [q.id, q.q, ...(q.code || []), ...q.options].join(' ').toLowerCase().includes(term)));

  $('#q-list').replaceChildren(...(list.length ? list.map((q) => h('div', { class: 'q-item' },
    h('div', { class: 'q-head' },
      h('span', { class: 'badge primary' }, q.id),
      h('span', { class: 'badge neutral' }, titleOf(q.section)),
      h('span', { class: 'badge ok' }, `Answer: ${'ABCD'[q.answer]}`),
      h('span', { class: 'badge neutral' }, `+${fmtNum(q.marks)} / −${fmtNum(q.negative)}`),
      h('span', { class: 'spacer' }),
      h('button', { class: 'small', onclick: () => openEditor(q) }, icon('edit'), 'Edit'),
      h('button', { class: 'small danger', disabled: liveAttempts > 0, onclick: () => removeQuestion(q) }, icon('trash'), 'Delete')),
    h('p', { class: 'q-stem' }, q.q),
    q.code && codeBlock(q.code),
    q.sub && h('ul', { class: 'q-sub' }, q.sub.map((x) => h('li', null, x))),
    h('div', { class: 'q-opts' }, q.options.map((o, i) => h('div', { class: 'q-opt' + (i === q.answer ? ' correct' : '') },
      h('span', { class: 'l' }, 'ABCD'[i]), h('span', null, o), i === q.answer && icon('check')))),
    q.solution?.length ? h('details', { class: 'q-sol' }, h('summary', null, 'Solution'), q.solution.map((l) => h('p', null, l))) : null))
    : [h('div', { class: 'card empty' }, questions.length ? 'No questions match your filter.' : 'No questions yet. Click "Add question" to create the first one.')]));
}

function renderSections() {
  const { sections, questions, liveAttempts } = Q.data;
  const locked = liveAttempts > 0;
  $('#btn-add-section').disabled = locked;
  $('#sections-table').replaceChildren(
    h('thead', null, h('tr', null, h('th', null, 'Order'), h('th', null, 'Section'), h('th', null, 'Question IDs'),
      h('th', { style: 'text-align:right' }, 'Questions'), h('th', { style: 'text-align:right' }, 'Marks'), h('th', { style: 'text-align:right' }, 'Time'), h('th', null, 'Actions'))),
    h('tbody', null, sections.length ? sections.map((s, i) => {
      const n = questions.filter((q) => q.section === s.key).length;
      return h('tr', null,
        h('td', null,
          h('button', { class: 'small', title: 'Move up', disabled: i === 0, onclick: () => moveSection(s, -1) }, '↑'), ' ',
          h('button', { class: 'small', title: 'Move down', disabled: i === sections.length - 1, onclick: () => moveSection(s, 1) }, '↓')),
        h('td', null, h('strong', null, s.title)),
        h('td', null, h('code', null, `${s.prefix}1, ${s.prefix}2, …`)),
        h('td', { class: 'num' }, n ? String(n) : h('span', { class: 'badge warn' }, 'Empty')),
        h('td', { class: 'num' }, n ? h('span', { title: markingOf(s.key) }, fmtNum(s.maxScore)) : '0'),
        h('td', { class: 'num' }, s.minutes ? `${s.minutes} min`
          : Q.data.timingMode === 'section' && n ? h('span', { class: 'badge danger' }, 'Not set') : '—'),
        h('td', null,
          h('button', { class: 'small', onclick: () => setSectionTime(s) }, icon('clock'), 'Set time'), ' ',
          h('button', { class: 'small', disabled: !n, onclick: () => setSectionMarks(s) }, icon('chart'), 'Set marks'), ' ',
          h('button', { class: 'small', onclick: () => renameSection(s) }, icon('edit'), 'Rename'), ' ',
          h('button', { class: 'small', onclick: () => { $('#q-section').value = s.key; renderQuestions(); openEditor(null); } }, icon('plus'), 'Add question'), ' ',
          h('button', { class: 'small danger', disabled: locked, onclick: () => deleteSection(s, n) }, icon('trash'), 'Delete')));
    }) : h('tr', null, h('td', { colspan: 7, class: 'empty' }, 'No sections yet. Add one above.'))),
    sections.length ? h('tfoot', null, h('tr', null,
      h('td', { colspan: 3 }, h('strong', null, 'Total'),
        Q.data.timingMode === 'section' ? h('span', { class: 'muted', style: 'margin-left:8px' }, '(per-section timing is on)') : h('span', { class: 'muted', style: 'margin-left:8px' }, '(section times are used only when per-section timing is on in Exam settings)')),
      h('td', { class: 'num' }, h('strong', null, String(questions.length))),
      h('td', { class: 'num' }, h('strong', null, fmtNum(questions.reduce((t, q) => t + q.marks, 0)))),
      h('td', { class: 'num' }, h('strong', null, `${sections.filter((s) => questions.some((q) => q.section === s.key)).reduce((t, s) => t + (s.minutes || 0), 0)} min`)),
      h('td'))) : null);
}

const fmtNum = (n) => String(Math.round(n * 100) / 100);
// "+4 / −1", or "mixed" when the section's questions differ.
function markingOf(key) {
  const qs = Q.data.questions.filter((q) => q.section === key);
  if (!qs.length) return '';
  const same = qs.every((q) => q.marks === qs[0].marks && q.negative === qs[0].negative);
  return same ? `+${fmtNum(qs[0].marks)} / −${fmtNum(qs[0].negative)} per question` : 'Marks differ between questions';
}

function setSectionMarks(s) {
  const qs = Q.data.questions.filter((q) => q.section === s.key);
  const cur = qs[0] ? `${fmtNum(qs[0].marks)}, ${fmtNum(qs[0].negative)}` : '4, 1';
  const v = prompt(`Marks for EVERY question in "${s.title}".\nEnter: marks for a correct answer, negative marks for a wrong answer\n(for example "4, 1", "2, 0.5" or "1, 0" for no negative marking):`, cur);
  if (v === null) return;
  const [marks, negative = '0'] = v.split(',').map((x) => x.trim());
  sectionCall(() => api('PUT', `/api/admin/sections/${encodeURIComponent(s.key)}`, { marks, negative }),
    (r) => `"${s.title}": ${r.updated} question${r.updated === 1 ? '' : 's'} now +${marks} / −${negative}. Submitted exams re-scored.`);
}

function setSectionTime(s) {
  const v = prompt(`Minutes allowed for "${s.title}" (leave blank to clear):`, s.minutes ?? '');
  if (v === null) return;
  const minutes = v.trim() === '' ? null : Number(v);
  if (minutes !== null && !(Number.isInteger(minutes) && minutes >= 1 && minutes <= 600)) return toast('Enter a whole number of minutes between 1 and 600.', 'warn');
  sectionCall(() => api('PUT', `/api/admin/sections/${encodeURIComponent(s.key)}`, { minutes }), minutes ? `"${s.title}": ${minutes} minutes.` : `Time cleared for "${s.title}".`);
}

async function sectionCall(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(r) : okMsg);
    await Promise.all([loadQuestions(), loadSummary()]);
  } catch (err) { toast(err.message, 'warn'); }
}

$('#btn-add-section').onclick = () => {
  const name = $('#new-section').value.trim();
  if (!name) return toast('Type a name for the new section.', 'warn');
  sectionCall(() => api('POST', '/api/admin/sections', { name }), `Section "${name}" added.`).then(() => { $('#new-section').value = ''; });
};
$('#new-section').onkeydown = (e) => { if (e.key === 'Enter') $('#btn-add-section').click(); };

function renameSection(s) {
  const name = prompt('New name for this section:', s.title);
  if (name === null || !name.trim() || name.trim() === s.title) return;
  sectionCall(() => api('PUT', `/api/admin/sections/${encodeURIComponent(s.key)}`, { name }), 'Section renamed.');
}

function moveSection(s, dir) {
  sectionCall(() => api('POST', `/api/admin/sections/${encodeURIComponent(s.key)}/move`, { dir }));
}

function deleteSection(s, n) {
  const msg = n
    ? `Delete the section "${s.title}" and its ${n} question${n === 1 ? '' : 's'}? Submitted exams will be re-scored without them. This cannot be undone.`
    : `Delete the empty section "${s.title}"?`;
  if (!confirm(msg)) return;
  sectionCall(() => api('DELETE', `/api/admin/sections/${encodeURIComponent(s.key)}`), `Section "${s.title}" deleted.`);
}

$('#q-section').onchange = renderQuestions;
$('#q-search').oninput = renderQuestions;
$('#btn-add-q').onclick = () => openEditor(null);

function openEditor(q) {
  A.openId = null;
  const { sections } = Q.data;
  const section = h('select', { style: 'width:100%' }, sections.map((s) => h('option', { value: s.key }, shortTitle(s.title))));
  section.value = q ? q.section : ($('#q-section').value || sections[0].key);
  const stem = h('textarea', { rows: 4, placeholder: 'e.g. What is printed?' });
  stem.value = q ? q.q : '';
  const code = h('textarea', { class: 'mono', rows: 6, spellcheck: 'false', placeholder: 'Optional. Paste code exactly as it should appear, one line per line.' });
  code.value = q?.code ? q.code.join('\n') : '';
  const sub = h('textarea', { rows: 3, placeholder: 'Optional. One statement per line, e.g. (i) ...' });
  sub.value = q?.sub ? q.sub.join('\n') : '';
  const solution = h('textarea', { rows: 4, placeholder: 'Optional. The worked solution, shown only to admins.' });
  solution.value = q?.solution ? q.solution.join('\n') : '';

  let answer = q ? q.answer : -1;
  const rows = [];
  const inputs = [0, 1, 2, 3].map((i) => {
    const input = h('input', { type: 'text', placeholder: `Option ${'ABCD'[i]}` });
    input.value = q ? q.options[i] : '';
    const radio = h('input', { type: 'radio', name: 'correct', title: 'Mark as the correct answer', checked: answer === i,
      onchange: () => { answer = i; rows.forEach((r, j) => r.classList.toggle('correct', j === i)); } });
    rows.push(h('label', { class: 'opt-row' + (answer === i ? ' correct' : '') }, radio, h('span', { class: 'l' }, 'ABCD'[i]), input));
    return input;
  });
  // New questions start with the marking already used in the chosen section (or +4 / −1).
  const sectionDefault = (key) => Q.data.questions.find((x) => x.section === key) || { marks: 4, negative: 1 };
  const marks = h('input', { type: 'number', min: '0.01', max: '100', step: '0.01', required: true });
  const negative = h('input', { type: 'number', min: '0', max: '100', step: '0.01', required: true });
  const fillMarks = (src) => { marks.value = fmtNum(src.marks); negative.value = fmtNum(src.negative); };
  fillMarks(q || sectionDefault(section.value));
  if (!q) section.addEventListener('change', () => fillMarks(sectionDefault(section.value)));
  const err = h('p', { class: 'error-text' });
  const save = h('button', { class: 'gradient', type: 'submit' }, icon('check'), q ? 'Save changes' : 'Add question');

  const form = h('form', { class: 'editor', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    save.disabled = true;
    const body = { section: section.value, q: stem.value, code: code.value, sub: sub.value, options: inputs.map((i) => i.value), answer, solution: solution.value, marks: marks.value, negative: negative.value };
    try {
      if (q) await api('PUT', `/api/admin/questions/${encodeURIComponent(q.id)}`, body);
      else await api('POST', '/api/admin/questions', body);
      toast(q ? `${q.id} updated.` : 'Question added.');
      closeDrawer();
      await Promise.all([loadQuestions(), loadSummary()]);
    } catch (ex) {
      err.textContent = ex.message;
      save.disabled = false;
    }
  } },
    h('label', { class: 'field' }, h('span', null, 'Section'), section),
    h('label', { class: 'field' }, h('span', null, 'Question'), stem),
    h('label', { class: 'field' }, h('span', null, 'Code ', h('span', { class: 'hint' }, '(optional)')), code),
    h('label', { class: 'field' }, h('span', null, 'Statements ', h('span', { class: 'hint' }, '(optional, one per line)')), sub),
    h('div', { class: 'field' }, h('span', { style: 'display:block;font-weight:600;font-size:13px;margin-bottom:.45em;color:var(--text-2)' },
      'Options ', h('span', { class: 'hint' }, '(select the circle next to the correct answer)')), h('div', { class: 'opt-rows' }, rows)),
    h('div', { class: 'settings-grid', style: 'grid-template-columns:1fr 1fr' },
      h('label', { class: 'field' }, h('span', null, 'Marks for a correct answer'), marks),
      h('label', { class: 'field' }, h('span', null, 'Negative marks for a wrong answer ', h('span', { class: 'hint' }, '(0 = none)')), negative)),
    h('label', { class: 'field' }, h('span', null, 'Solution ', h('span', { class: 'hint' }, '(optional, admin only)')), solution),
    err,
    h('div', { class: 'editor-actions' }, h('button', { type: 'button', onclick: closeDrawer }, 'Cancel'), save));

  $('#drawer-sheet').replaceChildren(
    h('div', { class: 'head' },
      h('span', { class: 'avatar', style: 'background:var(--primary)' }, icon(q ? 'edit' : 'plus')),
      h('div', null, h('h2', null, q ? `Edit question ${q.id}` : 'Add a question'),
        h('div', { class: 'muted' }, q ? 'Changes apply immediately. Submitted exams are re-scored if the answer changes.' : 'New questions are added to the chosen section.')),
      h('span', { class: 'spacer' }),
      h('button', { onclick: closeDrawer }, icon('x'), 'Close')),
    h('div', { class: 'body' }, h('div', { class: 'card' }, form)));
  $('#drawer').hidden = false;
  stem.focus();
}

async function removeQuestion(q) {
  if (!confirm(`Delete question ${q.id}? Students who already submitted will be re-scored without it. This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/admin/questions/${encodeURIComponent(q.id)}`);
    toast(`${q.id} deleted.`);
    await Promise.all([loadQuestions(), loadSummary()]);
  } catch (err) { toast(err.message, 'warn'); }
}

// ---------- settings ----------
function fillSettings() {
  const s = A.summary.settings;
  $('#set-open').checked = s.examOpen;
  $('#set-reg').checked = s.registrationOpen;
  $('#set-duration').value = s.durationMin;
  $('#set-timing-overall').checked = s.timingMode !== 'section';
  $('#set-timing-section').checked = s.timingMode === 'section';
  syncTimingFields();
  $('#set-maxv').value = s.maxViolations;
  $('#set-snap').value = s.snapshotIntervalSec;
  $('#set-org').value = s.orgName;
  $('#set-exam').value = s.examName;
  $('#set-mode-mcq').checked = s.examMode !== 'usecase';
  $('#set-mode-uc').checked = s.examMode === 'usecase';
  $('#set-uc-duration').value = s.ucDurationMin;
  $('#set-uc-marks').value = s.ucMaxMarks;
  syncModeFields();
}

function syncModeFields() {
  const uc = $('#set-mode-uc').checked;
  $('#uc-settings').hidden = !uc;
  $('#mcq-settings').hidden = uc;
  for (const el of $('#mcq-settings').querySelectorAll('input')) el.required = !uc && el.type === 'number';
}
$('#set-mode-mcq').onchange = syncModeFields;
$('#set-mode-uc').onchange = syncModeFields;

// In per-section mode the overall duration isn't used; show the section total instead.
async function syncTimingFields() {
  const section = $('#set-timing-section').checked;
  $('#set-duration').disabled = section;
  try {
    const qd = Q.data || await api('GET', '/api/admin/questions');
    const used = qd.sections.filter((s) => qd.questions.some((q) => q.section === s.key));
    const missing = used.filter((s) => !s.minutes).length;
    $('#section-total').textContent = ` (currently ${used.reduce((t, s) => t + (s.minutes || 0), 0)} min${missing ? `, ${missing} section${missing === 1 ? '' : 's'} without a time` : ''})`;
  } catch { /* ignore */ }
}
$('#set-timing-overall').onchange = syncTimingFields;
$('#set-timing-section').onchange = syncTimingFields;

$('#settings-form').onsubmit = async (e) => {
  e.preventDefault();
  const msg = $('#settings-msg');
  msg.textContent = '';
  try {
    await api('PUT', '/api/admin/settings', {
      examOpen: $('#set-open').checked,
      registrationOpen: $('#set-reg').checked,
      durationMin: Number($('#set-duration').value),
      timingMode: $('#set-timing-section').checked ? 'section' : 'overall',
      maxViolations: Number($('#set-maxv').value),
      snapshotIntervalSec: Number($('#set-snap').value),
      orgName: $('#set-org').value,
      examName: $('#set-exam').value,
      examMode: $('#set-mode-uc').checked ? 'usecase' : 'mcq',
      ucDurationMin: Number($('#set-uc-duration').value),
      ucMaxMarks: Number($('#set-uc-marks').value),
    });
    await loadSummary();
    fillSettings();
    loadBranding();
    toast('Configuration saved.');
  } catch (err) { msg.textContent = err.message; }
};

// ---------- use-case round: results & evaluation ----------
async function loadUcResults(force = true) {
  const d = await api('GET', '/api/admin/usecase-results');
  // the 15-second auto refresh must not wipe marks the examiner is still typing
  if (!force && A.ucDirty) return;
  A.uc = d;
  A.ucDirty = false;
  renderUcResults();
}

function renderUcStats() {
  const pending = A.summary.students.filter((s) => s.approval === 'pending').length;
  const rows = A.uc?.results || [];
  const done = rows.filter((r) => r.status === 'submitted');
  const marked = done.filter((r) => r.marks !== null && r.marks !== undefined);
  const max = A.summary.settings.ucMaxMarks;
  const avg = marked.length ? (marked.reduce((t, r) => t + r.marks, 0) / marked.length).toFixed(1) : '—';
  const stat = (tone, v, k) => h('div', { class: `stat tone-${tone}` }, h('div', null, h('div', { class: 'v' }, String(v)), h('div', { class: 'k' }, k)));
  $('#stats').replaceChildren(
    stat('primary', rows.length, 'Registered'),
    stat('warn', pending, 'Pending Approval'),
    stat('slate', rows.filter((r) => r.status === 'not_started').length, 'Not Started'),
    stat('violet', rows.filter((r) => r.status === 'in_progress').length, 'In Progress'),
    stat('ok', done.length, 'Submitted'),
    stat('warn', done.length - marked.length, 'Awaiting Evaluation'),
    stat('primary', avg, `Average (of ${max})`),
    stat('warn', marked.length ? Math.max(...marked.map((r) => r.marks)) : '—', 'Highest Marks'));
}

function renderUcResults() {
  const q = $('#uc-search').value.trim().toLowerCase();
  const f = $('#uc-filter').value;
  const max = A.uc.settings.ucMaxMarks;
  const evaluated = (r) => r.marks !== null && r.marks !== undefined;
  const rows = A.uc.results.filter((r) =>
    (!q || r.username.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)) &&
    (!f || (f === 'pending_eval' ? r.status === 'submitted' && !evaluated(r) : f === 'evaluated' ? evaluated(r) : r.status === f)));
  const body = rows.map((r) => {
    const canMark = r.status === 'submitted';
    const marks = h('input', { type: 'number', min: '0', max: String(max), step: '0.5', style: 'width:80px', disabled: !canMark, 'aria-label': 'Marks' });
    marks.value = evaluated(r) ? r.marks : '';
    const remarks = h('input', { type: 'text', maxlength: '1000', placeholder: 'Remarks', style: 'min-width:200px', disabled: !canMark, 'aria-label': 'Remarks' });
    remarks.value = r.remarks || '';
    const save = h('button', { class: 'small primary', disabled: !canMark, onclick: async () => {
      save.disabled = true;
      try {
        await api('PUT', `/api/admin/usecase-results/${r.id}`, { marks: marks.value === '' ? null : Number(marks.value), remarks: remarks.value });
        toast(`Marks saved for ${r.username}.`);
        await loadUcResults(true);
        renderUcStats();
      } catch (err) { toast(err.message, 'warn'); save.disabled = false; }
    } }, 'Save');
    const onEnter = (e) => { if (e.key === 'Enter') save.click(); };
    marks.onkeydown = onEnter;
    remarks.onkeydown = onEnter;
    marks.oninput = remarks.oninput = () => { A.ucDirty = true; };
    return h('tr', null,
      h('td', null, h('strong', null, r.username)),
      h('td', null, h('span', { class: 'cell-user' }, avatar(r.name, r.username), r.name)),
      h('td', null, statusBadge(r.status), evaluated(r) ? h('span', { class: 'badge ok', style: 'margin-left:4px' }, 'Evaluated') : null),
      h('td', { class: 'wrap', style: 'max-width:220px' }, r.usecase || '—'),
      h('td', null, r.status === 'in_progress' ? `${fmtDuration(r.remainingSec)} left` : r.submittedAt ? fmtTime(r.submittedAt) : '—',
        r.submitReason && r.submitReason !== 'Submitted by candidate' ? h('div', { class: 'muted', style: 'font-size:12px' }, r.submitReason) : null),
      h('td', { class: 'wrap', style: 'max-width:280px;word-break:break-all' },
        r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.url) : (r.status === 'submitted' ? h('span', { class: 'muted' }, 'No link submitted') : '—')),
      h('td', null, marks, h('span', { class: 'muted' }, ` / ${max}`)),
      h('td', null, remarks),
      h('td', null, save, ' ',
        r.status === 'in_progress' && h('button', { class: 'small danger', onclick: () => ucForceSubmit(r) }, 'Close Attempt')));
  });
  $('#uc-table').replaceChildren(
    h('thead', null, h('tr', null, ['Roll No.', 'Candidate Name', 'Status', 'Use Case', 'Time Left / Submitted At', 'Solution Link', 'Marks', 'Remarks', ''].map((t) => h('th', null, t)))),
    h('tbody', null, body.length ? body : h('tr', null, h('td', { colspan: 9, class: 'empty' }, 'No candidates match.'))));
}

async function ucForceSubmit(r) {
  if (!confirm(`Close ${r.username}'s use-case attempt now? They will not be able to submit a link after this.`)) return;
  try {
    await api('POST', `/api/admin/usecase-results/${r.id}/force-submit`);
    toast(`${r.username}'s attempt was closed.`);
    await loadSummary();
  } catch (err) { toast(err.message, 'warn'); }
}

$('#uc-search').oninput = () => A.uc && renderUcResults();
$('#uc-filter').onchange = () => A.uc && renderUcResults();
$('#uc-refresh').onclick = () => loadSummary().catch((e) => toast(e.message, 'warn'));
$('#uc-export').onclick = () => { location.href = '/api/admin/export.csv'; };

// ---------- use cases ----------
const U = { list: [] };
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

async function loadUseCases() {
  const d = await api('GET', '/api/admin/usecases');
  U.list = d.usecases;
  $('#uc-count').textContent = String(U.list.length);
  const note = $('#uc-mode-note');
  note.hidden = d.settings.examMode === 'usecase';
  note.textContent = 'The portal is currently set to the MCQ Test. To conduct the use-case round, choose "Use-Case Round" under Configuration → Test Type.';
  $('#usecases-table').replaceChildren(
    h('thead', null, h('tr', null, ['#', 'Title', 'Description', 'PDF', 'Assigned to', 'Actions'].map((t) => h('th', null, t)))),
    h('tbody', null, U.list.length ? U.list.map((u, i) => h('tr', null,
      h('td', null, String(i + 1)),
      h('td', { class: 'wrap', style: 'min-width:180px' }, h('strong', null, u.title)),
      h('td', { class: 'wrap muted', style: 'max-width:420px' }, u.description ? (u.description.length > 160 ? u.description.slice(0, 160) + '…' : u.description) : '—'),
      h('td', null, u.pdfName ? h('a', { href: `/api/admin/usecases/${u.id}/pdf`, target: '_blank', rel: 'noopener' }, `${u.pdfName} (${fmtSize(u.pdfSize)})`) : h('span', { class: 'muted' }, 'None')),
      h('td', { class: 'num' }, `${u.assigned} candidate${u.assigned === 1 ? '' : 's'}`),
      h('td', null,
        h('button', { class: 'small', onclick: () => openUseCaseEditor(u) }, 'Edit'), ' ',
        h('button', { class: 'small danger', disabled: u.assigned > 0, title: u.assigned ? 'Already assigned to candidates' : null, onclick: () => removeUseCase(u) }, 'Delete')))) :
      h('tr', null, h('td', { colspan: 6, class: 'empty' }, 'No use cases yet. Click "Add Use Case" to add the first one.'))));
}

async function uploadPdf(id, file) {
  const r = await fetch(`/api/admin/usecases/${id}/pdf`, {
    method: 'PUT', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/pdf', 'X-File-Name': encodeURIComponent(file.name) }, body: file,
  });
  if (!r.ok) {
    let msg = r.status === 413 ? 'The PDF is too large (maximum 25 MB).' : 'The PDF could not be uploaded.';
    try { msg = (await r.json()).error || msg; } catch { /* keep default */ }
    throw new Error(msg);
  }
}

function openUseCaseEditor(u) {
  A.openId = null;
  const title = h('input', { type: 'text', maxlength: '150', required: true, placeholder: 'e.g. Smart inventory forecasting for a retail chain' });
  title.value = u?.title || '';
  const desc = h('textarea', { rows: 12, placeholder: 'The problem statement, requirements and what the candidate should submit. Optional if a PDF is attached.' });
  desc.value = u?.description || '';
  const file = h('input', { type: 'file', accept: 'application/pdf,.pdf' });
  let removePdf = false;
  const current = u?.pdfName ? h('div', { class: 'uc-current-pdf' },
    h('a', { href: `/api/admin/usecases/${u.id}/pdf`, target: '_blank', rel: 'noopener' }, `${u.pdfName} (${fmtSize(u.pdfSize)})`), ' ',
    h('button', { type: 'button', class: 'small danger', onclick: (e) => { removePdf = true; e.target.closest('.uc-current-pdf').replaceChildren(h('span', { class: 'muted' }, 'The PDF will be removed when you save.')); } }, 'Remove PDF')) : null;
  const err = h('p', { class: 'error-text' });
  const save = h('button', { class: 'gradient', type: 'submit' }, u ? 'Save changes' : 'Add use case');
  const form = h('form', { class: 'editor', onsubmit: async (e) => {
    e.preventDefault();
    err.textContent = '';
    const f = file.files[0];
    if (f && (f.size > 25 * 1024 * 1024)) { err.textContent = 'The PDF is too large (maximum 25 MB).'; return; }
    if (!desc.value.trim() && !f && !(u?.pdfName && !removePdf)) { err.textContent = 'Add a description or attach a PDF.'; return; }
    save.disabled = true;
    try {
      let id = u?.id;
      if (u) {
        await api('PUT', `/api/admin/usecases/${id}`, { title: title.value, description: desc.value });
      } else {
        id = (await api('POST', '/api/admin/usecases', { title: title.value, description: desc.value })).id;
        // Adopt the newly created row so a subsequent PDF retry updates it instead of inserting a duplicate.
        u = { id, title: title.value, description: desc.value };
      }
      if (f) await uploadPdf(id, f);
      else if (removePdf) await api('DELETE', `/api/admin/usecases/${id}/pdf`);
      toast(u ? 'Use case updated.' : 'Use case added.');
      closeDrawer();
      await loadUseCases();
    } catch (ex) {
      err.textContent = ex.message;
      save.disabled = false;
      if (!u) await loadUseCases().catch(() => {});
    }
  } },
    h('label', { class: 'field' }, h('span', null, 'Title'), title),
    h('label', { class: 'field' }, h('span', null, 'Description ', h('span', { class: 'hint' }, '(shown to the candidate)')), desc),
    h('div', { class: 'field' }, h('span', { style: 'display:block;font-weight:600;font-size:13px;margin-bottom:.45em;color:var(--text-2)' },
      'PDF document ', h('span', { class: 'hint' }, u?.pdfName ? '(choose a file to replace the current one; max 25 MB)' : '(optional, max 25 MB)')), current, file),
    u?.assigned ? h('p', { class: 'muted', style: 'font-size:12.5px' }, `This use case is assigned to ${u.assigned} candidate${u.assigned === 1 ? '' : 's'}. Changes are visible to them immediately.`) : null,
    err,
    h('div', { class: 'editor-actions' }, h('button', { type: 'button', onclick: closeDrawer }, 'Cancel'), save));
  $('#drawer-sheet').replaceChildren(
    h('div', { class: 'head' },
      h('div', null, h('h2', null, u ? 'Edit use case' : 'Add a use case'),
        h('div', { class: 'muted' }, 'Candidates are assigned one use case at random.')),
      h('span', { class: 'spacer' }),
      h('button', { onclick: closeDrawer }, 'Close')),
    h('div', { class: 'body' }, h('div', { class: 'card' }, form)));
  $('#drawer').hidden = false;
  title.focus();
}

async function removeUseCase(u) {
  if (!confirm(`Delete the use case "${u.title}"? This cannot be undone.`)) return;
  try {
    await api('DELETE', `/api/admin/usecases/${u.id}`);
    toast('Use case deleted.');
    await loadUseCases();
  } catch (err) { toast(err.message, 'warn'); }
}
$('#btn-add-uc').onclick = () => openUseCaseEditor(null);

// ---------- start ----------
(async () => {
  const me = await api('GET', '/api/me');
  if (me.role !== 'admin') return location.replace('/exam');
  $('#admin-who').textContent = me.name || me.username;
  loadBranding();
  await loadSummary();
  fillSettings();
  setInterval(() => {
    if (document.hidden) return;
    loadSummary(true).catch(() => {});
    if (A.openId && A.openStatus === 'in_progress') refreshDrawer();
  }, 15000);
})().catch((e) => toast(e.message, 'warn'));
