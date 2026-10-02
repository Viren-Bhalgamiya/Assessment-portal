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
  if (!info.open) $('#tab-register').hidden = true;
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
    location.href = '/exam';
  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled = false;
  }
});
