import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, APP_NAME, SHUFFLE_OPTIONS } from './config.js';

/* =========================================================================
   Setup & helpers
   ========================================================================= */

const configured = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.startsWith('YOUR-');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const $app = document.getElementById('app');
const LETTERS = 'ABCDEFGHIJ';
const state = { profile: null, meta: null, run: null, exam: null, examResult: null, flash: '', timer: null };
document.title = APP_NAME;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pctNum = (n, d) => (d ? Math.round((100 * n) / d) : null);
const pct = (n, d) => (d ? Math.round((100 * n) / d) + '%' : '–');
const sum = (a) => a.reduce((x, y) => x + y, 0);
const sameSet = (a, b) => { const x = [...new Set(a)].sort((p, q) => p - q); const y = [...new Set(b)].sort((p, q) => p - q); return x.length === y.length && x.every((v, i) => v === y[i]); };
const accClass = (p) => (p === null ? '' : p >= 75 ? 'hi' : p >= 50 ? 'mid' : 'lo');
const barClass = (p) => (p === null ? '' : p >= 75 ? 'ok' : p >= 50 ? 'warn' : 'bad');

function fmtDate(ts, withTime = true) {
  if (!ts) return '–';
  const d = new Date(ts);
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (days === 0 && withTime) return 'Today ' + time;
  if (days === 1) return 'Yesterday';
  if (days < 7) return days + ' days ago';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
const shortDate = (ts) => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
const fmtClock = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); const r = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(r).padStart(2, '0'); };

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
const FIXED_ORDER = /(all|none|both|neither) of (the )?(above|these|them|following)|^(both|neither|all of|none of)\b|all (the )?(answers|statements) are/i;
function optionOrder(options) {
  const idx = options.map((_, i) => i);
  if (!SHUFFLE_OPTIONS || options.some((o) => FIXED_ORDER.test(String(o)))) return idx;
  return shuffle(idx);
}

function toast(msg, kind = '') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = (kind === 'ok' ? icon('check') : kind === 'bad' ? icon('alert') : '') + `<span>${esc(msg)}</span>`;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 4000);
  setTimeout(() => el.remove(), 4400);
}
const errMsg = (e) => (e && (e.message || e.error_description || e.details)) || String(e);
function check({ data, error }) { if (error) throw error; return data; }

async function fetchAll(build) {
  const size = 1000; let from = 0; let out = [];
  for (;;) {
    const data = check(await build().range(from, from + size - 1));
    out = out.concat(data);
    if (data.length < size) return out;
    from += size;
  }
}
async function inChunks(ids, size, fn) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await fn(ids.slice(i, i + size))));
  return out;
}
function randomPassword(len = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(len); crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const prefsKey = () => 'mcq-prefs:' + (state.profile ? state.profile.id : '');
const draftKey = () => 'mcq-exam-draft:' + (state.profile ? state.profile.id : '');
function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Lucide-style SVG icons (one stroke style everywhere, no emoji) */
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h5v-6h4v6h5V9.5"/>',
  book: '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/>',
  exam: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/>',
  trend: '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  left: '<polyline points="15 18 9 12 15 6"/>',
  right: '<polyline points="9 18 15 12 9 6"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  target: '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  retry: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  layers: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
};
const icon = (name, label) => `<svg class="i" viewBox="0 0 24 24" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}>${ICONS[name] || ''}</svg>`;
const loading = '<div class="loading" role="status"><div class="skeleton" style="width:40%;margin:0 auto 18px"></div><div class="skeleton"></div><div class="skeleton" style="width:85%"></div><span class="sr">Loading</span></div>';

/* =========================================================================
   Data
   ========================================================================= */

async function loadProfile() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { state.profile = null; return null; }
  const profile = check(await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle());
  const refuse = async (msg) => { state.flash = msg; await sb.auth.signOut(); throw new Error(msg); };
  if (!profile) await refuse('No profile found for this account. Ask your admin to add you.');
  if (!profile.active) await refuse('This account has been deactivated. Contact your admin.');
  state.profile = profile;
  return profile;
}

/** Disciplines, topics and question counts (cached until something changes). */
async function loadMeta(force = false) {
  if (state.meta && !force) return state.meta;
  const [d, c, counts] = await Promise.all([
    sb.from('disciplines').select('id,name,profile,weight,sort').order('sort'),
    sb.from('categories').select('id,name,discipline_id').order('name'),
    sb.rpc('category_counts'),
  ]);
  const disciplines = check(d).map((x) => ({ ...x, weight: Number(x.weight) }));
  const topics = check(c);
  const totals = new Map(check(counts).map((r) => [r.category_id, r.total]));
  const discById = new Map(disciplines.map((x) => [x.id, x]));
  const topicById = new Map(topics.map((t) => [t.id, t]));
  for (const x of disciplines) {
    x.topics = topics.filter((t) => t.discipline_id === x.id);
    x.total = sum(x.topics.map((t) => totals.get(t.id) || 0));
  }
  const orphans = topics.filter((t) => !discById.has(t.discipline_id));
  state.meta = { disciplines, topics, totals, discById, topicById, orphans };
  return state.meta;
}

/** progress_stats rows for one user, keyed by topic id. */
async function topicStats(userId) {
  const rows = check(await sb.rpc('progress_stats'));
  const m = new Map();
  for (const r of rows) if (r.user_id === userId) m.set(r.category_id, r);
  return m;
}
function rollUp(rows) {
  const s = { answered: 0, attempts: 0, correct: 0, due: 0, last: null };
  for (const r of rows) {
    if (!r) continue;
    s.answered += r.answered; s.attempts += r.attempts; s.correct += r.correct; s.due += r.due;
    if (r.last_answered && (!s.last || r.last_answered > s.last)) s.last = r.last_answered;
  }
  return s;
}
/** Per-discipline accuracy and the weighted estimate of an exam score. */
function readiness(meta, stats) {
  const per = meta.disciplines.map((d) => {
    const s = rollUp(d.topics.map((t) => stats.get(t.id)));
    return { d, s, acc: pctNum(s.correct, s.attempts), coverage: pctNum(s.answered, d.total) };
  });
  const counted = per.filter((p) => p.s.attempts >= 5 && p.d.weight > 0);
  const W = sum(counted.map((p) => p.d.weight));
  const score = W ? Math.round(sum(counted.map((p) => p.d.weight * p.acc)) / W) : null;
  const allW = sum(meta.disciplines.filter((d) => d.total).map((d) => d.weight));
  return { per, score, weightCovered: allW ? Math.round((100 * W) / allW) : 0 };
}
async function sessionsFor(userId) {
  return check(await sb.from('sessions').select('id,mode,label,total,answered,correct,started_at,finished_at')
    .eq('user_id', userId).gt('answered', 0).order('started_at').limit(500));
}

/* =========================================================================
   Shell & router
   ========================================================================= */

const NAV = [
  ['home', '#/home', 'Home', 'home'],
  ['practice', '#/practice', 'Practice', 'book'],
  ['exam', '#/exam', 'Mock exam', 'exam'],
  ['progress', '#/progress', 'Progress', 'trend'],
];
function shell(active, inner) {
  const p = state.profile;
  const items = NAV.concat(p.role === 'admin' ? [['admin', '#/admin/learners', 'Admin', 'shield']] : []);
  const link = ([key, href, label, ic]) => `<a href="${href}" ${active === key ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></a>`;
  $app.innerHTML = `
    <header class="top">
      <div class="top-inner">
        <a class="brand" href="#/home"><span class="mark">${icon('check')}</span>${esc(APP_NAME)}</a>
        <nav class="nav" aria-label="Main">${items.map(link).join('')}</nav>
        <div class="me">
          <a class="who" href="#/account" ${active === 'account' ? 'aria-current="page"' : ''} title="Account">${icon('user')}<span>${esc(p.full_name || p.email)}</span></a>
          <button class="btn ghost sm" id="signOut">${icon('logout')}<span class="sr">Sign out</span></button>
        </div>
      </div>
    </header>
    <main id="view" tabindex="-1">${inner}</main>
    <nav class="bottom-nav" aria-label="Main">${items.map(link).join('')}</nav>`;
  document.getElementById('signOut').onclick = () => sb.auth.signOut();
  return document.getElementById('view');
}

const routes = {
  home: renderHome,
  practice: renderPractice,
  session: renderSession,
  exam: renderExamSetup,
  'exam/run': renderExamRun,
  'exam/result': renderExamResult,
  progress: renderMyProgress,
  account: renderAccount,
  'admin/learners': renderAdminLearners,
  'admin/learner': renderAdminLearner,
  'admin/questions': renderAdminQuestions,
};

let lastRoute = '';
async function router() {
  if (!state.profile) return renderLogin();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  let route = parts[0] || 'home';
  let param;
  if (route === 'admin') {
    if (state.profile.role !== 'admin') { location.hash = '#/home'; return; }
    route = 'admin/' + (parts[1] || 'learners'); param = parts[2];
  } else if (route === 'exam' && parts[1]) {
    route = 'exam/' + parts[1];
  }
  if (route === 'login') { location.hash = '#/home'; return; }
  const fn = routes[route] || renderHome;
  try {
    await fn(param);
    if (route !== lastRoute) { const v = document.getElementById('view'); if (v) v.focus({ preventScroll: true }); window.scrollTo(0, 0); }
    lastRoute = route;
  } catch (e) {
    console.error(e);
    const view = document.getElementById('view') || $app;
    view.innerHTML = `<div class="card empty">${icon('alert')}<h2>Something went wrong</h2><p class="muted">${esc(errMsg(e))}</p>
      <button class="btn primary" onclick="location.reload()">${icon('retry')}Reload</button></div>`;
  }
}

/* =========================================================================
   Login
   ========================================================================= */

function renderLogin() {
  $app.innerHTML = `
    <main class="auth-wrap" id="view" tabindex="-1">
      <form class="card auth" id="loginForm" novalidate>
        <div class="brand"><span class="mark">${icon('check')}</span>${esc(APP_NAME)}</div>
        <h1>Sign in</h1>
        <p class="muted">Use the email and password your admin gave you.</p>
        <label class="field">Email<input type="email" name="email" required autocomplete="username" inputmode="email"></label>
        <label class="field">Password
          <span class="pw"><input type="password" name="password" required autocomplete="current-password" id="pwInput">
          <button type="button" class="btn ghost sm" id="pwToggle" aria-pressed="false">${icon('eye')}<span class="sr">Show password</span></button></span>
        </label>
        <button class="btn primary lg block" type="submit">Sign in</button>
        <p class="form-error" id="loginErr" role="alert">${esc(state.flash)}</p>
      </form>
    </main>`;
  state.flash = '';
  const form = document.getElementById('loginForm');
  const pw = document.getElementById('pwInput');
  const tg = document.getElementById('pwToggle');
  tg.onclick = () => { const show = pw.type === 'password'; pw.type = show ? 'text' : 'password'; tg.setAttribute('aria-pressed', String(show)); };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const errEl = document.getElementById('loginErr');
    const fd = new FormData(form);
    if (!fd.get('email') || !fd.get('password')) { errEl.textContent = 'Enter your email and password.'; return; }
    btn.disabled = true; btn.textContent = 'Signing in…'; errEl.textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: String(fd.get('email')).trim(), password: fd.get('password') });
    if (error) {
      errEl.textContent = error.message === 'Invalid login credentials' ? 'Wrong email or password. Check them and try again.' : error.message;
      btn.disabled = false; btn.textContent = 'Sign in';
      return;
    }
    try {
      await loadProfile();
      if (!location.hash || location.hash === '#/login') location.hash = '#/home'; else router();
    } catch (e) {
      errEl.textContent = errMsg(e);
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  };
}

/* =========================================================================
   Home dashboard
   ========================================================================= */

async function renderHome() {
  const view = shell('home', loading);
  const [meta, stats, sessions] = await Promise.all([loadMeta(), topicStats(state.profile.id), sessionsFor(state.profile.id)]);
  const totalQs = sum(meta.disciplines.map((d) => d.total));
  if (!totalQs) {
    view.innerHTML = `<div class="card empty">${icon('book')}<h2>No questions yet</h2><p class="muted">${state.profile.role === 'admin'
      ? 'Import the question bank on the <a href="#/admin/questions">Admin → Questions</a> page.'
      : 'Your admin has not loaded the question bank yet. Check back soon.'}</p></div>`;
    return;
  }
  const r = readiness(meta, stats);
  const overall = rollUp([...stats.values()]);
  const mocks = sessions.filter((s) => s.mode === 'mock' && s.finished_at);
  const lastMock = mocks[mocks.length - 1];
  const draft = store.get(draftKey());
  const weakest = r.per.flatMap((p) => p.d.topics.map((t) => ({ t, d: p.d, s: stats.get(t.id) })))
    .filter((x) => x.s && x.s.attempts >= 5)
    .map((x) => ({ ...x, acc: pctNum(x.s.correct, x.s.attempts) }))
    .sort((a, b) => a.acc - b.acc).slice(0, 5);
  const first = (state.profile.full_name || '').split(' ')[0];

  view.innerHTML = `
    <div class="page-head"><div><h1>${first ? 'Hello, ' + esc(first) : 'Welcome'}</h1>
      <p class="muted">${overall.answered ? `${overall.answered.toLocaleString()} of ${totalQs.toLocaleString()} questions practised · ${overall.due} due for review` : `${totalQs.toLocaleString()} questions across ${meta.disciplines.filter((d) => d.total).length} disciplines are ready.`}</p></div></div>

    ${draft ? `<div class="card tight row-between" style="border-color:var(--warn)"><div class="row">${icon('clock')}<div><b>You have an unfinished mock exam.</b><br><span class="muted small">${esc(draft.label || '')}</span></div></div>
      <a class="btn primary" href="#/exam/run">Resume exam</a></div>` : ''}

    <div class="grid stats">
      <div class="stat"><span class="label">${icon('target')}Estimated exam score</span><span class="value">${r.score === null ? '–' : r.score + '<small>%</small>'}</span>
        <span class="hint">${r.score === null ? 'Answer at least 5 questions in a discipline to start the estimate.' : `Weighted by the exam blueprint · covers ${r.weightCovered}% of the exam`}</span></div>
      <div class="stat"><span class="label">${icon('exam')}Latest mock exam</span><span class="value">${lastMock ? pct(lastMock.correct, lastMock.total) : '–'}</span>
        <span class="hint">${lastMock ? `${lastMock.correct}/${lastMock.total} · ${fmtDate(lastMock.started_at)} · ${mocks.length} taken` : 'No mock exam yet'}</span></div>
      <div class="stat"><span class="label">${icon('check')}Accuracy</span><span class="value">${pct(overall.correct, overall.attempts)}</span>
        <span class="hint">${overall.attempts.toLocaleString()} answers in total</span></div>
    </div>

    <div class="grid two">
      <section class="card" aria-labelledby="hq1">
        <h2 id="hq1">Start studying</h2>
        <p class="muted">Pick topics to drill, or sit a sample paper that follows the official exam weights.</p>
        <div class="btn-row">
          <a class="btn primary lg" href="#/exam">${icon('exam')}Mock exam</a>
          <a class="btn lg" href="#/practice">${icon('book')}Practise topics</a>
        </div>
        ${overall.due ? `<p class="small" style="margin-top:16px">${icon('retry')} <a href="#/practice" data-due>${overall.due} questions are due for review</a></p>` : ''}
      </section>
      <section class="card" aria-labelledby="hq2">
        <h2 id="hq2">Weakest topics</h2>
        ${weakest.length ? `<table><tbody>${weakest.map((w) => `<tr><td>${esc(w.t.name)}${w.t.name !== w.d.name ? `<br><span class="muted small">${esc(w.d.name)}</span>` : ''}</td>
          <td class="n"><span class="acc ${accClass(w.acc)}">${w.acc}%</span></td>
          <td class="n"><button class="btn sm" data-drill="${w.t.id}">Drill</button></td></tr>`).join('')}</tbody></table>`
          : '<p class="muted">Answer at least 5 questions in a topic and your weakest ones will show up here.</p>'}
      </section>
    </div>

    <section class="card" aria-labelledby="hq3">
      <div class="row-between"><h2 id="hq3">Improvement curve</h2><a class="btn sm" href="#/progress">Full progress ${icon('right')}</a></div>
      <div id="curve"></div>
    </section>`;

  drawCurveInto(view.querySelector('#curve'), sessions);
  view.querySelectorAll('[data-drill]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { await startPractice({ catIds: [+b.dataset.drill], mode: 'smart', count: '20' }); } catch (e) { toast(errMsg(e), 'bad'); b.disabled = false; }
  }));
  const due = view.querySelector('[data-due]');
  if (due) due.onclick = (e) => { e.preventDefault(); store.set(prefsKey(), { ...(store.get(prefsKey()) || {}), mode: 'smart' }); location.hash = '#/practice'; };
}

/* =========================================================================
   Practice: topic picker
   ========================================================================= */

async function renderPractice() {
  const view = shell('practice', loading);
  const [meta, stats] = await Promise.all([loadMeta(), topicStats(state.profile.id)]);
  const discs = meta.disciplines.filter((d) => d.total);
  if (!discs.length) { view.innerHTML = `<div class="card empty">${icon('book')}<h2>No questions yet</h2></div>`; return; }

  const prefs = store.get(prefsKey()) || {};
  const valid = new Set(meta.topics.filter((t) => meta.totals.get(t.id)).map((t) => t.id));
  const selected = new Set((prefs.cats || []).filter((id) => valid.has(id)));
  const mode = prefs.mode || 'smart';
  const count = prefs.count || '20';

  const topicRow = (t, d) => {
    const s = stats.get(t.id); const total = meta.totals.get(t.id) || 0;
    if (!total) return '';
    const acc = s ? pctNum(s.correct, s.attempts) : null;
    return `<label class="topic"><input type="checkbox" value="${t.id}" data-disc="${d.id}" ${selected.has(t.id) ? 'checked' : ''}>
      <span class="tname">${esc(t.name)}</span>
      <span class="tmeta">${s ? s.answered : 0}/${total}${acc !== null ? ` · <span class="acc ${accClass(acc)}">${acc}%</span>` : ''}${s && s.due ? ` · <span class="chip warn">${s.due} due</span>` : ''}</span></label>`;
  };

  view.innerHTML = `
    <div class="page-head"><div><h1>Practise by topic</h1><p class="muted">Choose disciplines or individual topics. Answers are checked against the official key as you go.</p></div></div>
    <section class="card" aria-labelledby="pt">
      <div class="row-between"><h2 id="pt">Topics</h2>
        <div class="btn-row"><button class="btn sm" data-all>Select all</button><button class="btn sm ghost" data-none>Clear</button></div></div>
      ${discs.map((d) => `
        <details class="disc" ${d.topics.some((t) => selected.has(t.id)) ? 'open' : ''}>
          <summary>
            <input type="checkbox" data-discall="${d.id}" aria-label="Select all ${esc(d.name)} topics">
            <span><span class="dname">${esc(d.name)}</span><br><span class="dmeta">${d.total} questions · ${d.weight}% of the exam · ${d.topics.filter((t) => meta.totals.get(t.id)).length} topic${d.topics.length === 1 ? '' : 's'}</span></span>
            <span class="chev">${icon('right')}</span>
          </summary>
          <div class="topics">${d.topics.map((t) => topicRow(t, d)).join('')}</div>
        </details>`).join('')}
    </section>

    <section class="card" aria-labelledby="pm">
      <fieldset><legend id="pm">Mode</legend>
        <div class="choices">
          ${[['smart', 'Smart review', 'Due and new questions first. Best for daily study.'],
             ['random', 'Random', 'Any questions from your selection, shuffled.'],
             ['mistakes', 'My mistakes', 'Only questions you got wrong last time.']]
            .map(([v, t, s]) => `<label class="choice"><input type="radio" name="mode" value="${v}" ${mode === v ? 'checked' : ''}><span><b>${t}</b><small>${s}</small></span></label>`).join('')}
        </div>
      </fieldset>
      <label class="field" style="max-width:220px">Questions per session
        <select id="count">${['10', '20', '30', '50', '100', 'all'].map((n) => `<option value="${n}" ${count === n ? 'selected' : ''}>${n === 'all' ? 'All' : n}</option>`).join('')}</select></label>
    </section>

    <div class="sticky-start"><div class="start-bar">
      <span id="selInfo" class="muted" aria-live="polite"></span>
      <button class="btn primary lg" id="start">Start practice ${icon('right')}</button>
    </div></div>`;

  const topicBoxes = [...view.querySelectorAll('.topic input')];
  const discBoxes = [...view.querySelectorAll('[data-discall]')];
  const info = view.querySelector('#selInfo');
  const opts = () => ({
    catIds: topicBoxes.filter((b) => b.checked).map((b) => +b.value),
    mode: view.querySelector('input[name=mode]:checked').value,
    count: view.querySelector('#count').value,
  });
  const sync = () => {
    for (const db of discBoxes) {
      const mine = topicBoxes.filter((b) => b.dataset.disc === db.dataset.discall);
      const n = mine.filter((b) => b.checked).length;
      db.checked = n === mine.length && n > 0; db.indeterminate = n > 0 && n < mine.length;
    }
    const o = opts();
    store.set(prefsKey(), { cats: o.catIds, mode: o.mode, count: o.count });
    const total = sum(o.catIds.map((id) => meta.totals.get(id) || 0));
    const due = sum(o.catIds.map((id) => (stats.get(id) || {}).due || 0));
    info.textContent = o.catIds.length ? `${o.catIds.length} topic${o.catIds.length > 1 ? 's' : ''} · ${total} questions${o.mode === 'smart' ? ` · ${due} due` : ''}` : 'Select at least one topic';
    view.querySelector('#start').disabled = !o.catIds.length;
  };
  discBoxes.forEach((db) => db.addEventListener('change', () => {
    topicBoxes.filter((b) => b.dataset.disc === db.dataset.discall).forEach((b) => (b.checked = db.checked));
    sync();
  }));
  view.querySelector('[data-all]').onclick = () => { topicBoxes.forEach((b) => (b.checked = true)); sync(); };
  view.querySelector('[data-none]').onclick = () => { topicBoxes.forEach((b) => (b.checked = false)); sync(); };
  view.addEventListener('change', (e) => { if (!e.target.dataset.discall) sync(); });
  sync();

  view.querySelector('#start').onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true; btn.textContent = 'Loading…';
    try { if (!(await startPractice(opts()))) { btn.disabled = false; btn.innerHTML = `Start practice ${icon('right')}`; } }
    catch (e) { toast(errMsg(e), 'bad'); btn.disabled = false; btn.innerHTML = `Start practice ${icon('right')}`; }
  };
}

const QCOLS = 'id,category_id,question,options,qtype,correct,explanation';

async function startPractice(opts, preset) {
  const meta = await loadMeta();
  let picked;
  if (preset) picked = shuffle(preset);
  else {
    const { catIds, mode, count } = opts;
    const qs = await inChunks(catIds, 40, (ids) => fetchAll(() => sb.from('questions').select(QCOLS).in('category_id', ids).eq('active', true).order('id')));
    const prog = await fetchAll(() => sb.from('progress').select('question_id,box,due_at,last_correct').eq('user_id', state.profile.id).order('question_id'));
    const pm = new Map(prog.map((p) => [p.question_id, p]));
    let pool;
    if (mode === 'mistakes') {
      pool = shuffle(qs.filter((q) => pm.get(q.id)?.last_correct === false));
      if (!pool.length) { toast('No mistakes to review in these topics. Well done!', 'ok'); return false; }
    } else if (mode === 'random') pool = shuffle(qs);
    else {
      const now = Date.now(); const due = [], fresh = [], later = [];
      for (const q of qs) { const p = pm.get(q.id); if (!p) fresh.push(q); else if (new Date(p.due_at).getTime() <= now) due.push(q); else later.push(q); }
      later.sort((a, b) => new Date(pm.get(a.id).due_at) - new Date(pm.get(b.id).due_at));
      pool = [...shuffle(due).sort((a, b) => pm.get(a.id).box - pm.get(b.id).box), ...shuffle(fresh), ...later];
    }
    if (!pool.length) { toast('No questions found for that selection.', 'bad'); return false; }
    picked = count === 'all' ? pool : pool.slice(0, +count);
    if (mode === 'smart') picked = shuffle(picked);
  }
  const names = [...new Set(picked.map((q) => meta.topicById.get(q.category_id)?.name).filter(Boolean))];
  const label = names.length === 1 ? names[0] : names.length <= 3 ? names.join(', ') : `${names.length} topics`;
  const sessionId = check(await sb.rpc('start_session', { p_mode: preset ? 'review' : 'topic', p_label: label, p_total: picked.length }));
  state.run = { opts, sessionId, label, i: 0, startedAt: Date.now(),
    items: picked.map((q) => ({ q, order: optionOrder(q.options), sel: new Set(), done: false, ok: null, saved: null })) };
  if (location.hash === '#/session') renderSession(); else location.hash = '#/session';
  return true;
}

/* =========================================================================
   Practice: one question at a time with immediate feedback
   ========================================================================= */

function verdictFor(q, sel) {
  const key = new Set(q.correct);
  const hits = [...sel].filter((i) => key.has(i)).length;
  const wrong = [...sel].filter((i) => !key.has(i)).length;
  if (wrong === 0 && hits === key.size) return { cls: 'ok', icon: 'check', text: 'Correct' };
  if (q.correct.length > 1 && hits > 0) return { cls: 'part', icon: 'alert', text: 'Partly right', sub: `${hits} of ${key.size} correct${wrong ? `, ${wrong} wrong` : ''}${key.size - hits ? `, ${key.size - hits} missed` : ''}` };
  return { cls: 'bad', icon: 'x', text: 'Incorrect' };
}

function optionButtons(it, { reveal = false, disabled = false } = {}) {
  const q = it.q; const multi = q.qtype === 'CM' || q.correct.length > 1;
  return it.order.map((orig, pos) => {
    const chosen = it.sel.has(orig); const isKey = q.correct.includes(orig);
    let cls = multi ? 'opt multi' : 'opt'; let mark = '';
    if (reveal) {
      if (isKey && chosen) { cls += ' correct'; mark = `${icon('check')}Correct`; }
      else if (isKey) { cls += ' missed'; mark = `${icon('check')}Missed`; }
      else if (chosen) { cls += ' wrong'; mark = `${icon('x')}Wrong`; }
      else cls += ' dim';
    }
    return `<button class="${cls}" data-orig="${orig}" data-pos="${pos}" role="${multi ? 'checkbox' : 'radio'}" aria-checked="${chosen}" ${disabled || reveal ? 'disabled' : ''}>
      <span class="key">${LETTERS[pos]}</span><span class="otext">${esc(q.options[orig])}</span>${mark ? `<span class="mark">${mark}</span>` : ''}</button>`;
  }).join('');
}

function renderSession() {
  const run = state.run;
  if (!run) { location.hash = '#/practice'; return; }
  if (run.ended || run.i >= run.items.length) return renderSessionSummary();
  const meta = state.meta;
  const it = run.items[run.i]; const q = it.q; const n = run.items.length;
  const multi = q.qtype === 'CM' || q.correct.length > 1;
  const right = run.items.filter((x) => x.ok).length;
  const topic = meta?.topicById.get(q.category_id); const disc = topic && meta.discById.get(topic.discipline_id);

  const view = shell('practice', `
    <div class="runner">
      <div>
        <div class="run-top">
          <button class="btn ghost sm" id="quit">${icon('x')}End session</button>
          <span class="pos">Question ${run.i + 1} of ${n}</span>
          <span class="chip ok num">${icon('check')}${right} correct</span>
        </div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${run.i}" aria-label="Session progress"><span style="width:${(100 * run.i) / n}%"></span></div>
        <article class="card qcard" aria-labelledby="qtext">
          <div class="qmeta">${disc ? `<span class="chip pri">${esc(disc.name)}</span>` : ''}${topic && topic.name !== disc?.name ? `<span class="chip">${esc(topic.name)}</span>` : ''}<span class="chip">${multi ? 'Multiple answers' : 'Single answer'}</span></div>
          <h1 class="qtext" id="qtext">${esc(q.question)}</h1>
          <p class="qhint">${multi ? 'Select all correct answers, then check.' : 'Select one answer.'}</p>
          <div class="options" role="${multi ? 'group' : 'radiogroup'}" aria-labelledby="qtext">${optionButtons(it, { reveal: it.done })}</div>
          <div class="run-actions" id="actions"></div>
          <div class="feedback" id="feedback" aria-live="polite"></div>
        </article>
        <p class="keys-hint">Keys: A–${LETTERS[q.options.length - 1]} choose · Enter ${multi ? 'check / ' : ''}next</p>
      </div>
    </div>`);

  view.querySelector('#quit').onclick = () => {
    const answered = run.items.filter((x) => x.done).length;
    if (!answered || confirm('End this session? Your answers so far are saved.')) { run.ended = true; renderSessionSummary(); }
  };
  const actions = view.querySelector('#actions');
  const fb = view.querySelector('#feedback');

  const save = async () => {
    const { data, error } = await sb.rpc('record_answer', { p_question_id: q.id, p_selected: [...it.sel], p_session_id: run.sessionId });
    it.saved = !error;
    if (error) console.error(error);
    if (!error && data !== it.ok) console.warn('Server and client disagree on correctness', q.id);
    if (state.run === run && run.items[run.i] === it) showSaveState();
  };
  const showSaveState = () => {
    const el = view.querySelector('#saveState'); if (!el) return;
    el.innerHTML = it.saved === false ? `<span class="chip bad">${icon('alert')}Not saved</span> <button class="btn sm" id="retrySave">${icon('retry')}Retry</button>` : '';
    const r = el.querySelector('#retrySave'); if (r) r.onclick = save;
  };
  const submit = () => {
    if (it.done || !it.sel.size) return;
    it.done = true; it.ok = sameSet([...it.sel], q.correct);
    renderSession(); save();
  };

  if (it.done) {
    const v = verdictFor(q, it.sel);
    const last = run.i === n - 1;
    fb.innerHTML = `<div class="verdict ${v.cls}">${icon(v.icon)}${v.text}${v.sub ? ` <span>${esc(v.sub)}</span>` : ''}</div>
      ${!it.ok ? `<p class="small">Answer key: <b>${q.correct.map((c) => LETTERS[it.order.indexOf(c)]).sort().join(', ')}</b></p>` : ''}
      ${q.explanation ? `<p>${esc(q.explanation)}</p>` : ''}<div id="saveState"></div>`;
    actions.innerHTML = `<span></span><button class="btn primary" id="next">${last ? 'See results' : 'Next question'} ${icon('right')}</button>`;
    actions.querySelector('#next').onclick = () => { run.i += 1; renderSession(); };
    actions.querySelector('#next').focus({ preventScroll: true });
    showSaveState();
    return;
  }

  if (multi) {
    actions.innerHTML = `<span class="muted small" id="selCount">${it.sel.size} selected</span><button class="btn primary" id="checkBtn" ${it.sel.size ? '' : 'disabled'}>${icon('check')}Check answer</button>`;
    actions.querySelector('#checkBtn').onclick = submit;
  }
  view.querySelectorAll('.opt').forEach((b) => (b.onclick = () => {
    const orig = +b.dataset.orig;
    if (multi) {
      it.sel.has(orig) ? it.sel.delete(orig) : it.sel.add(orig);
      b.setAttribute('aria-checked', String(it.sel.has(orig)));
      view.querySelector('#selCount').textContent = `${it.sel.size} selected`;
      view.querySelector('#checkBtn').disabled = !it.sel.size;
    } else {
      it.sel = new Set([orig]); submit();
    }
  }));
}

function renderSessionSummary() {
  const run = state.run;
  const done = run.items.filter((x) => x.done);
  const right = done.filter((x) => x.ok).length;
  const wrong = done.filter((x) => !x.ok);
  const score = done.length ? Math.round((100 * right) / done.length) : 0;
  if (!run.finished) { run.finished = true; sb.rpc('finish_session', { p_session_id: run.sessionId }).then(() => {}, () => {}); }
  const view = shell('practice', `
    <section class="card"><div class="result-head">
      <div class="ring" style="--p:${score};--c:var(${score >= 75 ? '--ok' : score >= 50 ? '--warn' : '--bad'})"><span>${score}%</span></div>
      <div style="flex:1;min-width:240px">
        <h1>${done.length ? (score >= 75 ? 'Strong session' : score >= 50 ? 'Good progress' : 'Keep at it') : 'Session ended'}</h1>
        <p class="muted">${right} of ${done.length} correct${done.length < run.items.length ? ` · ${run.items.length - done.length} not answered` : ''} · ${esc(run.label)}</p>
        ${done.some((x) => x.saved === false) ? `<p class="chip bad">${icon('alert')}Some answers were not saved because of a connection problem.</p>` : ''}
        <div class="btn-row">
          ${run.opts ? `<button class="btn primary" id="again">${icon('retry')}Practise again</button>` : ''}
          ${wrong.length ? `<button class="btn" id="retryWrong">Retry the ${wrong.length} I missed</button>` : ''}
          <a class="btn ghost" href="#/practice">Change topics</a>
        </div>
      </div></div></section>
    ${wrong.length ? `<section class="card"><h2>Review your mistakes</h2><ol class="review">${wrong.map((it) => reviewItem(it)).join('')}</ol></section>` : ''}`);
  const again = view.querySelector('#again');
  if (again) again.onclick = async () => { again.disabled = true; try { if (!(await startPractice(run.opts))) again.disabled = false; } catch (e) { toast(errMsg(e), 'bad'); again.disabled = false; } };
  const rw = view.querySelector('#retryWrong');
  if (rw) rw.onclick = () => startPractice(run.opts, wrong.map((x) => x.q)).catch((e) => toast(errMsg(e), 'bad'));
}

function reviewItem(it, meta = state.meta) {
  const q = it.q;
  const topic = meta?.topicById.get(q.category_id);
  const v = it.sel.size ? verdictFor(q, it.sel) : { cls: 'bad', text: 'Not answered', icon: 'x' };
  return `<li>
    <div class="qmeta"><span class="chip ${v.cls === 'ok' ? 'ok' : v.cls === 'part' ? 'warn' : 'bad'}">${icon(v.icon)}${v.text}</span>${topic ? `<span class="chip">${esc(topic.name)}</span>` : ''}${it.flagged ? `<span class="chip warn">${icon('flag')}Flagged</span>` : ''}</div>
    <p class="rq">${esc(q.question)}</p>
    <ul class="ropts">${it.order.map((orig, pos) => {
      const key = q.correct.includes(orig); const chosen = it.sel.has(orig);
      const cls = key ? 'c' : chosen ? 'w' : '';
      const tag = key && chosen ? 'Your answer · correct' : key ? 'Correct answer' : chosen ? 'Your answer' : '';
      return `<li class="${cls}"><b>${LETTERS[pos]}</b><span>${esc(q.options[orig])}</span>${tag ? `<span class="tag">${tag}</span>` : ''}</li>`;
    }).join('')}</ul>
    ${q.explanation ? `<p class="muted small" style="margin-top:8px">${esc(q.explanation)}</p>` : ''}
  </li>`;
}

document.addEventListener('keydown', (e) => {
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const h = location.hash;
  if (h !== '#/session' && h !== '#/exam/run') return;
  const k = e.key.toUpperCase();
  let pos = -1;
  if (/^[1-9]$/.test(k)) pos = +k - 1; else if (k.length === 1 && LETTERS.includes(k)) pos = LETTERS.indexOf(k);
  if (pos >= 0) { const b = document.querySelector(`.opt[data-pos="${pos}"]`); if (b && !b.disabled) { e.preventDefault(); b.click(); } return; }
  if (e.key === 'Enter') {
    const btn = document.getElementById('next') || document.getElementById('checkBtn');
    if (btn && !btn.disabled && document.activeElement !== btn) { e.preventDefault(); btn.click(); }
  }
  if (h === '#/exam/run') {
    if (e.key === 'ArrowRight') { const b = document.getElementById('exNext'); if (b && !b.disabled) b.click(); }
    if (e.key === 'ArrowLeft') { const b = document.getElementById('exPrev'); if (b && !b.disabled) b.click(); }
    if (k === 'F' && !LETTERS.slice(0, 5).includes('F')) { const b = document.getElementById('exFlag'); if (b) b.click(); }
  }
});

/* =========================================================================
   Mock exam (sample paper by the official weights)
   ========================================================================= */

/** Split n questions across disciplines by weight (largest remainder), capped by what's available. */
function allocate(n, discs) {
  const rows = discs.filter((d) => d.total > 0 && d.weight > 0).map((d) => ({ d, k: 0, exact: 0 }));
  const W = sum(rows.map((r) => r.d.weight));
  if (!W) return [];
  rows.forEach((r) => { r.exact = (n * r.d.weight) / W; r.k = Math.min(Math.floor(r.exact), r.d.total); });
  let left = n - sum(rows.map((r) => r.k));
  while (left > 0) {
    const cand = rows.filter((r) => r.k < r.d.total).sort((a, b) => (b.exact - b.k) - (a.exact - a.k));
    if (!cand.length) break;
    cand[0].k += 1; left -= 1;
  }
  return rows;
}

async function renderExamSetup() {
  const view = shell('exam', loading);
  const meta = await loadMeta();
  const draft = store.get(draftKey());
  const totalQs = sum(meta.disciplines.map((d) => d.total));
  if (!totalQs) { view.innerHTML = `<div class="card empty">${icon('exam')}<h2>No questions yet</h2></div>`; return; }
  const prefs = store.get(prefsKey()) || {};
  const size = String(prefs.examSize || 100);
  const timed = prefs.examTimed !== false;

  view.innerHTML = `
    <div class="page-head"><div><h1>Mock exam</h1><p class="muted">A sample paper drawn at random from the whole bank, with questions per discipline set by the official exam weights. Answers are revealed after you submit.</p></div></div>
    ${draft ? `<div class="card tight row-between" style="border-color:var(--warn)"><div class="row">${icon('clock')}<b>You have an unfinished exam: ${esc(draft.label || '')}</b></div><div class="btn-row"><a class="btn primary" href="#/exam/run">Resume</a><button class="btn ghost" id="discard">Discard</button></div></div>` : ''}
    <div class="grid two">
      <section class="card" aria-labelledby="es">
        <fieldset><legend id="es">Paper length</legend>
          <div class="choices">${[50, 100, 150, 200].map((n) => `<label class="choice"><input type="radio" name="size" value="${n}" ${size === String(n) ? 'checked' : ''}><span><b>${n} questions</b><small>${n === 100 ? 'Recommended' : n < 100 ? 'Quick check' : 'Full stamina test'}</small></span></label>`).join('')}</div>
        </fieldset>
        <label class="choice" style="margin-bottom:16px"><input type="checkbox" id="timed" ${timed ? 'checked' : ''}><span><b>Timed</b><small>One minute per question. The paper submits itself when time runs out.</small></span></label>
        <button class="btn primary lg block" id="go">${icon('exam')}Start mock exam</button>
      </section>
      <section class="card" aria-labelledby="eb">
        <h2 id="eb">Exam blueprint</h2>
        <p class="muted small">From the 2026 graduation exam test collection. Questions per paper update with the length you pick.</p>
        <div class="table-wrap"><table><thead><tr><th>Discipline</th><th class="n">Weight</th><th class="n">In paper</th><th class="n">In bank</th></tr></thead><tbody id="bp"></tbody></table></div>
      </section>
    </div>`;

  const bp = view.querySelector('#bp');
  const draw = () => {
    const n = +view.querySelector('input[name=size]:checked').value;
    const rows = allocate(n, meta.disciplines);
    const byId = new Map(rows.map((r) => [r.d.id, r.k]));
    let lastProfile = '';
    bp.innerHTML = meta.disciplines.filter((d) => d.total || d.weight).map((d) => {
      const head = d.profile !== lastProfile ? `<tr class="group"><td colspan="4">${esc(d.profile)}</td></tr>` : '';
      lastProfile = d.profile;
      return head + `<tr><td>${esc(d.name)}</td><td class="n">${d.weight}%</td><td class="n"><b>${byId.get(d.id) || 0}</b></td><td class="n muted">${d.total}</td></tr>`;
    }).join('') + `<tr><td><b>Total</b></td><td class="n">${sum(meta.disciplines.map((d) => d.weight))}%</td><td class="n"><b>${sum(rows.map((r) => r.k))}</b></td><td class="n muted">${totalQs}</td></tr>`;
  };
  view.addEventListener('change', () => {
    store.set(prefsKey(), { ...(store.get(prefsKey()) || {}), examSize: +view.querySelector('input[name=size]:checked').value, examTimed: view.querySelector('#timed').checked });
    draw();
  });
  draw();
  const discard = view.querySelector('#discard');
  if (discard) discard.onclick = () => { if (confirm('Discard the unfinished exam? Nothing from it will be saved.')) { store.del(draftKey()); state.exam = null; renderExamSetup(); } };

  view.querySelector('#go').onclick = async (ev) => {
    if (draft && !confirm('Starting a new exam discards your unfinished one. Continue?')) return;
    const btn = ev.currentTarget; btn.disabled = true; btn.textContent = 'Building your paper…';
    try {
      await startExam(+view.querySelector('input[name=size]:checked').value, view.querySelector('#timed').checked);
    } catch (e) { toast(errMsg(e), 'bad'); btn.disabled = false; btn.innerHTML = `${icon('exam')}Start mock exam`; }
  };
}

async function startExam(n, timed) {
  const meta = await loadMeta();
  const all = await fetchAll(() => sb.from('questions').select('id,category_id').eq('active', true).order('id'));
  const byDisc = new Map();
  for (const q of all) { const t = meta.topicById.get(q.category_id); if (!t) continue; if (!byDisc.has(t.discipline_id)) byDisc.set(t.discipline_id, []); byDisc.get(t.discipline_id).push(q.id); }
  const discs = meta.disciplines.map((d) => ({ ...d, total: (byDisc.get(d.id) || []).length }));
  const rows = allocate(n, discs);
  const ids = shuffle(rows.flatMap((r) => shuffle(byDisc.get(r.d.id) || []).slice(0, r.k)));
  if (!ids.length) throw new Error('No questions available for a mock exam.');
  const qs = await inChunks(ids, 100, (chunk) => fetchAll(() => sb.from('questions').select(QCOLS).in('id', chunk).order('id')));
  const qById = new Map(qs.map((q) => [q.id, q]));
  const items = ids.map((id) => qById.get(id)).filter(Boolean).map((q) => ({ q, order: optionOrder(q.options), sel: new Set(), flagged: false }));
  const label = `Mock exam · ${items.length} questions`;
  const sessionId = check(await sb.rpc('start_session', { p_mode: 'mock', p_label: label, p_total: items.length }));
  state.exam = { sessionId, label, timed, startedAt: Date.now(), endsAt: timed ? Date.now() + items.length * 60000 : null, i: 0, items };
  saveDraft();
  location.hash = '#/exam/run';
}

function saveDraft() {
  const ex = state.exam; if (!ex || ex.submitted) return;
  store.set(draftKey(), { sessionId: ex.sessionId, label: ex.label, timed: ex.timed, startedAt: ex.startedAt, endsAt: ex.endsAt, i: ex.i,
    items: ex.items.map((it) => ({ id: it.q.id, order: it.order, sel: [...it.sel], flagged: it.flagged })) });
}
async function restoreDraft() {
  const d = store.get(draftKey()); if (!d) return false;
  const qs = await inChunks(d.items.map((x) => x.id), 100, (chunk) => fetchAll(() => sb.from('questions').select(QCOLS).in('id', chunk).order('id')));
  const qById = new Map(qs.map((q) => [q.id, q]));
  const items = d.items.filter((x) => qById.has(x.id)).map((x) => ({ q: qById.get(x.id), order: x.order, sel: new Set(x.sel), flagged: x.flagged }));
  state.exam = { ...d, items };
  return true;
}

function startTimer() {
  clearInterval(state.timer);
  const ex = state.exam;
  if (!ex || !ex.timed) return;
  const tick = () => {
    const left = ex.endsAt - Date.now();
    const el = document.getElementById('timer');
    if (el) { el.querySelector('span').textContent = fmtClock(left); el.classList.toggle('low', left < 5 * 60000); }
    if (left <= 0 && !ex.submitted) { clearInterval(state.timer); toast('Time is up. Your paper has been submitted.'); submitExam(); }
  };
  tick(); state.timer = setInterval(tick, 1000);
}

async function renderExamRun() {
  if (!state.exam || state.exam.submitted) {
    shell('exam', loading);
    if (!(await restoreDraft())) { location.hash = '#/exam'; return; }
  }
  const ex = state.exam; const meta = await loadMeta();
  const n = ex.items.length; const it = ex.items[ex.i]; const q = it.q;
  const multi = q.qtype === 'CM' || q.correct.length > 1;
  const answered = ex.items.filter((x) => x.sel.size).length;
  const topic = meta.topicById.get(q.category_id); const disc = topic && meta.discById.get(topic.discipline_id);

  const view = shell('exam', `
    <div class="runner exam">
      <div>
        <div class="run-top"><span class="pos">Question ${ex.i + 1} of ${n}</span><span class="muted small num">${answered} answered</span></div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${answered}" aria-label="Questions answered"><span style="width:${(100 * answered) / n}%"></span></div>
        <article class="card qcard" aria-labelledby="qtext">
          <div class="qmeta">${disc ? `<span class="chip pri">${esc(disc.name)}</span>` : ''}<span class="chip">${multi ? 'Multiple answers' : 'Single answer'}</span>${it.flagged ? `<span class="chip warn">${icon('flag')}Flagged</span>` : ''}</div>
          <h1 class="qtext" id="qtext">${esc(q.question)}</h1>
          <p class="qhint">${multi ? 'Select all correct answers.' : 'Select one answer.'} You can change it until you submit.</p>
          <div class="options" role="${multi ? 'group' : 'radiogroup'}" aria-labelledby="qtext">${optionButtons(it)}</div>
          <div class="run-actions">
            <button class="btn" id="exPrev" ${ex.i === 0 ? 'disabled' : ''}>${icon('left')}Previous</button>
            <button class="btn ghost" id="exFlag" aria-pressed="${it.flagged}">${icon('flag')}${it.flagged ? 'Unflag' : 'Flag'}</button>
            ${ex.i < n - 1 ? `<button class="btn primary" id="exNext">Next ${icon('right')}</button>` : `<button class="btn primary" id="exSubmit2">Review &amp; submit</button>`}
          </div>
        </article>
        <p class="keys-hint">Keys: A–${LETTERS[q.options.length - 1]} choose · ← → move · F flag</p>
      </div>
      <aside class="card side" aria-label="Exam navigator">
        ${ex.timed ? `<div class="timer" id="timer" role="timer" aria-live="off">${icon('clock')}<span>--:--</span></div>` : `<div class="timer">${icon('clock')}<span class="small muted" style="font-weight:500">Untimed</span></div>`}
        <div class="qgrid" role="list">${ex.items.map((x, k) => `<button role="listitem" data-go="${k}" class="${x.sel.size ? 'answered' : ''} ${x.flagged ? 'flagged' : ''} ${k === ex.i ? 'current' : ''}" aria-label="Question ${k + 1}${x.sel.size ? ', answered' : ''}${x.flagged ? ', flagged' : ''}" ${k === ex.i ? 'aria-current="true"' : ''}>${k + 1}</button>`).join('')}</div>
        <div class="legend-row"><span><i class="a"></i>Answered</span><span><i></i>Not answered</span><span><i class="f"></i>Flagged</span></div>
        <button class="btn primary block" id="exSubmit" style="margin-top:16px">Submit exam</button>
        <p class="muted small" style="margin:8px 0 0">${n - answered} not answered</p>
      </aside>
    </div>`);

  const go = (k) => { ex.i = k; saveDraft(); renderExamRun(); };
  view.querySelectorAll('.opt').forEach((b) => (b.onclick = () => {
    const orig = +b.dataset.orig;
    if (multi) { it.sel.has(orig) ? it.sel.delete(orig) : it.sel.add(orig); }
    else it.sel = it.sel.has(orig) ? new Set() : new Set([orig]);
    saveDraft(); renderExamRun();
  }));
  view.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => go(+b.dataset.go)));
  const prev = view.querySelector('#exPrev'); if (prev) prev.onclick = () => go(ex.i - 1);
  const next = view.querySelector('#exNext'); if (next) next.onclick = () => go(ex.i + 1);
  view.querySelector('#exFlag').onclick = () => { it.flagged = !it.flagged; saveDraft(); renderExamRun(); };
  const askSubmit = () => {
    const missing = n - ex.items.filter((x) => x.sel.size).length;
    const flagged = ex.items.filter((x) => x.flagged).length;
    const msg = `Submit your exam now?${missing ? `\n\n${missing} question${missing > 1 ? 's are' : ' is'} not answered and will count as wrong.` : ''}${flagged ? `\n${flagged} question${flagged > 1 ? 's are' : ' is'} flagged.` : ''}`;
    if (confirm(msg)) submitExam();
  };
  view.querySelector('#exSubmit').onclick = askSubmit;
  const s2 = view.querySelector('#exSubmit2'); if (s2) s2.onclick = askSubmit;
  if (!state.timer || ex.timed) startTimer();
}

async function submitExam() {
  const ex = state.exam;
  if (!ex || ex.submitted || ex.submitting) return;
  ex.submitting = true;
  clearInterval(state.timer);
  const view = shell('exam', `<div class="card empty" role="status">${icon('upload')}<h2>Marking your paper…</h2><p class="muted num" id="saving">Saving answers 0 / ${ex.items.length}</p></div>`);
  let done = 0;
  for (let i = 0; i < ex.items.length; i += 8) {
    await Promise.all(ex.items.slice(i, i + 8).map(async (it) => {
      it.ok = sameSet([...it.sel], it.q.correct);
      const { data, error } = await sb.rpc('record_answer', { p_question_id: it.q.id, p_selected: [...it.sel], p_session_id: ex.sessionId });
      it.saved = !error;
      if (!error) it.ok = data;
      done += 1;
    }));
    const el = view.querySelector('#saving'); if (el) el.textContent = `Saving answers ${done} / ${ex.items.length}`;
  }
  await sb.rpc('finish_session', { p_session_id: ex.sessionId }).then(() => {}, () => {});
  ex.submitted = true; ex.finishedAt = Date.now();
  store.del(draftKey());
  state.examResult = ex; state.exam = null;
  location.hash = '#/exam/result';
}

async function renderExamResult() {
  const ex = state.examResult;
  if (!ex) { location.hash = '#/exam'; return; }
  const view = shell('exam', loading);
  const [meta, sessions] = await Promise.all([loadMeta(), sessionsFor(state.profile.id)]);
  const n = ex.items.length; const right = ex.items.filter((x) => x.ok).length;
  const score = Math.round((100 * right) / n);
  const per = new Map();
  for (const it of ex.items) {
    const t = meta.topicById.get(it.q.category_id); const d = t && meta.discById.get(t.discipline_id);
    const key = d ? d.id : 0;
    if (!per.has(key)) per.set(key, { d, n: 0, ok: 0 });
    const p = per.get(key); p.n += 1; if (it.ok) p.ok += 1;
  }
  const mins = Math.round(((ex.finishedAt || Date.now()) - ex.startedAt) / 60000);
  const unsaved = ex.items.filter((x) => x.saved === false).length;
  const mocks = sessions.filter((s) => s.mode === 'mock');
  const prevMock = mocks.filter((s) => s.id !== ex.sessionId).pop();

  view.innerHTML = `
    <section class="card"><div class="result-head">
      <div class="ring" style="--p:${score};--c:var(${score >= 75 ? '--ok' : score >= 50 ? '--warn' : '--bad'})"><span>${score}%</span></div>
      <div style="flex:1;min-width:240px">
        <h1>Mock exam result</h1>
        <p class="muted">${right} of ${n} correct · ${mins} min${prevMock ? ` · previous mock ${pct(prevMock.correct, prevMock.total)}` : ''}</p>
        ${unsaved ? `<p class="chip bad">${icon('alert')}${unsaved} answers were not saved because of a connection problem.</p>` : ''}
        <div class="btn-row"><a class="btn primary" href="#/exam">${icon('retry')}New mock exam</a><a class="btn" href="#/progress">${icon('trend')}See progress</a></div>
      </div></div></section>
    <div class="grid two">
      <section class="card" aria-labelledby="rd"><h2 id="rd">By discipline</h2>
        <div class="table-wrap"><table><thead><tr><th>Discipline</th><th class="n">Score</th><th>Result</th></tr></thead><tbody>
        ${[...per.values()].sort((a, b) => (a.d?.sort || 99) - (b.d?.sort || 99)).map((p) => { const a = pctNum(p.ok, p.n); return `<tr><td>${esc(p.d ? p.d.name : 'Other')}</td><td class="n">${p.ok}/${p.n}</td><td><div class="cov"><span class="bar ${barClass(a)}"><span style="width:${a}%"></span></span><small class="acc ${accClass(a)}">${a}%</small></div></td></tr>`; }).join('')}
        </tbody></table></div></section>
      <section class="card" aria-labelledby="rc"><h2 id="rc">Your mock exam scores</h2><div id="curve"></div></section>
    </div>
    <section class="card" aria-labelledby="rr">
      <div class="row-between"><h2 id="rr">Review answers</h2>
        <div class="filters" role="group" aria-label="Filter answers">${[['wrong', 'Wrong'], ['flagged', 'Flagged'], ['all', 'All']].map(([v, l], k) => `<button class="btn sm" data-f="${v}" aria-pressed="${k === 0}">${l}</button>`).join('')}</div></div>
      <ol class="review" id="rlist"></ol>
    </section>`;

  drawCurveInto(view.querySelector('#curve'), mocks.length ? mocks : sessions, { mockOnly: true, highlight: ex.sessionId });
  const list = view.querySelector('#rlist');
  const draw = (f) => {
    const items = ex.items.filter((x) => (f === 'wrong' ? !x.ok : f === 'flagged' ? x.flagged : true));
    list.innerHTML = items.length ? items.map((x) => reviewItem(x, meta)).join('') : `<li class="muted">${f === 'wrong' ? 'No wrong answers. Excellent!' : 'Nothing to show.'}</li>`;
  };
  view.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { view.querySelectorAll('[data-f]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); draw(b.dataset.f); }));
  draw('wrong');
}

/* =========================================================================
   Improvement curve (Chart.js line chart + table fallback + text summary)
   ========================================================================= */

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function trendSentence(points, what) {
  if (points.length < 2) return '';
  const first = points[0].score; const last = points[points.length - 1].score;
  const best = Math.max(...points.map((p) => p.score));
  const diff = last - first;
  return `${what}: ${first}% at the start, ${last}% now (${diff >= 0 ? '+' : ''}${diff} points), best ${best}%.`;
}

function drawCurveInto(box, sessions, { mockOnly = false, highlight = null } = {}) {
  const done = sessions.filter((s) => s.answered > 0 && (!mockOnly || s.mode === 'mock'));
  if (!done.length) {
    box.innerHTML = `<div class="empty" style="padding:24px">${icon('trend')}<p class="muted">No sessions yet. Finish a practice session or a mock exam and your scores will be plotted here.</p></div>`;
    return;
  }
  const points = done.map((s, k) => ({ k, s, score: Math.round((100 * s.correct) / s.answered), mock: s.mode === 'mock' }));
  const mocks = points.filter((p) => p.mock); const prac = points.filter((p) => !p.mock);
  const summary = [trendSentence(mocks, 'Mock exams'), mockOnly ? '' : trendSentence(prac, 'Practice sessions')].filter(Boolean).join(' ');
  const table = `<details class="data-table"><summary>Show scores as a table</summary><div class="table-wrap"><table><thead><tr><th>Date</th><th>Session</th><th class="n">Score</th><th class="n">Correct</th></tr></thead><tbody>
    ${points.slice().reverse().map((p) => `<tr><td>${fmtDate(p.s.started_at)}</td><td>${p.mock ? '<span class="chip pri">Mock exam</span>' : '<span class="chip">Practice</span>'} ${esc(p.s.label || '')}</td><td class="n"><span class="acc ${accClass(p.score)}">${p.score}%</span></td><td class="n">${p.s.correct}/${p.s.answered}</td></tr>`).join('')}
    </tbody></table></div></details>`;

  if (points.length < 4 || !window.Chart) {
    // Too few points for a meaningful trend line: show them as stat tiles instead.
    box.innerHTML = `<div class="grid stats">${points.slice(-4).map((p) => `<div class="stat"><span class="label">${p.mock ? 'Mock exam' : 'Practice'} · ${shortDate(p.s.started_at)}</span><span class="value">${p.score}<small>%</small></span><span class="hint">${p.s.correct}/${p.s.answered} correct</span></div>`).join('')}</div>
      <p class="muted small">${points.length < 4 ? `Complete ${4 - points.length} more session${4 - points.length > 1 ? 's' : ''} to see your improvement curve.` : ''}</p>${table}`;
    return;
  }

  box.innerHTML = `<div class="chart-box"><canvas role="img" aria-label="Line chart of session scores over time. ${esc(summary)}"></canvas></div>
    <p class="chart-summary muted small">${esc(summary)}</p>${table}`;
  const dayCount = {}; points.forEach((p) => { const k = shortDate(p.s.started_at); dayCount[k] = (dayCount[k] || 0) + 1; });
  const labels = points.map((p) => { const k = shortDate(p.s.started_at); return dayCount[k] > 1 ? `${k} ${new Date(p.s.started_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : k; });
  const primary = cssVar('--primary'); const grey = cssVar('--series-2'); const line = cssVar('--line'); const muted = cssVar('--muted');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const datasets = [];
  if (mocks.length) datasets.push({ label: 'Mock exams', data: points.map((p) => (p.mock ? p.score : null)), borderColor: primary, backgroundColor: primary,
    pointRadius: (c) => (c.dataIndex !== undefined && points[c.dataIndex] && points[c.dataIndex].s.id === highlight ? 7 : 4), pointHoverRadius: 8, pointStyle: 'circle', borderWidth: 2.5, spanGaps: true, tension: 0.25, clip: false });
  if (prac.length && !mockOnly) datasets.push({ label: 'Practice sessions', data: points.map((p) => (!p.mock ? p.score : null)), borderColor: grey, backgroundColor: grey,
    borderDash: [6, 4], pointStyle: 'triangle', pointRadius: 4, pointHoverRadius: 7, borderWidth: 2, spanGaps: true, tension: 0.25, clip: false });
  new window.Chart(box.querySelector('canvas'), {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false, animation: reduce ? false : { duration: 400 },
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        y: { min: 0, max: 100, ticks: { callback: (v) => v + '%', color: muted, stepSize: 25 }, grid: { color: line }, title: { display: true, text: 'Score', color: muted } },
        x: { ticks: { color: muted, autoSkip: true, maxRotation: 0, maxTicksLimit: 8 }, grid: { display: false }, title: { display: true, text: 'Session date', color: muted } },
      },
      plugins: {
        legend: { position: 'top', align: 'start', labels: { color: muted, usePointStyle: true, boxWidth: 8, boxHeight: 8 } },
        tooltip: { callbacks: {
          title: (items) => fmtDate(points[items[0].dataIndex].s.started_at),
          label: (c) => { const p = points[c.dataIndex]; return `${p.mock ? 'Mock exam' : 'Practice'}: ${c.parsed.y}% (${p.s.correct}/${p.s.answered})`; },
          afterLabel: (c) => points[c.dataIndex].s.label || '',
        } },
      },
    },
  });
}

/* =========================================================================
   Progress page (learner's own; reused by the admin for any learner)
   ========================================================================= */

async function progressHTML(userId) {
  const [meta, stats, sessions] = await Promise.all([loadMeta(), topicStats(userId), sessionsFor(userId)]);
  const r = readiness(meta, stats);
  const overall = rollUp([...stats.values()]);
  const totalQs = sum(meta.disciplines.map((d) => d.total));
  const mocks = sessions.filter((s) => s.mode === 'mock');
  const best = mocks.length ? Math.max(...mocks.map((s) => pctNum(s.correct, s.answered))) : null;
  const html = `
    <div class="grid stats">
      <div class="stat"><span class="label">${icon('target')}Estimated exam score</span><span class="value">${r.score === null ? '–' : r.score + '<small>%</small>'}</span><span class="hint">${r.score === null ? 'Not enough answers yet' : `Covers ${r.weightCovered}% of the exam weight`}</span></div>
      <div class="stat"><span class="label">${icon('layers')}Questions practised</span><span class="value">${overall.answered.toLocaleString()}<small>/${totalQs.toLocaleString()}</small></span><span class="hint">${pct(overall.answered, totalQs)} of the bank</span></div>
      <div class="stat"><span class="label">${icon('check')}Accuracy</span><span class="value">${pct(overall.correct, overall.attempts)}</span><span class="hint">${overall.due} due for review</span></div>
      <div class="stat"><span class="label">${icon('exam')}Mock exams</span><span class="value">${mocks.length}</span><span class="hint">${best === null ? 'None yet' : `Best ${best}% · latest ${pct(mocks[mocks.length - 1].correct, mocks[mocks.length - 1].answered)}`}</span></div>
    </div>
    <section class="card" aria-labelledby="pc"><h2 id="pc">Improvement curve</h2><p class="muted small">Every finished session, oldest to newest. Mock exams are the solid line; topic practice is dashed.</p><div id="curve"></div></section>
    <section class="card" aria-labelledby="pd"><h2 id="pd">Readiness by discipline</h2>
      <p class="muted small">Accuracy per discipline, with its weight in the exam. The estimated score weights these the same way the real paper does.</p>
      <div class="table-wrap"><table><thead><tr><th>Discipline</th><th class="n">Weight</th><th>Coverage</th><th class="n">Accuracy</th><th>Last practised</th></tr></thead><tbody>
      ${r.per.filter((p) => p.d.total).map((p) => `<tr><td>${esc(p.d.name)}</td><td class="n">${p.d.weight}%</td>
        <td><div class="cov"><span class="bar"><span style="width:${p.coverage || 0}%"></span></span><small>${p.s.answered}/${p.d.total}</small></div></td>
        <td class="n"><span class="acc ${accClass(p.acc)}">${p.acc === null ? '–' : p.acc + '%'}</span></td><td>${fmtDate(p.s.last)}</td></tr>`).join('')}
      </tbody></table></div></section>
    <section class="card" aria-labelledby="ptp"><h2 id="ptp">By topic</h2>
      <div class="table-wrap"><table><thead><tr><th>Topic</th><th>Coverage</th><th class="n">Accuracy</th><th class="n">Due</th></tr></thead><tbody>
      ${meta.disciplines.filter((d) => d.total).map((d) => `<tr class="group"><td colspan="4">${esc(d.name)}</td></tr>` + d.topics.filter((t) => meta.totals.get(t.id)).map((t) => {
        const s = stats.get(t.id); const total = meta.totals.get(t.id); const a = s ? pctNum(s.correct, s.attempts) : null;
        return `<tr><td>${esc(t.name)}</td><td><div class="cov"><span class="bar"><span style="width:${s ? Math.round((100 * s.answered) / total) : 0}%"></span></span><small>${s ? s.answered : 0}/${total}</small></div></td>
          <td class="n"><span class="acc ${accClass(a)}">${a === null ? '–' : a + '%'}</span></td><td class="n">${s ? s.due : 0}</td></tr>`;
      }).join('')).join('')}
      </tbody></table></div></section>`;
  return { html, sessions };
}

async function renderMyProgress() {
  const view = shell('progress', loading);
  const { html, sessions } = await progressHTML(state.profile.id);
  view.innerHTML = `<div class="page-head"><div><h1>Progress</h1><p class="muted">How your scores are moving, and where to focus next.</p></div></div>` + html;
  drawCurveInto(view.querySelector('#curve'), sessions);
}

/* =========================================================================
   Account
   ========================================================================= */

function renderAccount() {
  const p = state.profile;
  const view = shell('account', `
    <div class="page-head"><div><h1>Account</h1></div></div>
    <div class="grid two">
      <section class="card"><h2>Profile</h2>
        <table><tbody><tr><td class="muted">Name</td><td>${esc(p.full_name || '–')}</td></tr><tr><td class="muted">Email</td><td>${esc(p.email)}</td></tr><tr><td class="muted">Role</td><td>${p.role === 'admin' ? 'Admin' : 'Learner'}</td></tr></tbody></table></section>
      <form class="card" id="pwForm" novalidate><h2>Change password</h2>
        <label class="field">New password<input type="password" name="pw" minlength="8" required autocomplete="new-password" aria-describedby="pwErr"><span class="help">At least 8 characters.</span></label>
        <label class="field">Confirm new password<input type="password" name="pw2" minlength="8" required autocomplete="new-password" aria-describedby="pwErr"></label>
        <button class="btn primary" type="submit">Update password</button>
        <p class="form-error" id="pwErr" role="alert"></p>
      </form>
    </div>`);
  const form = view.querySelector('#pwForm');
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form); const err = view.querySelector('#pwErr');
    if (String(fd.get('pw')).length < 8) { err.textContent = 'The new password must be at least 8 characters.'; form.pw.focus(); return; }
    if (fd.get('pw') !== fd.get('pw2')) { err.textContent = "The two passwords don't match. Type them again."; form.pw2.focus(); return; }
    err.textContent = '';
    const btn = form.querySelector('button'); btn.disabled = true;
    const { error } = await sb.auth.updateUser({ password: fd.get('pw') });
    btn.disabled = false;
    if (error) { err.textContent = error.message; return; }
    form.reset(); toast('Password updated.', 'ok');
  };
}

/* =========================================================================
   Admin
   ========================================================================= */

async function adminAction(body) {
  const { data, error } = await sb.functions.invoke('admin-users', { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return data;
}
const adminTabs = (active) => `<nav class="tabs" aria-label="Admin sections">
  <a href="#/admin/learners" ${active === 'learners' ? 'aria-current="page"' : ''}>${icon('user')}Learners</a>
  <a href="#/admin/questions" ${active === 'questions' ? 'aria-current="page"' : ''}>${icon('layers')}Questions &amp; blueprint</a></nav>`;

async function renderAdminLearners() {
  const view = shell('admin', loading);
  const [profiles, stats, sessions] = await Promise.all([
    sb.from('profiles').select('*').order('created_at').then(check),
    sb.rpc('progress_stats').then(check),
    fetchAll(() => sb.from('sessions').select('user_id,mode,answered,correct,total,started_at').gt('answered', 0).order('started_at')),
  ]);
  const byUser = new Map();
  for (const r of stats) { if (!byUser.has(r.user_id)) byUser.set(r.user_id, []); byUser.get(r.user_id).push(r); }
  const sessByUser = new Map();
  for (const s of sessions) { if (!sessByUser.has(s.user_id)) sessByUser.set(s.user_id, []); sessByUser.get(s.user_id).push(s); }

  view.innerHTML = `${adminTabs('learners')}
    <div class="row-between"><h1 style="margin:0">Learners</h1><button class="btn primary" id="showAdd">+ Add learner</button></div>
    <form class="card" id="addForm" hidden novalidate>
      <h2>Add a learner</h2>
      <div class="grid two">
        <label class="field">Full name<input name="name" required autocomplete="off"></label>
        <label class="field">Email<input name="email" type="email" required autocomplete="off"></label>
        <label class="field">Temporary password<span class="input-btn"><input name="password" minlength="8" required autocomplete="off"><button type="button" class="btn sm" id="gen">Generate</button></span><span class="help">At least 8 characters. They can change it under Account.</span></label>
        <label class="field">Role<select name="role"><option value="learner">Learner</option><option value="admin">Admin</option></select></label>
      </div>
      <div class="btn-row"><button class="btn primary" type="submit">Create account</button><button class="btn ghost" type="button" id="cancelAdd">Cancel</button></div>
      <p class="form-error" id="addErr" role="alert"></p>
    </form>
    <div id="created"></div>
    <section class="card"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Email</th><th class="n">Practised</th><th class="n">Accuracy</th><th class="n">Mock exams</th><th class="n">Latest mock</th><th>Last active</th><th>Status</th></tr></thead>
      <tbody>${profiles.map((p) => {
        const s = rollUp(byUser.get(p.id) || []); const ss = sessByUser.get(p.id) || []; const mocks = ss.filter((x) => x.mode === 'mock');
        const last = ss.length ? ss[ss.length - 1].started_at : s.last;
        return `<tr class="${p.active ? '' : 'inactive'}">
          <td><a href="#/admin/learner/${p.id}">${esc(p.full_name || '–')}</a>${p.role === 'admin' ? ' <span class="chip pri">admin</span>' : ''}</td>
          <td>${esc(p.email)}</td><td class="n">${s.answered}</td><td class="n">${pct(s.correct, s.attempts)}</td><td class="n">${mocks.length}</td>
          <td class="n">${mocks.length ? pct(mocks[mocks.length - 1].correct, mocks[mocks.length - 1].answered) : '–'}</td>
          <td>${fmtDate(last)}</td><td>${p.active ? '<span class="chip ok">Active</span>' : '<span class="chip">Disabled</span>'}</td></tr>`;
      }).join('')}</tbody></table></div></section>`;

  const form = view.querySelector('#addForm');
  view.querySelector('#showAdd').onclick = () => { form.hidden = false; form.name.focus(); };
  view.querySelector('#cancelAdd').onclick = () => { form.hidden = true; form.reset(); };
  view.querySelector('#gen').onclick = () => { form.password.value = randomPassword(); };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = view.querySelector('#addErr'); const btn = form.querySelector('button[type=submit]');
    const fd = new FormData(form);
    const name = String(fd.get('name')).trim(); const email = String(fd.get('email')).trim().toLowerCase();
    const password = String(fd.get('password')); const role = fd.get('role');
    if (!name) { err.textContent = 'Enter the learner’s name.'; form.name.focus(); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { err.textContent = 'Enter a valid email address.'; form.email.focus(); return; }
    if (password.length < 8) { err.textContent = 'The password must be at least 8 characters. Use Generate for a random one.'; form.password.focus(); return; }
    err.textContent = ''; btn.disabled = true; btn.textContent = 'Creating…';
    try {
      await adminAction({ action: 'create_user', email, full_name: name, role, password });
      form.hidden = true; form.reset();
      view.querySelector('#created').innerHTML = `<div class="card created"><h2>${icon('check')} Account created for ${esc(name)}</h2><p>Send them these sign-in details:</p>
        <pre id="creds">Link: ${esc(location.href.split('#')[0])}\nEmail: ${esc(email)}\nPassword: ${esc(password)}</pre>
        <div class="btn-row"><button class="btn" id="copyCreds">Copy</button><button class="btn ghost" id="doneCreds">Done</button></div></div>`;
      view.querySelector('#copyCreds').onclick = async () => { try { await navigator.clipboard.writeText(view.querySelector('#creds').textContent); toast('Copied.', 'ok'); } catch { toast('Copy failed. Select the text and copy it.', 'bad'); } };
      view.querySelector('#doneCreds').onclick = () => renderAdminLearners();
    } catch (e) { err.textContent = errMsg(e); }
    finally { btn.disabled = false; btn.textContent = 'Create account'; }
  };
}

async function renderAdminLearner(id) {
  const view = shell('admin', loading);
  const p = check(await sb.from('profiles').select('*').eq('id', id).maybeSingle());
  if (!p) { view.innerHTML = `${adminTabs('learners')}<div class="card empty"><p>Learner not found.</p><a class="btn" href="#/admin/learners">Back</a></div>`; return; }
  const self = p.id === state.profile.id;
  const { html, sessions } = await progressHTML(id);
  view.innerHTML = `${adminTabs('learners')}
    <a class="btn ghost sm" href="#/admin/learners">${icon('left')}All learners</a>
    <div class="page-head"><div><h1>${esc(p.full_name || p.email)}</h1><p class="muted">${esc(p.email)} · ${p.role === 'admin' ? 'Admin' : 'Learner'} · ${p.active ? 'Active' : 'Disabled'} · added ${fmtDate(p.created_at, false)}</p></div></div>
    ${html}
    <section class="card"><h2>Manage account</h2>
      <div class="grid two">
        <form id="nameForm" class="inline-form"><label class="field">Name<input name="full_name" value="${esc(p.full_name || '')}"></label><button class="btn">Save</button></form>
        <form id="pwForm" class="inline-form"><label class="field">New password<span class="input-btn"><input name="pw" minlength="8" required placeholder="At least 8 characters" autocomplete="off"><button type="button" class="btn sm" id="gen">Generate</button></span></label><button class="btn">Set password</button></form>
      </div>
      <div class="btn-row" style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line)">
        ${self ? '' : `<button class="btn" id="toggleActive">${p.active ? 'Disable account' : 'Re-enable account'}</button><button class="btn" id="toggleRole">${p.role === 'admin' ? 'Make learner' : 'Make admin'}</button>`}
        <button class="btn danger" id="reset">Reset all progress</button>
      </div></section>`;
  drawCurveInto(view.querySelector('#curve'), sessions);

  const update = async (patch, msg) => { try { check(await sb.from('profiles').update(patch).eq('id', id)); toast(msg, 'ok'); renderAdminLearner(id); } catch (e) { toast(errMsg(e), 'bad'); } };
  view.querySelector('#nameForm').onsubmit = (ev) => { ev.preventDefault(); update({ full_name: ev.target.full_name.value.trim() || null }, 'Name saved.'); };
  view.querySelector('#gen').onclick = () => { view.querySelector('#pwForm').pw.value = randomPassword(); };
  view.querySelector('#pwForm').onsubmit = async (ev) => {
    ev.preventDefault(); const pw = ev.target.pw.value;
    if (pw.length < 8) { toast('The password must be at least 8 characters.', 'bad'); return; }
    try { await adminAction({ action: 'set_password', user_id: id, password: pw }); } catch (e) { toast(errMsg(e), 'bad'); return; }
    try { await navigator.clipboard.writeText(pw); toast('Password set and copied to clipboard.', 'ok'); } catch { toast('Password set. Copy it from the box before leaving.', 'ok'); }
  };
  const ta = view.querySelector('#toggleActive'); if (ta) ta.onclick = () => update({ active: !p.active }, p.active ? 'Account disabled.' : 'Account re-enabled.');
  const tr = view.querySelector('#toggleRole'); if (tr) tr.onclick = () => { if (confirm(p.role === 'admin' ? 'Remove admin rights?' : 'Give this person full admin rights?')) update({ role: p.role === 'admin' ? 'learner' : 'admin' }, 'Role updated.'); };
  view.querySelector('#reset').onclick = async () => {
    if (!confirm(`Delete all practice history, mock exams and the improvement curve for ${p.full_name || p.email}? This can't be undone.`)) return;
    try {
      check(await sb.from('answers').delete().eq('user_id', id));
      check(await sb.from('sessions').delete().eq('user_id', id));
      check(await sb.from('progress').delete().eq('user_id', id));
      toast('Progress reset.', 'ok'); renderAdminLearner(id);
    } catch (e) { toast(errMsg(e), 'bad'); }
  };
}

/* ---------- Admin: questions, blueprint, import ---------- */

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'not a question object' };
  const discipline = String(raw.discipline ?? '').trim() || 'General';
  const topic = String(raw.topic ?? raw.category ?? '').trim();
  const question = String(raw.question ?? '').trim();
  let options = Array.isArray(raw.options) ? raw.options.map((o) => String(o ?? '').trim()).filter(Boolean) : [];
  if (!topic) return { error: 'missing "topic"' };
  if (!question) return { error: 'missing "question"' };
  if (options.length < 2) return { error: 'needs at least 2 "options"' };
  if (options.length > LETTERS.length) return { error: `more than ${LETTERS.length} options` };
  const prefix = /^\(?[A-Ja-j][).:]\s+/;
  if (options.every((o) => prefix.test(o))) options = options.map((o) => o.replace(prefix, ''));
  let correct = [];
  const ans = raw.answer ?? raw.answers;
  if (Array.isArray(ans)) correct = ans.map((a) => (typeof a === 'number' ? a : LETTERS.indexOf(String(a).trim().toUpperCase())));
  else if (typeof ans === 'string' && /^[\sA-Ja-j,;()]+$/.test(ans) && ans.replace(/[^A-Ja-j]/g, '').length) correct = [...ans.replace(/[^A-Ja-j]/g, '').toUpperCase()].map((c) => LETTERS.indexOf(c));
  else if (typeof ans === 'string' && ans.trim()) correct = [options.findIndex((o) => o.toLowerCase() === ans.trim().toLowerCase())];
  else if (Number.isInteger(raw.correct_index)) correct = [raw.correct_index];
  correct = [...new Set(correct)].sort((a, b) => a - b);
  if (!correct.length || correct.some((c) => c < 0 || c >= options.length)) return { error: '"answer" must be letters (e.g. "B" or "ACD") that match the options' };
  const qtype = String(raw.type || '').toUpperCase() === 'CM' || correct.length > 1 ? 'CM' : 'CS';
  return { discipline, topic, question, options, correct, qtype, explanation: String(raw.explanation ?? '').trim() || null };
}

async function importQuestions(items, skipDuplicates, onProgress) {
  const errors = []; const valid = [];
  items.forEach((raw, i) => { const r = normalizeItem(raw); if (r.error) errors.push(`Question ${i + 1}: ${r.error}`); else valid.push(r); });
  if (errors.length) return { errors };

  const meta = await loadMeta(true);
  const discId = new Map(meta.disciplines.map((d) => [d.name.toLowerCase(), d.id]));
  const newDiscs = [...new Set(valid.map((v) => v.discipline))].filter((n) => !discId.has(n.toLowerCase()));
  if (newDiscs.length) {
    const made = check(await sb.from('disciplines').insert(newDiscs.map((name, k) => ({ name, profile: 'Other', weight: 0, sort: 100 + k }))).select('id,name'));
    made.forEach((d) => discId.set(d.name.toLowerCase(), d.id));
  }
  const topicKey = new Map(meta.topics.map((t) => [t.name.toLowerCase(), t]));
  const clashes = new Set(); const toCreate = new Map();
  for (const v of valid) {
    const did = discId.get(v.discipline.toLowerCase());
    const t = topicKey.get(v.topic.toLowerCase());
    if (t && t.discipline_id && t.discipline_id !== did) clashes.add(`"${v.topic}" already belongs to another discipline`);
    if (!t) toCreate.set(v.topic.toLowerCase(), { name: v.topic, discipline_id: did });
  }
  if (clashes.size) return { errors: [...clashes] };
  if (toCreate.size) {
    const made = check(await sb.from('categories').insert([...toCreate.values()]).select('id,name,discipline_id'));
    made.forEach((t) => topicKey.set(t.name.toLowerCase(), t));
  }
  const norm = (t) => String(t).toLowerCase().replace(/\s+/g, ' ').trim();
  const key = (cid, text, options) => [cid, norm(text), ...options.map(norm)].join('|');
  const seen = new Set();
  if (skipDuplicates) (await fetchAll(() => sb.from('questions').select('category_id,question,options').order('id'))).forEach((q) => seen.add(key(q.category_id, q.question, q.options)));
  const rows = []; let skipped = 0;
  for (const v of valid) {
    const cid = topicKey.get(v.topic.toLowerCase()).id; const k = key(cid, v.question, v.options);
    if (skipDuplicates && seen.has(k)) { skipped++; continue; }
    seen.add(k);
    rows.push({ category_id: cid, question: v.question, options: v.options, qtype: v.qtype, correct: v.correct, correct_index: v.correct[0], explanation: v.explanation });
  }
  for (let i = 0; i < rows.length; i += 400) {
    check(await sb.from('questions').insert(rows.slice(i, i + 400)));
    onProgress && onProgress(Math.min(i + 400, rows.length), rows.length);
  }
  state.meta = null;
  return { inserted: rows.length, skipped, newTopics: toCreate.size, newDisciplines: newDiscs.length };
}

async function renderAdminQuestions() {
  const view = shell('admin', loading);
  const meta = await loadMeta(true);
  const ui = state.qui || (state.qui = { disc: '', topic: '' });
  const totalQs = sum(meta.disciplines.map((d) => d.total));
  const W = sum(meta.disciplines.map((d) => d.weight));

  view.innerHTML = `${adminTabs('questions')}
    <div class="row-between"><h1 style="margin:0">Questions &amp; blueprint</h1>
      <div class="btn-row"><button class="btn" id="exportBtn">${icon('download')}Export JSON</button><button class="btn primary" id="newQ">+ New question</button></div></div>
    <p class="muted">${totalQs.toLocaleString()} active questions in ${meta.topics.length} topics across ${meta.disciplines.length} disciplines.</p>
    <div id="editor"></div>
    <div class="grid two">
      <section class="card" aria-labelledby="bw"><h2 id="bw">Exam blueprint</h2>
        <p class="muted small">Share of a mock exam per discipline. Weights should add up to 100%.</p>
        <form id="wForm"><div class="weights">${meta.disciplines.map((d) => `<label class="wrow"><span>${esc(d.name)} <span class="muted small">(${d.total})</span></span><input type="number" min="0" max="100" step="0.5" name="w${d.id}" value="${d.weight}" aria-label="Weight for ${esc(d.name)}"><span class="muted small">%</span></label>`).join('')}</div>
        <div class="row-between" style="margin-top:12px"><span id="wTotal" class="${W === 100 ? 'chip ok' : 'chip warn'}">Total ${W}%</span><button class="btn primary">Save weights</button></div></form>
      </section>
      <section class="card" aria-labelledby="bi"><h2 id="bi">Bulk import</h2>
        <p class="muted small">Upload the question bank JSON. Missing disciplines and topics are created automatically.</p>
        <label class="field">JSON file<input type="file" id="file" accept=".json,application/json"></label>
        <label class="choice" style="margin-bottom:12px"><input type="checkbox" id="skipDup" checked><span><b>Skip duplicates</b><small>Questions already in the same topic with the same options are not added again.</small></span></label>
        <button class="btn primary" id="importBtn" disabled>${icon('upload')}Import</button>
        <div class="import-progress" id="importResult" aria-live="polite"></div>
        <details style="margin-top:12px"><summary class="small">File format</summary><pre class="small" style="white-space:pre-wrap">[{ "discipline": "Cardiology",
   "topic": "Arrhythmias",
   "type": "CM",
   "question": "Tick the ECG signs of atrial fibrillation:",
   "options": ["…", "…", "…", "…", "…"],
   "answer": "AD",
   "explanation": "optional" }]</pre></details>
      </section>
    </div>
    <section class="card" aria-labelledby="bq">
      <div class="row-between"><h2 id="bq">Browse questions</h2>
        <div class="btn-row">
          <select id="fDisc" aria-label="Discipline" style="margin:0;min-width:200px"><option value="">Choose a discipline…</option>${meta.disciplines.map((d) => `<option value="${d.id}" ${String(ui.disc) === String(d.id) ? 'selected' : ''}>${esc(d.name)} (${d.total})</option>`).join('')}</select>
          <select id="fTopic" aria-label="Topic" style="margin:0;min-width:200px"></select>
        </div></div>
      <div id="qlist"><p class="muted">Pick a discipline and topic to see its questions.</p></div>
    </section>`;

  // blueprint weights
  const wForm = view.querySelector('#wForm');
  const wTotal = () => sum([...wForm.querySelectorAll('input')].map((i) => Number(i.value) || 0));
  wForm.addEventListener('input', () => { const t = wTotal(); const el = view.querySelector('#wTotal'); el.textContent = `Total ${t}%`; el.className = t === 100 ? 'chip ok' : 'chip warn'; });
  wForm.onsubmit = async (ev) => {
    ev.preventDefault();
    if (wTotal() !== 100 && !confirm(`The weights add up to ${wTotal()}%, not 100%. Mock exams still use them proportionally. Save anyway?`)) return;
    try {
      for (const d of meta.disciplines) {
        const v = Number(wForm[`w${d.id}`].value) || 0;
        if (v !== d.weight) check(await sb.from('disciplines').update({ weight: v }).eq('id', d.id));
      }
      state.meta = null; toast('Weights saved.', 'ok'); renderAdminQuestions();
    } catch (e) { toast(errMsg(e), 'bad'); }
  };

  // import
  const fileEl = view.querySelector('#file'); const impBtn = view.querySelector('#importBtn'); const out = view.querySelector('#importResult');
  let fileText = '';
  fileEl.onchange = async () => { fileText = fileEl.files[0] ? await fileEl.files[0].text() : ''; impBtn.disabled = !fileText; out.innerHTML = ''; };
  impBtn.onclick = async () => {
    let items;
    try { const parsed = JSON.parse(fileText); items = Array.isArray(parsed) ? parsed : parsed.questions; if (!Array.isArray(items) || !items.length) throw new Error('Expected a list of questions.'); }
    catch (e) { out.innerHTML = `<p class="form-error">Couldn't read the file: ${esc(errMsg(e))}</p>`; return; }
    impBtn.disabled = true; impBtn.textContent = 'Importing…';
    out.innerHTML = `<div class="progress" role="progressbar" aria-label="Import progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span style="width:0%"></span></div><p class="muted small num" id="impTxt">Checking ${items.length} questions…</p>`;
    try {
      const r = await importQuestions(items, view.querySelector('#skipDup').checked, (done, total) => {
        const bar = out.querySelector('.progress'); const p = Math.round((100 * done) / total);
        bar.firstElementChild.style.width = p + '%'; bar.setAttribute('aria-valuenow', p);
        out.querySelector('#impTxt').textContent = `Saved ${done} of ${total} questions…`;
      });
      if (r.errors) {
        out.innerHTML = `<div class="form-error"><p>Nothing was imported. Fix these first:</p><ul>${r.errors.slice(0, 15).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${r.errors.length > 15 ? `<p>…and ${r.errors.length - 15} more.</p>` : ''}</div>`;
        impBtn.disabled = false; impBtn.innerHTML = `${icon('upload')}Import`;
      } else {
        toast(`Imported ${r.inserted} questions${r.skipped ? `, skipped ${r.skipped} duplicates` : ''}.`, 'ok');
        renderAdminQuestions();
      }
    } catch (e) {
      out.innerHTML = `<p class="form-error">${esc(errMsg(e))}. Questions saved before the error stay; run the import again with "Skip duplicates" on to finish.</p>`;
      impBtn.disabled = false; impBtn.innerHTML = `${icon('upload')}Import`;
    }
  };

  // export
  view.querySelector('#exportBtn').onclick = async () => {
    const qs = await fetchAll(() => sb.from('questions').select('category_id,question,options,qtype,correct,explanation,active').order('id'));
    const data = qs.map((q) => { const t = meta.topicById.get(q.category_id); const d = t && meta.discById.get(t.discipline_id);
      return { discipline: d?.name, topic: t?.name, type: q.qtype, question: q.question, options: q.options, answer: q.correct.map((c) => LETTERS[c]).join(''), explanation: q.explanation || undefined, ...(q.active ? {} : { hidden: true }) }; });
    download(`question-bank-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 1));
  };

  // browse
  const fDisc = view.querySelector('#fDisc'); const fTopic = view.querySelector('#fTopic'); const listEl = view.querySelector('#qlist');
  const fillTopics = () => {
    const d = meta.discById.get(+fDisc.value);
    fTopic.innerHTML = d ? `<option value="">All topics</option>` + d.topics.map((t) => `<option value="${t.id}" ${String(ui.topic) === String(t.id) ? 'selected' : ''}>${esc(t.name)} (${meta.totals.get(t.id) || 0})</option>`).join('') : '<option value="">—</option>';
    fTopic.disabled = !d;
  };
  let current = [];
  const loadList = async () => {
    ui.disc = fDisc.value; ui.topic = fTopic.value;
    const d = meta.discById.get(+fDisc.value);
    if (!d) { listEl.innerHTML = '<p class="muted">Pick a discipline and topic to see its questions.</p>'; return; }
    listEl.innerHTML = loading;
    const ids = fTopic.value ? [+fTopic.value] : d.topics.map((t) => t.id);
    current = ids.length ? await inChunks(ids, 40, (c) => fetchAll(() => sb.from('questions').select(QCOLS + ',active').in('category_id', c).order('id'))) : [];
    drawList(100);
  };
  const drawList = (limit) => {
    listEl.innerHTML = current.length ? `<ol class="qlist">${current.slice(0, limit).map((q) => `<li class="${q.active ? '' : 'inactive'}">
        <div class="qmeta"><span class="chip">${esc(meta.topicById.get(q.category_id)?.name || '')}</span><span class="chip">${q.qtype}</span>${q.active ? '' : '<span class="chip warn">hidden</span>'}</div>
        <p class="rq" style="font-weight:600">${esc(q.question)}</p>
        <ul class="ropts" style="list-style:none;padding:0">${q.options.map((o, i) => `<li class="${q.correct.includes(i) ? 'c' : ''}" style="display:flex;gap:8px"><b>${LETTERS[i]}</b><span>${esc(o)}</span></li>`).join('')}</ul>
        <div class="btn-row" style="margin-top:8px"><button class="btn sm" data-edit="${q.id}">Edit</button><button class="btn sm" data-toggle="${q.id}">${q.active ? 'Hide' : 'Show'}</button><button class="btn sm danger" data-del="${q.id}">Delete</button></div>
      </li>`).join('')}</ol>${current.length > limit ? `<button class="btn block" id="more">Show more (${current.length - limit} left)</button>` : ''}`
      : '<p class="muted">No questions here.</p>';
    const more = listEl.querySelector('#more'); if (more) more.onclick = () => drawList(limit + 200);
  };
  fDisc.onchange = () => { ui.topic = ''; fillTopics(); loadList(); };
  fTopic.onchange = loadList;
  fillTopics(); if (fDisc.value) loadList();

  listEl.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const id = +(b.dataset.edit || b.dataset.toggle || b.dataset.del); const q = current.find((x) => x.id === id); if (!q) return;
    try {
      if (b.dataset.edit) openEditor(q);
      else if (b.dataset.toggle) { check(await sb.from('questions').update({ active: !q.active }).eq('id', id)); q.active = !q.active; drawList(100); state.meta = null; }
      else if (b.dataset.del) { if (!confirm("Delete this question and everyone's history on it?")) return; check(await sb.from('questions').delete().eq('id', id)); current.splice(current.indexOf(q), 1); drawList(100); toast('Deleted.', 'ok'); state.meta = null; }
    } catch (err) { toast(errMsg(err), 'bad'); }
  };

  // editor
  const editorEl = view.querySelector('#editor');
  const openEditor = (q) => {
    if (!meta.topics.length) { toast('Import questions or create a topic first.', 'bad'); return; }
    const isNew = !q;
    q = q || { category_id: +fTopic.value || meta.disciplines.find((d) => d.topics.length)?.topics[0]?.id, question: '', options: ['', '', '', '', ''], correct: [0], explanation: '' };
    editorEl.innerHTML = `<form class="card" id="qForm" style="border-color:var(--primary)" novalidate>
      <h2>${isNew ? 'New question' : 'Edit question'}</h2>
      <label class="field">Topic<select name="category_id">${meta.disciplines.map((d) => `<optgroup label="${esc(d.name)}">${d.topics.map((t) => `<option value="${t.id}" ${t.id === q.category_id ? 'selected' : ''}>${esc(t.name)}</option>`).join('')}</optgroup>`).join('')}</select></label>
      <label class="field">Question<textarea name="question" rows="3" required>${esc(q.question)}</textarea></label>
      <label class="field">Options<span class="help">One per line.</span><textarea name="options" rows="5" required>${esc(q.options.join('\n'))}</textarea></label>
      <fieldset><legend>Correct answers</legend><div class="row" id="corr"></div><p class="muted small">Tick one for single choice, several for multiple choice.</p></fieldset>
      <label class="field">Explanation<span class="help">Optional. Shown after answering.</span><textarea name="explanation" rows="2">${esc(q.explanation || '')}</textarea></label>
      <div class="btn-row"><button class="btn primary">Save</button><button type="button" class="btn ghost" id="cancelQ">Cancel</button></div>
      <p class="form-error" id="qErr" role="alert"></p></form>`;
    const f = editorEl.querySelector('#qForm');
    let chosen = new Set(q.correct);
    const fillCorr = () => {
      const opts = f.options.value.split('\n').map((s) => s.trim()).filter(Boolean);
      chosen = new Set([...chosen].filter((i) => i < opts.length));
      f.querySelector('#corr').innerHTML = opts.map((o, i) => `<label class="choice" style="flex:1 1 140px;padding:8px 12px"><input type="checkbox" value="${i}" ${chosen.has(i) ? 'checked' : ''}><span><b>${LETTERS[i]}</b><small>${esc(o.slice(0, 50))}</small></span></label>`).join('');
      f.querySelectorAll('#corr input').forEach((c) => (c.onchange = () => { c.checked ? chosen.add(+c.value) : chosen.delete(+c.value); }));
    };
    fillCorr(); f.options.oninput = fillCorr;
    f.querySelector('#cancelQ').onclick = () => (editorEl.innerHTML = '');
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const err = f.querySelector('#qErr');
      const options = f.options.value.split('\n').map((s) => s.trim()).filter(Boolean);
      const correct = [...chosen].sort((a, b) => a - b);
      if (!f.question.value.trim()) { err.textContent = 'Write the question text.'; f.question.focus(); return; }
      if (options.length < 2) { err.textContent = 'Add at least 2 options, one per line.'; f.options.focus(); return; }
      if (!correct.length) { err.textContent = 'Tick at least one correct answer.'; return; }
      const row = { category_id: +f.category_id.value, question: f.question.value.trim(), options, correct, correct_index: correct[0], qtype: correct.length > 1 ? 'CM' : 'CS', explanation: f.explanation.value.trim() || null };
      try {
        if (isNew) check(await sb.from('questions').insert(row)); else check(await sb.from('questions').update(row).eq('id', q.id));
        toast('Saved.', 'ok'); state.meta = null; renderAdminQuestions();
      } catch (e2) { err.textContent = errMsg(e2); }
    };
    editorEl.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    f.question.focus({ preventScroll: true });
  };
  view.querySelector('#newQ').onclick = () => openEditor(null);
}

/* =========================================================================
   Boot
   ========================================================================= */

(async () => {
  if (!configured) {
    $app.innerHTML = '<main class="auth-wrap"><div class="card auth"><h1>Almost there</h1><p>Add your Supabase URL and publishable key to <code>config.js</code>.</p></div></main>';
    return;
  }
  try { await loadProfile(); } catch (e) { state.flash = errMsg(e); }
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      clearInterval(state.timer);
      Object.assign(state, { profile: null, meta: null, run: null, exam: null, examResult: null });
      document.getElementById('toasts').replaceChildren();
      setTimeout(() => (location.hash === '' || location.hash === '#/login' ? router() : (location.hash = '#/login')), 0);
    }
  });
  window.addEventListener('hashchange', router);
  window.addEventListener('unhandledrejection', (e) => toast(errMsg(e.reason), 'bad'));
  router();
})();
