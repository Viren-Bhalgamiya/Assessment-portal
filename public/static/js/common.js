'use strict';
// Shared helpers for all pages.

// Keep a private reference to the browser's own fetch so later monkey-patching from the console has no effect,
// and make `api` a constant so it can't be reassigned either.
const nativeFetch = window.fetch.bind(window);

const api = async function api(method, url, body) {
  const res = await nativeFetch(url, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && url !== '/api/login') {
    location.href = '/';
    throw new Error('Not logged in');
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
};

// Small DOM builder: h('div', { class: 'x', onclick: fn }, 'text', childNode, [more])
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

const $ = (sel, root = document) => root.querySelector(sel);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(sec));
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return hh ? `${hh}:${p(mm)}:${p(ss)}` : `${p(mm)}:${p(ss)}`;
}

function fmtTime(ms) {
  return ms ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' }) : '—';
}

// Inline SVG icons (Lucide-style strokes). Static strings only, so innerHTML is safe here.
const ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  camera: '<path d="m22 8-6 4 6 4V8z"/><rect x="2" y="6" width="14" height="12" rx="2"/>',
  monitor: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  share: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4M9 10l3-3 3 3M12 7v6"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M1 21a8 8 0 0 1 16 0M17 4a4 4 0 0 1 0 8M23 21a8 8 0 0 0-5-7.4"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  hash: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  hourglass: '<path d="M6 2h12M6 22h12M6 2v4a6 6 0 0 0 12 0V2M6 22v-4a6 6 0 0 1 12 0v4"/>',
  x: '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7z"/><path d="M22 2 11 13"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  copyoff: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1M2 2l20 20"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4V8z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/>',
  eraser: '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L11 21M22 21H7M5 11l9 9"/>',
};

function icon(name, cls = 'icon') {
  const span = document.createElement('span');
  span.className = cls;
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span;
}

// <span data-icon="camera"></span> placeholders in static HTML become SVG icons.
document.querySelectorAll('[data-icon]').forEach((el) => el.replaceWith(icon(el.dataset.icon, el.className ? `icon ${el.className}` : 'icon')));

const AVATAR_COLORS = ['#0f766e', '#1e40af', '#6d28d9', '#b45309', '#9f1239', '#4b5563', '#166534', '#155e75'];
function avatar(name, username) {
  const initials = String(name || username || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  let hsh = 0;
  for (const c of String(username || name)) hsh = (hsh * 31 + c.charCodeAt(0)) >>> 0;
  return h('span', { class: 'avatar', style: `background:${AVATAR_COLORS[hsh % AVATAR_COLORS.length]}` }, initials || '?');
}

// Organisation / examination names (set by the admin) shown in every page header.
const orgInitials = (name) => String(name || '').split(/\s+/).filter((w) => /^[A-Za-z]/.test(w) && !/^(of|and|the|for)$/i.test(w))
  .slice(0, 3).map((w) => w[0].toUpperCase()).join('') || 'EX';
function applyBranding(info) {
  if (!info) return;
  document.querySelectorAll('[data-org]').forEach((e) => { e.textContent = info.orgName; });
  document.querySelectorAll('[data-exam]').forEach((e) => { e.textContent = info.examName; });
  document.querySelectorAll('.emblem').forEach((e) => { e.textContent = orgInitials(info.orgName); });
  document.querySelectorAll('[data-year]').forEach((e) => { e.textContent = new Date().getFullYear(); });
  const pageName = document.body.dataset.page;
  document.title = pageName ? `${pageName} | ${info.examName}` : info.examName;
}
async function loadBranding() {
  try { const info = await api('GET', '/api/registration'); applyBranding(info); return info; } catch { return null; }
}

async function logout() {
  try { await api('POST', '/api/logout'); } catch { /* ignore */ }
  try { sessionStorage.clear(); } catch { /* ignore */ }
  location.href = '/';
}
