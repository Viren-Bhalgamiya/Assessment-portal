'use strict';

function showTab(which) {
  $('#tab-login').classList.toggle('active', which === 'login');
  $('#tab-register').classList.toggle('active', which === 'register');
  $('#login-form').hidden = which !== 'login';
  $('#register-form').hidden = which !== 'register';
}
$('#tab-login').onclick = () => showTab('login');
$('#tab-register').onclick = () => showTab('register');

// Password visibility toggles
const STRONG_PASS = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z0-9]).{8,}$/;
const PW_RULES = {
  len: (v) => v.length >= 8,
  upper: (v) => /[A-Z]/.test(v),
  lower: (v) => /[a-z]/.test(v),
  digit: (v) => /\d/.test(v),
  symbol: (v) => /[^A-Za-z0-9]/.test(v),
};
const regPass = document.getElementById('reg-pass');
const checklist = document.getElementById('pw-checklist');
if (regPass && checklist) {
  const items = checklist.querySelectorAll('li');
  const update = () => {
    const v = regPass.value;
    items.forEach((li) => {
      const ok = PW_RULES[li.dataset.rule](v);
      li.classList.toggle('ok', ok);
      li.querySelector('.mark').textContent = ok ? '✔' : '✖';
    });
  };
  regPass.addEventListener('input', update);
  regPass.addEventListener('focus', update);
  update();
}

document.querySelectorAll('.toggle-pass').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    btn.textContent = show ? 'Hide' : 'Show';
    btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });
});

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
  const pw = $('#reg-pass').value;
  if (!STRONG_PASS.test(pw)) {
    errEl.textContent = 'Password must be at least 8 characters and include uppercase, lowercase, a number, and a special character.';
    return;
  }
  if (pw !== $('#reg-pass2').value) {
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
