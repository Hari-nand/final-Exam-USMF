import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, APP_NAME, SHUFFLE_OPTIONS } from './config.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const configured = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.startsWith('YOUR-');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Admin actions that need the server-side secret key (creating accounts,
// setting passwords) go through the admin-users Edge Function.
async function adminAction(body) {
  const { data, error } = await sb.functions.invoke('admin-users', { body });
  if (error) {
    let msg = error.message;
    try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch { /* keep default */ }
    throw new Error(msg);
  }
  return data;
}

const $app = document.getElementById('app');
const LETTERS = 'ABCDEFGHIJ';
const PREFS_KEY = 'mcq-practice-prefs';
const state = { profile: null, run: null, flash: '' };

document.title = APP_NAME;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const pct = (n, d) => (d ? Math.round((100 * n) / d) + '%' : '–');

function fmtDate(ts) {
  if (!ts) return '–';
  const d = new Date(ts);
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diffDays === 0) return 'Today ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return diffDays + ' days ago';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const FIXED_ORDER = /(all|none|both|neither) of the (above|following)|^(both|neither|all of|none of)\b/i;
function optionOrder(options) {
  const idx = options.map((_, i) => i);
  if (!SHUFFLE_OPTIONS || options.some((o) => FIXED_ORDER.test(String(o)))) return idx;
  return shuffle(idx);
}

function toast(msg, kind = 'info') {
  const box = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.classList.add('out'), 3800);
  setTimeout(() => el.remove(), 4300);
}

function errMsg(e) {
  return (e && (e.message || e.error_description || e.details)) || String(e);
}

function check({ data, error }) {
  if (error) throw error;
  return data;
}

// Supabase returns at most 1000 rows per request, so page through.
async function fetchAll(build) {
  const size = 1000;
  let from = 0;
  let out = [];
  for (;;) {
    const data = check(await build().range(from, from + size - 1));
    out = out.concat(data);
    if (data.length < size) return out;
    from += size;
  }
}

function randomPassword(len = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  return Array.from(buf, (n) => chars[n % chars.length]).join('');
}

// Practice settings are remembered per user on this browser.
const prefsKey = () => PREFS_KEY + ':' + (state.profile ? state.profile.id : '');
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(prefsKey())) || {}; } catch { return {}; }
}
function savePrefs(p) {
  try { localStorage.setItem(prefsKey(), JSON.stringify(p)); } catch { /* ignore */ }
}

function download(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

async function loadProfile() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { state.profile = null; return null; }
  const profile = check(await sb.from('profiles').select('*').eq('id', session.user.id).maybeSingle());
  const refuse = async (msg) => {
    // Signing out redraws the login page, so leave the reason there for it to show.
    state.flash = msg;
    await sb.auth.signOut();
    throw new Error(msg);
  };
  if (!profile) await refuse('No profile found for this account. Ask your admin to add you.');
  if (!profile.active) await refuse('This account has been deactivated. Contact your admin.');
  state.profile = profile;
  return profile;
}

async function loadCategoryData() {
  const [cats, counts, stats] = await Promise.all([
    sb.from('categories').select('id,name').order('name'),
    sb.rpc('category_counts'),
    sb.rpc('progress_stats'),
  ]);
  const totals = new Map(check(counts).map((r) => [r.category_id, r.total]));
  return { cats: check(cats), totals, stats: check(stats) };
}

function statsFor(stats, userId) {
  const m = new Map();
  for (const r of stats) if (r.user_id === userId) m.set(r.category_id, r);
  return m;
}

function sumStats(rows) {
  const s = { answered: 0, attempts: 0, correct: 0, due: 0, last: null };
  for (const r of rows) {
    s.answered += r.answered; s.attempts += r.attempts; s.correct += r.correct; s.due += r.due;
    if (r.last_answered && (!s.last || r.last_answered > s.last)) s.last = r.last_answered;
  }
  return s;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

function shell(active, inner) {
  const p = state.profile;
  const isAdmin = p.role === 'admin';
  const link = (key, href, label) =>
    `<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`;
  $app.innerHTML = `
    <header class="top">
      <div class="top-inner">
        <a class="brand" href="#/practice"><span class="logo" aria-hidden="true">✓</span>${esc(APP_NAME)}</a>
        <nav>
          ${link('practice', '#/practice', 'Practice')}
          ${link('progress', '#/progress', 'My progress')}
          ${isAdmin ? link('users', '#/admin/users', 'Learners') : ''}
          ${isAdmin ? link('questions', '#/admin/questions', 'Questions') : ''}
        </nav>
        <div class="me">
          <a href="#/account" class="${active === 'account' ? 'on' : ''}" title="Account">${esc(p.full_name || p.email)}</a>
          <button class="btn ghost sm" id="signOut">Sign out</button>
        </div>
      </div>
    </header>
    <main id="view">${inner}</main>`;
  document.getElementById('signOut').onclick = async () => {
    await sb.auth.signOut();
  };
  return document.getElementById('view');
}

const loading = '<div class="loading">Loading…</div>';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = {
  practice: renderPractice,
  session: renderSession,
  progress: () => renderMyProgress(),
  account: renderAccount,
  'admin/users': renderAdminUsers,
  'admin/user': renderAdminUser,
  'admin/questions': renderAdminQuestions,
};

async function router() {
  if (!state.profile) return renderLogin();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  let route = parts[0] || 'practice';
  let param;
  if (route === 'admin') {
    if (state.profile.role !== 'admin') { location.hash = '#/practice'; return; }
    route = 'admin/' + (parts[1] || 'users');
    param = parts[2];
  }
  if (route === 'login') { location.hash = '#/practice'; return; }
  const fn = routes[route] || renderPractice;
  try {
    await fn(param);
  } catch (e) {
    console.error(e);
    const view = document.getElementById('view') || $app;
    view.innerHTML = `<div class="card error-card"><h2>Something went wrong</h2><p>${esc(errMsg(e))}</p>
      <button class="btn" onclick="location.reload()">Reload</button></div>`;
  }
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function renderLogin() {
  $app.innerHTML = `
    <div class="auth-wrap">
      <form class="card auth" id="loginForm">
        <div class="logo big" aria-hidden="true">✓</div>
        <h1>${esc(APP_NAME)}</h1>
        <p class="muted">Sign in with the account your admin gave you.</p>
        <label>Email<input type="email" name="email" required autocomplete="username"></label>
        <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
        <button class="btn primary wide" type="submit">Sign in</button>
        <p class="form-error" id="loginErr">${esc(state.flash)}</p>
      </form>
    </div>`;
  state.flash = '';
  const form = document.getElementById('loginForm');
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const btn = form.querySelector('button');
    const errEl = document.getElementById('loginErr');
    btn.disabled = true; btn.textContent = 'Signing in…'; errEl.textContent = '';
    const fd = new FormData(form);
    const { error } = await sb.auth.signInWithPassword({ email: fd.get('email').trim(), password: fd.get('password') });
    if (error) {
      errEl.textContent = error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message;
      btn.disabled = false; btn.textContent = 'Sign in';
      return;
    }
    try {
      await loadProfile();
      if (location.hash === '#/practice' || !location.hash) router(); else location.hash = '#/practice';
    } catch (e) {
      errEl.textContent = errMsg(e);
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  };
}

// ---------------------------------------------------------------------------
// Practice: choose categories
// ---------------------------------------------------------------------------

async function renderPractice() {
  const view = shell('practice', loading);
  const { cats, totals, stats } = await loadCategoryData();
  const mine = statsFor(stats, state.profile.id);
  const usable = cats.filter((c) => (totals.get(c.id) || 0) > 0);

  if (!usable.length) {
    view.innerHTML = `<div class="card empty"><h2>No questions yet</h2>
      <p class="muted">${state.profile.role === 'admin'
        ? 'Add or import questions on the <a href="#/admin/questions">Questions</a> page.'
        : 'Your admin hasn\'t added any questions yet. Check back soon.'}</p></div>`;
    return;
  }

  const prefs = loadPrefs();
  const selected = new Set((prefs.cats || []).filter((id) => usable.some((c) => c.id === id)));
  if (!selected.size) usable.forEach((c) => selected.add(c.id));
  const mode = prefs.mode || 'smart';
  const count = prefs.count || '20';
  const overall = sumStats([...mine.values()]);
  const totalQs = usable.reduce((n, c) => n + totals.get(c.id), 0);

  view.innerHTML = `
    <section class="hello">
      <div>
        <h1>Hi ${esc((state.profile.full_name || '').split(' ')[0] || 'there')}</h1>
        <p class="muted">${overall.answered
          ? `You've answered ${overall.answered} of ${totalQs} questions. ${overall.due} due for review.`
          : `${totalQs} questions are waiting. Pick your categories and start.`}</p>
      </div>
    </section>

    <section class="card">
      <div class="row-between">
        <h2>Categories</h2>
        <div class="btn-group">
          <button class="btn ghost sm" data-sel="all">Select all</button>
          <button class="btn ghost sm" data-sel="none">Clear</button>
        </div>
      </div>
      <div class="cat-grid">
        ${usable.map((c) => {
          const s = mine.get(c.id);
          const total = totals.get(c.id);
          const done = s ? s.answered : 0;
          return `<label class="cat">
            <input type="checkbox" value="${c.id}" ${selected.has(c.id) ? 'checked' : ''}>
            <span class="cat-body">
              <span class="cat-name">${esc(c.name)}</span>
              <span class="cat-meta">${done}/${total} done · ${s ? pct(s.correct, s.attempts) + ' correct' : 'not started'}${s && s.due ? ` · <b>${s.due} due</b>` : ''}</span>
              <span class="bar"><span style="width:${Math.round((100 * done) / total)}%"></span></span>
            </span>
          </label>`;
        }).join('')}
      </div>
    </section>

    <section class="card">
      <h2>How to practise</h2>
      <div class="modes">
        ${[
          ['smart', 'Smart review', 'Questions due for review and new ones first. Best for daily practice.'],
          ['random', 'Random mix', 'Any questions from the chosen categories, shuffled.'],
          ['mistakes', 'My mistakes', 'Only questions you got wrong last time.'],
        ].map(([v, t, d]) => `<label class="mode">
            <input type="radio" name="mode" value="${v}" ${mode === v ? 'checked' : ''}>
            <span><b>${t}</b><small>${d}</small></span></label>`).join('')}
      </div>
      <div class="start-row">
        <label class="inline">Questions
          <select id="count">
            ${['10', '20', '30', '50', 'all'].map((n) => `<option value="${n}" ${count === n ? 'selected' : ''}>${n === 'all' ? 'All' : n}</option>`).join('')}
          </select>
        </label>
        <button class="btn primary big" id="start">Start practice</button>
      </div>
      <p class="muted small" id="startInfo"></p>
    </section>`;

  const boxes = [...view.querySelectorAll('.cat input')];
  const info = view.querySelector('#startInfo');
  const getOpts = () => ({
    catIds: boxes.filter((b) => b.checked).map((b) => +b.value),
    mode: view.querySelector('input[name=mode]:checked').value,
    count: view.querySelector('#count').value,
  });
  const update = () => {
    const o = getOpts();
    savePrefs({ cats: o.catIds, mode: o.mode, count: o.count });
    if (!o.catIds.length) { info.textContent = 'Pick at least one category.'; return; }
    let pool;
    if (o.mode === 'mistakes') info.textContent = 'Shows questions where your latest answer was wrong.';
    else {
      pool = o.catIds.reduce((n, id) => n + totals.get(id), 0);
      const due = o.catIds.reduce((n, id) => n + (mine.get(id)?.due || 0), 0);
      const fresh = o.catIds.reduce((n, id) => n + totals.get(id) - (mine.get(id)?.answered || 0), 0);
      info.textContent = o.mode === 'smart'
        ? `${due} due + ${fresh} new in your selection (${pool} total).`
        : `${pool} questions in your selection.`;
    }
  };
  view.querySelectorAll('[data-sel]').forEach((b) => (b.onclick = () => {
    boxes.forEach((x) => (x.checked = b.dataset.sel === 'all'));
    update();
  }));
  view.addEventListener('change', update);
  update();

  view.querySelector('#start').onclick = async (ev) => {
    const o = getOpts();
    if (!o.catIds.length) { toast('Pick at least one category.', 'error'); return; }
    ev.target.disabled = true; ev.target.textContent = 'Loading…';
    try {
      const ok = await startSession(o);
      if (!ok) { ev.target.disabled = false; ev.target.textContent = 'Start practice'; }
    } catch (e) {
      toast(errMsg(e), 'error');
      ev.target.disabled = false; ev.target.textContent = 'Start practice';
    }
  };
}

async function startSession(opts, presetQuestions) {
  const catNames = new Map(check(await sb.from('categories').select('id,name')).map((c) => [c.id, c.name]));
  let picked;

  if (presetQuestions) {
    picked = shuffle(presetQuestions);
  } else {
    const { catIds, mode, count } = opts;
    const qs = await fetchAll(() =>
      sb.from('questions').select('id,category_id,question,options,correct_index,explanation')
        .in('category_id', catIds).eq('active', true).order('id'));
    const prog = await fetchAll(() =>
      sb.from('progress').select('question_id,box,due_at,last_correct')
        .eq('user_id', state.profile.id).order('question_id'));
    const pmap = new Map(prog.map((p) => [p.question_id, p]));
    const now = Date.now();
    let pool;

    if (mode === 'mistakes') {
      pool = shuffle(qs.filter((q) => pmap.get(q.id)?.last_correct === false));
      if (!pool.length) { toast('No mistakes to review in these categories. Nice work!', 'success'); return false; }
    } else if (mode === 'random') {
      pool = shuffle(qs);
    } else {
      const due = [], fresh = [], later = [];
      for (const q of qs) {
        const p = pmap.get(q.id);
        if (!p) fresh.push(q);
        else if (new Date(p.due_at).getTime() <= now) due.push(q);
        else later.push(q);
      }
      shuffle(due).sort((a, b) => pmap.get(a.id).box - pmap.get(b.id).box);
      later.sort((a, b) => new Date(pmap.get(a.id).due_at) - new Date(pmap.get(b.id).due_at));
      pool = [...shuffle(due).sort((a, b) => pmap.get(a.id).box - pmap.get(b.id).box), ...shuffle(fresh), ...later];
    }
    if (!pool.length) { toast('No questions found for that selection.', 'error'); return false; }
    picked = count === 'all' ? pool : pool.slice(0, +count);
    if (mode === 'smart') picked = shuffle(picked);
  }

  state.run = {
    opts,
    catNames,
    i: 0,
    items: picked.map((q) => ({ q, order: optionOrder(q.options), chosen: null, correct: null, saved: null })),
  };
  // From the results screen we're already on #/session, so no hashchange fires.
  if (location.hash === '#/session') renderSession(); else location.hash = '#/session';
  window.scrollTo(0, 0);
  return true;
}

// ---------------------------------------------------------------------------
// Practice session
// ---------------------------------------------------------------------------

function renderSession() {
  const run = state.run;
  if (!run) { location.hash = '#/practice'; return; }
  if (run.ended || run.i >= run.items.length) return renderSummary();

  const it = run.items[run.i];
  const q = it.q;
  const n = run.items.length;
  const right = run.items.filter((x) => x.correct).length;

  const view = shell('practice', `
    <div class="session">
      <div class="session-top">
        <button class="btn ghost sm" id="quit">End session</button>
        <span class="muted">Question ${run.i + 1} of ${n}</span>
        <span class="score" title="Correct so far">✓ ${right}</span>
      </div>
      <div class="progressbar"><span style="width:${(100 * run.i) / n}%"></span></div>
      <article class="card qcard">
        <span class="tag">${esc(run.catNames.get(q.category_id) || '')}</span>
        <h2 class="qtext">${esc(q.question)}</h2>
        <div class="options">
          ${it.order.map((orig, pos) => `
            <button class="opt" data-orig="${orig}" data-pos="${pos}">
              <span class="letter">${LETTERS[pos]}</span><span class="opt-text">${esc(q.options[orig])}</span>
            </button>`).join('')}
        </div>
        <div id="feedback" class="feedback"></div>
      </article>
      <p class="muted small center keys">Keys: A–${LETTERS[q.options.length - 1]} or 1–${q.options.length} to answer · Enter for next</p>
    </div>`);

  view.querySelector('#quit').onclick = () => {
    const answered = run.items.filter((x) => x.chosen !== null).length;
    if (!answered || confirm('End this session? Your answers so far are saved.')) {
      run.ended = true;
      renderSummary();
    }
  };

  const fb = view.querySelector('#feedback');
  const paint = () => {
    view.querySelectorAll('.opt').forEach((b) => {
      const orig = +b.dataset.orig;
      b.disabled = true;
      if (orig === q.correct_index) b.classList.add('correct');
      else if (orig === it.chosen) b.classList.add('wrong');
      else b.classList.add('dim');
    });
    const last = run.i === n - 1;
    fb.innerHTML = `
      <div class="verdict ${it.correct ? 'ok' : 'bad'}">${it.correct ? 'Correct' : 'Not quite'}
        ${it.correct ? '' : `<span>The answer is ${LETTERS[it.order.indexOf(q.correct_index)]}.</span>`}</div>
      ${q.explanation ? `<div class="explain">${esc(q.explanation)}</div>` : ''}
      <div class="save-state" id="saveState"></div>
      <button class="btn primary" id="next">${last ? 'See results' : 'Next question'}</button>`;
    fb.querySelector('#next').onclick = () => { run.i += 1; renderSession(); };
    fb.querySelector('#next').focus({ preventScroll: true });
    showSaveState();
  };
  const showSaveState = () => {
    const el = view.querySelector('#saveState');
    if (!el) return;
    if (it.saved === false) {
      el.innerHTML = `<span class="warn">Couldn't save this answer.</span> <button class="btn ghost sm" id="retrySave">Retry</button>`;
      el.querySelector('#retrySave').onclick = save;
    } else el.innerHTML = '';
  };
  const save = async () => {
    const { error } = await sb.rpc('record_answer', { p_question_id: q.id, p_selected: it.chosen });
    it.saved = !error;
    if (error) console.error(error);
    if (state.run === run && run.items[run.i] === it) showSaveState();
  };

  if (it.chosen !== null) { paint(); return; }

  view.querySelectorAll('.opt').forEach((b) => {
    b.onclick = () => {
      if (it.chosen !== null) return;
      it.chosen = +b.dataset.orig;
      it.correct = it.chosen === q.correct_index;
      paint();
      save();
    };
  });
}

document.addEventListener('keydown', (e) => {
  if (location.hash !== '#/session' || !state.run) return;
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toUpperCase();
  let pos = -1;
  if (/^[1-9]$/.test(key)) pos = +key - 1;
  else if (key.length === 1 && LETTERS.includes(key)) pos = LETTERS.indexOf(key);
  if (pos >= 0) {
    const btn = document.querySelector(`.opt[data-pos="${pos}"]`);
    if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
  } else if (e.key === 'Enter') {
    const next = document.getElementById('next');
    if (next && document.activeElement !== next) { e.preventDefault(); next.click(); }
  }
});

function renderSummary() {
  const run = state.run;
  const answered = run.items.filter((x) => x.chosen !== null);
  const right = answered.filter((x) => x.correct).length;
  const wrong = answered.filter((x) => !x.correct);
  const unsaved = answered.filter((x) => x.saved === false).length;
  const score = answered.length ? Math.round((100 * right) / answered.length) : 0;

  const view = shell('practice', `
    <section class="card summary">
      <div class="ring" style="--p:${score}"><span>${score}%</span></div>
      <div>
        <h1>${answered.length ? (score >= 80 ? 'Great work' : score >= 50 ? 'Good effort' : 'Keep going') : 'Session ended'}</h1>
        <p class="muted">${right} of ${answered.length} correct${answered.length < run.items.length ? ` (${run.items.length - answered.length} skipped)` : ''}.</p>
        ${unsaved ? `<p class="warn">${unsaved} answer(s) couldn't be saved because of a connection problem.</p>` : ''}
        <div class="btn-row">
          ${run.opts ? '<button class="btn primary" id="again">Practise again</button>' : ''}
          ${wrong.length ? `<button class="btn" id="retryWrong">Retry the ${wrong.length} I missed</button>` : ''}
          <a class="btn ghost" href="#/practice">Change categories</a>
        </div>
      </div>
    </section>
    ${wrong.length ? `
      <section class="card">
        <h2>Review your mistakes</h2>
        <ol class="review">
          ${wrong.map((it) => `<li>
            <p class="rq">${esc(it.q.question)}</p>
            <p class="ra bad">Your answer: ${esc(it.q.options[it.chosen])}</p>
            <p class="ra ok">Correct: ${esc(it.q.options[it.q.correct_index])}</p>
            ${it.q.explanation ? `<p class="muted small">${esc(it.q.explanation)}</p>` : ''}
          </li>`).join('')}
        </ol>
      </section>` : ''}`);

  const again = view.querySelector('#again');
  if (again) again.onclick = async () => {
    again.disabled = true;
    try { if (!(await startSession(run.opts))) again.disabled = false; } catch (e) { toast(errMsg(e), 'error'); again.disabled = false; }
  };
  const rw = view.querySelector('#retryWrong');
  if (rw) rw.onclick = () => startSession(run.opts, wrong.map((x) => x.q)).catch((e) => toast(errMsg(e), 'error'));
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------------
// Progress (learner's own, and reused by admin)
// ---------------------------------------------------------------------------

async function progressHTML(userId) {
  const { cats, totals, stats } = await loadCategoryData();
  const mine = statsFor(stats, userId);
  const rows = cats.filter((c) => totals.get(c.id) || mine.get(c.id));
  const s = sumStats([...mine.values()]);
  const totalQs = rows.reduce((n, c) => n + (totals.get(c.id) || 0), 0);

  return `
    <div class="stat-row">
      <div class="stat"><b>${s.answered}<small>/${totalQs}</small></b><span>Questions seen</span></div>
      <div class="stat"><b>${pct(s.correct, s.attempts)}</b><span>Accuracy</span></div>
      <div class="stat"><b>${s.due}</b><span>Due for review</span></div>
      <div class="stat"><b class="sm">${fmtDate(s.last)}</b><span>Last practised</span></div>
    </div>
    <section class="card">
      <h2>By category</h2>
      ${rows.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Category</th><th>Coverage</th><th class="num">Accuracy</th><th class="num">Due</th><th>Last practised</th></tr></thead>
        <tbody>
          ${rows.map((c) => {
            const r = mine.get(c.id);
            const total = totals.get(c.id) || 0;
            const done = r ? r.answered : 0;
            const acc = r && r.attempts ? Math.round((100 * r.correct) / r.attempts) : null;
            return `<tr>
              <td>${esc(c.name)}</td>
              <td><div class="cov"><span class="bar"><span style="width:${total ? Math.min(100, Math.round((100 * done) / total)) : 0}%"></span></span><small>${done}/${total}</small></div></td>
              <td class="num"><span class="acc ${acc === null ? '' : acc >= 80 ? 'hi' : acc >= 50 ? 'mid' : 'lo'}">${acc === null ? '–' : acc + '%'}</span></td>
              <td class="num">${r ? r.due : 0}</td>
              <td>${fmtDate(r && r.last_answered)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>` : '<p class="muted">No categories yet.</p>'}
    </section>`;
}

async function renderMyProgress() {
  const view = shell('progress', loading);
  view.innerHTML = `<h1 class="page-title">My progress</h1>` + (await progressHTML(state.profile.id));
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

function renderAccount() {
  const p = state.profile;
  const view = shell('account', `
    <h1 class="page-title">Account</h1>
    <section class="card narrow">
      <dl class="kv">
        <dt>Name</dt><dd>${esc(p.full_name || '–')}</dd>
        <dt>Email</dt><dd>${esc(p.email)}</dd>
        <dt>Role</dt><dd>${p.role === 'admin' ? 'Admin' : 'Learner'}</dd>
      </dl>
    </section>
    <form class="card narrow" id="pwForm">
      <h2>Change password</h2>
      <label>New password<input type="password" name="pw" minlength="8" required autocomplete="new-password"></label>
      <label>Confirm new password<input type="password" name="pw2" minlength="8" required autocomplete="new-password"></label>
      <button class="btn primary" type="submit">Update password</button>
      <p class="form-error" id="pwErr"></p>
    </form>`);
  const form = view.querySelector('#pwForm');
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const err = view.querySelector('#pwErr');
    if (fd.get('pw') !== fd.get('pw2')) { err.textContent = "Passwords don't match."; return; }
    err.textContent = '';
    const { error } = await sb.auth.updateUser({ password: fd.get('pw') });
    if (error) { err.textContent = error.message; return; }
    form.reset();
    toast('Password updated.', 'success');
  };
}

// ---------------------------------------------------------------------------
// Admin: learners
// ---------------------------------------------------------------------------

async function renderAdminUsers() {
  const view = shell('users', loading);
  const [profilesRes, statsRes] = await Promise.all([
    sb.from('profiles').select('*').order('created_at'),
    sb.rpc('progress_stats'),
  ]);
  const profiles = check(profilesRes);
  const stats = check(statsRes);
  const byUser = new Map();
  for (const r of stats) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }

  view.innerHTML = `
    <div class="row-between"><h1 class="page-title">Learners</h1>
      <button class="btn primary" id="showAdd">+ Add learner</button></div>

    <form class="card" id="addForm" hidden>
      <h2>Add a learner</h2>
      <div class="grid-2">
        <label>Full name<input name="name" required></label>
        <label>Email<input name="email" type="email" required></label>
        <label>Temporary password
          <span class="input-btn"><input name="password" minlength="8" required><button type="button" class="btn ghost sm" id="gen">Generate</button></span>
        </label>
        <label>Role<select name="role"><option value="learner">Learner</option><option value="admin">Admin</option></select></label>
      </div>
      <div class="btn-row"><button class="btn primary" type="submit">Create account</button>
        <button class="btn ghost" type="button" id="cancelAdd">Cancel</button></div>
      <p class="form-error" id="addErr"></p>
    </form>
    <div id="created"></div>

    <section class="card">
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th class="num">Seen</th><th class="num">Accuracy</th><th class="num">Due</th><th>Last practised</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${profiles.map((p) => {
            const s = sumStats(byUser.get(p.id) || []);
            return `<tr class="${p.active ? '' : 'inactive'}">
              <td><a href="#/admin/user/${p.id}">${esc(p.full_name || '–')}</a>${p.role === 'admin' ? ' <span class="pill">admin</span>' : ''}</td>
              <td>${esc(p.email)}</td>
              <td class="num">${s.answered}</td>
              <td class="num">${pct(s.correct, s.attempts)}</td>
              <td class="num">${s.due}</td>
              <td>${fmtDate(s.last)}</td>
              <td>${p.active ? '<span class="pill ok">Active</span>' : '<span class="pill">Disabled</span>'}</td>
              <td><a class="btn ghost sm" href="#/admin/user/${p.id}">View</a></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table></div>
    </section>`;

  const form = view.querySelector('#addForm');
  view.querySelector('#showAdd').onclick = () => { form.hidden = false; form.name.focus(); };
  view.querySelector('#cancelAdd').onclick = () => { form.hidden = true; form.reset(); };
  view.querySelector('#gen').onclick = () => { form.password.value = randomPassword(); };
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const err = view.querySelector('#addErr');
    const btn = form.querySelector('button[type=submit]');
    const fd = new FormData(form);
    const name = fd.get('name').trim();
    const email = fd.get('email').trim().toLowerCase();
    const password = fd.get('password');
    const role = fd.get('role');
    err.textContent = ''; btn.disabled = true; btn.textContent = 'Creating…';
    try {
      await adminAction({ action: 'create_user', email, full_name: name, role, password });
      form.hidden = true; form.reset();
      view.querySelector('#created').innerHTML = `
        <div class="card created">
          <h2>Account created for ${esc(name)}</h2>
          <p>Share these sign-in details with them:</p>
          <pre id="creds">Link: ${esc(location.href.split('#')[0])}\nEmail: ${esc(email)}\nPassword: ${esc(password)}</pre>
          <div class="btn-row"><button class="btn" id="copyCreds">Copy</button><button class="btn ghost" id="doneCreds">Done</button></div>
        </div>`;
      view.querySelector('#copyCreds').onclick = async () => {
        try { await navigator.clipboard.writeText(view.querySelector('#creds').textContent); toast('Copied.', 'success'); }
        catch { toast('Copy failed. Select the text and copy it manually.', 'error'); }
      };
      view.querySelector('#doneCreds').onclick = () => renderAdminUsers();
    } catch (e) {
      err.textContent = errMsg(e);
    } finally {
      btn.disabled = false; btn.textContent = 'Create account';
    }
  };
}

async function renderAdminUser(id) {
  const view = shell('users', loading);
  const p = check(await sb.from('profiles').select('*').eq('id', id).maybeSingle());
  if (!p) { view.innerHTML = '<div class="card"><p>Learner not found.</p><a href="#/admin/users">Back</a></div>'; return; }
  const self = p.id === state.profile.id;

  view.innerHTML = `
    <a class="back" href="#/admin/users">← All learners</a>
    <div class="row-between">
      <div><h1 class="page-title">${esc(p.full_name || p.email)}</h1>
        <p class="muted">${esc(p.email)} · ${p.role === 'admin' ? 'Admin' : 'Learner'} · ${p.active ? 'Active' : 'Disabled'} · added ${fmtDate(p.created_at)}</p></div>
    </div>
    <div id="prog">${loading}</div>
    <section class="card">
      <h2>Manage account</h2>
      <div class="manage">
        <form id="nameForm" class="inline-form"><label>Name<input name="full_name" value="${esc(p.full_name || '')}"></label><button class="btn">Save</button></form>
        <form id="pwForm" class="inline-form"><label>New password
          <span class="input-btn"><input name="pw" minlength="8" required placeholder="At least 8 characters"><button type="button" class="btn ghost sm" id="gen">Generate</button></span></label>
          <button class="btn">Set password</button></form>
      </div>
      <div class="btn-row danger-zone">
        ${self ? '' : `<button class="btn" id="toggleActive">${p.active ? 'Disable account' : 'Re-enable account'}</button>
        <button class="btn" id="toggleRole">${p.role === 'admin' ? 'Make learner' : 'Make admin'}</button>`}
        <button class="btn danger" id="reset">Reset progress</button>
      </div>
    </section>`;

  view.querySelector('#prog').innerHTML = await progressHTML(id);

  const update = async (patch, msg) => {
    try { check(await sb.from('profiles').update(patch).eq('id', id)); toast(msg, 'success'); renderAdminUser(id); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
  view.querySelector('#nameForm').onsubmit = (ev) => {
    ev.preventDefault();
    update({ full_name: ev.target.full_name.value.trim() || null }, 'Name saved.');
  };
  view.querySelector('#gen').onclick = () => { view.querySelector('#pwForm').pw.value = randomPassword(); };
  view.querySelector('#pwForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const pw = ev.target.pw.value;
    try { await adminAction({ action: 'set_password', user_id: id, password: pw }); }
    catch (e) { toast(errMsg(e), 'error'); return; }
    try { await navigator.clipboard.writeText(pw); toast('Password set and copied to clipboard.', 'success'); }
    catch { toast('Password set. Copy it from the box before leaving.', 'success'); }
  };
  const ta = view.querySelector('#toggleActive');
  if (ta) ta.onclick = () => update({ active: !p.active }, p.active ? 'Account disabled.' : 'Account re-enabled.');
  const tr = view.querySelector('#toggleRole');
  if (tr) tr.onclick = () => {
    if (confirm(p.role === 'admin' ? 'Remove admin rights?' : 'Give this person full admin rights?'))
      update({ role: p.role === 'admin' ? 'learner' : 'admin' }, 'Role updated.');
  };
  view.querySelector('#reset').onclick = async () => {
    if (!confirm(`Delete all practice history for ${p.full_name || p.email}? This can't be undone.`)) return;
    try { check(await sb.from('progress').delete().eq('user_id', id)); toast('Progress reset.', 'success'); renderAdminUser(id); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
}

// ---------------------------------------------------------------------------
// Admin: questions
// ---------------------------------------------------------------------------

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return { error: 'not a question object' };
  const category = String(raw.category ?? '').trim();
  const question = String(raw.question ?? '').trim();
  let options = Array.isArray(raw.options) ? raw.options.map((o) => String(o ?? '').trim()).filter(Boolean) : [];
  if (!category) return { error: 'missing "category"' };
  if (!question) return { error: 'missing "question"' };
  if (options.length < 2) return { error: 'needs at least 2 "options"' };
  if (options.length > LETTERS.length) return { error: `more than ${LETTERS.length} options` };
  // Strip "A) ", "b. ", "(C) " style prefixes if every option has one.
  const prefix = /^\(?[A-Ja-j][).:]\s+/;
  if (options.every((o) => prefix.test(o))) options = options.map((o) => o.replace(prefix, ''));

  let ci = -1;
  const ans = raw.answer;
  if (typeof ans === 'string' && /^\(?[A-Ja-j]\)?$/.test(ans.trim())) ci = ans.trim().replace(/[()]/g, '').toUpperCase().charCodeAt(0) - 65;
  else if (typeof ans === 'string' && ans.trim()) ci = options.findIndex((o) => o.toLowerCase() === ans.trim().toLowerCase());
  else if (Number.isInteger(raw.correct_index)) ci = raw.correct_index;
  if (ci < 0 || ci >= options.length) return { error: '"answer" must be a letter (A, B, …) or the exact text of one option' };

  const explanation = String(raw.explanation ?? '').trim() || null;
  return { category, question, options, correct_index: ci, explanation };
}

async function importQuestions(items, skipDuplicates) {
  const errors = [];
  const valid = [];
  items.forEach((raw, i) => {
    const r = normalizeItem(raw);
    if (r.error) errors.push(`Question ${i + 1}: ${r.error}`);
    else valid.push(r);
  });
  if (errors.length) return { errors };

  const cats = check(await sb.from('categories').select('id,name'));
  const catId = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]));
  const missing = [...new Set(valid.map((v) => v.category))].filter((n) => !catId.has(n.toLowerCase()));
  if (missing.length) {
    const created = check(await sb.from('categories').insert(missing.map((name) => ({ name }))).select('id,name'));
    created.forEach((c) => catId.set(c.name.toLowerCase(), c.id));
  }

  const key = (cid, text) => cid + '|' + text.toLowerCase().replace(/\s+/g, ' ').trim();
  const seen = new Set();
  if (skipDuplicates) {
    const existing = await fetchAll(() => sb.from('questions').select('category_id,question').order('id'));
    existing.forEach((q) => seen.add(key(q.category_id, q.question)));
  }
  const rows = [];
  let skipped = 0;
  for (const v of valid) {
    const cid = catId.get(v.category.toLowerCase());
    const k = key(cid, v.question);
    if (skipDuplicates && seen.has(k)) { skipped++; continue; }
    seen.add(k);
    rows.push({ category_id: cid, question: v.question, options: v.options, correct_index: v.correct_index, explanation: v.explanation });
  }
  for (let i = 0; i < rows.length; i += 500) check(await sb.from('questions').insert(rows.slice(i, i + 500)));
  return { inserted: rows.length, skipped, newCategories: missing.length };
}

async function renderAdminQuestions() {
  const view = shell('questions', loading);
  const [catsRes, qs] = await Promise.all([
    sb.from('categories').select('id,name').order('name'),
    fetchAll(() => sb.from('questions').select('id,category_id,question,options,correct_index,explanation,active').order('id')),
  ]);
  const cats = check(catsRes);
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const countBy = new Map();
  qs.forEach((q) => countBy.set(q.category_id, (countBy.get(q.category_id) || 0) + 1));
  const ui = state.qui || (state.qui = { filter: '', search: '', limit: 50 });

  view.innerHTML = `
    <div class="row-between"><h1 class="page-title">Questions</h1>
      <div class="btn-group"><button class="btn" id="exportBtn">Export JSON</button><button class="btn primary" id="newQ">+ New question</button></div></div>
    <div id="editor"></div>

    <div class="grid-2 top-align">
      <section class="card">
        <h2>Categories</h2>
        <ul class="cat-list">
          ${cats.map((c) => `<li><span>${esc(c.name)} <small class="muted">${countBy.get(c.id) || 0}</small></span>
            <span class="btn-group"><button class="btn ghost sm" data-rename="${c.id}">Rename</button><button class="btn ghost sm danger-text" data-delcat="${c.id}">Delete</button></span></li>`).join('') || '<li class="muted">No categories yet.</li>'}
        </ul>
        <form id="catForm" class="inline-form"><input name="name" placeholder="New category name" required><button class="btn">Add</button></form>
      </section>

      <section class="card">
        <h2>Bulk import</h2>
        <p class="muted small">Upload or paste a JSON list. Missing categories are created automatically.
          <a href="sample-questions.json" download>Download the sample format</a>.</p>
        <pre class="fmt">[{ "category": "Networking",
   "question": "Which port does HTTPS use?",
   "options": ["21", "80", "443", "8080"],
   "answer": "C",
   "explanation": "Optional" }]</pre>
        <input type="file" id="file" accept=".json,application/json">
        <textarea id="paste" rows="4" placeholder="…or paste JSON here"></textarea>
        <label class="check"><input type="checkbox" id="skipDup" checked> Skip questions that already exist</label>
        <button class="btn primary" id="importBtn">Import</button>
        <div id="importResult"></div>
      </section>
    </div>

    <section class="card">
      <div class="row-between wrap">
        <h2>All questions <small class="muted">${qs.length}</small></h2>
        <div class="filters">
          <select id="filter"><option value="">All categories</option>
            ${cats.map((c) => `<option value="${c.id}" ${String(ui.filter) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
          <input id="search" type="search" placeholder="Search" value="${esc(ui.search)}">
        </div>
      </div>
      <div id="qlist"></div>
    </section>`;

  // --- question list
  const listEl = view.querySelector('#qlist');
  const drawList = () => {
    const s = ui.search.toLowerCase();
    const shown = qs.filter((q) =>
      (!ui.filter || String(q.category_id) === String(ui.filter)) &&
      (!s || q.question.toLowerCase().includes(s) || q.options.some((o) => String(o).toLowerCase().includes(s))));
    listEl.innerHTML = shown.length ? `
      <ol class="qlist">
        ${shown.slice(0, ui.limit).map((q) => `
          <li class="${q.active ? '' : 'inactive'}">
            <div class="q-head"><span class="tag">${esc(catName.get(q.category_id) || '?')}</span>${q.active ? '' : '<span class="pill">hidden</span>'}</div>
            <p class="rq">${esc(q.question)}</p>
            <ul class="q-opts">${q.options.map((o, i) => `<li class="${i === q.correct_index ? 'ok' : ''}"><b>${LETTERS[i]}</b> ${esc(o)}</li>`).join('')}</ul>
            ${q.explanation ? `<p class="muted small">${esc(q.explanation)}</p>` : ''}
            <div class="btn-group">
              <button class="btn ghost sm" data-edit="${q.id}">Edit</button>
              <button class="btn ghost sm" data-toggle="${q.id}">${q.active ? 'Hide' : 'Show'}</button>
              <button class="btn ghost sm danger-text" data-del="${q.id}">Delete</button>
            </div>
          </li>`).join('')}
      </ol>
      ${shown.length > ui.limit ? `<button class="btn ghost wide" id="more">Show more (${shown.length - ui.limit} left)</button>` : ''}`
      : '<p class="muted">No questions match.</p>';
    const more = listEl.querySelector('#more');
    if (more) more.onclick = () => { ui.limit += 100; drawList(); };
  };
  drawList();
  view.querySelector('#filter').onchange = (e) => { ui.filter = e.target.value; ui.limit = 50; drawList(); };
  view.querySelector('#search').oninput = (e) => { ui.search = e.target.value; ui.limit = 50; drawList(); };

  listEl.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const qid = +(b.dataset.edit || b.dataset.toggle || b.dataset.del);
    const q = qs.find((x) => x.id === qid);
    if (!q) return;
    try {
      if (b.dataset.edit) openEditor(q);
      else if (b.dataset.toggle) {
        check(await sb.from('questions').update({ active: !q.active }).eq('id', qid));
        q.active = !q.active; drawList();
      } else if (b.dataset.del) {
        if (!confirm('Delete this question and everyone\'s progress on it?')) return;
        check(await sb.from('questions').delete().eq('id', qid));
        qs.splice(qs.indexOf(q), 1); toast('Deleted.', 'success'); drawList();
      }
    } catch (err) { toast(errMsg(err), 'error'); }
  };

  // --- editor (new + edit)
  const editorEl = view.querySelector('#editor');
  const openEditor = (q) => {
    if (!cats.length) { toast('Add a category first.', 'error'); return; }
    const isNew = !q;
    q = q || { category_id: ui.filter ? +ui.filter : cats[0].id, question: '', options: ['', '', '', ''], correct_index: 0, explanation: '' };
    editorEl.innerHTML = `
      <form class="card editor" id="qForm">
        <h2>${isNew ? 'New question' : 'Edit question'}</h2>
        <label>Category<select name="category_id">${cats.map((c) => `<option value="${c.id}" ${c.id === q.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></label>
        <label>Question<textarea name="question" rows="3" required>${esc(q.question)}</textarea></label>
        <label>Options <small class="muted">one per line</small><textarea name="options" rows="5" required>${esc(q.options.join('\n'))}</textarea></label>
        <label>Correct answer<select name="correct"></select></label>
        <label>Explanation <small class="muted">optional, shown after answering</small><textarea name="explanation" rows="2">${esc(q.explanation || '')}</textarea></label>
        <div class="btn-row"><button class="btn primary">Save</button><button type="button" class="btn ghost" id="cancelQ">Cancel</button></div>
      </form>`;
    const f = editorEl.querySelector('#qForm');
    const fillCorrect = () => {
      const opts = f.options.value.split('\n').map((s) => s.trim()).filter(Boolean);
      const cur = f.correct.value === '' ? q.correct_index : +f.correct.value;
      f.correct.innerHTML = opts.map((o, i) => `<option value="${i}" ${i === cur ? 'selected' : ''}>${LETTERS[i]}. ${esc(o.slice(0, 80))}</option>`).join('');
    };
    fillCorrect();
    f.options.oninput = fillCorrect;
    f.querySelector('#cancelQ').onclick = () => (editorEl.innerHTML = '');
    f.onsubmit = async (ev) => {
      ev.preventDefault();
      const options = f.options.value.split('\n').map((s) => s.trim()).filter(Boolean);
      if (options.length < 2) { toast('Add at least 2 options.', 'error'); return; }
      if (options.length > LETTERS.length) { toast(`Maximum ${LETTERS.length} options.`, 'error'); return; }
      const row = {
        category_id: +f.category_id.value,
        question: f.question.value.trim(),
        options,
        correct_index: Math.min(+f.correct.value || 0, options.length - 1),
        explanation: f.explanation.value.trim() || null,
      };
      try {
        if (isNew) check(await sb.from('questions').insert(row));
        else check(await sb.from('questions').update(row).eq('id', q.id));
        toast('Saved.', 'success');
        renderAdminQuestions();
      } catch (err) { toast(errMsg(err), 'error'); }
    };
    editorEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    f.question.focus({ preventScroll: true });
  };
  view.querySelector('#newQ').onclick = () => openEditor(null);

  // --- categories
  view.querySelector('#catForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const name = ev.target.name.value.trim();
    if (!name) return;
    try { check(await sb.from('categories').insert({ name })); renderAdminQuestions(); }
    catch (e) { toast(/duplicate|unique/i.test(errMsg(e)) ? 'That category already exists.' : errMsg(e), 'error'); }
  };
  view.querySelectorAll('[data-rename]').forEach((b) => (b.onclick = async () => {
    const id = +b.dataset.rename;
    const name = prompt('New name', catName.get(id));
    if (!name || !name.trim()) return;
    try { check(await sb.from('categories').update({ name: name.trim() }).eq('id', id)); renderAdminQuestions(); }
    catch (e) { toast(errMsg(e), 'error'); }
  }));
  view.querySelectorAll('[data-delcat]').forEach((b) => (b.onclick = async () => {
    const id = +b.dataset.delcat;
    const n = countBy.get(id) || 0;
    if (!confirm(`Delete "${catName.get(id)}"${n ? ` and its ${n} question(s), including everyone's progress on them` : ''}?`)) return;
    try { check(await sb.from('categories').delete().eq('id', id)); toast('Category deleted.', 'success'); renderAdminQuestions(); }
    catch (e) { toast(errMsg(e), 'error'); }
  }));

  // --- import
  const fileEl = view.querySelector('#file');
  const pasteEl = view.querySelector('#paste');
  fileEl.onchange = async () => { if (fileEl.files[0]) pasteEl.value = await fileEl.files[0].text(); };
  view.querySelector('#importBtn').onclick = async (ev) => {
    const out = view.querySelector('#importResult');
    let items;
    try {
      const parsed = JSON.parse(pasteEl.value);
      items = Array.isArray(parsed) ? parsed : parsed.questions;
      if (!Array.isArray(items) || !items.length) throw new Error('Expected a list of questions.');
    } catch (e) {
      out.innerHTML = `<p class="form-error">Couldn't read the JSON: ${esc(errMsg(e))}</p>`;
      return;
    }
    ev.target.disabled = true; ev.target.textContent = 'Importing…';
    try {
      const r = await importQuestions(items, view.querySelector('#skipDup').checked);
      if (r.errors) {
        out.innerHTML = `<div class="form-error"><p>Nothing imported. Fix these first:</p><ul>${r.errors.slice(0, 15).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${r.errors.length > 15 ? `<p>…and ${r.errors.length - 15} more.</p>` : ''}</div>`;
      } else {
        toast(`Imported ${r.inserted} question(s)${r.skipped ? `, skipped ${r.skipped} duplicate(s)` : ''}.`, 'success');
        renderAdminQuestions();
        return;
      }
    } catch (e) {
      out.innerHTML = `<p class="form-error">${esc(errMsg(e))}</p>`;
    }
    ev.target.disabled = false; ev.target.textContent = 'Import';
  };

  // --- export
  view.querySelector('#exportBtn').onclick = () => {
    const data = qs.map((q) => ({
      category: catName.get(q.category_id),
      question: q.question,
      options: q.options,
      answer: LETTERS[q.correct_index],
      explanation: q.explanation || undefined,
      ...(q.active ? {} : { hidden: true }),
    }));
    download(`questions-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2));
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function renderNotConfigured() {
  $app.innerHTML = `<div class="auth-wrap"><div class="card auth">
    <h1>Almost there</h1>
    <p>Open <code>config.js</code> and paste in your Supabase project URL and publishable (anon) key. The README walks through it.</p>
  </div></div>`;
}

(async () => {
  if (!configured) return renderNotConfigured();
  try {
    await loadProfile();
  } catch (e) {
    state.flash = errMsg(e);
  }
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      state.profile = null;
      state.run = null;
      document.getElementById('toasts').replaceChildren();
      setTimeout(() => (location.hash === '' || location.hash === '#/login' ? router() : (location.hash = '#/login')), 0);
    }
  });
  window.addEventListener('hashchange', router);
  window.addEventListener('unhandledrejection', (e) => toast(errMsg(e.reason), 'error'));
  router();
})();
