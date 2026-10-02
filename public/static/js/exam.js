'use strict';
// Student exam page: pre-exam device checks, the exam itself, and in-browser proctoring.
// Everything lives inside this closure so it can't be reached or overridden from the browser console.
(() => {

const S = {
  me: null,
  questions: [], sections: [], answers: {}, marked: new Set(), idx: 0, qbtns: [],
  deadlineLocal: 0, warned5: false,
  violations: 0, maxViolations: 3, snapshotIntervalSec: 30, secCounts: [],
  cam: null, screen: null, camMutedAt: 0,
  mic: null, micMutedAt: 0, audio: null, // audio = { ctx, analyser, buf, floor, loud: [], lastVoice, silentSince, recording }
  started: false, ended: false, submitting: false,
  focusLost: false, inPicker: false, resuming: false,
  seq: 0, outbox: [], // proctoring events not yet acknowledged by the server
  blockers: new Set(),
  timers: [],
};

// Keep the browser's own getters. A student who later redefines document.hidden, visibilityState,
// hasFocus or fullscreenElement from the console cannot fool these.
const getter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).get;
const nativeVisibility = getter(Document.prototype, 'visibilityState');
const nativeFullscreenElement = getter(Document.prototype, 'fullscreenElement');
const nativeHasFocus = Document.prototype.hasFocus;
const isHidden = () => nativeVisibility.call(document) === 'hidden';
const hasFocus = () => nativeHasFocus.call(document);
const fsElement = () => nativeFullscreenElement.call(document);
// Listeners go on window in the capture phase, registered at page load, so they run before
// anything added later and cannot be silenced with stopImmediatePropagation().
const guard = (type, fn) => window.addEventListener(type, fn, true);

// Event ids: unique and increasing across page reloads, never taken from the server.
let seqCounter = 0;
const nextSeq = () => Date.now() * 1000 + (seqCounter++ % 1000);

const camVideo = $('#cam-video');
const screenVideo = $('#screen-video');
const preview = $('#setup-preview');

// ---------- screens ----------
function show(id) {
  for (const s of ['screen-loading', 'screen-message', 'screen-setup', 'screen-exam', 'screen-usecase']) $('#' + s).hidden = s !== id;
}

function showMessage(title, body, { refresh = false, tone = 'info', ic = null } = {}) {
  const TONE_ICONS = { success: 'check', danger: 'alert', warn: 'clock', info: 'shield', wait: 'hourglass' };
  const box = $('#msg-icon');
  box.className = `msg-icon ${tone}`;
  box.replaceChildren(icon(ic || TONE_ICONS[tone]));
  $('#msg-title').textContent = title;
  $('#msg-body').textContent = body;
  $('#msg-refresh').hidden = !refresh;
  show('screen-message');
}

function showSubmitted(kind) {
  const msgs = {
    submitted: ['Test Submitted Successfully', 'Your responses have been recorded. Results will be declared by the examination authority. You may now close this window.', 'success'],
    time_up: ['Time Over: Test Submitted', 'The allotted time has ended and your responses have been submitted automatically. Results will be declared by the examination authority.', 'warn'],
    terminated: ['Test Terminated: Violation Limit Reached', 'Your test has been submitted automatically because the permitted number of violations was reached. Your responses and the proctoring record have been forwarded to the examination authority.', 'danger'],
    already: ['Test Already Submitted', 'You have already submitted this test. Results will be declared by the examination authority.', 'success'],
  };
  const [title, body, tone] = msgs[kind] || msgs.already;
  showMessage(title, body, { tone });
}

$('#msg-refresh').onclick = () => location.reload();
$('#msg-logout').onclick = logout;
$('#setup-logout').onclick = logout;

let toastTimer;
function toast(msg, kind = 'warn', ms = 5000) {
  const t = $('#toast');
  t.replaceChildren(icon(kind === 'warn' ? 'alert' : 'shield'), msg);
  t.className = 'toast show' + (kind === 'warn' ? ' warn' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, ms);
}

// ---------- start-up ----------
async function init() {
  S.me = await api('GET', '/api/me');
  if (S.me.role === 'admin') return location.replace('/admin');
  const st = await api('GET', '/api/exam/status');
  if (st.approval === 'approved' && st.mode === 'usecase') return initUseCase();
  if (!window.isSecureContext) {
    return showMessage('Secure Connection Required', 'This test must be opened over a secure (HTTPS) connection so that the webcam and screen sharing can work. Please contact the examination authority.', { tone: 'danger', ic: 'lock' });
  }
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || !navigator.mediaDevices?.getDisplayMedia ||
      !navigator.mediaDevices?.getUserMedia || !document.documentElement.requestFullscreen) {
    return showMessage('Unsupported Device or Browser', 'This test can only be taken on a laptop or desktop computer using the latest Google Chrome or Microsoft Edge.', { tone: 'danger', ic: 'monitor' });
  }
  if (st.approval === 'pending') {
    showMessage('Registration Awaiting Approval',
      `Dear ${S.me.name}, your registration (${S.me.username}) has been received and is awaiting approval by the examination authority. This page will update automatically once it is approved.`, { tone: 'wait' });
    setTimeout(() => location.reload(), 5000);
    return;
  }
  if (st.approval === 'rejected') return showMessage('Registration Not Approved', 'Your registration has not been approved. Please contact the examination authority.', { tone: 'danger', ic: 'x' });
  if (st.status === 'submitted') return showSubmitted(st.violations >= st.maxViolations && st.maxViolations > 0 ? 'terminated' : 'already');
  if (st.status === 'none' && !st.examOpen) {
    return showMessage('Test Not Yet Started', 'The test has not been opened yet. Please wait for the invigilator\'s instruction and click Refresh.', { refresh: true, tone: 'info', ic: 'clock' });
  }
  showSetup(st);
}

function showSetup(st) {
  $('#setup-who').textContent = `${S.me.name} (${S.me.username})`;
  $('#resume-note').hidden = st.status !== 'in_progress';
  // Resuming mid-exam: the clock is running, so leaving the page here is monitored too.
  S.resuming = st.status === 'in_progress';
  if (S.resuming) {
    S.violations = st.violations;
    S.maxViolations = st.maxViolations;
    $('#resume-note').replaceChildren(icon('alert'), h('span', null,
      `You have already started this test. Re-opening the test page has been recorded as violation ${st.violations}` +
      (st.maxViolations > 0 ? ` of ${st.maxViolations}` : '') + '. Your saved responses and remaining time will be restored.'));
  }
  loadBranding().then((info) => { if (info) $('#hero-subjects').textContent = `Sections: ${info.subjects.join(', ')}.`; });
  $('#hs-q').textContent = st.questionCount;
  $('#hs-t').textContent = st.durationMin;
  $('#hs-w').textContent = st.maxViolations > 0 ? st.maxViolations : '∞';
  const timeNote = st.status === 'in_progress' ? ` About ${Math.ceil(st.remainingSec / 60)} minutes are left.` : '';
  const sectionRule = st.timingMode === 'section'
    ? [['clock', `Each section is separately timed: ${st.sectionTimes.map((x) => `${x.title} (${x.minutes} min)`).join(', ')}. ` +
        'Sections must be attempted in the order shown. When the time for a section ends, or you choose to finish it, the next section opens and you cannot return to the previous section.', true]]
    : [];
  const rules = [
    ['clock', `The total duration of the test is ${st.durationMin} minutes.${timeNote} The countdown timer at the top right of the screen shows the time remaining. The test is submitted automatically when the time ends.`],
    ...sectionRule,
    ['book', `The test contains ${st.questionCount} multiple-choice questions. Each question has four options, of which only one is correct.`],
    ['book', st.marking
      ? `Each correct answer carries ${st.marking.marks} marks. ${st.marking.negative ? `${st.marking.negative} mark${st.marking.negative === 1 ? ' is' : 's are'} deducted for each wrong answer.` : 'There is no negative marking.'} No marks are awarded or deducted for unattempted questions.`
      : 'The marks for each question are displayed above the question. Wrong answers may carry negative marks. No marks are awarded or deducted for unattempted questions.'],
    ['book', 'To answer a question, select an option and click "Save & Next". Use "Mark for Review & Next" to revisit a question later; answered questions marked for review will be evaluated. Use "Clear Response" to remove a selected answer.'],
    ['book', 'Use the question palette on the right to move directly to any question of the current section. The colour of each number shows the status of the question (see the legend below).'],
    ['alert', 'Your webcam and microphone must stay on for the whole test. Sound around you is monitored: if speech or other sound is detected, a short audio recording is sent to the examination authority. Turning off or muting the microphone is recorded as a violation.', true],
    ['maximize', 'The test runs in full-screen mode. Switching to another tab, window or application, minimising the browser, leaving full-screen mode or reloading the page is recorded as a violation.', true],
    ['copyoff', 'Copying, cutting, pasting, right-clicking and keyboard shortcuts are not permitted. Any such attempt is recorded as a violation.', true],
    ['alert', st.maxViolations > 0
      ? `If ${st.maxViolations} violations are recorded, the test is submitted automatically and cannot be re-attempted.`
      : 'Every violation is recorded and reviewed by the examination authority.', true],
    ['camera', 'Your webcam must remain switched on with your face clearly visible, and your entire screen must be shared for the whole test. Both are recorded.'],
    ['shield', 'Responses are saved automatically. Marks are not displayed after submission; results will be declared by the examination authority.'],
  ];
  $('#rules').replaceChildren(...rules.map(([ic, text, danger]) => h('li', { class: danger ? 'danger' : null }, icon(ic), h('span', null, text))));
  show('screen-setup');
  refreshMonitorStep();
}

function setStep(id, ok, text) {
  const el = $('#' + id);
  el.classList.toggle('done', ok === true);
  el.classList.toggle('failed', ok === false);
  if (text) $('.status', el).textContent = text;
}

const isLive = (stream) => !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
const isLiveAudio = (stream) => !!stream && stream.getAudioTracks().some((t) => t.readyState === 'live');
const hasExtraMonitor = () => window.screen.isExtended === true;
const stopStream = (stream) => stream?.getTracks().forEach((t) => t.stop());

function updateStartButton() {
  $('#btn-start').disabled = !(isLive(S.cam) && isLiveAudio(S.mic) && isLive(S.screen) && !hasExtraMonitor() && $('#agree').checked);
}

function refreshMonitorStep() {
  if (window.screen.isExtended === undefined) setStep('step-monitor', true, 'This browser cannot detect extra displays; the invigilator will check.');
  else if (hasExtraMonitor()) setStep('step-monitor', false, 'More than one display is connected. Disconnect the extra monitor, then click Check.');
  else setStep('step-monitor', true, 'Single display detected.');
  updateStartButton();
}

// ---------- camera & screen ----------
function cameraError(e) {
  if (e.name === 'NotAllowedError') return 'Camera permission was denied. Allow camera access from the address bar and try again.';
  if (e.name === 'NotFoundError') return 'No camera was found. Connect a webcam and try again.';
  if (e.name === 'NotReadableError') return 'The camera is being used by another app. Close that app and try again.';
  return `Could not start the camera (${e.name || e.message}).`;
}

async function startCamera() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  } catch (e) {
    throw new Error(cameraError(e));
  }
  stopStream(S.cam);
  S.cam = stream;
  S.camMutedAt = 0;
  camVideo.srcObject = stream;
  const track = stream.getVideoTracks()[0];
  track.addEventListener('ended', () => { if (S.cam === stream) onCameraLost('Camera was turned off or disconnected'); });
  track.addEventListener('mute', () => { if (S.cam === stream) S.camMutedAt = Date.now(); });
  track.addEventListener('unmute', () => { if (S.cam === stream) S.camMutedAt = 0; });
}

// ---------- microphone ----------
function micError(e) {
  if (e.name === 'NotAllowedError') return 'Microphone permission was denied. Allow microphone access from the address bar and try again.';
  if (e.name === 'NotFoundError') return 'No microphone was found. Connect a microphone (or headset) and try again.';
  if (e.name === 'NotReadableError') return 'The microphone is being used by another app. Close that app and try again.';
  return `Could not start the microphone (${e.name || e.message}).`;
}

async function startMic() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false }, video: false });
  } catch (e) {
    throw new Error(micError(e));
  }
  stopStream(S.mic);
  S.mic = stream;
  S.micMutedAt = 0;
  const track = stream.getAudioTracks()[0];
  track.addEventListener('ended', () => { if (S.mic === stream) onMicLost('Microphone was turned off or disconnected'); });
  track.addEventListener('mute', () => { if (S.mic === stream) S.micMutedAt = Date.now(); });
  track.addEventListener('unmute', () => { if (S.mic === stream) S.micMutedAt = 0; });
  // level analysis (runs locally; only short clips around detected speech are uploaded)
  try { S.audio?.ctx.close(); } catch { /* ignore */ }
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(analyser);
  S.audio = { ctx, analyser, buf: new Float32Array(analyser.fftSize), floor: 0, frames: 0, loud: [], lastVoice: 0, silentSince: 0, lastSilentReport: 0, recording: false };
  if (!S.audioTimer) S.audioTimer = setInterval(audioTick, 100);
}

// Every 100 ms: update the level meters and look for sustained sound well above the room's noise floor.
const VOICE_WINDOW = 20;       // 2 s of frames
const VOICE_MIN_LOUD = 8;      // at least 0.8 s of sound within those 2 s
const VOICE_COOLDOWN_MS = 30000;
function audioTick() {
  const a = S.audio;
  if (!a || !isLiveAudio(S.mic)) return;
  if (a.ctx.state === 'suspended') a.ctx.resume().catch(() => {});
  a.analyser.getFloatTimeDomainData(a.buf);
  let sum = 0;
  for (let i = 0; i < a.buf.length; i++) sum += a.buf[i] * a.buf[i];
  const rms = Math.sqrt(sum / a.buf.length);
  const level = Math.min(1, rms * 12);
  for (const m of document.querySelectorAll('.mic-meter > i')) m.style.width = `${Math.round(level * 100)}%`;

  // the noise floor follows the quiet parts of the room
  a.frames++;
  if (a.frames <= 10) a.floor = a.frames === 1 ? rms : (a.floor * (a.frames - 1) + rms) / a.frames;
  else if (rms < a.floor * 2 || rms < 0.004) a.floor = a.floor * 0.98 + rms * 0.02;
  const loud = rms > Math.max(0.02, a.floor * 4);
  a.loud.push(loud);
  if (a.loud.length > VOICE_WINDOW) a.loud.shift();

  if (!S.started || S.ended) return;
  // a microphone that delivers pure silence (hardware mute switch, muted in the OS) is logged
  if (rms === 0) {
    if (!a.silentSince) a.silentSince = Date.now();
    else if (Date.now() - a.silentSince > 30000 && Date.now() - a.lastSilentReport > 120000) {
      a.lastSilentReport = Date.now();
      report('microphone_silent', 'The microphone has delivered no sound for over 30 seconds (it may be muted)');
    }
  } else a.silentSince = 0;

  if (a.loud.filter(Boolean).length >= VOICE_MIN_LOUD && Date.now() - a.lastVoice > VOICE_COOLDOWN_MS) {
    a.lastVoice = Date.now();
    a.loud = [];
    report('voice_detected', 'Speech or sound was detected near the candidate (audio clip recorded)');
    snap('camera');
    recordClip();
  }
}

// Record ~10 s of microphone audio and upload it for the examiner.
function recordClip(ms = 10000) {
  const a = S.audio;
  if (!a || a.recording || !window.MediaRecorder || !isLiveAudio(S.mic)) return;
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) return;
  let rec;
  try { rec = new MediaRecorder(S.mic, { mimeType: type, audioBitsPerSecond: 24000 }); } catch { return; }
  const parts = [];
  const t0 = Date.now();
  a.recording = true;
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  rec.onstop = () => {
    a.recording = false;
    const blob = new Blob(parts, { type: type.split(';')[0] });
    if (blob.size < 200 || S.ended) return;
    fetch('/api/exam/audio', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': type.split(';')[0], 'X-Duration-Ms': String(Date.now() - t0) }, body: blob,
    }).catch(() => {});
  };
  rec.start();
  setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, ms);
}

async function startScreen() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { displaySurface: 'monitor', frameRate: { ideal: 5, max: 10 } },
      audio: false,
      monitorTypeSurfaces: 'include',
      selfBrowserSurface: 'exclude',
      surfaceSwitching: 'exclude',
    });
  } catch (e) {
    throw new Error(e.name === 'NotAllowedError'
      ? 'Screen sharing was cancelled or blocked. Click the button again and choose "Entire screen".'
      : `Could not share the screen (${e.name || e.message}).`);
  }
  const track = stream.getVideoTracks()[0];
  const surface = track.getSettings().displaySurface;
  if (surface && surface !== 'monitor') {
    stopStream(stream);
    throw new Error('You shared a window or tab. Share again and choose "Entire screen".');
  }
  stopStream(S.screen);
  S.screen = stream;
  screenVideo.srcObject = stream;
  track.addEventListener('ended', () => { if (S.screen === stream) onScreenLost('Screen sharing was stopped'); });
}

// Browser pickers and permission prompts can take focus; don't treat that as leaving the exam.
async function withPicker(fn) {
  S.inPicker = true;
  try { return await fn(); } finally { setTimeout(() => { S.inPicker = false; }, 800); }
}

$('#btn-camera').onclick = async () => {
  try {
    await withPicker(startCamera);
    preview.srcObject = S.cam;
    preview.hidden = false;
    setStep('step-camera', true, 'Camera is on.');
  } catch (e) {
    setStep('step-camera', false, e.message);
  }
  updateStartButton();
};

$('#btn-mic').onclick = async () => {
  try {
    await withPicker(startMic);
    $('#setup-mic-meter').hidden = false;
    setStep('step-mic', true, 'Microphone is on. Speak to see the level move.');
  } catch (e) {
    setStep('step-mic', false, e.message);
  }
  updateStartButton();
};

$('#btn-screen').onclick = async () => {
  try {
    await withPicker(startScreen);
    setStep('step-screen', true, 'Your entire screen is being shared.');
  } catch (e) {
    setStep('step-screen', false, e.message);
  }
  updateStartButton();
};

$('#btn-monitor').onclick = refreshMonitorStep;
$('#agree').onchange = updateStartButton;

$('#btn-start').onclick = async () => {
  const err = $('#setup-error');
  err.textContent = '';
  $('#btn-start').disabled = true;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch {
    err.textContent = 'Fullscreen is required. Allow fullscreen and try again.';
    return updateStartButton();
  }
  try {
    beginExam(await api('POST', '/api/exam/start'));
  } catch (e) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (e.data?.submitted) return showSubmitted('already');
    err.textContent = e.message;
    updateStartButton();
  }
};

// ---------- exam ----------
function beginExam(data) {
  S.questions = data.questions;
  S.sections = data.sections.filter((sec) => data.questions.some((q) => q.section === sec.key));
  S.answers = data.answers || {};
  S.violations = data.violations;
  S.maxViolations = data.maxViolations;
  S.snapshotIntervalSec = data.snapshotIntervalSec;
  S.timing = data.timingMode;
  applySection(data.section, false);
  S.marked = loadSet('marked');
  S.visited = loadSet('visited');
  for (const q of S.questions) if (S.answers[q.id] !== undefined) S.visited.add(q.id);
  S.started = true;

  document.body.classList.add('exam-running');
  $('#exam-who').textContent = `${S.me.name} · ${S.me.username}`;
  $('#cand-name').textContent = S.me.name;
  $('#cand-roll').textContent = S.me.username;
  preview.hidden = true;
  preview.srcObject = null;
  show('screen-exam');

  buildSectionTabs();
  goTo(firstUnanswered());
  updateWarnings();
  setDeadline(data.remainingSec);
  tick();
  S.timers.push(setInterval(tick, 500));
  S.timers.push(setInterval(heartbeat, 20000));
  S.timers.push(setInterval(takeSnapshots, S.snapshotIntervalSec * 1000));
  S.timers.push(setInterval(checkDevices, 3000));
  setTimeout(takeSnapshots, 2000);
}

// ---------- per-section timing ----------
const sectionMode = () => S.timing === 'section' && !!S.sec;
// In section mode only the current section's questions can be opened.
const allowed = (i) => !sectionMode() || S.questions[i]?.section === S.sec.key;
const allowedIdxs = () => S.questions.map((_, i) => i).filter(allowed);
const lastSection = () => !sectionMode() || S.sec.index === S.sec.plan.length - 1;
const currentSectionTitle = () => (sectionMode() ? S.sec.plan[S.sec.index].title : '');

function firstUnanswered() {
  const idxs = allowedIdxs();
  return idxs.find((i) => S.answers[S.questions[i].id] === undefined) ?? idxs[0] ?? 0;
}

function applySection(sec, announce) {
  if (!sec) return;
  const moved = !!S.sec && sec.index !== S.sec.index;
  S.sec = sec;
  S.secDeadlineLocal = Date.now() + sec.remainingSec * 1000;
  if (moved) {
    $('#section-modal').hidden = true;
    S.secWarned = null;
    if (announce) toast(`Section "${currentSectionTitle()}" has started. The previous section is now closed.`, 'info', 6000);
    if (S.tabs) goTo(firstUnanswered());
  }
}

async function advanceSection() {
  if (S.advancing || S.ended || !sectionMode()) return;
  S.advancing = true;
  try {
    const waitUntil = Date.now() + 5000;
    while ((pending.size || flushing) && Date.now() < waitUntil) await sleep(150);
    const st = await api('POST', '/api/exam/next-section', { from: S.sec.index });
    if (st.status && st.status !== 'in_progress') return endExam('already');
    setDeadline(st.remainingSec);
    applySection(st.section, true);
  } catch (e) {
    if (e.data?.submitted) endExam('already');
    else toast('Could not reach the server. Retrying…', 'info', 2000);
  } finally {
    S.advancing = false;
  }
}

function openFinishSection() {
  const qs = S.questions.filter((q) => q.section === S.sec.key);
  const answered = qs.filter((q) => S.answers[q.id] !== undefined).length;
  const next = S.sec.plan[S.sec.index + 1];
  const left = Math.max(0, Math.ceil((S.secDeadlineLocal - Date.now()) / 1000));
  $('#section-modal-title').textContent = `Finish Section: ${currentSectionTitle()}`;
  $('#section-modal-body').textContent = `Once you finish this section you cannot return to it. Time remaining in this section: ${fmtDuration(left)}. The next section is "${next.title}".`;
  const row = (cls, label, v) => h('tr', null, h('td', null, h('i', { class: `st ${cls}` }), label), h('td', null, String(v)));
  $('#section-stats').replaceChildren(h('tbody', null,
    row('answered', 'Answered in this section', answered),
    row('not-answered', 'Not answered in this section', qs.length - answered)));
  $('#section-modal').hidden = false;
}
$('#section-cancel').onclick = () => { $('#section-modal').hidden = true; };
$('#section-ok').onclick = () => { $('#section-modal').hidden = true; advanceSection(); };

// Marked-for-review and visited are per-browser conveniences; answers themselves live on the server.
const storeKey = (name) => `${name}:${S.me.username}`;
function loadSet(name) {
  try { return new Set(JSON.parse(sessionStorage.getItem(storeKey(name)) || '[]')); } catch { return new Set(); }
}
function saveSet(name, set) {
  try { sessionStorage.setItem(storeKey(name), JSON.stringify([...set])); } catch { /* storage unavailable */ }
}

const sectionName = (sec) => sec.title.replace(/^Section [A-Z0-9]+: /, '');
const sectionOf = (q) => S.sections.find((s) => s.key === q.section);

// Standard CBT palette states.
function statusOf(q) {
  const answered = S.answers[q.id] !== undefined;
  if (S.marked.has(q.id)) return answered ? 'marked answered' : 'marked';
  if (answered) return 'answered';
  return S.visited.has(q.id) ? 'not-answered' : '';
}

function buildSectionTabs() {
  S.tabs = S.sections.map((sec) => {
    const count = h('span', { class: 'count' });
    const label = h('span', null, sectionName(sec));
    const btn = h('button', { type: 'button', onclick: () => {
      if (sectionMode() && sec.key !== S.sec.key) {
        const done = S.sec.plan.findIndex((p) => p.key === sec.key) < S.sec.index;
        return toast(done ? 'This section is closed.' : 'Sections are timed separately. Please finish the current section first.', 'info', 3500);
      }
      goTo(firstIndexInSection(sec.key));
    } }, label, count);
    return { key: sec.key, btn, count, label, title: sectionName(sec) };
  });
  $('#section-tabs').replaceChildren(...S.tabs.map((t) => t.btn));
}

function firstIndexInSection(key) {
  const idxs = S.questions.map((q, i) => (q.section === key ? i : -1)).filter((i) => i >= 0);
  return idxs.find((i) => S.answers[S.questions[i].id] === undefined) ?? idxs[0];
}

function renderPalette() {
  const cur = S.questions[S.idx];
  $('#pal-title').textContent = `${sectionName(sectionOf(cur))}`;
  const grid = h('div', { class: 'pal-grid' });
  S.questions.forEach((q, i) => {
    if (q.section !== cur.section) return;
    grid.append(h('button', { type: 'button', class: `qbtn ${statusOf(q)}${i === S.idx ? ' current' : ''}`, onclick: () => goTo(i) }, String(i + 1)));
  });
  $('#palette').replaceChildren(grid);

  for (const t of S.tabs) {
    const qs = S.questions.filter((q) => q.section === t.key);
    t.btn.classList.toggle('active', t.key === cur.section);
    t.count.textContent = `${qs.filter((q) => S.answers[q.id] !== undefined).length}/${qs.length}`;
    if (sectionMode()) {
      const pos = S.sec.plan.findIndex((p) => p.key === t.key);
      const state = pos < S.sec.index ? 'done' : pos > S.sec.index ? 'locked' : '';
      if (t.state !== state) {
        t.state = state;
        t.btn.classList.toggle('done', state === 'done');
        t.btn.classList.toggle('locked', state === 'locked');
        t.label.replaceChildren(...(state ? [icon(state === 'done' ? 'check' : 'lock')] : []), t.title);
      }
    }
  }

  const c = counts();
  $('#lg-answered').textContent = c.answered;
  $('#lg-not-answered').textContent = c.notAnswered;
  $('#lg-not-visited').textContent = c.notVisited;
  $('#lg-marked').textContent = c.marked;
  $('#lg-answered-marked').textContent = c.answeredMarked;
}

function counts() {
  const c = { answered: 0, notAnswered: 0, notVisited: 0, marked: 0, answeredMarked: 0 };
  for (const q of S.questions) {
    const st = statusOf(q);
    if (st === 'answered') c.answered++;
    else if (st === 'not-answered') c.notAnswered++;
    else if (st === 'marked') c.marked++;
    else if (st === 'marked answered') c.answeredMarked++;
    else c.notVisited++;
  }
  return c;
}

function goTo(i) {
  if (!allowed(i)) return;
  S.idx = Math.max(0, Math.min(S.questions.length - 1, i));
  S.visited.add(S.questions[S.idx].id);
  saveSet('visited', S.visited);
  renderQuestion();
  renderPalette();
  $('#q-body').scrollTop = 0;
}

function renderQuestion() {
  const q = S.questions[S.idx];
  const chosen = S.answers[q.id];
  const scope = allowedIdxs();
  const last = S.idx === scope[scope.length - 1];
  const options = q.options.map((text, i) => h('label', { class: 'option' + (chosen === i ? ' selected' : '') },
    h('input', { type: 'radio', name: 'opt', value: String(i), checked: chosen === i, onchange: () => choose(i) }),
    h('span', { class: 'letter' }, `${'ABCD'[i]}.`),
    h('span', { class: 'text' + (q.code ? ' mono' : '') }, text),
    h('span', { class: 'tick' }, icon('check'))));

  $('#q-no').textContent = `Question No. ${S.idx + 1}`;
  $('#q-marks').textContent = `+${q.marks ?? 4}`;
  $('#q-neg').textContent = q.negative ? `−${q.negative}` : '0';
  $('#q-section').textContent = sectionName(sectionOf(q));
  $('#q-body').replaceChildren(h('div', { class: 'q-body-inner' },
    h('p', { class: 'q-text' }, q.q),
    q.code && h('pre', { class: 'code' }, q.code.map((line) => h('span', { class: 'ln' }, line || ' '))),
    q.sub && h('ul', { class: 'q-sub' }, q.sub.map((s) => h('li', null, s))),
    h('div', { class: 'options', role: 'radiogroup' }, options)));
  $('#btn-prev').disabled = S.idx === scope[0];
  $('#btn-clear').disabled = chosen === undefined;
  const lastLabel = lastSection() ? 'Save & Submit' : 'Save & Finish Section';
  $('#btn-save-next').replaceChildren(last ? lastLabel : 'Save & Next');
  $('#btn-review-next').replaceChildren(last ? 'Mark for Review' : 'Mark for Review & Next');
}

function choose(i) {
  const q = S.questions[S.idx];
  if (i === null) delete S.answers[q.id];
  else S.answers[q.id] = i;
  queueSave(q.id, i);
  renderQuestion();
  renderPalette();
}

function next() {
  const after = allowedIdxs().find((i) => i > S.idx);
  if (after !== undefined) goTo(after);
  else { renderQuestion(); renderPalette(); }
}

// "Save & next" clears a review mark (the answer is final); "Mark for review & next" sets it.
$('#btn-save-next').onclick = () => {
  const id = S.questions[S.idx].id;
  S.marked.delete(id);
  saveSet('marked', S.marked);
  const scope = allowedIdxs();
  if (S.idx !== scope[scope.length - 1]) return next();
  renderPalette();
  if (lastSection()) openConfirm(); else openFinishSection();
};
$('#btn-review-next').onclick = () => {
  S.marked.add(S.questions[S.idx].id);
  saveSet('marked', S.marked);
  next();
};
$('#btn-clear').onclick = () => choose(null);
$('#btn-prev').onclick = () => {
  const before = allowedIdxs().filter((i) => i < S.idx).pop();
  if (before !== undefined) goTo(before);
};

// ---------- autosave ----------
const pending = new Map(); // qid -> latest choice not yet confirmed by the server
let flushing = false;

function setSaveStatus(text, isError = false) {
  const el = $('#save-status');
  el.textContent = text;
  el.classList.toggle('error', isError);
}

function queueSave(qid, choice) {
  pending.set(qid, choice);
  flush();
}

async function flush() {
  if (flushing) return;
  flushing = true;
  setSaveStatus('Saving…');
  try {
    while (pending.size && !S.ended) {
      const [qid, choice] = pending.entries().next().value;
      try {
        applyEventAck(await api('PUT', '/api/exam/answer', { qid, choice, events: S.outbox }));
        if (pending.get(qid) === choice) pending.delete(qid);
      } catch (e) {
        if (e.data?.submitted) { pending.clear(); endExam(e.data.terminated ? 'terminated' : 'already'); return; }
        if (e.data?.sectionLocked) {
          pending.delete(qid);
          toast('That answer was not saved because its section has closed.', 'warn', 5000);
          continue;
        }
        setSaveStatus('Not saved, retrying…', true);
        await sleep(3000);
      }
    }
    if (!S.ended) setSaveStatus('All answers saved');
  } finally {
    flushing = false;
  }
}

// ---------- timer & heartbeat ----------
function setDeadline(sec) { S.deadlineLocal = Date.now() + sec * 1000; }

function tick() {
  if (S.ended) return;
  if (sectionMode()) {
    const secLeft = Math.max(0, Math.ceil((S.secDeadlineLocal - Date.now()) / 1000));
    $('#timer').textContent = fmtDuration(secLeft);
    $('#timer-label').textContent = `Section ${S.sec.index + 1} of ${S.sec.plan.length} · Time Left`;
    $('#timer-wrap').title = `Total time left: ${fmtDuration(Math.max(0, Math.ceil((S.deadlineLocal - Date.now()) / 1000)))}`;
    $('#timer-wrap').classList.toggle('low', secLeft <= 120);
    if (secLeft <= 60 && secLeft > 0 && S.secWarned !== S.sec.key) {
      S.secWarned = S.sec.key;
      toast(lastSection() ? 'One minute remaining. The test will be submitted automatically.' : 'One minute remaining in this section. The next section will open automatically.', 'info', 6000);
    }
    if (secLeft === 0) {
      if (lastSection()) submitExam('time_up');
      else if (!S.advancing && Date.now() > (S.advanceRetryAt || 0)) { S.advanceRetryAt = Date.now() + 3000; advanceSection(); }
    }
    return;
  }
  const left = Math.max(0, Math.ceil((S.deadlineLocal - Date.now()) / 1000));
  $('#timer').textContent = fmtDuration(left);
  $('#timer-wrap').classList.toggle('low', left <= 300);
  if (left <= 300 && left > 0 && !S.warned5) {
    S.warned5 = true;
    toast('Five minutes remaining. The test will be submitted automatically when the time ends.', 'info', 7000);
  }
  if (left === 0) submitExam('time_up');
}

async function heartbeat() {
  if (S.ended) return;
  try {
    const st = await api('POST', '/api/exam/heartbeat', { events: S.outbox });
    if (st.status !== 'in_progress') return endExam(st.terminated ? 'terminated' : 'already');
    setDeadline(st.remainingSec);
    applySection(st.section, true);
    applyEventAck(st);
  } catch { /* offline: keep the local timer running */ }
}

// ---------- proctoring ----------
function pips(el, count, max) {
  const n = max > 0 ? max : Math.max(count, 1);
  el.replaceChildren(...Array.from({ length: n }, (_, i) => h('i', { class: i < count ? 'on' : null })));
}

function updateWarnings() {
  const el = $('#warnings');
  el.title = S.maxViolations > 0 ? `Warnings: ${S.violations} of ${S.maxViolations}` : `Warnings: ${S.violations}`;
  el.classList.toggle('hot', S.violations > 0);
  pips($('#warn-pips'), S.violations, S.maxViolations);
}

function showWarning(message, count, max) {
  $('#warn-title').textContent = count ? `Warning ${count}${max > 0 ? ` of ${max}` : ''}` : 'Warning';
  $('#warn-body').textContent = `Violation detected: ${message} This has been recorded and reported to the examination authority.`;
  pips($('#warn-modal-pips'), count, max);
  const left = max > 0 ? max - count : null;
  $('#warn-left').textContent = left === null ? '' : left === 1
    ? 'One more violation will result in automatic submission of your test.'
    : `${left} more violations will result in automatic submission of your test.`;
  $('#warn-modal').hidden = false;
}
$('#warn-ok').onclick = () => { $('#warn-modal').hidden = true; };

const monitoring = () => (S.started || S.resuming) && !S.ended;

function applyEventAck(r) {
  if (!r) return;
  if (Array.isArray(r.acked)) {
    const acked = new Set(r.acked);
    S.outbox = S.outbox.filter((e) => !acked.has(e.seq));
  }
  if (Number.isInteger(r.violations)) {
    S.violations = r.violations;
    S.maxViolations = r.maxViolations;
    updateWarnings();
  }
  if (r.terminated) endExam('terminated');
}

async function report(type, detail) {
  if (!monitoring()) return null;
  S.outbox.push({ seq: nextSeq(), type, detail });
  try {
    const r = await api('POST', '/api/exam/event', { events: S.outbox });
    applyEventAck(r);
    return r;
  } catch (e) {
    if (e.data?.submitted) endExam('already');
    return null; // stays in the outbox and is re-sent with the next answer save or heartbeat
  }
}

async function warn(type, detail, message) {
  const r = await report(type, detail);
  if (!r) { showWarning(message, S.violations + 1, S.maxViolations); return; }
  if (r.terminated) return;
  showWarning(message, r.violations, r.maxViolations);
}

// Copying from, or pasting into, the exam is a warning. One gesture can fire several events
// (e.g. Ctrl+C keydown and the copy event), so they are merged within a short window.
let lastCopyWarning = 0;
function copyAttempt(detail) {
  if (Date.now() - lastCopyWarning < 3000) return;
  lastCopyWarning = Date.now();
  warn('copy_attempt', detail, 'copying or pasting is not permitted.');
}

let lastBlockedToast = 0;
let lastBlockedReport = 0;
function blocked(detail) {
  if (Date.now() - lastBlockedReport > 2000) {
    lastBlockedReport = Date.now();
    report('blocked_action', detail);
  }
  if (Date.now() - lastBlockedToast > 3000) {
    lastBlockedToast = Date.now();
    toast('Keyboard shortcuts are disabled during the test.', 'info', 3000);
  }
}

// The page going hidden while it unloads is a reload/close, which the server counts once on reopening.
window.addEventListener('pagehide', () => { S.unloading = true; });

function onFocusLost(detail) {
  if (!monitoring() || S.focusLost || S.inPicker || S.unloading) return;
  S.focusLost = true;
  warn('focus_lost', detail, 'you left the test window.');
  setTimeout(() => snap('screen'), 1200); // capture what the student switched to
}

// Remember when the student came back: Chrome delivers the fullscreen-exit caused by a tab switch
// only once the tab is visible again, and that belongs to the same incident.
function focusBack() {
  if (S.focusLost) S.backAt = Date.now();
  S.focusLost = false;
}

guard('visibilitychange', () => {
  if (isHidden()) onFocusLost('Switched tab or minimised the browser');
  else if (hasFocus()) focusBack();
});
guard('blur', (e) => {
  if (e.target !== window) return; // blur of an element inside the page, not of the window
  setTimeout(() => { if (!hasFocus()) onFocusLost('Exam window lost focus (another window or app was used)'); }, 300);
});
guard('focus', (e) => { if (e.target === window) focusBack(); });

guard('fullscreenchange', () => {
  if (!S.started || S.ended) return;
  if (fsElement()) return removeBlocker('fullscreen');
  addBlocker('fullscreen');
  // Switching tabs/apps also drops fullscreen; that is already one focus_lost warning, so don't count it twice.
  setTimeout(() => {
    if (S.inPicker || fsElement() || isHidden() || !hasFocus() || S.focusLost || Date.now() - (S.backAt || 0) < 3000) return;
    warn('fullscreen_exit', 'Exited fullscreen', 'you left full-screen mode.');
  }, 400);
});

function onCameraLost(detail) {
  if (!S.started) { setStep('step-camera', false, 'The camera stopped. Enable it again.'); updateStartButton(); return; }
  if (S.ended || S.blockers.has('camera')) return;
  warn('camera_stopped', detail, 'your camera stopped.');
  addBlocker('camera');
}

function onMicLost(detail) {
  if (!S.started) { setStep('step-mic', false, 'The microphone stopped. Enable it again.'); updateStartButton(); return; }
  if (S.ended || S.blockers.has('mic')) return;
  warn('microphone_stopped', detail, 'your microphone stopped.');
  addBlocker('mic');
}

function onScreenLost(detail) {
  if (!S.started) { setStep('step-screen', false, 'Screen sharing stopped. Share your entire screen again.'); updateStartButton(); return; }
  if (S.ended || S.blockers.has('screen')) return;
  warn('screen_share_stopped', detail, 'screen sharing stopped.');
  addBlocker('screen');
}

function checkDevices() {
  if (!S.started || S.ended) return;
  if (!isLive(S.cam)) onCameraLost('Camera feed ended');
  else if (S.camMutedAt && Date.now() - S.camMutedAt > 8000) { S.camMutedAt = 0; onCameraLost('Camera feed was interrupted for more than 8 seconds'); }
  if (!isLiveAudio(S.mic)) onMicLost('Microphone feed ended');
  else if (S.micMutedAt && Date.now() - S.micMutedAt > 8000) { S.micMutedAt = 0; onMicLost('Microphone was muted or interrupted for more than 8 seconds'); }
  if (!isLive(S.screen)) onScreenLost('Screen sharing ended');
  if (hasExtraMonitor() && !S.blockers.has('monitor')) {
    warn('multiple_monitors', 'An additional display was connected', 'an extra monitor was connected.');
    addBlocker('monitor');
  }
  if (!fsElement() && !S.inPicker && !S.blockers.has('fullscreen')) addBlocker('fullscreen');
}
window.screen.addEventListener?.('change', checkDevices);

const BLOCKERS = {
  camera: {
    icon: 'camera',
    title: 'Webcam Not Detected',
    body: 'Your webcam has stopped. This has been recorded as a violation. Switch the webcam back on to continue the test.',
    action: 'Enable Camera',
    fix: startCamera,
  },
  mic: {
    icon: 'alert',
    title: 'Microphone Not Detected',
    body: 'Your microphone has stopped or been muted. This has been recorded as a violation. Switch the microphone back on to continue the test.',
    action: 'Enable Microphone',
    fix: startMic,
  },
  screen: {
    icon: 'share',
    title: 'Screen Sharing Stopped',
    body: 'Screen sharing has stopped. This has been recorded as a violation. Share your entire screen again to continue the test.',
    action: 'Share Entire Screen',
    fix: startScreen,
  },
  monitor: {
    icon: 'monitor',
    title: 'Additional Display Detected',
    body: 'Only one display is permitted during the test. Disconnect all additional monitors and click Check Again.',
    action: 'Check Again',
    fix: async () => { if (hasExtraMonitor()) throw new Error('An extra display is still connected.'); },
  },
  fullscreen: {
    icon: 'maximize',
    title: 'Full-Screen Mode Required',
    body: 'The test must be taken in full-screen mode. Leaving full-screen mode is recorded as a violation. Click the button below to return.',
    action: 'Return to Full Screen',
    fix: () => document.documentElement.requestFullscreen({ navigationUI: 'hide' }),
  },
};
const BLOCKER_ORDER = ['camera', 'mic', 'screen', 'monitor', 'fullscreen'];

function addBlocker(key) { S.blockers.add(key); renderOverlay(); }
function removeBlocker(key) { S.blockers.delete(key); renderOverlay(); }

function renderOverlay() {
  const ov = $('#overlay');
  const key = BLOCKER_ORDER.find((k) => S.blockers.has(k));
  if (!key || S.ended) { ov.hidden = true; return; }
  const b = BLOCKERS[key];
  $('#overlay-icon').replaceChildren(icon(b.icon));
  $('#overlay-title').textContent = b.title;
  $('#overlay-body').textContent = b.body;
  $('#overlay-action').textContent = b.action;
  $('#overlay-error').textContent = '';
  ov.dataset.key = key;
  ov.hidden = false;
}

$('#overlay-action').onclick = async () => {
  const key = $('#overlay').dataset.key;
  try {
    await withPicker(BLOCKERS[key].fix);
    removeBlocker(key);
    if (!fsElement()) addBlocker('fullscreen');
  } catch (e) {
    $('#overlay-error').textContent = e.message || 'That did not work. Try again.';
  }
};

// Copy, cut, paste and right-click count as warnings; drag-and-drop is just blocked.
const COPY_EVENTS = { copy: 'Tried to copy', cut: 'Tried to cut', paste: 'Tried to paste', contextmenu: 'Right-clicked' };
for (const ev of ['copy', 'cut', 'paste', 'contextmenu', 'dragstart', 'drop']) {
  guard(ev, (e) => {
    if (!S.started || S.ended) return;
    e.preventDefault();
    if (COPY_EVENTS[ev]) copyAttempt(COPY_EVENTS[ev]);
    else blocked(`${ev} blocked`);
  });
}
guard('selectstart', (e) => { if (S.started && !S.ended) e.preventDefault(); });

guard('keydown', (e) => {
  if (!S.started || S.ended) return;
  const k = (e.key || '').toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  const bad = k === 'f12' || k === 'f5' || k === 'printscreen' ||
    (mod && e.shiftKey && ['i', 'j', 'c', 'k'].includes(k)) ||
    (mod && ['c', 'v', 'x', 'a', 'p', 's', 'u', 'f', 'g', 'h', 'j', 'o', 'r'].includes(k)) ||
    (e.altKey && ['arrowleft', 'arrowright'].includes(k));
  const copyKey = k === 'printscreen' || (mod && !e.shiftKey && ['c', 'v', 'x', 'a', 'insert'].includes(k)) || (e.shiftKey && k === 'insert');
  if (bad || copyKey) {
    e.preventDefault();
    e.stopPropagation();
    const combo = [e.ctrlKey && 'Ctrl', e.metaKey && 'Cmd', e.altKey && 'Alt', e.shiftKey && 'Shift', e.key].filter(Boolean).join('+');
    if (copyKey) copyAttempt(`Pressed ${combo}`);
    else blocked(`Shortcut ${combo}`);
  }
});

guard('keyup', (e) => {
  if (S.started && !S.ended && e.key === 'PrintScreen') {
    copyAttempt('Pressed PrintScreen');
    navigator.clipboard?.writeText?.('').catch(() => {});
  }
});

window.addEventListener('beforeunload', (e) => {
  if (S.started && !S.ended) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- snapshots ----------
const canvas = $('#snap-canvas');
const ctx = canvas.getContext('2d');

async function frameFrom(stream, video, maxW) {
  const track = stream?.getVideoTracks()[0];
  if (!track || track.readyState !== 'live') return null;
  let src = null;
  let w = 0;
  let hgt = 0;
  if (window.ImageCapture) {
    try { src = await new ImageCapture(track).grabFrame(); w = src.width; hgt = src.height; } catch { src = null; }
  }
  if (!src && video.videoWidth) { src = video; w = video.videoWidth; hgt = video.videoHeight; }
  if (!src || !w) return null;
  const scale = Math.min(1, maxW / w);
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(hgt * scale);
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  src.close?.();
  return canvas.toDataURL('image/jpeg', 0.5);
}

async function snap(kind) {
  if (S.ended) return;
  // Small frames keep uploads and storage manageable with 1000+ students (~15 KB camera, ~60 KB screen).
  const image = kind === 'camera' ? await frameFrom(S.cam, camVideo, 320) : await frameFrom(S.screen, screenVideo, 1024);
  if (image) api('POST', '/api/exam/snapshot', { kind, image }).catch(() => {});
}

function takeSnapshots() { snap('camera'); snap('screen'); }

// ---------- submit ----------
function openConfirm() {
  const c = counts();
  const row = (cls, label, v) => h('tr', null, h('td', null, h('i', { class: `st ${cls}` }), label), h('td', null, String(v)));
  $('#confirm-stats').replaceChildren(h('tbody', null,
    row('answered', 'Answered', c.answered),
    row('not-answered', 'Not answered', c.notAnswered),
    row('', 'Not visited', c.notVisited),
    row('marked', 'Marked for review', c.marked),
    row('marked answered', 'Answered & marked (evaluated)', c.answeredMarked)));
  $('#confirm-note').textContent = lastSection()
    ? 'Are you sure you want to submit the test? You will not be able to change your responses after submission.'
    : 'Are you sure you want to submit the test? You will not be able to change your responses, and the remaining sections will not be attempted.';
  $('#confirm-modal').hidden = false;
}
$('#btn-submit').onclick = openConfirm;
$('#confirm-cancel').onclick = () => { $('#confirm-modal').hidden = true; };
$('#confirm-ok').onclick = () => { $('#confirm-modal').hidden = true; submitExam('submitted'); };

async function submitExam(reason) {
  if (S.submitting || S.ended) return;
  S.submitting = true;
  const waitUntil = Date.now() + 8000;
  while ((pending.size || flushing) && Date.now() < waitUntil) await sleep(200);
  for (let i = 0; i < 5; i++) {
    try {
      await api('POST', '/api/exam/submit', { reason, events: S.outbox });
      return endExam(reason);
    } catch (e) {
      if (e.data?.submitted || e.status === 404) return endExam('already');
      toast('Could not reach the server. Retrying…', 'info', 2000);
      await sleep(2000);
    }
  }
  S.submitting = false;
  toast('Submission failed. Please check your internet connection and click Submit Test again.');
}

function endExam(kind) {
  if (S.ended) return;
  S.ended = true;
  S.timers.forEach(clearInterval);
  stopStream(S.cam);
  stopStream(S.mic);
  stopStream(S.screen);
  clearInterval(S.audioTimer);
  try { S.audio?.ctx.close(); } catch { /* ignore */ }
  $('#overlay').hidden = true;
  $('#confirm-modal').hidden = true;
  $('#warn-modal').hidden = true;
  $('#cam-box').hidden = true;
  document.body.classList.remove('exam-running');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  showSubmitted(kind);
}

// ---------- use-case round (timed, not proctored) ----------
const UC = { deadlineLocal: 0, timer: null, submitting: false };

async function initUseCase() {
  const st = await api('GET', '/api/usecase/state');
  loadBranding();
  $('#uc-who').textContent = `${S.me.name} (${S.me.username})`;
  if (st.status === 'submitted') return ucSubmitted(st);
  if (st.status === 'in_progress') return ucWork(st);
  if (!st.examOpen) {
    return showMessage('Test Not Yet Started', 'The test has not been opened yet. Please wait for the invigilator\'s instruction and click Refresh.', { refresh: true, tone: 'info', ic: 'clock' });
  }
  $('#uc-hs-t').textContent = st.durationMin;
  $('#uc-hs-m').textContent = st.maxMarks;
  const rules = [
    `You will be assigned one use case (problem statement) at random. Read it carefully and build your solution.`,
    `The time allowed is ${st.durationMin} minutes. The timer starts as soon as you click "Start" and continues even if you close this page.`,
    'When you are done, paste one link to your solution (for example a GitHub repository, Google Drive folder or deployed application) in the box provided and click "Submit Solution".',
    'Make sure the link can be opened by the examiners without signing in. A link that cannot be opened may not be evaluated.',
    'You can submit only once. If the time ends before you submit, the round is closed and no solution is recorded.',
    `The solution will be evaluated by the examination authority out of ${st.maxMarks} marks.`,
  ];
  $('#uc-rules').replaceChildren(...rules.map((t) => h('li', null, h('span', null, t))));
  $('#uc-intro').hidden = false;
  $('#uc-work').hidden = true;
  show('screen-usecase');
}

$('#uc-logout').onclick = logout;
$('#uc-agree').onchange = () => { $('#uc-start').disabled = !$('#uc-agree').checked; };
$('#uc-start').onclick = async () => {
  $('#uc-start').disabled = true;
  $('#uc-start-error').textContent = '';
  try {
    const st = await api('POST', '/api/usecase/start');
    ucWork(st);
  } catch (e) {
    if (e.data?.submitted) return location.reload();
    $('#uc-start-error').textContent = e.message;
    $('#uc-start').disabled = false;
  }
};

function ucWork(st) {
  const u = st.usecase;
  $('#uc-title').textContent = u?.title || 'Use Case';
  $('#uc-desc').textContent = u?.description || '';
  $('#uc-desc').hidden = !u?.description;
  $('#uc-pdf-wrap').hidden = !u?.hasPdf;
  if (u?.hasPdf) {
    const src = `/api/usecase/pdf?v=${encodeURIComponent(u.pdfName || '')}`;
    if ($('#uc-pdf').getAttribute('src') !== src) $('#uc-pdf').src = src;
    $('#uc-pdf-open').href = src;
  }
  $('#uc-intro').hidden = true;
  $('#uc-work').hidden = false;
  $('#uc-timer-wrap').hidden = false;
  show('screen-usecase');
  UC.deadlineLocal = Date.now() + st.remainingSec * 1000;
  clearInterval(UC.timer);
  UC.timer = setInterval(ucTick, 1000);
  ucTick();
  // keep the clock in line with the server
  setInterval(async () => {
    try {
      const s2 = await api('GET', '/api/usecase/state');
      if (s2.status === 'submitted') return ucSubmitted(s2);
      if (s2.remainingSec !== null) UC.deadlineLocal = Date.now() + s2.remainingSec * 1000;
    } catch { /* offline: keep the local clock */ }
  }, 60000);
}

function ucTick() {
  const left = Math.max(0, Math.round((UC.deadlineLocal - Date.now()) / 1000));
  const hh = Math.floor(left / 3600), mm = Math.floor((left % 3600) / 60), ss = left % 60;
  $('#uc-timer').textContent = (hh ? `${hh}:${String(mm).padStart(2, '0')}` : String(mm).padStart(2, '0')) + ':' + String(ss).padStart(2, '0');
  $('#uc-timer-wrap').classList.toggle('low', left <= 300);
  if (left === 300) toast('5 minutes left. Submit your solution link before the time ends.');
  if (left <= 0) ucTimeUp();
}

async function ucTimeUp() {
  clearInterval(UC.timer);
  if (UC.submitting) return;
  UC.submitting = true;
  const url = $('#uc-url').value.trim();
  try {
    // a link already typed in is submitted; otherwise the round is simply closed
    let st;
    try { st = url ? await api('POST', '/api/usecase/submit', { url, reason: 'time_up' }) : null; } catch { st = null; }
    if (!st) st = await api('POST', '/api/usecase/submit', { url: null, reason: 'time_up' });
    ucSubmitted(st, true);
  } catch (e) {
    if (e.data?.submitted) return ucSubmitted(await api('GET', '/api/usecase/state'), true);
    setTimeout(() => { UC.submitting = false; ucTimeUp(); }, 5000);
  }
}

$('#uc-submit').onclick = () => {
  $('#uc-error').textContent = '';
  const url = $('#uc-url').value.trim();
  if (!/^https?:\/\/[^\s/]+\.[^\s]+/i.test(url)) {
    $('#uc-error').textContent = 'Enter a complete link starting with https:// (for example https://github.com/...).';
    return $('#uc-url').focus();
  }
  $('#uc-confirm-url').textContent = url;
  $('#uc-confirm').hidden = false;
};
$('#uc-confirm-cancel').onclick = () => { $('#uc-confirm').hidden = true; };
$('#uc-confirm-ok').onclick = async () => {
  if (UC.submitting) return;
  UC.submitting = true;
  $('#uc-confirm-ok').disabled = true;
  try {
    const st = await api('POST', '/api/usecase/submit', { url: $('#uc-url').value.trim() });
    $('#uc-confirm').hidden = true;
    ucSubmitted(st);
  } catch (e) {
    $('#uc-confirm').hidden = true;
    if (e.data?.submitted) return ucSubmitted(await api('GET', '/api/usecase/state'));
    $('#uc-error').textContent = e.message;
  } finally {
    UC.submitting = false;
    $('#uc-confirm-ok').disabled = false;
  }
};

function ucSubmitted(st, timeUp = false) {
  clearInterval(UC.timer);
  $('#uc-confirm').hidden = true;
  if (st.url) {
    showMessage(timeUp ? 'Time Over: Solution Submitted' : 'Solution Submitted Successfully',
      `Your solution link has been recorded: ${st.url}\nResults will be declared by the examination authority. You may now close this window.`, { tone: 'success' });
  } else {
    showMessage('Time Over', 'The allotted time has ended and no solution link was submitted. Please contact the examination authority if you believe this is an error.', { tone: 'warn' });
  }
}

init().catch((e) => showMessage('Unable to Load the Test', e.message, { refresh: true, tone: 'danger' }));
})();
