'use strict';

function showTab(which) {
  $('#tab-login').classList.toggle('active', which === 'login');
  $('#tab-register').classList.toggle('active', which === 'register');
  $('#login-form').hidden = which !== 'login';
  $('#register-form').hidden = which !== 'register';
}
$('#tab-login').onclick = () => showTab('login');
$('#tab-register').onclick = () => showTab('register');

// Already signed in (e.g. pages served statically by Vercel): go straight to the right page.
fetch('/api/me', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((me) => {
  if (me) location.replace(me.role === 'admin' ? '/admin' : '/exam');
}).catch(() => {});

loadBranding().then((info) => {
  if (!info) return;
  const statusCell = $('#fact-status');
  if (statusCell) statusCell.textContent = info.examOpen ? 'Open for testing' : 'Not yet opened';
  const badge = $('#exam-status-badge');
  if (badge) {
    badge.textContent = info.examOpen ? 'Exam Open' : 'Exam Not Started';
    badge.className = 'alert ' + (info.examOpen ? 'ok' : 'info');
    badge.hidden = false;
  }
  if (!info.open) {
    $('#tab-register').hidden = true;
    const notice = $('#reg-closed-notice');
    if (notice) {
      notice.textContent = 'Self-registration is currently closed by the examination authority. If you already have credentials, sign in below.';
      notice.hidden = false;
    }
  }
  if (info.mode === 'usecase') {
    $('#login-rules').replaceChildren(...[
      'Use a laptop or desktop computer with a stable internet connection.',
      'After signing in and starting the round, you will be assigned one use case at random. The timer starts when you click "Start".',
      'Submit one link to your solution (for example a GitHub repository, Google Drive folder or deployed app) before the time ends. Make sure the link can be opened without signing in.',
      'You can submit only once. Do not share your roll number or password.',
    ].map((t) => h('li', null, t)));
    $('#fact-q-label').textContent = 'Test type';
    $('#fact-q').textContent = 'Use-case round';
    $('#fact-t').textContent = info.durationMin;
    $('#fact-m').textContent = `Evaluated by the examiner (maximum ${info.useCaseMaxMarks} marks)`;
    return;
  }
  $('#fact-q').textContent = info.questionCount;
  $('#fact-t').textContent = info.durationMin;
  $('#fact-m').textContent = info.marking
    ? `+${info.marking.marks} for a correct answer, ${info.marking.negative ? `−${info.marking.negative} for a wrong answer` : 'no negative marking'}`
    : `Varies by question (maximum ${info.maxScore} marks)`;
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#login-btn');
  const errEl = $('#login-error');
  errEl.textContent = '';
  btn.disabled = true;
  try {
    const { role } = await api('POST', '/api/login', {
      username: $('#username').value.trim(),
      password: $('#password').value,
    });
    location.href = role === 'admin' ? '/admin' : '/exam';
  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled = false;
  }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#reg-btn');
  const errEl = $('#reg-error');
  errEl.className = 'error-text';
  errEl.textContent = '';
  if ($('#reg-pass').value !== $('#reg-pass2').value) {
    errEl.textContent = 'The passwords do not match.';
    return;
  }
  btn.disabled = true;
  try {
    await api('POST', '/api/register', {
      username: $('#reg-roll').value.trim(),
      name: $('#reg-name').value.trim(),
      password: $('#reg-pass').value,
    });
    errEl.className = 'success-text';
    errEl.textContent = 'Registration submitted successfully. Redirecting to your verification portal…';
    setTimeout(() => { location.href = '/exam'; }, 1500);
  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled = false;
  }
});
