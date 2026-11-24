import { SUPABASE_URL, SUPABASE_ANON_KEY, APP_NAME, SHUFFLE_OPTIONS } from './config.js';

/* =========================================================================
   Setup & helpers
   ========================================================================= */

// Refuse to run inside another site's frame (clickjacking). GitHub Pages can't send the header for this.
if (window.top !== window.self) {
  document.body.innerHTML = '<p style="padding:24px;font:16px system-ui">This page can only be opened directly. <a href="' + location.href.replace(/"/g, '') + '" target="_top" rel="noopener">Open USMF Exam Prep</a></p>';
  throw new Error('Framed');
}
// Supabase JS is loaded by index.html as a pinned file with an integrity hash.
const createClient = window.supabase?.createClient;
if (!createClient) {
  document.getElementById('app').innerHTML = '<div class="boot">A required file could not be loaded. Check your connection and reload the page.</div>';
  throw new Error('supabase-js did not load');
}

const configured = !SUPABASE_URL.includes('YOUR-PROJECT') && !SUPABASE_ANON_KEY.startsWith('YOUR-');
const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const $app = document.getElementById('app');
const LETTERS = 'ABCDEFGHIJ';
const state = { profile: null, meta: null, run: null, exam: null, examResult: null, drafts: null, flash: '', timer: null };
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
const practiceKey = () => 'mcq-practice-draft:' + (state.profile ? state.profile.id : '');

/* ---------------------------------------------------------------
   Unfinished tests live in the database (table test_drafts): one
   'practice' and one 'exam' per learner, so they can be continued on
   any device. Writes per kind are queued so the latest one always wins.
   Drafts saved on a device by the earlier version are moved up once.
---------------------------------------------------------------- */
const LOCAL_DRAFT = { practice: practiceKey, exam: draftKey };
const draftQ = {};
async function loadDrafts(force = false) {
  if (state.drafts && !force) return state.drafts;
  const { data, error } = await sb.from('test_drafts').select('kind,session_id,state');
  const drafts = {};
  if (error) { if (!missingInDb(error)) console.warn(error); }
  else (data || []).forEach((r) => { drafts[r.kind] = { ...r.state, sessionId: r.session_id }; });
  for (const kind of Object.keys(draftQ)) {                 // a save still on its way: trust what this tab has
    if (draftQ[kind].busy && state.drafts) { if (state.drafts[kind]) drafts[kind] = state.drafts[kind]; else delete drafts[kind]; }
  }
  state.drafts = drafts;
  if (error) return state.drafts;
  for (const kind of Object.keys(LOCAL_DRAFT)) {           // one-time move from this device
    const local = store.get(LOCAL_DRAFT[kind]());
    if (!local) continue;
    store.del(LOCAL_DRAFT[kind]());
    if (!drafts[kind] && local.sessionId && Array.isArray(local.items)) putDraft(kind, local);
  }
  return state.drafts;
}
function putDraft(kind, d) {
  if (!state.profile) return;
  state.drafts = state.drafts || {};
  state.drafts[kind] = d;
  const q = (draftQ[kind] = draftQ[kind] || { busy: false, next: undefined, last: '' });
  const json = d ? JSON.stringify(d) : '';
  if (json === q.last && q.next === undefined) return;      // nothing changed
  q.next = d;
  if (q.busy) return;
  q.busy = true;
  (async () => {
    while (q.next !== undefined) {
      const cur = q.next; q.next = undefined;
      const uid = state.profile?.id; if (!uid) break;
      const { error } = cur
        ? await sb.from('test_drafts').upsert({ user_id: uid, kind, session_id: cur.sessionId, state: cur, updated_at: new Date().toISOString() }, { onConflict: 'user_id,kind' })
        : await sb.from('test_drafts').delete().eq('user_id', uid).eq('kind', kind);
      if (error) { if (!missingInDb(error)) console.warn('Draft not saved', error); q.last = ''; }
      else q.last = cur ? JSON.stringify(cur) : '';
    }
    q.busy = false;
  })();
}
const dropDraft = (kind) => putDraft(kind, null);
function download(filename, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Lucide-style SVG icons (one stroke style everywhere, no emoji) */
const ICONS = {
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/><path d="M8.5 11h7M8.5 14.5h4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
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
  const refuse = async (msg) => { state.flash = msg; SEC.leaving = true; await sb.auth.signOut({ scope: 'local' }); throw new Error(msg); };
  if (!profile) await refuse('No profile found for this account. Ask your admin to add you.');
  if (!profile.active) await refuse('This account has been deactivated. Contact your admin.');
  state.profile = profile;
  return profile;
}

/* =========================================================================
   Session security: one device at a time, idle timeout, session length,
   new-country block. Enforced in the database (migration 004); the app
   registers each sign-in, sends a heartbeat, and explains sign-outs.
   ========================================================================= */

const SEC = { enabled: null, exempt: false, idle: 0, max: 0, lastActivity: Date.now(), lastBeat: 0, beatTimer: null, idleTimer: null, warnEl: null, leaving: false };

function deviceLabel() {
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'ChromeOS' : /Linux/.test(ua) ? 'Linux' : 'unknown OS';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} on ${os}`;
}
const missingInDb = (e) => !!e && (e.code === 'PGRST202' || e.code === 'PGRST205' || e.code === '42P01' || /Could not find the (function|table)/i.test(e.message || ''));

/** "MD, SA" → "Moldova and Saudi Arabia" */
const countryName = (c) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(c) || c; } catch { return c; } };
const countryList = (list) => { const n = (list || []).map(countryName); return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}` : n[0] || ''; };
function secMessage(r) {
  switch (r.reason || r.state) {
    case 'replaced': return 'You were signed out because your account was signed in on another device. Each account can be used on one device at a time.';
    case 'admin': return 'Your admin signed you out of all devices.';
    case 'idle': return `You were signed out after ${r.idle_minutes || SEC.idle} minutes without activity.`;
    case 'expired': return `For security, a sign-in lasts ${r.max_session_hours || SEC.max} hours. Please sign in again.`;
    case 'country': return `USMF Exam Prep can only be used from ${countryList(r.allowed) || 'the allowed countries'}. ${r.country && r.country !== 'unknown' ? `Your connection appears to come from ${countryName(r.country)}.` : 'We could not tell which country your connection comes from.'} If you use a VPN, turn it off and sign in again.`;
    case 'location': return `This sign-in was blocked because your account was used from another country${r.previous ? ` (${r.previous})` : ''} in the last ${r.hours} hours. If this was you, ask your admin to allow it.`;
    default: return 'Your session has ended. Please sign in again.';
  }
}
function applySec(d) {
  if (!d) return;
  SEC.enabled = true; SEC.idle = d.idle_minutes || 0; SEC.max = d.max_session_hours || 0;
  if (d.state) SEC.exempt = d.state === 'exempt';
}

/** Register this sign-in with the database. Returns { ok, reason, ... }. */
async function claimSession() {
  const { data, error } = await sb.rpc('claim_session', { p_device: deviceLabel() });
  if (error) { if (missingInDb(error)) { SEC.enabled = false; return { ok: true }; } throw error; }
  applySec(data); SEC.lastBeat = Date.now();
  return data;
}

/** Check this device's session (and record activity). Signs out with a reason if it has ended. */
async function heartbeat(touch = false, force = false) {
  if (!state.profile || SEC.leaving) return true;
  // Security not in the database yet: look again every 5 minutes (or when a save fails),
  // so open tabs pick it up as soon as it's switched on.
  if (SEC.enabled === false && !force && Date.now() - SEC.lastBeat < 300000) return true;
  const { data, error } = await sb.rpc('session_heartbeat', { p_touch: touch });
  if (error) { if (missingInDb(error)) { SEC.enabled = false; SEC.lastBeat = Date.now(); } else console.warn(error); return true; } // network blip: keep going
  SEC.lastBeat = Date.now();
  applySec(data);
  if (data.state === 'ok' || data.state === 'exempt') return true;
  if (data.state === 'none') {
    const r = await claimSession().catch(() => ({ ok: true }));
    if (r.ok) return true;
    await forceSignOut(secMessage(r)); return false;
  }
  await forceSignOut(secMessage(data));
  return false;
}

async function forceSignOut(msg) {
  if (SEC.leaving) return;
  SEC.leaving = true; state.flash = msg;
  stopSecurityTimers();
  await sb.auth.signOut({ scope: 'local' });
  state.profile = null; // covers page start, before the sign-out listener is attached
}
async function signOutNow() {
  SEC.leaving = true;
  if (SEC.enabled) await sb.rpc('end_my_session').then(() => {}, () => {});
  await sb.auth.signOut({ scope: 'local' });
}

function startSecurityTimers() {
  stopSecurityTimers();
  SEC.leaving = false; SEC.lastActivity = Date.now();
  SEC.beatTimer = setInterval(() => { if (!document.hidden) heartbeat(SEC.lastActivity > SEC.lastBeat); }, 60000);
  SEC.idleTimer = setInterval(checkIdle, 10000);
}
function stopSecurityTimers() { clearInterval(SEC.beatTimer); clearInterval(SEC.idleTimer); hideIdleWarning(); }

function checkIdle() {
  if (!SEC.enabled || SEC.exempt || !SEC.idle || !state.profile || SEC.leaving) return;
  const idleMs = Date.now() - SEC.lastActivity; const limit = SEC.idle * 60000;
  if (idleMs >= limit) { forceSignOut(secMessage({ reason: 'idle' })); return; }
  if (idleMs >= limit - 60000) showIdleWarning(Math.ceil((limit - idleMs) / 1000));
}
function showIdleWarning(secs) {
  if (!SEC.warnEl) {
    SEC.warnEl = document.createElement('div');
    SEC.warnEl.className = 'idle-warn'; SEC.warnEl.setAttribute('role', 'alertdialog'); SEC.warnEl.setAttribute('aria-live', 'assertive');
    SEC.warnEl.innerHTML = `${icon('clock')}<span></span><button class="btn primary sm" type="button">Stay signed in</button>`;
    SEC.warnEl.querySelector('button').onclick = () => { SEC.lastActivity = Date.now(); hideIdleWarning(); heartbeat(true); };
    document.body.appendChild(SEC.warnEl);
  }
  SEC.warnEl.querySelector('span').textContent = `You'll be signed out in about ${secs} seconds because there's been no activity.`;
}
function hideIdleWarning() { if (SEC.warnEl) { SEC.warnEl.remove(); SEC.warnEl = null; } }

['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => window.addEventListener(ev, (e) => {
  SEC.lastActivity = Date.now();
  if (SEC.warnEl && !SEC.warnEl.contains(e.target)) hideIdleWarning();
}, { passive: true, capture: true }));
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.profile) { checkIdle(); heartbeat(false); } });

/* =========================================================================
   Question sets: separate question banks. Learners see the sets the admin gave them;
   admins see every set. Everything else (topics, tests, mocks, progress) follows the
   set chosen in the bar under the header.
   ========================================================================= */
const USMF_SET = 1;
const setKey = () => `mcq-set-${state.profile?.id}`;
async function loadSets(force = false) {
  if (state.sets && !force) return state.sets;
  const { data, error } = await sb.from('question_sets').select('id,name,sort').order('sort').order('id');
  if (error) { if (!missingInDb(error)) throw error; state.sets = [{ id: USMF_SET, name: 'USMF Final 2026' }]; }
  else state.sets = data;
  if (!state.sets.some((x) => x.id === state.setId)) {
    const saved = store.get(setKey());
    state.setId = state.sets.some((x) => x.id === saved) ? saved : state.sets[0]?.id ?? null;
  }
  return state.sets;
}
/** The exam countdown is for USMF Final 2026 learners only (admins see every set). */
const hasUsmf = () => !!state.sets?.some((x) => x.id === USMF_SET);
const currentSet = () => state.sets?.find((x) => x.id === state.setId) || null;
function switchSet(id) {
  if (id === state.setId) return;
  state.setId = id; store.set(setKey(), id);
  state.meta = null; state.pool = null;
  toast(`Switched to ${currentSet()?.name || 'question set'}.`, 'ok');
  if (location.hash === '#/home' || !location.hash) router(); else location.hash = '#/home';
}
function setBar() {
  if (!state.sets || state.sets.length < 2) return '';
  return `<div class="setbar"><label>${icon('book')}<span>Question set</span>
    <select id="setPick" aria-label="Question set">${state.sets.map((x) => `<option value="${x.id}" ${x.id === state.setId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label></div>`;
}
function renderNoSets() {
  const view = shell('home', '');
  view.innerHTML = `<div class="card empty">${icon('book')}<h2>No question sets yet</h2>
    <p class="muted">The admin hasn't given your account access to a question set yet. Please ask them to add you, then reload this page.</p>
    <a class="btn" href="#/feedback">${icon('chat')}Message the admin</a></div>`;
}

/** Disciplines, topics and question counts of the current set (cached until something changes). */
async function loadMeta(force = false) {
  if (state.meta && !force && state.meta.setId === state.setId) return state.meta;
  const [d, c, counts] = await Promise.all([
    sb.from('disciplines').select('id,name,profile,weight,sort').eq('set_id', state.setId).order('sort'),
    sb.from('categories').select('id,name,discipline_id').eq('set_id', state.setId).order('name'),
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
  state.meta = { disciplines, topics, totals, discById, topicById, orphans, setId: state.setId };
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
/* Mock exams from 22 Nov 2026 carry partial marks (sessions.points); older
   sessions have points = null and are scored as whole questions right. */
const markFor = (q, sel) => {
  const key = new Set(q.correct); const picked = [...sel];
  if (q.qtype !== 'CM') return sameSet(picked, q.correct) ? 1 : 0;
  const hits = picked.filter((i) => key.has(i)).length; const wrong = picked.length - hits;
  return (hits - wrong) / Math.max(key.size, 1);
};
const fmtMark = (m) => (Math.round(m * 100) / 100).toString();
const sessPct = (s) => (s.points != null && s.answered ? Math.round((100 * Number(s.points)) / s.answered) : pctNum(s.correct, s.answered));
const sessScore = (s) => (s.points != null ? `${fmtMark(Number(s.points))}/${s.answered} marks` : `${s.correct}/${s.answered}`);
/* Mock exam final mark out of 10: same marks as above, divided by the number of
   questions in the paper and scaled to 10 (never below 0). */
const out10 = (marks, n) => Math.max(0, Math.round((1000 * marks) / Math.max(n, 1)) / 100);
const fmt10 = (v) => v.toFixed(2);
const sess10 = (s) => out10(s.points != null ? Number(s.points) : s.correct, s.total || s.answered);

async function sessionsFor(userId) {
  const cols = 'id,mode,label,total,answered,correct,points,started_at,finished_at';
  const r = await sb.from('sessions').select(cols + ',details_cleared').eq('user_id', userId).eq('set_id', state.setId).gt('answered', 0).order('started_at').limit(500);
  if (!r.error || !missingInDb(r.error)) return check(r);
  return check(await sb.from('sessions').select(cols)
    .eq('user_id', userId).gt('answered', 0).order('started_at').limit(500));
}

/* =========================================================================
   Security notice: everyone accepts it once (again if NOTICE_VERSION goes up)
   ========================================================================= */

const NOTICE_VERSION = 1;
const NOTICE_DATE = '16 November 2026';
const NOTICE_ISSUER = 'ANYMS';
const needsNotice = () => !!state.profile && 'notice_version' in state.profile && (state.profile.notice_version || 0) < NOTICE_VERSION;

function noticeItems(r) {
  const items = [
    ['user', 'Your account is personal', 'Do not share your email or password, and do not let anyone else use your account.'],
  ];
  if (r.one_device) items.push(['shield', 'One device at a time', 'Signing in on another device signs you out everywhere else.']);
  if (r.idle_minutes || r.max_session_hours) items.push(['clock', 'Automatic sign-out', [
    r.idle_minutes ? `You are signed out after ${r.idle_minutes} minutes without activity.` : '',
    r.max_session_hours ? `You need to sign in again every ${r.max_session_hours} hours.` : '',
    'Unfinished mock exams are kept.'].filter(Boolean).join(' ')]);
  if (r.geo_countries?.length) items.push(['alert', 'Where you can use the app', `The app can only be used from ${countryList(r.geo_countries)}. Sign-ins and activity from other countries, or through a VPN that hides your country, are blocked.`]);
  if (r.country_lock_hours) items.push(['alert', 'Location check', `A sign-in from a different country within ${r.country_lock_hours} hours of your last sign-in is blocked. If you travel, ask the admin to allow it.`]);
  items.push(
    ['shield', 'Device check', 'With your permission, the app recognises the devices you use (browser, system, screen, hardware and a device fingerprint) and saves a cookie with a random device ID. Only the admin can see this.'],
    ['eye', 'What is recorded', 'For each sign-in we record the time, your device and browser, your approximate country and your IP address. This is used only to protect accounts, is visible only to the admin, and is deleted after 90 days. Your answers and progress are also visible to the admin.'],
    ['x', 'If an account is shared', 'Accounts that show signs of sharing may be signed out or deactivated.'],
    ['book', 'Question content', 'The questions are for your personal study. Do not copy, sell or redistribute them.'],
  );
  return items;
}

/* =========================================================================
   Device check & cookies: everyone consents once (again if the version goes up).
   Required to use the app. The device details help the admin spot shared accounts.
   ========================================================================= */
const DEVICE_CONSENT_VERSION = 1;
const needsDeviceConsent = () => !!state.profile && 'device_consent_version' in state.profile && (state.profile.device_consent_version || 0) < DEVICE_CONSENT_VERSION;
const getCookie = (n) => (document.cookie.split('; ').find((c) => c.startsWith(n + '=')) || '').split('=').slice(1).join('=') || null;
const setCookie = (n, v) => { document.cookie = `${n}=${v}; Max-Age=31536000; Path=/; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`; };
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));

async function deviceDetails() {
  const n = navigator; const scr = window.screen || {};
  let gpu = null, canvas = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (gl) gpu = ext ? `${gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)} · ${gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)}` : gl.getParameter(gl.RENDERER);
  } catch { /* not available */ }
  try {
    const c = document.createElement('canvas'); c.width = 220; c.height = 40; const x = c.getContext('2d');
    x.textBaseline = 'top'; x.font = '16px Arial'; x.fillStyle = '#0e7490'; x.fillRect(0, 0, 220, 40); x.fillStyle = '#fbbf24'; x.fillText('USMF exam prep ✓ 2026', 4, 10);
    canvas = (await sha256(c.toDataURL())).slice(0, 16);
  } catch { /* blocked */ }
  let hi = {};
  try { if (n.userAgentData?.getHighEntropyValues) hi = await n.userAgentData.getHighEntropyValues(['platformVersion', 'model', 'architecture', 'bitness', 'fullVersionList']); } catch { /* refused */ }
  const d = {
    browser_os: deviceLabel(), user_agent: n.userAgent, platform: n.userAgentData?.platform || n.platform || null,
    mobile: n.userAgentData ? n.userAgentData.mobile : /Mobi|Android|iPhone|iPad/i.test(n.userAgent),
    model: hi.model || null, os_version: hi.platformVersion || null, architecture: [hi.architecture, hi.bitness].filter(Boolean).join(' ') || null,
    browser_versions: hi.fullVersionList ? hi.fullVersionList.map((b) => `${b.brand} ${b.version}`).join(', ') : null,
    screen: `${scr.width}×${scr.height}`, pixel_ratio: window.devicePixelRatio || 1, colour_depth: scr.colorDepth || null,
    languages: (n.languages || [n.language]).join(', '), time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || null,
    cpu_cores: n.hardwareConcurrency || null, memory_gb: n.deviceMemory || null, touch_points: n.maxTouchPoints || 0,
    gpu, canvas, cookies_enabled: n.cookieEnabled, do_not_track: n.doNotTrack || null,
    connection: n.connection?.effectiveType || null, installed_app: window.matchMedia?.('(display-mode: standalone)').matches || false,
  };
  // The fingerprint uses only things that stay the same on this device (not the cookie, so clearing it doesn't change it).
  const stable = [d.user_agent, d.platform, d.model, d.os_version, d.architecture, d.screen, d.pixel_ratio, d.colour_depth, d.languages, d.time_zone, d.cpu_cores, d.memory_gb, d.touch_points, d.gpu, d.canvas].join('|');
  return { details: d, fingerprint: await sha256(stable) };
}
/** Everything the app finds stored in this browser for the site. Sign-in tokens and keys are hidden. */
function storageSnapshot() {
  const out = []; let size = 0;
  const hide = (name, value) => /auth|token|secret|password|api.?key|session/i.test(name) || /(^|[^A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\./.test(value);
  const add = (area, name, value) => {
    value = String(value ?? '');
    const v = hide(name, value) ? '[hidden]' : value.length > 300 ? value.slice(0, 300) + '…' : value;
    size += name.length + v.length; if (size > 20000) return;
    out.push({ area, name: name.slice(0, 120), value: v });
  };
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); add('localStorage', k, localStorage.getItem(k)); } } catch { /* blocked */ }
  try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); add('sessionStorage', k, sessionStorage.getItem(k)); } } catch { /* blocked */ }
  for (const c of document.cookie ? document.cookie.split('; ') : []) { const i = c.indexOf('='); add('cookie', c.slice(0, i), decodeURIComponent(c.slice(i + 1))); }
  return out;
}
let deviceRecorded = false;
async function recordDevice(force = false) {
  if ((deviceRecorded && !force) || !state.profile || needsDeviceConsent()) return;
  deviceRecorded = true;
  try {
    let id = getCookie('usmf_device');
    if (!/^[0-9a-f-]{36}$/.test(id || '')) { id = crypto.randomUUID(); setCookie('usmf_device', id); }
    const { details, fingerprint } = await deviceDetails();
    details.device_cookie = id;
    const { error } = await sb.rpc('record_device', { p_fingerprint: fingerprint, p_device_id: id, p_label: deviceLabel(), p_details: details, p_storage: storageSnapshot() });
    if (error && !missingInDb(error)) console.warn(error);
  } catch (e) { console.warn(e); }
}

function renderDeviceConsent() {
  const first = (state.profile.full_name || '').split(' ')[0];
  const items = [
    ['shield', 'Why we ask', 'To keep accounts personal, the app recognises the devices you use it on. This helps the admin spot an account being shared.'],
    ['user', 'What is collected from your device', 'Your browser and operating system, device model, screen size, language, time zone, number of processor cores and memory, graphics card, and a device fingerprint built from these. We also record the approximate country and IP address of each visit.'],
    ['book', 'Cookies and stored data', 'The app saves a cookie with a random device ID, and keeps your settings in the browser. The admin can see what the app stores on your device. Your password and sign-in details are always hidden.'],
    ['eye', 'Who can see it', 'Only the admin. It is used only for account security and is deleted 90 days after you last use a device.'],
    ['alert', 'Required', 'The device check is part of account security, so it is needed to use USMF Exam Prep. If you don\'t accept, you will be signed out.'],
  ];
  $app.innerHTML = `
    <main class="auth-wrap" id="view" tabindex="-1">
      <form class="card notice" id="devForm" aria-labelledby="dt" novalidate>
        <div class="brand"><span class="mark">${icon('shield')}</span>${esc(APP_NAME)}</div>
        <h1 id="dt">Device check and cookies</h1>
        <p class="muted">${first ? `${esc(first)}, before` : 'Before'} you continue, we need your permission to recognise this device and to use cookies.</p>
        <ol class="notice-list">${items.map(([ic, t, d]) => `<li>${icon(ic)}<div><b>${t}</b><p>${esc(d)}</p></div></li>`).join('')}</ol>
        <p class="signed"><span>Issued by <b>${esc(NOTICE_ISSUER)}</b></span><span>Version ${DEVICE_CONSENT_VERSION}</span></p>
        <label class="choice"><input type="checkbox" id="devAgree"><span><b>I allow the device check and cookies</b><small>Your choice is recorded with the date and time.</small></span></label>
        <div class="btn-row">
          <button class="btn primary lg" type="submit" id="devAccept" disabled>Allow and continue ${icon('right')}</button>
          <button class="btn ghost" type="button" id="devDecline">${icon('logout')}Don't allow and sign out</button>
        </div>
        <p class="form-error" id="devErr" role="alert"></p>
      </form>
    </main>`;
  const f = document.getElementById('devForm'); const agree = f.querySelector('#devAgree'); const btn = f.querySelector('#devAccept');
  agree.onchange = () => { btn.disabled = !agree.checked; };
  f.querySelector('#devDecline').onclick = async () => { state.flash = 'You need to allow the device check and cookies to use USMF Exam Prep. You can sign in again at any time and allow it.'; await signOutNow();
    if (state.profile) { state.profile = null; if (location.hash === '#/login') router(); else location.hash = '#/login'; } };
  document.getElementById('view').focus({ preventScroll: true });
  f.onsubmit = async (ev) => {
    ev.preventDefault(); if (!agree.checked) return;
    btn.disabled = true; btn.textContent = 'Saving…';
    const { error } = await sb.rpc('accept_device_consent', { p_version: DEVICE_CONSENT_VERSION });
    if (error) { f.querySelector('#devErr').textContent = errMsg(error); btn.disabled = false; btn.innerHTML = `Allow and continue ${icon('right')}`; return; }
    state.profile.device_consent_version = DEVICE_CONSENT_VERSION; state.profile.device_consent_at = new Date().toISOString();
    setCookie('usmf_consent', String(DEVICE_CONSENT_VERSION));
    await recordDevice(true);
    if (!location.hash || location.hash === '#/login') location.hash = '#/home'; else router();
  };
}

/* =========================================================================
   Two-step sign-in (authenticator app) for admins.
   Admins without an authenticator must set one up at sign-in; admins with one
   enter a 6-digit code. The database refuses admin powers without it (aal2).
   ========================================================================= */
const MFA_ISSUER = 'USMF Exam Prep';
async function mfaFactors() {
  const { data, error } = await sb.auth.mfa.listFactors();
  if (error) throw error;
  return { verified: (data.totp || []).filter((f) => f.status === 'verified'), all: data.all || [] };
}
/** Returns true when it has drawn a screen (setup or code) and the router should stop. */
async function adminMfaGate() {
  if (state.profile.role !== 'admin' || state.mfaOk) return false;
  const { data, error } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) { console.warn(error); state.mfaOk = true; return false; } // the database still enforces it
  if (data.currentLevel === 'aal2') { state.mfaOk = true; return false; }
  if (data.nextLevel === 'aal2') { renderMfaCode(); return true; }
  renderMfaSetup({ compulsory: true }); return true;
}
const codeField = `<label class="field">6-digit code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="9" required class="otp" placeholder="123456"></label>`;
const cleanCode = (v) => String(v || '').replace(/\D/g, '').slice(0, 6);

async function renderMfaCode() {
  let factors = [];
  try { factors = (await mfaFactors()).verified; } catch (e) { console.warn(e); }
  $app.innerHTML = `
    <main class="auth-wrap" id="view" tabindex="-1">
      <form class="card auth" id="mfaForm" novalidate>
        <div class="brand"><span class="mark">${icon('shield')}</span>${esc(APP_NAME)}</div>
        <h1>Enter your code</h1>
        <p class="muted">Open your authenticator app (for example Google Authenticator) and type the 6-digit code for ${esc(MFA_ISSUER)}.</p>
        ${factors.length > 1 ? `<label class="field">Authenticator<select name="factor">${factors.map((f) => `<option value="${esc(f.id)}">${esc(f.friendly_name || 'Authenticator')}</option>`).join('')}</select></label>` : ''}
        ${codeField}
        <button class="btn primary lg" type="submit">${icon('check')}Verify</button>
        <button class="btn ghost" type="button" id="mfaOut">${icon('logout')}Sign out</button>
        <p class="form-error" id="mfaErr" role="alert"></p>
        <p class="muted small">Lost your phone? Use your backup authenticator if you added one. Otherwise the authenticator can be reset in the Supabase dashboard.</p>
      </form>
    </main>`;
  const f = document.getElementById('mfaForm'); f.code.focus();
  f.querySelector('#mfaOut').onclick = () => signOutNow();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const code = cleanCode(f.code.value); const err = f.querySelector('#mfaErr');
    if (code.length !== 6) { err.textContent = 'Type the 6 digits from your authenticator app.'; f.code.focus(); return; }
    const factorId = f.factor ? f.factor.value : factors[0]?.id;
    if (!factorId) { err.textContent = 'No authenticator found on this account. Sign out and in again.'; return; }
    const btn = f.querySelector('[type=submit]'); btn.disabled = true;
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId, code });
    if (error) { btn.disabled = false; f.code.value = ''; f.code.focus(); err.textContent = /invalid|expired/i.test(error.message) ? 'That code is wrong or has expired. Wait for the next code and try again.' : error.message; return; }
    state.mfaOk = true; reportCache.at = 0;
    if (!location.hash || location.hash === '#/login') location.hash = '#/home'; else router();
  };
}

/** Set up an authenticator. compulsory = the first one at sign-in; otherwise a backup from Account. */
async function renderMfaSetup({ compulsory = false } = {}) {
  const host = compulsory ? $app : shell('account', loading);
  try {
    for (const f of (await mfaFactors()).all.filter((x) => x.status !== 'verified')) await sb.auth.mfa.unenroll({ factorId: f.id });
  } catch (e) { console.warn(e); }
  const name = `${compulsory ? 'Authenticator' : 'Backup'} ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const { data, error } = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: name, issuer: MFA_ISSUER });
  const body = error ? `<p class="form-error">${esc(errMsg(error))}</p>` : `
        <ol class="mfa-steps">
          <li><b>Install an authenticator app</b> on your phone, such as Google Authenticator or Microsoft Authenticator.</li>
          <li><b>Scan this QR code</b> with the app (tap + then Scan a QR code).
            <div class="qr"><img src="${esc(data.totp.qr_code)}" alt="QR code to add ${esc(MFA_ISSUER)} to your authenticator app" width="200" height="200"></div>
            <details><summary class="small">Can't scan? Enter this key instead</summary><p class="mono secret">${esc(data.totp.secret.replace(/(.{4})/g, '$1 ').trim())}</p></details></li>
          <li><b>Type the 6-digit code</b> the app now shows for ${esc(MFA_ISSUER)}.</li>
        </ol>
        ${codeField}
        <div class="btn-row"><button class="btn primary" type="submit">${icon('check')}Turn on two-step sign-in</button>
          ${compulsory ? `<button class="btn ghost" type="button" id="mfaOut">${icon('logout')}Sign out</button>` : '<a class="btn ghost" href="#/account">Cancel</a>'}</div>
        <p class="form-error" id="mfaErr" role="alert"></p>`;
  const html = `<form class="card ${compulsory ? 'notice' : ''}" id="mfaSetup" novalidate>
        ${compulsory ? `<div class="brand"><span class="mark">${icon('shield')}</span>${esc(APP_NAME)}</div>` : ''}
        <h1>${compulsory ? 'Set up two-step sign-in' : 'Add a backup authenticator'}</h1>
        <p class="muted">${compulsory ? 'Admin accounts now need a code from an authenticator app at every sign-in. Set it up once to continue.' : 'Add the same account to a second phone or a password manager, so you can still sign in if you lose your main phone.'}</p>
        ${body}
      </form>`;
  if (compulsory) host.innerHTML = `<main class="auth-wrap" id="view" tabindex="-1">${html}</main>`; else host.innerHTML = html;
  const f = document.getElementById('mfaSetup');
  f.querySelector('#mfaOut')?.addEventListener('click', () => signOutNow());
  if (error) return;
  f.code.focus();
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const code = cleanCode(f.code.value); const err = f.querySelector('#mfaErr');
    if (code.length !== 6) { err.textContent = 'Type the 6 digits from your authenticator app.'; f.code.focus(); return; }
    const btn = f.querySelector('[type=submit]'); btn.disabled = true;
    const { error: e2 } = await sb.auth.mfa.challengeAndVerify({ factorId: data.id, code });
    if (e2) { btn.disabled = false; f.code.value = ''; err.textContent = /invalid|expired/i.test(e2.message) ? 'That code is wrong or has expired. Check the app and try the new code.' : e2.message; return; }
    state.mfaOk = true; reportCache.at = 0;
    toast(compulsory ? 'Two-step sign-in is on. You will be asked for a code at every sign-in.' : 'Backup authenticator added.', 'ok');
    if (compulsory) { if (!location.hash || location.hash === '#/login') location.hash = '#/home'; else router(); } else location.hash = '#/account';
  };
}

/** Unread notices, shown before the app. Each needs Got it; the app opens once all are acknowledged. */
function renderNoticeGate(list) {
  const first = (state.profile.full_name || '').split(' ')[0];
  const left = () => $app.querySelectorAll('.gate-notice:not(.done)').length;
  $app.innerHTML = `
    <main class="auth-wrap gate" id="view" tabindex="-1">
      <div class="card notice">
        <div class="brand"><span class="mark">${icon('bell')}</span>${esc(APP_NAME)}</div>
        <h1>New notices</h1>
        <p class="muted">${first ? `${esc(first)}, please` : 'Please'} read ${list.length === 1 ? 'this notice' : `these ${list.length} notices`} and press <b>Got it</b> on each to continue to your practice and mock exams.</p>
        <p class="chip warn" id="gateLeft" role="status">${list.length} to read</p>
        <ol class="gate-list">${list.map((u) => `<li class="gate-notice" data-id="${esc(u.id)}">
          <h2>${esc(u.title)}</h2>${noticeBody(u)}
          <div class="row-between"><span class="muted small">Issued by <b>${esc(u.issuer || NOTICE_ISSUER)}</b> · ${esc(longDate(u.show_from))}</span>
            <button class="btn primary sm" type="button" data-ack="${esc(u.id)}">${icon('check')}Got it</button></div></li>`).join('')}</ol>
        <div class="btn-row">
          ${list.length > 1 ? `<button class="btn primary" type="button" id="ackAll">${icon('check')}I have read all of them</button>` : ''}
          <button class="btn ghost" type="button" id="gateOut">${icon('logout')}Sign out</button>
        </div>
        <p class="form-error" id="gateErr" role="alert"></p>
      </div>
    </main>`;
  document.getElementById('view').focus({ preventScroll: true });
  const save = async (ids) => {
    const { error } = await sb.from('notice_reads').upsert(ids.map((id) => ({ announcement_id: id, user_id: state.profile.id })), { onConflict: 'announcement_id,user_id', ignoreDuplicates: true });
    if (error && !missingInDb(error)) throw error;
    const seen = store.get(updatesKey()) || []; ids.forEach((id) => { if (!seen.includes(id)) seen.push(id); state.noticeReads?.add(id); }); store.set(updatesKey(), seen);
    ids.forEach((id) => { const li = $app.querySelector(`.gate-notice[data-id="${CSS.escape(id)}"]`); if (li) { li.classList.add('done'); const b = li.querySelector('[data-ack]'); b.disabled = true; b.innerHTML = `${icon('check')}Acknowledged`; } });
    const n = left(); const lab = $app.querySelector('#gateLeft');
    if (lab) lab.textContent = n ? `${n} to read` : 'All read';
    if (!n) { state.noticesOk = true; bellCache.at = 0; if (!location.hash || location.hash === '#/login') location.hash = '#/home'; else router(); }
  };
  const fail = (e) => { $app.querySelector('#gateErr').textContent = errMsg(e); };
  $app.querySelectorAll('[data-ack]').forEach((b) => (b.onclick = () => { b.disabled = true; save([b.dataset.ack]).catch((e) => { b.disabled = false; fail(e); }); }));
  const all = $app.querySelector('#ackAll');
  if (all) all.onclick = () => { all.disabled = true; save([...$app.querySelectorAll('.gate-notice:not(.done)')].map((li) => li.dataset.id)).catch((e) => { all.disabled = false; fail(e); }); };
  $app.querySelector('#gateOut').onclick = () => signOutNow();
}

async function renderNotice() {
  const { data } = await sb.rpc('security_summary');
  const r = data || { one_device: true, idle_minutes: SEC.idle, max_session_hours: SEC.max, country_lock_hours: 0 };
  const first = (state.profile.full_name || '').split(' ')[0];
  $app.innerHTML = `
    <main class="auth-wrap" id="view" tabindex="-1">
      <form class="card notice" id="noticeForm" aria-labelledby="nt" novalidate>
        <div class="brand"><span class="mark">${icon('shield')}</span>${esc(APP_NAME)}</div>
        <h1 id="nt">Account security notice</h1>
        <p class="muted">${first ? `${esc(first)}, we` : 'We'} have added protections to keep accounts secure. Please read them and accept once to continue.</p>
        <ol class="notice-list">${noticeItems(r).map(([ic, t, d]) => `<li>${icon(ic)}<div><b>${t}</b><p>${esc(d)}</p></div></li>`).join('')}</ol>
        <p class="signed"><span>Issued by <b>${esc(NOTICE_ISSUER)}</b></span><span>Version ${NOTICE_VERSION} · ${NOTICE_DATE}</span></p>
        <label class="choice"><input type="checkbox" id="agree"><span><b>I have read and accept this notice</b><small>Your acceptance is recorded with the date and time.</small></span></label>
        <div class="btn-row">
          <button class="btn primary lg" type="submit" id="acceptBtn" disabled>Accept and continue ${icon('right')}</button>
          <button class="btn ghost" type="button" id="noticeOut">${icon('logout')}Sign out</button>
        </div>
        <p class="form-error" id="noticeErr" role="alert"></p>
      </form>
    </main>`;
  const f = document.getElementById('noticeForm'); const agree = f.querySelector('#agree'); const btn = f.querySelector('#acceptBtn');
  agree.onchange = () => { btn.disabled = !agree.checked; };
  f.querySelector('#noticeOut').onclick = () => signOutNow();
  document.getElementById('view').focus({ preventScroll: true });
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    if (!agree.checked) return;
    btn.disabled = true; btn.textContent = 'Saving…';
    const { error } = await sb.rpc('accept_notice', { p_version: NOTICE_VERSION, p_device: deviceLabel() });
    if (error) { f.querySelector('#noticeErr').textContent = errMsg(error); btn.disabled = false; btn.innerHTML = `Accept and continue ${icon('right')}`; return; }
    state.profile.notice_version = NOTICE_VERSION; state.profile.notice_accepted_at = new Date().toISOString();
    if (!location.hash || location.hash === '#/login') location.hash = '#/home'; else router();
  };
}

/* =========================================================================
   Shell & router
   ========================================================================= */

const NAV = [
  ['home', '#/home', 'Home', 'home'],
  ['practice', '#/practice', 'Practice', 'book'],
  ['exam', '#/exam', 'Mock exam', 'exam'],
  ['progress', '#/progress', 'Progress', 'trend'],
  ['feedback', '#/feedback', 'Feedback', 'chat'],
];
function shell(active, inner) {
  const p = state.profile;
  const items = NAV.concat(p.role === 'admin' ? [['admin', '#/admin/learners', 'Admin', 'shield']] : []);
  const link = ([key, href, label, ic]) => `<a href="${href}" data-nav="${key}" ${active === key ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></a>`;
  $app.innerHTML = `
    <header class="top">
      <div class="top-inner">
        <a class="brand" href="#/home"><span class="mark">${icon('check')}</span>${esc(APP_NAME)}</a>
        <nav class="nav" aria-label="Main">${items.map(link).join('')}</nav>
        <div class="me">
          <button class="btn ghost sm bell" id="bellBtn" type="button" aria-label="Notifications" aria-haspopup="dialog">${icon('bell')}<span class="nbadge" hidden></span></button>
          <a class="who" href="#/account" ${active === 'account' ? 'aria-current="page"' : ''} title="Account">${icon('user')}<span>${esc(p.full_name || p.email)}</span></a>
          <button class="btn ghost sm" id="signOut">${icon('logout')}<span class="sr">Sign out</span></button>
        </div>
      </div>
    </header>
    ${setBar()}
    <main id="view" tabindex="-1">${inner}</main>
    <nav class="bottom-nav" aria-label="Main">${items.map(link).join('')}</nav>`;
  document.getElementById('signOut').onclick = () => signOutNow();
  const pick = document.getElementById('setPick'); if (pick) pick.onchange = () => switchSet(+pick.value);
  document.getElementById('bellBtn').onclick = () => openNotifications();
  paintBell();
  if (p.role === 'admin') paintReportBadge();
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
  feedback: renderFeedback,
  'admin/learners': renderAdminLearners,
  'admin/learner': renderAdminLearner,
  'admin/questions': renderAdminQuestions,
  'admin/security': renderAdminSecurity,
  'admin/reports': renderAdminReports,
  'admin/notices': renderAdminNotices,
  'admin/insights': renderAdminInsights,
};

let lastRoute = '';
async function router() {
  if (!state.profile) return renderLogin();
  if (Date.now() - SEC.lastBeat > 30000 && !(await heartbeat(SEC.lastActivity > SEC.lastBeat, true))) return;
  if (await adminMfaGate()) return;
  if (needsNotice()) return renderNotice();
  if (needsDeviceConsent()) return renderDeviceConsent();
  recordDevice();
  // Learners read and acknowledge every live notice before using the app (checked once per sign-in).
  if (state.profile.role !== 'admin' && !state.noticesOk) {
    const unread = await unreadNoticeList(true).catch(() => []);
    if (unread.length) return renderNoticeGate(unread);
    state.noticesOk = true;
  }
  await loadSets().catch((e) => { console.warn(e); state.sets = state.sets || []; });
  if (!state.setId && !location.hash.startsWith('#/admin') && !location.hash.startsWith('#/account') && !location.hash.startsWith('#/feedback')) return renderNoSets();
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  let route = parts[0] || 'home';
  let param;
  if (route === 'admin') {
    if (state.profile.role !== 'admin') { location.hash = '#/home'; return; }
    route = 'admin/' + (parts[1] || 'learners'); param = parts[2];
  } else if (route === 'exam' && parts[1]) {
    route = 'exam/' + parts[1];
  } else if (route === 'mockreview') {
    return renderMockReview(+parts[1]);
  } else if (route === 'feedback') {
    param = parts[1];
  } else if (route === 'account' && parts[1] === 'backup') {
    if (state.profile.role === 'admin') return renderMfaSetup();
  }
  if (route === 'login') { location.hash = '#/home'; return; }
  const fn = routes[route] || renderHome;
  try {
    await fn(param);
    if (state.justSignedIn) { state.justSignedIn = false; openCountdownPopup(); }
    if (route !== lastRoute) { const v = document.getElementById('view'); if (v) v.focus({ preventScroll: true }); window.scrollTo(0, 0); }
    lastRoute = route;
  } catch (e) {
    console.error(e);
    const view = document.getElementById('view') || $app;
    view.innerHTML = `<div class="card empty">${icon('alert')}<h2>Something went wrong</h2><p class="muted">${esc(errMsg(e))}</p>
      <button class="btn primary" data-reload>${icon('retry')}Reload</button></div>`;
    view.querySelector('[data-reload]').onclick = () => location.reload();
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
    SEC.leaving = false;
    const { error } = await sb.auth.signInWithPassword({ email: String(fd.get('email')).trim(), password: fd.get('password') });
    if (error) {
      errEl.textContent = error.message === 'Invalid login credentials' ? 'Wrong email or password. Check them and try again.' : error.message;
      btn.disabled = false; btn.textContent = 'Sign in';
      return;
    }
    try {
      await loadProfile();
      const r = await claimSession();
      if (!r.ok) { await forceSignOut(secMessage(r)); return; }
      startSecurityTimers();
      state.justSignedIn = true;
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

/* ---------------------------------------------------------------
   Notices from the database (table "announcements"): each shows on Home
   between show_from and show_until, once per user until they tap "Got it"
---------------------------------------------------------------- */
async function loadAnnouncements() {
  const { data, error } = await sb.from('announcements').select('id,title,intro,items,issuer,show_from,show_until').order('show_from', { ascending: false });
  if (error) { if (!missingInDb(error)) console.warn(error); return []; }
  const now = Date.now();
  const reads = await sb.from('notice_reads').select('announcement_id').eq('user_id', state.profile.id);
  state.noticeReads = new Set(reads.error ? [] : reads.data.map((r) => r.announcement_id));
  const live = (data || []).filter((a) => Date.parse(a.show_from) <= now && (!a.show_until || Date.parse(a.show_until) > now));
  // Notices dismissed on this device before "Got it" was saved online: save them now.
  if (!reads.error) {
    const local = (store.get(updatesKey()) || []).filter((id) => live.some((a) => a.id === id) && !state.noticeReads.has(id));
    if (local.length) {
      local.forEach((id) => state.noticeReads.add(id));
      sb.from('notice_reads').upsert(local.map((id) => ({ announcement_id: id, user_id: state.profile.id })), { onConflict: 'announcement_id,user_id', ignoreDuplicates: true }).then(() => {}, () => {});
    }
  }
  state.noticeCache = { at: Date.now(), list: live };
  return live;
}
/** Live notices this learner hasn't pressed "Got it" on. They count in the bell until then. */
const unreadNotices = (list) => { const seen = store.get(updatesKey()) || []; return list.filter((u) => !seen.includes(u.id) && !state.noticeReads?.has(u.id)); };
async function unreadNoticeList(force = false) {
  const list = !force && state.noticeCache && Date.now() - state.noticeCache.at < 60000 ? state.noticeCache.list : await loadAnnouncements();
  return unreadNotices(list);
}
function markNoticeRead(id) {
  const seen = store.get(updatesKey()) || [];
  if (!seen.includes(id)) seen.push(id);
  store.set(updatesKey(), seen);
  state.noticeReads?.add(id);
  sb.from('notice_reads').upsert({ announcement_id: id, user_id: state.profile.id }, { onConflict: 'announcement_id,user_id', ignoreDuplicates: true }).then(({ error }) => { if (error && !missingInDb(error)) console.warn(error); });
  document.querySelectorAll(`[data-update="${CSS.escape(id)}"]`).forEach((el) => el.remove());
  bellCache.at = 0; paintBell(true);
}
const longDate = (ts) => new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const updatesKey = () => 'mcq-updates-seen:' + (state.profile ? state.profile.id : '');
function noticeBody(u) {
  return `${u.intro ? `<p class="muted">${esc(u.intro)}</p>` : ''}
      <ul class="notice-list">${(Array.isArray(u.items) ? u.items : []).map(([ic, t, d]) => `<li>${icon(ICONS[ic] ? ic : 'check')}<div><b>${esc(t)}</b><p>${esc(d)}</p></div></li>`).join('')}</ul>`;
}
function updateCards(list) {
  return unreadNotices(list).map((u) => `
    <section class="card update" data-update="${esc(u.id)}" aria-labelledby="up-${esc(u.id)}">
      <div class="row-between"><h2 id="up-${esc(u.id)}">${icon('shield')}${esc(u.title)}</h2><span class="muted small">${esc(longDate(u.show_from))}</span></div>
      ${u.intro ? `<p class="muted">${esc(u.intro)}</p>` : ''}
      <ul class="notice-list">${(Array.isArray(u.items) ? u.items : []).map(([ic, t, d]) => `<li>${icon(ICONS[ic] ? ic : 'check')}<div><b>${esc(t)}</b><p>${esc(d)}</p></div></li>`).join('')}</ul>
      <div class="row-between"><span class="muted small">Issued by <b>${esc(u.issuer)}</b></span><button class="btn primary sm" type="button" data-dismiss-update="${esc(u.id)}">Got it</button></div>
    </section>`).join('');
}
function wireUpdates(root) {
  root.querySelectorAll('[data-dismiss-update]').forEach((b) => (b.onclick = () => markNoticeRead(b.dataset.dismissUpdate)));
}

/* ---------------------------------------------------------------
   Exam countdown + daily motivation: a card on Home, and a popup
   once after each sign-in. Times are Chisinau time (EET, UTC+2).
---------------------------------------------------------------- */
const EXAMS = [
  { key: 'mock', name: 'Mock exam', at: '2026-11-24T08:00:00+02:00' },
  { key: 'final', name: 'Final exam', at: '2026-12-07T08:00:00+02:00' },
];
const EXAM_DAY_MS = 12 * 3600e3; // after the start time, show "today" for 12 hours, then "done"
const QUOTES = [
  'Every question you answer today is one less surprise on exam day.',
  'Six years of work got you here. A few more focused days will carry you through.',
  'Do not aim for perfect. Aim for one more topic than yesterday.',
  'Your wrong answers are your best teachers. Review them, then move on.',
  'Small, steady sessions beat one long panic. Keep showing up.',
  'You already know more than you think. Now prove it to yourself, one block at a time.',
  'Calm mind, clear reading, one option at a time.',
  'Future patients are the reason. This exam is just a step on the way.',
  'Progress, not pressure. Do the next question.',
  'Tired is normal. Quitting is optional. Rest well, then come back stronger.',
  'Discipline today, a white coat with your name on it tomorrow.',
  'Read the whole question, trust your preparation, and keep going.',
  'Hard topics shrink every time you face them.',
  'The finish line is close. Finish like you started: with purpose.',
];
const quoteOfDay = () => QUOTES[Math.floor((Date.now() + 2 * 3600e3) / 864e5) % QUOTES.length];
const upcomingExams = () => EXAMS.filter((e) => Date.now() < Date.parse(e.at) + EXAM_DAY_MS);

function countdownParts(at) {
  const ms = Date.parse(at) - Date.now();
  if (ms <= 0) return null;
  const s = Math.floor(ms / 1000);
  return [[Math.floor(s / 86400), 'days'], [Math.floor(s / 3600) % 24, 'hours'], [Math.floor(s / 60) % 60, 'min'], [s % 60, 'sec']];
}
function countdownInner(e) {
  const p = countdownParts(e.at);
  if (!p) return `<span class="cd-today">${icon('check')}Today. Good luck!</span>`;
  return p.map(([n, l]) => `<span class="cd-unit"><b>${String(n).padStart(2, '0')}</b><small>${l}</small></span>`).join('');
}
function countdownHTML(list = upcomingExams()) {
  return `<div class="cd-grid">${list.map((e) => `
    <div class="cd-item">
      <div class="cd-head"><b>${esc(e.name)}</b><span class="muted small">${esc(longDate(e.at))}</span></div>
      <div class="cd-clock" data-countdown="${esc(e.key)}">${countdownInner(e)}</div>
    </div>`).join('')}</div>`;
}
const quoteHTML = () => `<blockquote class="cd-quote">${icon('target')}<span>${esc(quoteOfDay())}</span></blockquote>`;
function countdownCard() {
  if (!hasUsmf()) return '';
  const list = upcomingExams();
  if (!list.length) return '';
  return `<section class="card countdown" aria-labelledby="cdH"><h2 id="cdH">${icon('clock')}Exam countdown</h2>${countdownHTML(list)}${quoteHTML()}</section>`;
}
let cdTimer = null;
function tickCountdowns() {
  if (cdTimer) return;
  cdTimer = setInterval(() => {
    const els = document.querySelectorAll('[data-countdown]');
    if (!els.length) { clearInterval(cdTimer); cdTimer = null; return; }
    els.forEach((el) => { const e = EXAMS.find((x) => x.key === el.dataset.countdown); if (e) el.innerHTML = countdownInner(e); });
  }, 1000);
}
function openCountdownPopup() {
  if (!hasUsmf()) return;
  const list = upcomingExams();
  if (!list.length) return;
  document.querySelector('.modal-back')?.remove();
  const first = (state.profile.full_name || '').split(' ')[0];
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="card modal countdown" role="dialog" aria-modal="true" aria-labelledby="cdP">
      <h2 id="cdP">${icon('clock')}${first ? `Welcome back, ${esc(first)}` : 'Welcome back'}</h2>
      ${countdownHTML(list)}${quoteHTML()}
      <div class="btn-row"><button class="btn primary" type="button" id="cdGo">Let's study ${icon('right')}</button></div>
    </div>`;
  document.body.appendChild(back);
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  const go = back.querySelector('#cdGo'); go.onclick = close; go.focus();
  tickCountdowns();
}

/* Exam readiness for the signed-in learner: the same rules as Admin → Insights.
   A discipline needs attention when under 25% of its questions are seen, or
   accuracy is under 60% after at least 5 answers. */
function readinessStatus(p) {
  if (!p.s.attempts) return ['Not started', ''];
  if ((p.coverage ?? 0) < 25 || (p.s.attempts >= 5 && p.acc < 60)) return ['Needs attention', 'warn'];
  return ['On track', 'ok'];
}
function readinessCard(r, overall, totalQs, lastMock) {
  const final = state.setId === USMF_SET ? EXAMS.find((e) => e.key === 'final') : null;
  const days = final ? Math.max(0, Math.ceil((Date.parse(final.at) - Date.now()) / 864e5)) : null;
  const list = r.per.filter((p) => p.d.total && p.d.weight > 0).sort((a, b) => b.d.weight - a.d.weight);
  const focus = list.filter((p) => readinessStatus(p)[0] !== 'On track').slice(0, 3);
  const seen = pctNum(overall.answered, totalQs) || 0;
  const level = r.score === null ? null : r.score >= 75 ? ['Well prepared', 'ok'] : r.score >= 60 ? ['Getting there', 'pri'] : ['Needs more work', 'warn'];
  const why = (p) => (!p.s.attempts ? 'not started yet' : (p.coverage ?? 0) < 25 ? `only ${p.coverage ?? 0}% of its questions seen` : `${p.acc}% right`);
  return `<section class="card readiness" aria-labelledby="rdH">
    <div class="row-between"><h2 id="rdH">${icon('target')}Your exam readiness</h2>${level ? `<span class="chip ${level[1]}">${level[0]}</span>` : ''}</div>
    <p class="muted">${r.score === null ? 'Answer at least 5 questions in a discipline to get an estimate.' : `Estimated score <b>${r.score}%</b> (about <b>${fmt10(r.score / 10)}/10</b>), based on ${r.weightCovered}% of the exam weight.`}
      You have seen ${seen}% of the bank${lastMock ? `, and your latest mock was ${fmt10(sess10(lastMock))}/10` : ''}.${days !== null ? ` Final exam in ${days} day${days === 1 ? '' : 's'}.` : ''}</p>
    ${focus.length ? `<p><b>Focus next:</b> ${focus.map((p) => `${esc(p.d.name)} (${p.d.weight}% of the exam) – ${why(p)}`).join('; ')}.</p>` : r.score !== null ? '<p><b>Every discipline is on track.</b> Keep mixing mock exams with your weakest topics.</p>' : ''}
    <details class="rd-more"${focus.length ? '' : ''}><summary>All disciplines</summary>
      <div class="table-wrap"><table><thead><tr><th>Discipline</th><th class="n">Weight</th><th>Seen</th><th class="n">Right</th><th>Status</th><th></th></tr></thead><tbody>
      ${list.map((p) => { const [st, cls] = readinessStatus(p); return `<tr><td>${esc(p.d.name)}</td><td class="n">${p.d.weight}%</td>
        <td><div class="cov"><span class="bar"><span style="width:${p.coverage || 0}%"></span></span><small>${p.coverage || 0}%</small></div></td>
        <td class="n">${p.acc === null ? '<span class="muted">–</span>' : `<span class="acc ${accClass(p.acc)}">${p.acc}%</span>`}</td>
        <td><span class="chip ${cls}">${st}</span></td>
        <td class="n">${st === 'On track' ? '' : `<button class="btn sm" data-drill-disc="${p.d.id}">Practise</button>`}</td></tr>`; }).join('')}
      </tbody></table></div></details>
  </section>`;
}

async function renderHome() {
  const view = shell('home', loading);
  const [meta, stats, sessions, pool, notices, nReports] = await Promise.all([loadMeta(), topicStats(state.profile.id), sessionsFor(state.profile.id), loadPool(), loadAnnouncements(), state.profile.role === 'admin' ? openReportCount(true) : 0, loadDrafts(true)]);
  const totalQs = sum(meta.disciplines.map((d) => d.total));
  const nUnused = pool.filter((q) => q.status === 'unused').length;
  const nWrong = pool.filter((q) => q.status === 'incorrect').length;
  const nMarked = pool.filter((q) => q.marked).length;
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
  const draft = state.drafts?.exam;
  const weakest = r.per.flatMap((p) => p.d.topics.map((t) => ({ t, d: p.d, s: stats.get(t.id) })))
    .filter((x) => x.s && x.s.attempts >= 5)
    .map((x) => ({ ...x, acc: pctNum(x.s.correct, x.s.attempts) }))
    .sort((a, b) => a.acc - b.acc).slice(0, 5);
  const first = (state.profile.full_name || '').split(' ')[0];

  view.innerHTML = `
    <div class="page-head"><div><h1>${first ? 'Hello, ' + esc(first) : 'Welcome'}</h1>
      <p class="muted">${overall.answered ? `${(totalQs - nUnused).toLocaleString()} of ${totalQs.toLocaleString()} questions used · ${nWrong.toLocaleString()} incorrect · ${nMarked.toLocaleString()} marked` : `${totalQs.toLocaleString()} questions across ${meta.disciplines.filter((d) => d.total).length} disciplines are ready.`}</p></div></div>

    ${draft ? `<div class="card tight row-between" style="border-color:var(--warn)"><div class="row">${icon('clock')}<div><b>You have an unfinished test.</b><br><span class="muted small">${esc(draft.label || '')}</span></div></div>
      <a class="btn primary" href="#/exam/run">Resume exam</a></div>` : ''}

    ${countdownCard()}

    ${practiceDraftInfo() ? practiceResumeCard(practiceDraftInfo()) : ''}

    ${nReports ? reportsHomeCard(nReports) : ''}${updateCards(notices)}

    <div class="grid stats">
      <div class="stat"><span class="label">${icon('target')}Estimated exam score</span><span class="value">${r.score === null ? '–' : r.score + '<small>%</small>'}</span>
        <span class="hint">${r.score === null ? 'Answer at least 5 questions in a discipline to start the estimate.' : `Weighted by the exam blueprint · covers ${r.weightCovered}% of the exam`}</span></div>
      <div class="stat"><span class="label">${icon('exam')}Latest mock exam</span><span class="value">${lastMock ? fmt10(sess10(lastMock)) + '<small>/10</small>' : '–'}</span>
        <span class="hint">${lastMock ? `${sessPct(lastMock)}% · ${fmtDate(lastMock.started_at)} · ${mocks.length} taken` : 'No mock exam yet'}</span></div>
      <div class="stat"><span class="label">${icon('check')}Accuracy</span><span class="value">${pct(overall.correct, overall.attempts)}</span>
        <span class="hint">${overall.attempts.toLocaleString()} answers in total</span></div>
    </div>

    ${readinessCard(r, overall, totalQs, lastMock)}

    <div class="grid two">
      <section class="card" aria-labelledby="hq1">
        <h2 id="hq1">Start studying</h2>
        <p class="muted">Build a test from any subject, or sit a mock paper that follows the official exam weights.</p>
        <div class="btn-row">
          <a class="btn primary lg" href="#/practice">${icon('book')}Create a test</a>
          <a class="btn lg" href="#/exam">${icon('exam')}Mock exam</a>
        </div>
        <div class="pool-links">
          <button class="btn ghost sm" data-pool="unused" ${nUnused ? '' : 'disabled'}>${nUnused.toLocaleString()} unused</button>
          <button class="btn ghost sm" data-pool="incorrect" ${nWrong ? '' : 'disabled'}>${nWrong.toLocaleString()} incorrect</button>
          <button class="btn ghost sm" data-pool="marked" ${nMarked ? '' : 'disabled'}>${nMarked.toLocaleString()} marked</button>
        </div>
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
  wireUpdates(view);
  wirePracticeResume(view, renderHome);
  tickCountdowns();
  view.querySelectorAll('[data-drill-disc]').forEach((b) => (b.onclick = async () => {
    const d = meta.discById.get(+b.dataset.drillDisc); if (!d) return;
    b.disabled = true;
    try { await startTest({ catIds: d.topics.filter((t) => meta.totals.get(t.id)).map((t) => t.id), mode: 'tutor', pools: ['unused', 'incorrect', 'marked', 'correct'], types: ['CS', 'CM'], count: 20 }, pool); } catch (e) { toast(errMsg(e), 'bad'); b.disabled = false; }
  }));
  view.querySelectorAll('[data-drill]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try { await startTest({ catIds: [+b.dataset.drill], mode: 'tutor', pools: ['unused', 'incorrect', 'marked', 'correct'], types: ['CS', 'CM'], count: 20 }, pool); } catch (e) { toast(errMsg(e), 'bad'); b.disabled = false; }
  }));
  // shortcuts: open the test builder with every subject and just that pool selected
  view.querySelectorAll('[data-pool]').forEach((b) => (b.onclick = () => {
    store.set(prefsKey(), { ...(store.get(prefsKey()) || {}), cats: meta.topics.filter((t) => meta.totals.get(t.id)).map((t) => t.id), pools: [b.dataset.pool], types: ['CS', 'CM'] });
    location.hash = '#/practice';
  }));
}

/* =========================================================================
   Create a test (UWorld-style builder)
   ========================================================================= */

const QCOLS = 'id,category_id,question,options,qtype,correct,explanation';
const POOLS = [
  ['unused', 'Unused', 'Never answered'],
  ['incorrect', 'Incorrect', 'Wrong the last time'],
  ['marked', 'Marked', 'Flagged for review'],
  ['correct', 'Correct', 'Right the last time'],
];

/** Every active question with this learner's status: unused / correct / incorrect, plus marked. */
async function loadPool(uid = state.profile.id) {
  const [qs, prog, marks] = await Promise.all([
    fetchAll(() => sb.from('questions').select('id,category_id,qtype').eq('active', true).eq('set_id', state.setId).order('id')),
    fetchAll(() => sb.from('progress').select('question_id,last_correct').eq('user_id', uid).order('question_id')),
    fetchAll(() => sb.from('marks').select('question_id').eq('user_id', uid).order('question_id')),
  ]);
  const last = new Map(prog.map((p) => [p.question_id, p.last_correct]));
  const marked = new Set(marks.map((m) => m.question_id));
  if (uid === state.profile.id) state.marks = marked;
  return qs.map((q) => ({ id: q.id, cat: q.category_id, type: q.qtype,
    status: !last.has(q.id) ? 'unused' : last.get(q.id) ? 'correct' : 'incorrect', marked: marked.has(q.id) }));
}
const inPools = (q, pools) => pools.includes(q.status) || (q.marked && pools.includes('marked'));

async function toggleMark(qid) {
  const marked = state.marks?.has(qid);
  if (!state.marks) state.marks = new Set();
  if (marked) { state.marks.delete(qid); const { error } = await sb.from('marks').delete().eq('user_id', state.profile.id).eq('question_id', qid); if (error) { state.marks.add(qid); toast(errMsg(error), 'bad'); } }
  else { state.marks.add(qid); const { error } = await sb.from('marks').insert({ user_id: state.profile.id, question_id: qid }); if (error && !/duplicate/i.test(error.message)) { state.marks.delete(qid); toast(errMsg(error), 'bad'); } }
  return state.marks.has(qid);
}

async function renderPractice() {
  const view = shell('practice', loading);
  const [meta, pool] = await Promise.all([loadMeta(), loadPool(), loadDrafts(true)]);
  const discs = meta.disciplines.filter((d) => d.total);
  if (!discs.length) { view.innerHTML = `<div class="card empty">${icon('book')}<h2>No questions yet</h2></div>`; return; }

  const prefs = store.get(prefsKey()) || {};
  const valid = new Set(meta.topics.filter((t) => meta.totals.get(t.id)).map((t) => t.id));
  const selected = new Set((prefs.cats || []).filter((id) => valid.has(id)));
  const mode = prefs.testMode || 'tutor';
  const timed = prefs.testTimed !== false;
  const pools = prefs.pools || ['unused'];
  const types = prefs.types || ['CS', 'CM'];
  const count = prefs.testCount || 20;

  view.innerHTML = `
    <div class="page-head"><div><h1>Create a test</h1><p class="muted">Work through a subject one pass at a time: unused questions first, then your incorrect ones, then mixed blocks. Answers are marked against the official key.</p></div></div>

    ${practiceDraftInfo() ? practiceResumeCard(practiceDraftInfo()) : ''}
    <div class="card tight row-between"><div class="row">${icon('alert')}<div><b>Most missed by the group</b><br><span class="muted small">Up to 20 questions most learners got wrong on their first try. No names or scores are shared.</span></div></div>
      <button class="btn" type="button" id="mostMissed">${icon('right')}Start</button></div>

    <section class="card" aria-labelledby="tm">
      <fieldset><legend id="tm">Test mode</legend>
        <div class="choices">
          <label class="choice"><input type="radio" name="tmode" value="tutor" ${mode === 'tutor' ? 'checked' : ''}><span><b>Tutor</b><small>See the answer and key after each question.</small></span></label>
          <label class="choice"><input type="radio" name="tmode" value="exam" ${mode === 'exam' ? 'checked' : ''}><span><b>Exam</b><small>Answer the whole block, then see your score and review.</small></span></label>
        </div>
      </fieldset>
      <label class="choice" id="timedWrap" style="margin-top:8px"><input type="checkbox" id="timed" ${timed ? 'checked' : ''}><span><b>Timed</b><small>One minute per question, like the real exam.</small></span></label>
    </section>

    <section class="card" aria-labelledby="tp">
      <fieldset><legend id="tp">Question pool</legend>
        <div class="choices four">${POOLS.map(([v, t, s]) => `<label class="choice"><input type="checkbox" name="pool" value="${v}" ${pools.includes(v) ? 'checked' : ''}><span><b>${t} <span class="count num" data-pc="${v}"></span></b><small>${s}</small></span></label>`).join('')}</div>
      </fieldset>
      <fieldset style="margin-top:16px"><legend>Question type</legend>
        <div class="choices">
          <label class="choice"><input type="checkbox" name="qtype" value="CS" ${types.includes('CS') ? 'checked' : ''}><span><b>Single answer (CS) <span class="count num" data-tc="CS"></span></b><small>One correct option</small></span></label>
          <label class="choice"><input type="checkbox" name="qtype" value="CM" ${types.includes('CM') ? 'checked' : ''}><span><b>Multiple answers (CM) <span class="count num" data-tc="CM"></span></b><small>Two or more correct options</small></span></label>
        </div>
      </fieldset>
    </section>

    <section class="card" aria-labelledby="pt">
      <div class="row-between"><h2 id="pt">Subjects</h2>
        <div class="btn-row"><button class="btn sm" data-all>Select all</button><button class="btn sm ghost" data-none>Clear</button></div></div>
      <p class="muted small">Numbers show how many questions match the pool and type you picked.</p>
      ${discs.map((d) => `
        <details class="disc" ${d.topics.some((t) => selected.has(t.id)) && !d.topics.every((t) => !valid.has(t.id) || selected.has(t.id)) ? 'open' : ''}>
          <summary>
            <input type="checkbox" data-discall="${d.id}" aria-label="Select all ${esc(d.name)} topics">
            <span><span class="dname">${esc(d.name)}</span><br><span class="dmeta"><span data-dc="${d.id}"></span> · ${d.total} in total · ${d.weight}% of the exam</span></span>
            <span class="chev">${icon('right')}</span>
          </summary>
          <div class="topics">${d.topics.filter((t) => valid.has(t.id)).map((t) => `<label class="topic"><input type="checkbox" value="${t.id}" data-disc="${d.id}" ${selected.has(t.id) ? 'checked' : ''}>
            <span class="tname">${esc(t.name)}</span><span class="tmeta" data-tcnt="${t.id}"></span></label>`).join('')}</div>
        </details>`).join('')}
    </section>

    <section class="card" aria-labelledby="tn">
      <h2 id="tn">Number of questions</h2>
      <div class="row">
        <label class="field" style="max-width:160px;margin:0"><span class="sr">Number of questions</span><input type="number" id="count" min="1" max="500" step="1" value="${count}" inputmode="numeric"></label>
        <div class="btn-row">${[10, 20, 50, 100].map((n) => `<button class="btn sm" data-n="${n}">${n}</button>`).join('')}<button class="btn sm" id="maxBtn">Max</button></div>
      </div>
      <p class="help" id="countHelp"></p>
    </section>

    <div class="sticky-start"><div class="start-bar">
      <span id="selInfo" class="muted" aria-live="polite"></span>
      <button class="btn primary lg" id="start">Create test ${icon('right')}</button>
    </div></div>`;
  wirePracticeResume(view, renderPractice);
  view.querySelector('#mostMissed').onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try {
      const { data, error } = await sb.rpc('most_missed_ids', { p_limit: 20, p_set: state.setId });
      if (error) throw error;
      const qs = await fetchQuestions((data || []).map(Number));
      if (!qs.length) { toast('Not enough answers from the group yet. Try again later.', ''); b.disabled = false; return; }
      await startTutor(shuffle(qs), 'Most missed by the group', null);
    } catch (err) { toast(errMsg(err), 'bad'); b.disabled = false; }
  };

  const topicBoxes = [...view.querySelectorAll('.topic input')];
  const discBoxes = [...view.querySelectorAll('[data-discall]')];
  const countEl = view.querySelector('#count');
  const opts = () => ({
    catIds: topicBoxes.filter((b) => b.checked).map((b) => +b.value),
    mode: view.querySelector('input[name=tmode]:checked').value,
    timed: view.querySelector('#timed').checked,
    pools: [...view.querySelectorAll('input[name=pool]:checked')].map((b) => b.value),
    types: [...view.querySelectorAll('input[name=qtype]:checked')].map((b) => b.value),
    count: Math.max(1, Math.floor(+countEl.value || 0)),
  });
  let available = 0;
  const sync = () => {
    for (const db of discBoxes) {
      const mine = topicBoxes.filter((b) => b.dataset.disc === db.dataset.discall);
      const n = mine.filter((b) => b.checked).length;
      db.checked = n === mine.length && n > 0; db.indeterminate = n > 0 && n < mine.length;
    }
    const o = opts();
    view.querySelector('#timedWrap').hidden = o.mode !== 'exam';
    store.set(prefsKey(), { ...(store.get(prefsKey()) || {}), cats: o.catIds, testMode: o.mode, testTimed: o.timed, pools: o.pools, types: o.types, testCount: o.count });
    const cats = new Set(o.catIds);
    const scope = cats.size ? pool.filter((q) => cats.has(q.cat)) : pool;
    // pool counts within selected subjects and types; type counts within selected subjects and pools
    for (const [v] of POOLS) view.querySelector(`[data-pc=${v}]`).textContent = `(${scope.filter((q) => o.types.includes(q.type) && inPools(q, [v])).length})`;
    for (const t of ['CS', 'CM']) view.querySelector(`[data-tc=${t}]`).textContent = `(${scope.filter((q) => q.type === t && inPools(q, o.pools)).length})`;
    const match = pool.filter((q) => o.types.includes(q.type) && inPools(q, o.pools));
    const byCat = new Map(); for (const q of match) byCat.set(q.cat, (byCat.get(q.cat) || 0) + 1);
    for (const t of meta.topics) { const el = view.querySelector(`[data-tcnt="${t.id}"]`); if (el) el.textContent = `${byCat.get(t.id) || 0} / ${meta.totals.get(t.id) || 0}`; }
    for (const d of discs) view.querySelector(`[data-dc="${d.id}"]`).textContent = `${sum(d.topics.map((t) => byCat.get(t.id) || 0))} available`;
    available = match.filter((q) => cats.has(q.cat)).length;
    const n = Math.min(o.count, available);
    view.querySelector('#countHelp').textContent = cats.size ? `${available} questions available in your selection.` : 'Pick at least one subject.';
    view.querySelector('#selInfo').textContent = !cats.size ? 'Select at least one subject' : !o.pools.length ? 'Pick at least one question pool' : !o.types.length ? 'Pick at least one question type' : !available ? 'No questions match these filters' : `${n} question${n === 1 ? '' : 's'} · ${o.mode === 'exam' ? (o.timed ? `exam, ${n} min` : 'exam, untimed') : 'tutor'}`;
    view.querySelector('#start').disabled = !available;
  };
  discBoxes.forEach((db) => db.addEventListener('change', () => {
    topicBoxes.filter((b) => b.dataset.disc === db.dataset.discall).forEach((b) => (b.checked = db.checked));
    sync();
  }));
  view.querySelector('[data-all]').onclick = () => { topicBoxes.forEach((b) => (b.checked = true)); sync(); };
  view.querySelector('[data-none]').onclick = () => { topicBoxes.forEach((b) => (b.checked = false)); sync(); };
  view.querySelectorAll('[data-n]').forEach((b) => (b.onclick = () => { countEl.value = b.dataset.n; sync(); }));
  view.querySelector('#maxBtn').onclick = () => { countEl.value = Math.max(1, available); sync(); };
  view.addEventListener('change', (e) => { if (!e.target.dataset.discall) sync(); });
  countEl.addEventListener('input', sync);
  sync();

  view.querySelector('#start').onclick = async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true; btn.textContent = 'Building test…';
    try { if (!(await startTest(opts(), pool))) { btn.disabled = false; btn.innerHTML = `Create test ${icon('right')}`; } }
    catch (e) { toast(errMsg(e), 'bad'); btn.disabled = false; btn.innerHTML = `Create test ${icon('right')}`; }
  };
}

function testLabel(meta, catIds, pools) {
  const cats = new Set(catIds);
  const parts = [];
  for (const d of meta.disciplines) {
    const mine = d.topics.filter((t) => meta.totals.get(t.id));
    const chosen = mine.filter((t) => cats.has(t.id));
    if (!chosen.length) continue;
    if (chosen.length === mine.length) parts.push(d.name); else parts.push(...chosen.map((t) => t.name));
  }
  const subj = parts.length <= 2 ? parts.join(', ') : `${parts.length} subjects`;
  const pl = pools.length === POOLS.length ? 'All' : pools.map((p) => POOLS.find((x) => x[0] === p)[1]).join(' + ');
  return `${subj} · ${pl}`;
}

async function fetchQuestions(ids) {
  const qs = await inChunks(ids, 100, (chunk) => fetchAll(() => sb.from('questions').select(QCOLS).in('id', chunk).order('id')));
  const byId = new Map(qs.map((q) => [q.id, q]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}

/** Build a test from builder options. `pool` may be passed in to skip reloading it. */
async function startTest(o, pool) {
  const meta = await loadMeta();
  pool = pool || (await loadPool());
  const cats = new Set(o.catIds);
  const match = pool.filter((q) => cats.has(q.cat) && o.types.includes(q.type) && inPools(q, o.pools));
  if (!match.length) { toast('No questions match that selection.', 'bad'); return false; }
  const ids = shuffle(match).slice(0, o.count).map((q) => q.id);
  const qs = await fetchQuestions(ids);
  const label = testLabel(meta, o.catIds, o.pools);
  if (o.mode === 'exam') { await startExamWith(qs, { mode: 'topic', label, timed: o.timed, opts: o }); return true; }
  await startTutor(qs, label, o);
  return true;
}

async function startTutor(qs, label, opts, review = false) {
  const sessionId = check(await sb.rpc('start_session', { p_mode: review ? 'review' : 'topic', p_label: label, p_total: qs.length, p_set: state.setId }));
  if (!state.marks) await loadPool();
  closePracticeDraft();
  state.run = { opts, sessionId, label, i: 0, startedAt: Date.now(),
    items: qs.map((q) => ({ q, order: optionOrder(q.options), sel: new Set(), done: false, ok: null, saved: null })) };
  savePractice();
  if (location.hash === '#/session') renderSession(); else location.hash = '#/session';
}

/* ---------------------------------------------------------------
   Unfinished practice tests are kept on this device, so a learner who
   closes the tab, is signed out or signs out can carry on later.
   Only question ids, option order and answers are stored, not the
   question text. Answers already checked are also saved on the server.
---------------------------------------------------------------- */
function savePractice(run = state.run) {
  if (!run || run.ended || !state.profile || run.i >= run.items.length) return;
  putDraft('practice', { sessionId: run.sessionId, label: run.label, opts: run.opts || null, i: run.i, startedAt: run.startedAt,
    items: run.items.map((it) => ({ id: it.q.id, order: it.order, sel: [...it.sel], done: it.done, ok: it.ok })) });
}
/** Drop the saved draft; if it belonged to another session, close that session on the server. */
function closePracticeDraft() {
  const d = state.drafts?.practice;
  if (d) dropDraft('practice');
  if (d && d.sessionId && d.sessionId !== state.run?.sessionId) sb.rpc('finish_session', { p_session_id: d.sessionId }).then(() => {}, () => {});
}
const practiceDraftInfo = () => {
  const d = state.drafts?.practice;
  if (!d || !Array.isArray(d.items) || !d.items.length) return null;
  return { label: d.label || 'Practice test', answered: d.items.filter((x) => x.done).length, total: d.items.length, savedAt: d.savedAt };
};
async function resumePractice() {
  const d = (await loadDrafts()).practice;
  if (!d || !Array.isArray(d.items) || !d.items.length) return false;
  await loadMeta();
  if (!state.marks) await loadPool();
  const qs = await fetchQuestions(d.items.map((x) => x.id));
  const byId = new Map(qs.map((q) => [q.id, q]));
  const items = d.items.filter((x) => byId.has(x.id)).map((x) => {
    const q = byId.get(x.id);
    const okOrder = Array.isArray(x.order) && x.order.length === q.options.length && sameSet(x.order, q.options.map((_, k) => k));
    return { q, order: okOrder ? x.order : optionOrder(q.options), sel: new Set(x.sel || []), done: !!x.done, ok: x.done ? sameSet(x.sel || [], q.correct) : null, saved: x.done ? true : null };
  });
  if (!items.length) { dropDraft('practice'); return false; }
  const firstOpen = items.findIndex((x) => !x.done);
  state.run = { opts: d.opts, sessionId: d.sessionId, label: d.label, startedAt: d.startedAt, items,
    i: firstOpen === -1 ? items.length - 1 : Math.min(Math.max(d.i || 0, 0), firstOpen) };
  return true;
}
const practiceResumeCard = (info) => `<div class="card tight row-between" style="border-color:var(--warn)"><div class="row">${icon('book')}<div><b>You have an unfinished practice test.</b><br>
  <span class="muted small">${esc(info.label)} · ${info.answered} of ${info.total} answered</span></div></div>
  <div class="btn-row"><button class="btn ghost sm" type="button" data-practice-discard>Discard</button><button class="btn primary" type="button" data-practice-resume>Continue test ${icon('right')}</button></div></div>`;
function wirePracticeResume(root, rerender) {
  const go = root.querySelector('[data-practice-resume]');
  if (go) go.onclick = async () => {
    go.disabled = true;
    try { state.run = null; if (await resumePractice()) location.hash = '#/session'; else { toast('That test could not be restored.', 'bad'); rerender(); } }
    catch (e) { toast(errMsg(e), 'bad'); go.disabled = false; }
  };
  const del = root.querySelector('[data-practice-discard]');
  if (del) del.onclick = () => {
    if (!confirm('Discard the unfinished practice test? Answers you already checked stay in your progress.')) return;
    closePracticeDraft(); rerender();
  };
}

/* =========================================================================
   Report a question: learners flag a mistake with a comment; the admin
   sees a count on the Admin tab and Home, and works through them on
   Admin → Reports.
   ========================================================================= */

const REPORTS_FROM = Date.parse('2026-11-20T18:00:00Z'); // goes live with the 20 Nov update (8:00 pm Chisinau)
const reportsOn = () => Date.now() >= REPORTS_FROM || state.profile?.role === 'admin';
const REPORTABLE = new Map(); // question id -> question, for the report dialog
const reportedNow = new Set(); // reported in this tab

function reportBtn(q, order, extra = '') {
  if (!reportsOn()) return '';
  REPORTABLE.set(q.id, q);
  const done = reportedNow.has(q.id);
  return `<button type="button" class="btn ghost sm report-btn${extra}" data-report="${q.id}" data-order="${order.join(',')}" ${done ? 'aria-pressed="true"' : ''} title="Report a mistake in this question">${icon('alert')}${done ? 'Reported' : 'Report'}</button>`;
}

function openReport(qid, order) {
  const q = REPORTABLE.get(qid); if (!q) return;
  document.querySelector('.modal-back')?.remove();
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<form class="card modal" role="dialog" aria-modal="true" aria-labelledby="rpT" novalidate>
      <h2 id="rpT">${icon('alert')}Report this question</h2>
      <p class="muted small">Tell us what is wrong. The admin will check it against the university file and correct it if needed.</p>
      <blockquote class="rq-quote">${esc(q.question.length > 220 ? q.question.slice(0, 220) + '…' : q.question)}</blockquote>
      <label class="field">What is the issue?<span class="help">Use the letters you see on screen (A, B, C…). Required.</span>
        <textarea name="comment" rows="4" maxlength="1000" required placeholder="For example: option C is cut off, or the answer key looks wrong"></textarea></label>
      <div class="row-between"><span class="muted small" id="rpCount">0 / 1000</span>
        <div class="btn-row"><button type="button" class="btn ghost" id="rpCancel">Cancel</button><button class="btn primary" id="rpSend">${icon('check')}Send report</button></div></div>
      <p class="form-error" id="rpErr" role="alert"></p>
    </form>`;
  document.body.appendChild(back);
  const f = back.querySelector('form'); const ta = f.comment; const err = f.querySelector('#rpErr');
  const opener = document.activeElement;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); if (opener && opener.isConnected) opener.focus({ preventScroll: true }); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  f.querySelector('#rpCancel').onclick = close;
  ta.oninput = () => { f.querySelector('#rpCount').textContent = `${ta.value.length} / 1000`; err.textContent = ''; };
  ta.focus();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const comment = ta.value.trim();
    if (comment.length < 3) { err.textContent = 'Write a few words about what is wrong.'; ta.focus(); return; }
    const btn = f.querySelector('#rpSend'); btn.disabled = true; btn.textContent = 'Sending…';
    const { error } = await sb.from('question_reports').insert({ question_id: qid, comment, shown_order: order });
    if (error && error.code !== '23505') { err.textContent = errMsg(error); btn.disabled = false; btn.innerHTML = `${icon('check')}Send report`; return; }
    reportedNow.add(qid); close();
    document.querySelectorAll(`[data-report="${qid}"]`).forEach((b) => { b.setAttribute('aria-pressed', 'true'); b.innerHTML = `${icon('alert')}Reported`; });
    toast(error ? 'You already reported this question. The admin will check it.' : 'Thanks. The admin has been told and will check this question.', 'ok');
    reportCache.at = 0;
  };
}

document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-report]'); if (!b) return;
  e.preventDefault();
  openReport(+b.dataset.report, (b.dataset.order || '').split(',').filter((x) => x !== '').map(Number));
});

const ACTIVE_REPORT = ['open', 'in_review'];
const reportCache = { n: 0, at: 0 };
async function openReportCount(force = false) {
  if (state.profile?.role !== 'admin') return 0;
  if (!force && Date.now() - reportCache.at < 60000) return reportCache.n;
  const [{ count, error }, fb] = await Promise.all([
    sb.from('question_reports').select('id', { count: 'exact', head: true }).in('status', ACTIVE_REPORT),
    sb.from('feedback').select('id', { count: 'exact', head: true }).neq('status', 'closed'),
  ]);
  if (error) { if (!missingInDb(error)) console.warn(error); return 0; }
  reportCache.n = (count || 0) + (fb.error ? 0 : fb.count || 0); reportCache.fb = fb.error ? 0 : fb.count || 0; reportCache.at = Date.now();
  return reportCache.n;
}
async function paintReportBadge() {
  const n = await openReportCount();
  document.querySelectorAll('a[data-nav="admin"]').forEach((a) => {
    a.querySelector('.nbadge')?.remove();
    if (n) a.insertAdjacentHTML('beforeend', `<span class="nbadge" aria-label="${n} open report${n > 1 ? 's' : ''}">${n > 99 ? '99+' : n}</span>`);
  });
  const tab = document.querySelector('[data-tab-badge]'); if (tab) tab.textContent = n ? String(n) : '';
}
const reportsHomeCard = (n) => `<section class="card update" aria-labelledby="rpH">
  <div class="row-between"><h2 id="rpH">${icon('alert')}${n} question report${n > 1 ? 's' : ''} to check</h2>
  <a class="btn primary sm" href="#/admin/reports">Open reports ${icon('right')}</a></div>
  <p class="muted" style="margin:0">Learners flagged possible mistakes. Check each question against the university file, then fix it or mark it as no change needed.</p></section>`;

/* ---------- Conversations: question reports and feedback share one thread format ---------- */

const FEEDBACK_STATUS = { open: ['New', 'warn'], in_review: ['Under review', 'pri'], closed: ['Closed', 'ok'] };
const FEEDBACK_KIND = { feedback: 'Feedback', suggestion: 'Suggestion' };
/** ticket_messages for these reports / feedback ids, grouped as 'r<id>' / 'f<id>' → [messages oldest first]. */
async function loadThreads(reportIds, feedbackIds) {
  const out = new Map();
  const get = async (col, ids) => (ids.length ? inChunks(ids, 100, (c) => fetchAll(() => sb.from('ticket_messages').select('id,report_id,feedback_id,author,from_admin,body,created_at').in(col, c).order('created_at'))) : []);
  const [a, b] = await Promise.all([get('report_id', reportIds), get('feedback_id', feedbackIds)]).catch(() => [[], []]);
  for (const m of [...a, ...b]) { const k = m.report_id ? 'r' + m.report_id : 'f' + m.feedback_id; if (!out.has(k)) out.set(k, []); out.get(k).push(m); }
  return out;
}
/** A conversation: the learner's first message, then the replies. `nameOf(msg)` labels each one. */
function threadHtml(first, msgs, nameOf) {
  const one = (who, mine, body, at) => `<li class="msg ${mine ? 'admin' : 'learner'}"><div class="msg-head"><b>${esc(who)}</b><span class="muted small">${esc(fmtDate(at))}</span></div><p>${esc(body)}</p></li>`;
  return `<ol class="thread">${first ? one(first.who, false, first.body, first.at) : ''}${msgs.map((m) => one(nameOf(m), m.from_admin, m.body, m.created_at)).join('')}</ol>`;
}
async function sendMessage(ticket, body) {
  const row = ticket.type === 'r' ? { report_id: ticket.id, body } : { feedback_id: ticket.id, body };
  check(await sb.from('ticket_messages').insert(row));
}

/* ---------- Learner: feedback & suggestions, and their question reports ---------- */

async function renderFeedback(param) {
  const view = shell('feedback', loading);
  const uid = state.profile.id;
  const [fb, reps] = await Promise.all([
    sb.from('feedback').select('id,kind,subject,body,status,created_at,updated_at,closed_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(200),
    sb.from('question_reports').select('id,question_id,comment,status,created_at,resolved_at').eq('user_id', uid).order('created_at', { ascending: false }).limit(200),
  ]);
  if (fb.error && missingInDb(fb.error)) { view.innerHTML = `<div class="card empty">${icon('chat')}<h2>Feedback isn't switched on yet</h2><p class="muted">Please check back soon.</p></div>`; return; }
  const feedback = check(fb); const reports = reps.error ? [] : reps.data;
  const threads = await loadThreads(reports.map((r) => r.id), feedback.map((f) => f.id));
  const qs = reports.length ? await fetchQuestions([...new Set(reports.map((r) => r.question_id))]).catch(() => []) : [];
  const qById = new Map(qs.map((q) => [q.id, q]));
  const tickets = [
    ...feedback.map((f) => ({ type: 'f', id: f.id, title: f.subject, tag: FEEDBACK_KIND[f.kind], status: FEEDBACK_STATUS[f.status], active: f.status !== 'closed', created: f.created_at, closedAt: f.closed_at, first: f.body })),
    ...reports.map((r) => { const q = qById.get(r.question_id); return { type: 'r', id: r.id, title: q ? (q.question.length > 90 ? q.question.slice(0, 90) + '…' : q.question) : `Question #${r.question_id}`, tag: 'Question report', status: REPORT_STATUS[r.status], active: ACTIVE_REPORT.includes(r.status), created: r.created_at, closedAt: r.resolved_at, first: r.comment }; }),
  ].map((t) => { const m = threads.get(t.type + t.id) || []; return { ...t, msgs: m, last: m.length ? m[m.length - 1].created_at : t.created }; })
    .sort((a, b) => (a.active === b.active ? Date.parse(b.last) - Date.parse(a.last) : a.active ? -1 : 1));
  const openKey = param || '';
  const card = (t) => {
    const lastAdmin = t.msgs.length && t.msgs[t.msgs.length - 1].from_admin;
    return `<li><details class="card ticket" id="t-${t.type}${t.id}" ${openKey === t.type + t.id ? 'open' : ''}>
      <summary><div class="row-between"><span><span class="chip">${esc(t.tag)}</span> <b>${esc(t.title)}</b></span>
        <span>${lastAdmin && t.active ? '<span class="chip pri">Admin replied</span> ' : ''}<span class="chip ${t.status[1]}">${esc(t.status[0])}</span></span></div>
        <span class="muted small">Started ${esc(fmtDate(t.created))} · ${t.msgs.length} repl${t.msgs.length === 1 ? 'y' : 'ies'}</span></summary>
      ${threadHtml({ who: 'You', body: t.first, at: t.created }, t.msgs, (m) => (m.from_admin ? 'Admin' : 'You'))}
      ${t.active ? `<form class="reply-form" data-ticket="${t.type}${t.id}" novalidate>
          <label class="field"><span class="sr">Your reply</span><textarea name="body" rows="2" maxlength="2000" placeholder="Write a reply to the admin"></textarea></label>
          <div class="btn-row"><button class="btn primary sm" type="submit">${icon('right')}Send reply</button></div><p class="form-error" role="alert"></p></form>`
        : `<p class="muted small">Closed by the admin${t.closedAt ? ` on ${esc(longDate(t.closedAt))}` : ''}. Start a new conversation below if you need more help.</p>`}
    </details></li>`;
  };
  view.innerHTML = `<div class="page-head"><div><h1>Feedback</h1><p class="muted">Tell the admin what works, what doesn't, or what you'd like added. You can keep talking in each conversation until the admin closes it. Your question reports are here too.</p></div></div>
    <form class="card" id="fbForm" novalidate>
      <h2>${icon('chat')}New feedback or suggestion</h2>
      <fieldset class="field"><legend>Type</legend><div class="btn-row">
        <label class="radio"><input type="radio" name="kind" value="feedback" checked> Feedback</label>
        <label class="radio"><input type="radio" name="kind" value="suggestion"> Suggestion</label></div></fieldset>
      <label class="field">Subject<input type="text" name="subject" maxlength="120" required placeholder="For example: Timer in practice mode"></label>
      <label class="field">Message<textarea name="body" rows="4" maxlength="2000" required placeholder="What happened, or what would help you?"></textarea></label>
      <div class="btn-row"><button class="btn primary" type="submit">${icon('right')}Send to the admin</button></div>
      <p class="form-error" role="alert"></p>
    </form>
    <section aria-labelledby="fbList"><h2 id="fbList">Your conversations</h2>
      ${tickets.length ? `<ol class="tickets">${tickets.map(card).join('')}</ol>` : '<p class="muted">Nothing yet. Feedback you send, and questions you report, show up here.</p>'}</section>`;

  const target = openKey && view.querySelector('#t-' + CSS.escape(openKey)); if (target) target.scrollIntoView({ block: 'start' });
  const f = view.querySelector('#fbForm');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const subject = f.subject.value.trim(); const body = f.body.value.trim(); const err = f.querySelector('.form-error');
    if (subject.length < 3) { err.textContent = 'Add a short subject (at least 3 characters).'; f.subject.focus(); return; }
    if (body.length < 3) { err.textContent = 'Write your message (at least 3 characters).'; f.body.focus(); return; }
    const btn = f.querySelector('[type=submit]'); btn.disabled = true;
    try {
      const row = check(await sb.from('feedback').insert({ kind: f.kind.value, subject, body }).select('id').single());
      toast('Sent. The admin will reply here.', 'ok');
      const to = '#/feedback/f' + row.id; if (location.hash === to) renderFeedback('f' + row.id); else location.hash = to;
    } catch (x) { btn.disabled = false; err.textContent = errMsg(x); }
  };
  view.querySelectorAll('.reply-form').forEach((rf) => (rf.onsubmit = async (e) => {
    e.preventDefault();
    const body = rf.body.value.trim(); if (!body) { rf.querySelector('.form-error').textContent = 'Write a reply first.'; return; }
    const key = rf.dataset.ticket; const btn = rf.querySelector('[type=submit]'); btn.disabled = true;
    try { await sendMessage({ type: key[0], id: +key.slice(1) }, body); toast('Reply sent.', 'ok'); renderFeedback(key); }
    catch (x) { btn.disabled = false; rf.querySelector('.form-error').textContent = errMsg(x); }
  }));
}

/* ---------- Admin: reports ---------- */

const REPORT_STATUS = { open: ['New', 'warn'], in_review: ['Under review', 'pri'], fixed: ['Closed: fixed', 'ok'], no_change: ['Closed: no change needed', ''] };

async function renderAdminReports() {
  const view = shell('admin', loading);
  const meta = await loadMeta(true);
  const ui = state.rui || (state.rui = { status: 'open', kind: 'reports' });
  if (ui.kind === 'feedback') return renderAdminFeedback(view, ui);
  let q = sb.from('question_reports').select('id,question_id,user_id,comment,shown_order,status,awaiting_admin,admin_reply,replied_at,created_at,resolved_at').order('created_at', { ascending: false }).limit(500);
  if (ui.status === 'open') q = q.in('status', ACTIVE_REPORT); else if (ui.status === 'done') q = q.in('status', ['fixed', 'no_change']);
  const { data: reps, error } = await q;
  if (error) {
    if (missingInDb(error)) { view.innerHTML = adminTabs('reports') + `<section class="card"><h2>${icon('alert')} Reports aren't switched on yet</h2><p class="muted">Run <code>supabase/migration_006_notices_reports.sql</code> in the Supabase SQL Editor, then reload.</p></section>`; return; }
    throw error;
  }
  // Admin-only notes live in their own table, which learners can't read.
  if (reps.length) {
    const { data: notes } = await sb.from('report_notes').select('report_id,note').in('report_id', reps.map((r) => r.id));
    const byId = new Map((notes || []).map((n) => [n.report_id, n.note]));
    reps.forEach((r) => { r.admin_note = byId.get(r.id) || null; });
  }
  const qids = [...new Set(reps.map((r) => r.question_id))];
  const uids = [...new Set(reps.map((r) => r.user_id))];
  const [qs, people] = await Promise.all([
    qids.length ? inChunks(qids, 100, (c) => fetchAll(() => sb.from('questions').select(QCOLS + ',active').in('id', c))) : [],
    uids.length ? inChunks(uids, 100, (c) => fetchAll(() => sb.from('profiles').select('id,full_name,email').in('id', c))) : [],
  ]);
  const qById = new Map(qs.map((x) => [x.id, x])); const who = new Map(people.map((p) => [p.id, p.full_name || p.email]));
  // Read receipts: the newest notification per report
  const seen = new Map();
  if (reps.length) {
    const ns = await inChunks(reps.map((r) => r.id), 100, (c) => fetchAll(() => sb.from('notifications').select('report_id,created_at,seen_at').in('report_id', c).order('created_at', { ascending: false }))).catch(() => []);
    ns.forEach((n) => { if (!seen.has(n.report_id)) seen.set(n.report_id, n); });
  }
  const groups = qids.map((id) => ({ q: qById.get(id), id, reps: reps.filter((r) => r.question_id === id) }));
  const nOpen = await openReportCount(true);
  const threads = await loadThreads(reps.map((r) => r.id), []);
  const adminName = (m) => (m.from_admin ? (m.author === state.profile.id ? 'You' : 'Admin') : who.get(m.author) || 'Learner');

  const seenAs = (order, q) => (order && order.length && q ? order.map((orig, pos) => `${LETTERS[pos]}=${LETTERS[orig] || '?'}`).join(' · ') : '');
  const repLine = (r, q) => `<li class="rep">
      <div class="row-between"><span><b>${esc(who.get(r.user_id) || 'Learner')}</b> <span class="muted small">${esc(fmtDate(r.created_at))}</span></span><span class="chip ${REPORT_STATUS[r.status][1]}">${REPORT_STATUS[r.status][0]}</span></div>
      <p class="rep-comment">${esc(r.comment)}</p>
      ${seenAs(r.shown_order, q) ? `<p class="muted small" style="margin:0">Their letters → letters below: ${esc(seenAs(r.shown_order, q))}</p>` : ''}
      ${r.admin_note ? `<p class="small muted" style="margin:6px 0 0">Your note (admin only): ${esc(r.admin_note)}</p>` : ''}
      ${(threads.get('r' + r.id) || []).length ? threadHtml(null, threads.get('r' + r.id), adminName) : r.admin_reply ? `<div class="rep-reply"><span class="small muted">Your reply · ${esc(fmtDate(r.replied_at))}</span><p>${esc(r.admin_reply)}</p></div>` : ''}
      ${r.awaiting_admin && ACTIVE_REPORT.includes(r.status) && (threads.get('r' + r.id) || []).length ? '<p><span class="chip warn">Learner replied · waiting for you</span></p>' : ''}
      ${seen.get(r.id) ? `<p class="small muted" style="margin:4px 0 0">${icon('eye')} ${seen.get(r.id).seen_at ? `Seen by ${esc(who.get(r.user_id) || 'the learner')} · ${esc(fmtDate(seen.get(r.id).seen_at))}` : 'Notification not seen yet'}</p>` : ''}
      <div class="btn-row" style="margin-top:8px"><button class="btn sm" type="button" data-reply="${r.id}">${icon('chat')}${ACTIVE_REPORT.includes(r.status) ? 'Message / change status' : 'Reopen or message'}</button></div>
      <div class="rep-form" data-form="${r.id}" hidden></div>
    </li>`;
  const groupCard = (g) => {
    const q = g.q; const topic = q && meta.topicById.get(q.category_id); const disc = topic && meta.discById.get(topic.discipline_id);
    const open = g.reps.filter((r) => ACTIVE_REPORT.includes(r.status)).length;
    return `<li class="card rgroup" data-q="${g.id}">
      ${q ? `<div class="qmeta">${disc ? `<span class="chip pri">${esc(disc.name)}</span>` : ''}${topic && topic.name !== disc?.name ? `<span class="chip">${esc(topic.name)}</span>` : ''}<span class="chip">${q.qtype}</span><span class="chip">#${q.id}</span>${q.active ? '' : '<span class="chip warn">hidden</span>'}</div>
      <p class="rq" style="font-weight:600">${esc(q.question)}</p>
      <ul class="ropts" style="list-style:none;padding:0">${q.options.map((o, i) => `<li class="${q.correct.includes(i) ? 'c' : ''}" style="display:flex;gap:8px"><b>${LETTERS[i]}</b><span>${esc(o)}</span>${q.correct.includes(i) ? '<span class="tag">Correct</span>' : ''}</li>`).join('')}</ul>`
      : `<p class="muted">This question was deleted.</p>`}
      <h3 class="small" style="margin:12px 0 6px">${g.reps.length} report${g.reps.length > 1 ? 's' : ''}${open && open !== g.reps.length ? ` · ${open} open` : ''}</h3>
      <ul class="reps">${g.reps.map((r) => repLine(r, q)).join('')}</ul>
      <div class="qedit"></div>
      ${open ? `<div class="resolve">
        <label class="field" style="margin:12px 0 8px">Note to keep with the reports<span class="help">Admin only, e.g. what you changed. Learners never see it. To write to a learner, use Message / change status on their report.</span><input type="text" maxlength="300" class="rnote"></label>
        <div class="btn-row">${q ? `<button class="btn" data-act="edit">${icon('layers')}Edit question</button>` : ''}<button class="btn primary" data-act="fixed">${icon('check')}Close all as fixed</button><button class="btn ghost" data-act="no_change">Close all: no change needed</button></div>
        <p class="muted small" style="margin:6px 0 0">Closing notifies each learner who reported this question.</p></div>` : ''}
    </li>`;
  };

  view.innerHTML = `${adminTabs('reports')}
    ${ticketSwitch(ui)}
    <div class="row-between"><h1 style="margin:0">Question reports</h1>
      <div class="seg" role="group" aria-label="Show">${[['open', `Active (${nOpen})`], ['done', 'Closed'], ['all', 'All']].map(([k, l]) => `<button class="btn sm ${ui.status === k ? 'primary' : 'ghost'}" data-status="${k}" aria-pressed="${ui.status === k}">${l}</button>`).join('')}</div></div>
    <p class="muted">Learners report questions they think are wrong. Check the question against the university file and edit it if needed. Message each learner and set the report to Under review or Closed: they get a notification and can reply until you close it. Past answers are not re-scored.</p>
    ${groups.length ? `<ol class="rlist">${groups.map(groupCard).join('')}</ol>` : `<div class="card empty">${icon('check')}<h2>${ui.status === 'open' ? 'No open reports' : 'Nothing here'}</h2><p class="muted">${ui.status === 'open' ? 'When a learner reports a question, it shows up here.' : ''}</p></div>`}`;
  paintReportBadge();

  view.querySelectorAll('[data-status]').forEach((b) => (b.onclick = () => { ui.status = b.dataset.status; renderAdminReports(); }));
  wireTicketSwitch(view, ui);
  view.querySelectorAll('.rgroup').forEach((card) => {
    const id = +card.dataset.q; const g = groups.find((x) => x.id === id);
    card.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
      if (b.dataset.act === 'edit') {
        questionEditor(card.querySelector('.qedit'), meta, g.q, { onSaved: () => { toast('Question saved. Now mark the report as fixed.', 'ok'); state.meta = null; renderAdminReports(); } });
        return;
      }
      b.disabled = true;
      const note = card.querySelector('.rnote')?.value.trim() || null;
      try {
        const { data: closed, error: upErr } = await sb.from('question_reports').update({ status: b.dataset.act, resolved_at: new Date().toISOString(), resolved_by: state.profile.id }).eq('question_id', id).in('status', ACTIVE_REPORT).select('id');
        check({ error: upErr });
        if (note && closed?.length) check(await sb.from('report_notes').upsert(closed.map((x) => ({ report_id: x.id, note, updated_at: new Date().toISOString(), updated_by: state.profile.id })), { onConflict: 'report_id' }));
        toast(b.dataset.act === 'fixed' ? 'Closed as fixed. Reporters were notified.' : 'Closed as no change needed. Reporters were notified.', 'ok');
        reportCache.at = 0; renderAdminReports();
      } catch (err) { b.disabled = false; toast(errMsg(err), 'bad'); }
    }));
  });

  // Per-report reply + status (works for any report, new or old)
  view.querySelectorAll('[data-reply]').forEach((b) => (b.onclick = () => {
    const r = reps.find((x) => x.id === +b.dataset.reply); const box = view.querySelector(`[data-form="${r.id}"]`);
    if (!box.hidden) { box.hidden = true; return; }
    const next = r.status === 'open' ? 'in_review' : r.status;
    box.innerHTML = `<form novalidate>
        <label class="field">Message to ${esc(who.get(r.user_id) || 'the learner')}<span class="help">They get a notification and can reply until you close the report. Optional when you only change the status.</span>
          <textarea name="reply" rows="3" maxlength="2000" placeholder="For example: Thanks, you were right. Option C was cut off and is now fixed."></textarea></label>
        <fieldset class="field"><legend>Status</legend><div class="btn-row">
          ${[['in_review', 'Under review'], ['fixed', 'Closed: fixed'], ['no_change', 'Closed: no change needed']].map(([k, l]) => `<label class="radio"><input type="radio" name="st" value="${k}" ${next === k ? 'checked' : ''}> ${l}</label>`).join('')}
        </div></fieldset>
        <div class="btn-row"><button class="btn primary" type="submit">${icon('check')}Send to learner</button><button class="btn ghost" type="button" data-cancel>Cancel</button></div>
        <p class="form-error" role="alert"></p></form>`;
    box.hidden = false;
    const f = box.querySelector('form'); f.reply.focus();
    f.querySelector('[data-cancel]').onclick = () => { box.hidden = true; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      const reply = f.reply.value.trim(); const status = f.st.value;
      if (!reply && status === r.status) { f.querySelector('.form-error').textContent = 'Write a message or choose a different status.'; return; }
      const btn = f.querySelector('[type=submit]'); btn.disabled = true;
      try {
        if (reply) await sendMessage({ type: 'r', id: r.id }, reply);
        if (status !== r.status) check(await sb.from('question_reports').update({ status }).eq('id', r.id));
        toast(`Sent to ${who.get(r.user_id) || 'the learner'}.`, 'ok');
        reportCache.at = 0; renderAdminReports();
      } catch (err) { btn.disabled = false; f.querySelector('.form-error').textContent = errMsg(err); }
    };
  }));
}

function ticketSwitch(ui) {
  const nFb = reportCache.fb || 0;
  return `<div class="seg" role="group" aria-label="Kind" style="margin:0 0 12px">${[['reports', 'Question reports'], ['feedback', `Feedback & suggestions${nFb ? ` (${nFb})` : ''}`]].map(([k, l]) => `<button class="btn sm ${ui.kind === k ? 'primary' : 'ghost'}" data-kind="${k}" aria-pressed="${ui.kind === k}">${l}</button>`).join('')}</div>`;
}
function wireTicketSwitch(view, ui) {
  view.querySelectorAll('[data-kind]').forEach((b) => (b.onclick = () => { ui.kind = b.dataset.kind; renderAdminReports(); }));
}

async function renderAdminFeedback(view, ui) {
  let q = sb.from('feedback').select('id,user_id,kind,subject,body,status,awaiting_admin,created_at,updated_at,closed_at').order('updated_at', { ascending: false }).limit(300);
  if (ui.status === 'open') q = q.neq('status', 'closed'); else if (ui.status === 'done') q = q.eq('status', 'closed');
  const { data, error } = await q;
  if (error) { view.innerHTML = adminTabs('reports') + ticketSwitch(ui) + `<section class="card"><p class="muted">${missingInDb(error) ? 'Feedback is not switched on yet (migration 014).' : esc(errMsg(error))}</p></section>`; wireTicketSwitch(view, ui); return; }
  const list = data || [];
  await openReportCount(true);
  const uids = [...new Set(list.map((f) => f.user_id))];
  const [people, threads] = await Promise.all([
    uids.length ? inChunks(uids, 100, (c) => fetchAll(() => sb.from('profiles').select('id,full_name,email').in('id', c))) : [],
    loadThreads([], list.map((f) => f.id)),
  ]);
  const who = new Map(people.map((p) => [p.id, p.full_name || p.email]));
  const nameOf = (m) => (m.from_admin ? (m.author === state.profile.id ? 'You' : 'Admin') : who.get(m.author) || 'Learner');
  const nActive = list.filter((f) => f.status !== 'closed').length;
  const card = (f) => {
    const [label, cls] = FEEDBACK_STATUS[f.status]; const msgs = threads.get('f' + f.id) || [];
    return `<li class="card ticket admin" data-fb="${f.id}">
      <div class="row-between"><span><span class="chip">${esc(FEEDBACK_KIND[f.kind])}</span> <b>${esc(f.subject)}</b></span>
        <span>${f.awaiting_admin && f.status !== 'closed' ? '<span class="chip warn">Waiting for you</span> ' : ''}<span class="chip ${cls}">${esc(label)}</span></span></div>
      <p class="muted small" style="margin:4px 0 8px">From <b>${esc(who.get(f.user_id) || 'Learner')}</b> · ${esc(fmtDate(f.created_at))}</p>
      ${threadHtml({ who: who.get(f.user_id) || 'Learner', body: f.body, at: f.created_at }, msgs, nameOf)}
      <form class="rep-form" novalidate>
        <label class="field">Message to ${esc(who.get(f.user_id) || 'the learner')}<span class="help">They get a notification and can reply until you close this.</span>
          <textarea name="reply" rows="2" maxlength="2000"></textarea></label>
        <fieldset class="field"><legend>Status</legend><div class="btn-row">
          ${[['in_review', 'Under review'], ['closed', 'Closed']].concat(f.status === 'open' ? [['open', 'Leave as New']] : []).map(([k, l]) => `<label class="radio"><input type="radio" name="st" value="${k}" ${(f.status === 'open' ? 'in_review' : f.status) === k ? 'checked' : ''}> ${l}</label>`).join('')}
        </div></fieldset>
        <div class="btn-row"><button class="btn primary sm" type="submit">${icon('check')}Send</button></div><p class="form-error" role="alert"></p></form>
    </li>`;
  };
  view.innerHTML = `${adminTabs('reports')}${ticketSwitch(ui)}
    <div class="row-between"><h1 style="margin:0">Feedback &amp; suggestions</h1>
      <div class="seg" role="group" aria-label="Show">${[['open', `Active (${nActive})`], ['done', 'Closed'], ['all', 'All']].map(([k, l]) => `<button class="btn sm ${ui.status === k ? 'primary' : 'ghost'}" data-status="${k}" aria-pressed="${ui.status === k}">${l}</button>`).join('')}</div></div>
    <p class="muted">Learners send these from the Feedback page. Reply as often as you need; the conversation stays open for both of you until you close it.</p>
    ${list.length ? `<ol class="tickets">${list.map(card).join('')}</ol>` : `<div class="card empty">${icon('chat')}<h2>${ui.status === 'open' ? 'No open feedback' : 'Nothing here'}</h2></div>`}`;
  paintReportBadge(); wireTicketSwitch(view, ui);
  view.querySelectorAll('[data-status]').forEach((b) => (b.onclick = () => { ui.status = b.dataset.status; renderAdminReports(); }));
  view.querySelectorAll('[data-fb]').forEach((li) => {
    const f = list.find((x) => x.id === +li.dataset.fb); const form = li.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const reply = form.reply.value.trim(); const status = form.st.value;
      if (!reply && status === f.status) { form.querySelector('.form-error').textContent = 'Write a message or choose a different status.'; return; }
      const btn = form.querySelector('[type=submit]'); btn.disabled = true;
      try {
        if (reply) await sendMessage({ type: 'f', id: f.id }, reply);
        if (status !== f.status) check(await sb.from('feedback').update({ status }).eq('id', f.id));
        toast(status === 'closed' ? 'Sent and closed.' : 'Sent.', 'ok'); reportCache.at = 0; renderAdminReports();
      } catch (x) { btn.disabled = false; form.querySelector('.form-error').textContent = errMsg(x); }
    };
  });
}

/* ---------- Notifications (bell) ---------- */

const bellCache = { n: 0, at: 0 };
async function unseenCount(force = false) {
  if (!force && Date.now() - bellCache.at < 60000) return bellCache.n;
  const [{ count, error }, notices] = await Promise.all([
    sb.from('notifications').select('id', { count: 'exact', head: true }).is('seen_at', null).eq('user_id', state.profile.id),
    unreadNoticeList(force).catch(() => []),
  ]);
  if (error && !missingInDb(error)) console.warn(error);
  bellCache.n = (error ? 0 : count || 0) + notices.length; bellCache.at = Date.now();
  return bellCache.n;
}
async function paintBell(force = false) {
  const n = state.profile ? await unseenCount(force) : 0;
  const b = document.getElementById('bellBtn'); if (!b) return;
  const badge = b.querySelector('.nbadge');
  badge.hidden = !n; badge.textContent = n > 99 ? '99+' : String(n);
  b.setAttribute('aria-label', n ? `Notifications, ${n} new` : 'Notifications');
}
const NOTE_TEXT = {
  in_review: 'The admin is checking your report.',
  fixed: 'Your report was checked and the question was corrected.',
  no_change: 'Your report was checked. The question matches the university file, so it stays as it is.',
  open: 'Your report is waiting to be checked.',
};
async function openNotifications() {
  document.querySelector('.modal-back')?.remove();
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="card modal notif" role="dialog" aria-modal="true" aria-labelledby="ntH">
      <div class="row-between"><h2 id="ntH" style="margin:0">${icon('bell')}Notifications</h2><button class="btn ghost sm" type="button" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="notif-body">${loading}</div></div>`;
  document.body.appendChild(back);
  const opener = document.activeElement;
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); if (opener && opener.isConnected) opener.focus({ preventScroll: true }); };
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  back.querySelector('[data-close]').onclick = close; back.querySelector('[data-close]').focus();
  const body = back.querySelector('.notif-body');
  try {
    const [notices, res] = await Promise.all([
      unreadNoticeList(true),
      sb.from('notifications')
        .select('id,created_at,kind,report_id,feedback_id,question_reports(id,question_id,comment,status,admin_reply),feedback(id,kind,subject,status)')
        .eq('user_id', state.profile.id).is('seen_at', null).order('created_at', { ascending: false }).limit(50),
    ]);
    if (res.error && !missingInDb(res.error)) throw res.error;
    const all = (res.data || []).filter((n) => n.question_reports || n.feedback);
    const items = all.filter((n, i) => all.findIndex((x) => (x.report_id || 'f' + x.feedback_id) === (n.report_id || 'f' + n.feedback_id)) === i);
    // Latest message from the admin on each ticket
    const lastMsg = new Map();
    const rIds = items.filter((n) => n.report_id).map((n) => n.report_id); const fIds = items.filter((n) => n.feedback_id).map((n) => n.feedback_id);
    if (rIds.length || fIds.length) {
      const [mr, mf] = await Promise.all([
        rIds.length ? sb.from('ticket_messages').select('report_id,body,created_at').eq('from_admin', true).in('report_id', rIds).order('created_at', { ascending: false }) : { data: [] },
        fIds.length ? sb.from('ticket_messages').select('feedback_id,body,created_at').eq('from_admin', true).in('feedback_id', fIds).order('created_at', { ascending: false }) : { data: [] },
      ]);
      for (const m of mr.data || []) if (!lastMsg.has('r' + m.report_id)) lastMsg.set('r' + m.report_id, m.body);
      for (const m of mf.data || []) if (!lastMsg.has('f' + m.feedback_id)) lastMsg.set('f' + m.feedback_id, m.body);
    }
    if (!items.length && !notices.length) {
      body.innerHTML = `<div class="empty" style="padding:24px 8px">${icon('check')}<p class="muted" style="margin:8px 0 0">You're all caught up. New notices, and answers from the admin to your reports and feedback, show up here.</p></div>`;
    } else {
      const qs = items.some((n) => n.question_reports) ? await fetchQuestions([...new Set(items.filter((n) => n.question_reports).map((n) => n.question_reports.question_id))]).catch(() => []) : [];
      const qById = new Map(qs.map((q) => [q.id, q]));
      const noticeHtml = notices.map((u) => `<li class="notif-item notice" data-notice="${esc(u.id)}">
          <div class="row-between"><b>${icon('shield')}${esc(u.title)}</b><span class="chip warn">Unread</span></div>
          ${noticeBody(u)}
          <div class="row-between"><span class="muted small">Issued by <b>${esc(u.issuer)}</b> · ${esc(longDate(u.show_from))}</span><button class="btn primary sm" type="button" data-got="${esc(u.id)}">Got it</button></div>
        </li>`).join('');
      const itemHtml = items.map((n) => {
        if (n.feedback) {
          const f = n.feedback; const [label, cls] = FEEDBACK_STATUS[f.status] || [f.status, ''];
          const msg = lastMsg.get('f' + f.id);
          return `<li class="notif-item">
            <div class="row-between"><b>Your ${f.kind === 'suggestion' ? 'suggestion' : 'feedback'}: ${esc(f.subject)}</b><span class="chip ${cls}">${esc(label)}</span></div>
            ${msg ? `<div class="rep-reply"><span class="small muted">Latest from the admin</span><p>${esc(msg)}</p></div>` : `<p class="small" style="margin:8px 0 0">${f.status === 'closed' ? 'The admin closed this conversation.' : 'The admin updated this conversation.'}</p>`}
            <p class="small muted" style="margin:8px 0 0">${esc(fmtDate(n.created_at))}</p>
            <div class="btn-row" style="margin-top:8px"><a class="btn sm" href="#/feedback/f${f.id}" data-go>${icon('chat')}Open conversation</a></div>
          </li>`;
        }
        const r = n.question_reports; const q = qById.get(r.question_id); const [label, cls] = REPORT_STATUS[r.status] || [r.status, ''];
        const msg = lastMsg.get('r' + r.id) || r.admin_reply;
        return `<li class="notif-item">
          <div class="row-between"><b>Your question report</b><span class="chip ${cls}">${esc(label)}</span></div>
          ${q ? `<p class="small muted" style="margin:6px 0 0">${esc(q.question.length > 160 ? q.question.slice(0, 160) + '…' : q.question)}</p>` : ''}
          <p class="small" style="margin:8px 0 0">${esc(NOTE_TEXT[r.status] || '')}</p>
          ${msg ? `<div class="rep-reply"><span class="small muted">Latest from the admin</span><p>${esc(msg)}</p></div>` : ''}
          <p class="small muted" style="margin:8px 0 0">You wrote: "${esc(r.comment.length > 140 ? r.comment.slice(0, 140) + '…' : r.comment)}" · ${esc(fmtDate(n.created_at))}</p>
          <div class="btn-row" style="margin-top:8px"><a class="btn sm" href="#/feedback/r${r.id}" data-go>${icon('chat')}Open conversation</a>${q ? `<button class="btn sm" type="button" data-try="${q.id}">${icon('book')}Practice this question</button>` : ''}</div>
        </li>`; }).join('');
      body.innerHTML = `${notices.length ? `<h3 class="small" style="margin:8px 0">Notices</h3><p class="muted small" style="margin:0 0 8px">These stay here until you press Got it.</p><ul class="notif-list">${noticeHtml}</ul>` : ''}
        ${items.length ? `<h3 class="small" style="margin:16px 0 8px">Replies and updates</h3><p class="muted small" style="margin:0 0 8px">These disappear once you close this panel.</p><ul class="notif-list">${itemHtml}</ul>` : ''}`;
      body.querySelectorAll('[data-got]').forEach((b) => (b.onclick = () => {
        markNoticeRead(b.dataset.got);
        b.closest('.notif-item')?.remove();
        if (!body.querySelector('.notif-item')) body.innerHTML = `<div class="empty" style="padding:24px 8px">${icon('check')}<p class="muted" style="margin:8px 0 0">You're all caught up.</p></div>`;
      }));
      body.querySelectorAll('[data-go]').forEach((a) => a.addEventListener('click', () => close()));
      body.querySelectorAll('[data-try]').forEach((b) => (b.onclick = async () => {
        b.disabled = true; const q = qById.get(+b.dataset.try);
        try { close(); await startTutor([q], 'Reported question', null); } catch (e) { toast(errMsg(e), 'bad'); }
      }));
      // Replies and updates: viewed now, so they leave the panel next time. Notices wait for Got it.
      if (items.length) {
        const { error: e2 } = await sb.from('notifications').update({ seen_at: new Date().toISOString() }).in('id', all.map((n) => n.id));
        if (e2) console.warn(e2);
      }
    }
  } catch (e) {
    body.innerHTML = `<p class="form-error" style="margin:12px 0 0">${esc(errMsg(e))}</p>`;
  }
  bellCache.at = 0; paintBell(true);
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

async function renderSession() {
  if (!state.run) { try { if ((await loadDrafts()).practice) await resumePractice(); } catch (e) { console.warn(e); } }
  const run = state.run;
  if (!run) { location.hash = '#/practice'; return; }
  savePractice(run);
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
          <div class="qmeta">${disc ? `<span class="chip pri">${esc(disc.name)}</span>` : ''}${topic && topic.name !== disc?.name ? `<span class="chip">${esc(topic.name)}</span>` : ''}<span class="chip">${multi ? 'Multiple answers' : 'Single answer'}</span><button class="btn ghost sm mark-btn" id="markBtn" aria-pressed="${!!state.marks?.has(q.id)}">${icon('flag')}${state.marks?.has(q.id) ? 'Marked' : 'Mark'}</button>${reportBtn(q, it.order)}</div>
          <h1 class="qtext" id="qtext">${esc(q.question)}</h1>
          <p class="qhint">${multi ? 'Select all correct answers, then check.' : 'Select one answer.'}</p>
          <div class="options" role="${multi ? 'group' : 'radiogroup'}" aria-labelledby="qtext">${optionButtons(it, { reveal: it.done })}</div>
          <div class="run-actions" id="actions"></div>
          <div class="feedback" id="feedback" aria-live="polite"></div>
        </article>
        <p class="keys-hint">Keys: A–${LETTERS[q.options.length - 1]} choose · Enter ${multi ? 'check / ' : ''}next · M mark</p>
      </div>
    </div>`);

  view.querySelector('#markBtn').onclick = async (ev) => {
    const b = ev.currentTarget; b.disabled = true;
    const on = await toggleMark(q.id);
    b.disabled = false; b.setAttribute('aria-pressed', String(on)); b.innerHTML = `${icon('flag')}${on ? 'Marked' : 'Mark'}`;
  };
  view.querySelector('#quit').onclick = () => {
    const answered = run.items.filter((x) => x.done).length;
    if (!answered || confirm('End this session? Your answers so far are saved.')) { run.ended = true; renderSessionSummary(); }
  };
  const actions = view.querySelector('#actions');
  const fb = view.querySelector('#feedback');

  const save = async () => {
    const { data, error } = await sb.rpc('record_answer', { p_question_id: q.id, p_selected: [...it.sel], p_session_id: run.sessionId });
    it.saved = !error;
    if (error) { console.error(error); heartbeat(false, true); }
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
  if (state.drafts?.practice?.sessionId === run.sessionId) dropDraft('practice');
  const view = shell('practice', `
    <section class="card"><div class="result-head">
      <div class="ring" style="--p:${score};--c:var(${score >= 75 ? '--ok' : score >= 50 ? '--warn' : '--bad'})"><span>${score}%</span></div>
      <div style="flex:1;min-width:240px">
        <h1>${done.length ? (score >= 75 ? 'Strong session' : score >= 50 ? 'Good progress' : 'Keep at it') : 'Session ended'}</h1>
        <p class="muted">${right} of ${done.length} correct${done.length < run.items.length ? ` · ${run.items.length - done.length} not answered` : ''} · ${esc(run.label)}</p>
        ${done.some((x) => x.saved === false) ? `<p class="chip bad">${icon('alert')}Some answers were not saved because of a connection problem.</p>` : ''}
        <div class="btn-row">
          ${run.opts ? `<button class="btn primary" id="again">${icon('retry')}New test, same settings</button>` : ''}
          ${wrong.length ? `<button class="btn" id="retryWrong">Retry the ${wrong.length} I missed</button>` : ''}
          <a class="btn ghost" href="#/practice">Change settings</a>
        </div>
      </div></div></section>
    ${wrong.length ? `<section class="card"><h2>Review your mistakes</h2><ol class="review">${wrong.map((it) => reviewItem(it)).join('')}</ol></section>` : ''}`);
  const again = view.querySelector('#again');
  if (again) again.onclick = async () => { again.disabled = true; try { if (!(await startTest(run.opts))) again.disabled = false; } catch (e) { toast(errMsg(e), 'bad'); again.disabled = false; } };
  const rw = view.querySelector('#retryWrong');
  if (rw) rw.onclick = () => startTutor(shuffle(wrong.map((x) => x.q)), 'Retry: ' + run.label, run.opts, true).catch((e) => toast(errMsg(e), 'bad'));
}

function reviewItem(it, meta = state.meta) {
  const q = it.q;
  const topic = meta?.topicById.get(q.category_id);
  const v = it.sel.size ? verdictFor(q, it.sel) : { cls: 'bad', text: 'Not answered', icon: 'x' };
  return `<li>
    <div class="qmeta"><span class="chip ${v.cls === 'ok' ? 'ok' : v.cls === 'part' ? 'warn' : 'bad'}">${icon(v.icon)}${v.text}</span>${typeof it.mark === 'number' ? `<span class="chip ${it.mark >= 1 ? 'ok' : it.mark > 0 ? 'warn' : 'bad'}">Mark ${it.mark > 0 ? '+' : ''}${fmtMark(it.mark)}</span>` : ''}${topic ? `<span class="chip">${esc(topic.name)}</span>` : ''}${it.flagged ? `<span class="chip warn">${icon('flag')}Marked</span>` : ''}${reportBtn(q, it.order, ' mark-btn')}</div>
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
  }
  if (k === 'M') { const b = document.getElementById('exFlag') || document.getElementById('markBtn'); if (b && !b.disabled) { e.preventDefault(); b.click(); } }
  {
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

const MOCK_POOLS = [
  ['new', 'New questions first', 'Unanswered questions, by the exam weights. Repeats come in only when a discipline has none left (your incorrect ones first).'],
  ['incorrect', 'Incorrect only', 'Second round: only questions you got wrong, still by the exam weights.'],
  ['any', 'Any questions', 'Random from the whole bank, ignoring what you have done.'],
];

/** Questions grouped by discipline, with this learner's status. */
function poolByDisc(meta, pool) {
  const by = new Map(meta.disciplines.map((d) => [d.id, { all: [], unused: [], incorrect: [], correct: [] }]));
  for (const q of pool) {
    const t = meta.topicById.get(q.cat); const g = t && by.get(t.discipline_id); if (!g) continue;
    g.all.push(q); g[q.status].push(q);
  }
  return by;
}

async function renderExamSetup() {
  const view = shell('exam', loading);
  const [meta, pool] = await Promise.all([loadMeta(), loadPool(), loadDrafts(true)]);
  const draft = state.drafts?.exam;
  const totalQs = sum(meta.disciplines.map((d) => d.total));
  if (!totalQs) { view.innerHTML = `<div class="card empty">${icon('exam')}<h2>No questions yet</h2></div>`; return; }
  const prefs = store.get(prefsKey()) || {};
  const size = String(prefs.examSize || 50);
  const timed = prefs.examTimed !== false;
  const by = poolByDisc(meta, pool);
  const nNew = pool.filter((q) => q.status === 'unused').length;
  const nWrong = pool.filter((q) => q.status === 'incorrect').length;
  const mpool = prefs.mockPool && (prefs.mockPool !== 'incorrect' || nWrong) ? prefs.mockPool : 'new';

  view.innerHTML = `
    <div class="page-head"><div><h1>Mock exam</h1><p class="muted">A paper built to the official exam weights. Answers are revealed after you submit.</p><p class="muted small">Scoring: single-answer questions score 1 or 0. Multi-answer questions give partial marks: each correct option you pick earns a share, each wrong option takes a share away, and a question can score below 0. Your final mark is out of 10: total marks ÷ number of questions × 10 (lowest 0). You can review your answers afterwards in Progress; answers are kept for your last 3 mock exams.</p></div></div>
    ${draft ? `<div class="card tight row-between" style="border-color:var(--warn)"><div class="row">${icon('clock')}<b>You have an unfinished test: ${esc(draft.label || '')}</b></div><div class="btn-row"><a class="btn primary" href="#/exam/run">Resume</a><button class="btn ghost" id="discard">Discard</button></div></div>` : ''}
    <div class="grid two">
      <section class="card" aria-labelledby="es">
        <fieldset><legend>Questions</legend>
          <div class="choices one">${MOCK_POOLS.map(([v, t, s]) => {
            const n = v === 'new' ? nNew : v === 'incorrect' ? nWrong : totalQs;
            return `<label class="choice"><input type="radio" name="mpool" value="${v}" ${mpool === v ? 'checked' : ''} ${v === 'incorrect' && !nWrong ? 'disabled' : ''}><span><b>${t} <span class="count num">(${n.toLocaleString()})</span></b><small>${s}</small></span></label>`;
          }).join('')}</div>
        </fieldset>
        <fieldset><legend id="es">Paper length</legend>
          <div class="choices">${[50, 100, 150, 200].map((n) => `<label class="choice"><input type="radio" name="size" value="${n}" ${size === String(n) ? 'checked' : ''}><span><b>${n} questions</b><small>${n === 50 ? 'One block' : n === 100 ? 'Half paper' : 'Stamina test'}</small></span></label>`).join('')}</div>
        </fieldset>
        <label class="choice" style="margin-bottom:16px"><input type="checkbox" id="timed" ${timed ? 'checked' : ''}><span><b>Timed</b><small>One minute per question. The paper submits itself when time runs out.</small></span></label>
        <p class="muted small" id="runway" aria-live="polite"></p>
        <button class="btn primary lg block" id="go">${icon('exam')}Start mock exam</button>
      </section>
      <section class="card" aria-labelledby="eb">
        <h2 id="eb">Exam blueprint</h2>
        <p class="muted small">From the 2026 graduation exam test collection. "In paper" updates with your choices.</p>
        <div class="table-wrap"><table><thead><tr><th>Discipline</th><th class="n">Weight</th><th class="n">In paper</th><th class="n">New left</th><th class="n">Incorrect</th></tr></thead><tbody id="bp"></tbody></table></div>
      </section>
    </div>`;

  const bp = view.querySelector('#bp');
  const choice = () => ({ n: +view.querySelector('input[name=size]:checked').value, mpool: view.querySelector('input[name=mpool]:checked').value, timed: view.querySelector('#timed').checked });
  const draw = () => {
    const c = choice();
    const capped = meta.disciplines.map((d) => ({ ...d, total: c.mpool === 'incorrect' ? by.get(d.id).incorrect.length : by.get(d.id).all.length }));
    const rows = allocate(c.n, capped);
    const byId = new Map(rows.map((r) => [r.d.id, r.k]));
    let lastProfile = '';
    bp.innerHTML = meta.disciplines.filter((d) => d.total || d.weight).map((d) => {
      const g = by.get(d.id);
      const head = d.profile !== lastProfile ? `<tr class="group"><td colspan="5">${esc(d.profile)}</td></tr>` : '';
      lastProfile = d.profile;
      const low = c.mpool === 'new' && (byId.get(d.id) || 0) > g.unused.length;
      return head + `<tr><td>${esc(d.name)}</td><td class="n">${d.weight}%</td><td class="n"><b>${byId.get(d.id) || 0}</b></td><td class="n ${low ? 'acc lo' : ''}">${g.unused.length}</td><td class="n">${g.incorrect.length}</td></tr>`;
    }).join('') + `<tr><td><b>Total</b></td><td class="n">${sum(meta.disciplines.map((d) => d.weight))}%</td><td class="n"><b>${sum(rows.map((r) => r.k))}</b></td><td class="n">${nNew}</td><td class="n">${nWrong}</td></tr>`;
    // how many more papers of this size before the first discipline runs out of new questions
    const runway = rows.filter((r) => r.k > 0).map((r) => Math.floor(by.get(r.d.id).unused.length / r.k));
    const left = runway.length ? Math.min(...runway) : 0;
    const total = sum(rows.map((r) => r.k));
    view.querySelector('#runway').textContent = c.mpool === 'new'
      ? (left ? `About ${left} more ${c.n}-question paper${left === 1 ? '' : 's'} of all-new questions before the first discipline runs out. After that, that discipline repeats your incorrect questions first.` : 'At least one discipline has run out of new questions, so this paper will include some repeats (incorrect ones first).')
      : c.mpool === 'incorrect' ? (total < c.n ? `You have ${total} incorrect questions in weighted disciplines, so this paper will have ${total}.` : '') : '';
    view.querySelector('#go').disabled = !total;
  };
  view.addEventListener('change', () => {
    const c = choice();
    store.set(prefsKey(), { ...(store.get(prefsKey()) || {}), examSize: c.n, examTimed: c.timed, mockPool: c.mpool });
    draw();
  });
  draw();
  const discard = view.querySelector('#discard');
  if (discard) discard.onclick = () => { if (confirm('Discard the unfinished test? Nothing from it will be saved.')) { const d = state.drafts?.exam; dropDraft('exam'); if (d?.sessionId) sb.rpc('finish_session', { p_session_id: d.sessionId }).then(() => {}, () => {}); state.exam = null; renderExamSetup(); } };

  view.querySelector('#go').onclick = async (ev) => {
    if (draft && !confirm('Starting a new exam discards your unfinished test. Continue?')) return;
    const btn = ev.currentTarget; btn.disabled = true; btn.textContent = 'Building your paper…';
    try { const c = choice(); await startExam(c.n, c.timed, c.mpool, pool); }
    catch (e) { toast(errMsg(e), 'bad'); btn.disabled = false; btn.innerHTML = `${icon('exam')}Start mock exam`; }
  };
}

async function startExam(n, timed, mpool = 'new', pool = null) {
  const meta = await loadMeta();
  pool = pool || (await loadPool());
  const by = poolByDisc(meta, pool);
  const capped = meta.disciplines.map((d) => ({ ...d, total: mpool === 'incorrect' ? by.get(d.id).incorrect.length : by.get(d.id).all.length }));
  const rows = allocate(n, capped);
  const ids = shuffle(rows.flatMap((r) => {
    const g = by.get(r.d.id);
    const order = mpool === 'incorrect' ? shuffle(g.incorrect)
      : mpool === 'any' ? shuffle(g.all)
      : [...shuffle(g.unused), ...shuffle(g.incorrect), ...shuffle(g.correct)];
    return order.slice(0, r.k).map((q) => q.id);
  }));
  if (!ids.length) throw new Error('No questions available for this mock exam.');
  const qs = await fetchQuestions(ids);
  const tag = { new: 'New', incorrect: 'Incorrect', any: 'Any' }[mpool];
  await startExamWith(qs, { mode: 'mock', label: `Mock exam · ${qs.length} questions · ${tag}`, timed, opts: { mock: true, n, mpool } });
}

/** Start a block in exam mode: the weighted mock paper, or a custom test from the builder. */
async function startExamWith(qs, { mode, label, timed, opts = null }) {
  if (!state.marks) await loadPool();
  const items = qs.map((q) => ({ q, order: optionOrder(q.options), sel: new Set(), flagged: state.marks.has(q.id) }));
  const sessionId = check(await sb.rpc('start_session', { p_mode: mode, p_label: label, p_total: items.length, p_set: state.setId }));
  const old = state.drafts?.exam;
  if (old?.sessionId && old.sessionId !== sessionId) sb.rpc('finish_session', { p_session_id: old.sessionId }).then(() => {}, () => {});
  state.exam = { sessionId, mode, label, opts, timed, startedAt: Date.now(), endsAt: timed ? Date.now() + items.length * 60000 : null, i: 0, items };
  saveDraft();
  if (location.hash === '#/exam/run') renderExamRun(); else location.hash = '#/exam/run';
}
const examNav = (ex) => (ex && ex.mode !== 'mock' ? 'practice' : 'exam');

function saveDraft() {
  const ex = state.exam; if (!ex || ex.submitted) return;
  putDraft('exam', { sessionId: ex.sessionId, mode: ex.mode, opts: ex.opts, label: ex.label, timed: ex.timed, startedAt: ex.startedAt, endsAt: ex.endsAt, i: ex.i,
    items: ex.items.map((it) => ({ id: it.q.id, order: it.order, sel: [...it.sel], flagged: it.flagged })) });
}
async function restoreDraft() {
  const d = (await loadDrafts()).exam; if (!d || !Array.isArray(d.items)) return false;
  const qs = await fetchQuestions(d.items.map((x) => x.id));
  const qById = new Map(qs.map((q) => [q.id, q]));
  const items = d.items.filter((x) => qById.has(x.id)).map((x) => ({ q: qById.get(x.id), order: x.order, sel: new Set(x.sel), flagged: x.flagged }));
  state.exam = { mode: 'mock', ...d, items };
  if (!state.marks) await loadPool();
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
    shell(examNav(state.drafts?.exam), loading);
    if (!(await restoreDraft())) { location.hash = '#/exam'; return; }
  }
  const ex = state.exam; const meta = await loadMeta();
  const n = ex.items.length; const it = ex.items[ex.i]; const q = it.q;
  const multi = q.qtype === 'CM' || q.correct.length > 1;
  const answered = ex.items.filter((x) => x.sel.size).length;
  const topic = meta.topicById.get(q.category_id); const disc = topic && meta.discById.get(topic.discipline_id);

  const view = shell(examNav(ex), `
    <div class="runner exam">
      <div>
        <div class="run-top"><span class="pos">Question ${ex.i + 1} of ${n}</span><span class="muted small num">${answered} answered</span></div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${n}" aria-valuenow="${answered}" aria-label="Questions answered"><span style="width:${(100 * answered) / n}%"></span></div>
        <article class="card qcard" aria-labelledby="qtext">
          <div class="qmeta">${disc ? `<span class="chip pri">${esc(disc.name)}</span>` : ''}<span class="chip">${multi ? 'Multiple answers' : 'Single answer'}</span>${reportBtn(q, it.order, ' mark-btn')}</div>
          <h1 class="qtext" id="qtext">${esc(q.question)}</h1>
          <p class="qhint">${multi ? 'Select all correct answers.' : 'Select one answer.'} You can change it until you submit.</p>
          <div class="options" role="${multi ? 'group' : 'radiogroup'}" aria-labelledby="qtext">${optionButtons(it)}</div>
          <div class="run-actions">
            <button class="btn" id="exPrev" ${ex.i === 0 ? 'disabled' : ''}>${icon('left')}Previous</button>
            <button class="btn ghost" id="exFlag" aria-pressed="${it.flagged}">${icon('flag')}${it.flagged ? 'Marked' : 'Mark'}</button>
            ${ex.i < n - 1 ? `<button class="btn primary" id="exNext">Next ${icon('right')}</button>` : `<button class="btn primary" id="exSubmit2">Review &amp; submit</button>`}
          </div>
        </article>
        <p class="keys-hint">Keys: A–${LETTERS[q.options.length - 1]} choose · ← → move · F flag</p>
      </div>
      <aside class="card side" aria-label="Exam navigator">
        ${ex.timed ? `<div class="timer" id="timer" role="timer" aria-live="off">${icon('clock')}<span>--:--</span></div>` : `<div class="timer">${icon('clock')}<span class="small muted" style="font-weight:500">Untimed</span></div>`}
        <div class="qgrid" role="list">${ex.items.map((x, k) => `<button role="listitem" data-go="${k}" class="${x.sel.size ? 'answered' : ''} ${x.flagged ? 'flagged' : ''} ${k === ex.i ? 'current' : ''}" aria-label="Question ${k + 1}${x.sel.size ? ', answered' : ''}${x.flagged ? ', marked' : ''}" ${k === ex.i ? 'aria-current="true"' : ''}>${k + 1}</button>`).join('')}</div>
        <div class="legend-row"><span><i class="a"></i>Answered</span><span><i></i>Not answered</span><span><i class="f"></i>Marked</span></div>
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
  view.querySelector('#exFlag').onclick = () => {
    it.flagged = !it.flagged; saveDraft(); renderExamRun();
    if (it.flagged !== !!state.marks?.has(q.id)) toggleMark(q.id);
  };
  const askSubmit = () => {
    const missing = n - ex.items.filter((x) => x.sel.size).length;
    const flagged = ex.items.filter((x) => x.flagged).length;
    const msg = `Submit your exam now?${missing ? `\n\n${missing} question${missing > 1 ? 's are' : ' is'} not answered and will count as wrong.` : ''}${flagged ? `\n${flagged} question${flagged > 1 ? 's are' : ' is'} marked.` : ''}`;
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
  const view = shell(examNav(ex), `<div class="card empty" role="status">${icon('upload')}<h2>Marking your paper…</h2><p class="muted num" id="saving">Saving answers 0 / ${ex.items.length}</p></div>`);
  let done = 0;
  for (let i = 0; i < ex.items.length; i += 8) {
    await Promise.all(ex.items.slice(i, i + 8).map(async (it) => {
      it.ok = sameSet([...it.sel], it.q.correct);
      if (ex.mode === 'mock') it.mark = markFor(it.q, it.sel);
      const { data, error } = await sb.rpc('record_answer', { p_question_id: it.q.id, p_selected: [...it.sel], p_session_id: ex.sessionId });
      it.saved = !error;
      if (!error) it.ok = data;
      done += 1;
    }));
    const el = view.querySelector('#saving'); if (el) el.textContent = `Saving answers ${done} / ${ex.items.length}`;
  }
  if (ex.items.some((x) => x.saved === false) && !(await heartbeat(false, true))) return;
  await sb.rpc('finish_session', { p_session_id: ex.sessionId }).then(() => {}, () => {});
  ex.submitted = true; ex.finishedAt = Date.now();
  dropDraft('exam');
  state.examResult = ex; state.exam = null;
  location.hash = '#/exam/result';
}

async function renderExamResult() {
  const ex = state.examResult;
  if (!ex) { location.hash = '#/exam'; return; }
  const view = shell(examNav(ex), loading);
  const isMock = ex.mode === 'mock';
  const [meta, sessions] = await Promise.all([loadMeta(), sessionsFor(state.profile.id)]);
  const n = ex.items.length; const right = ex.items.filter((x) => x.ok).length;
  const partial = isMock && ex.items.every((x) => typeof x.mark === 'number');
  const marks = partial ? ex.items.reduce((a, x) => a + x.mark, 0) : right;
  const score = Math.round((100 * marks) / n);
  const final10 = out10(marks, n);
  const per = new Map();
  for (const it of ex.items) {
    const t = meta.topicById.get(it.q.category_id); const d = t && meta.discById.get(t.discipline_id);
    const key = d ? d.id : 0;
    if (!per.has(key)) per.set(key, { d, n: 0, ok: 0 });
    const p = per.get(key); p.n += 1; p.ok += partial ? it.mark : (it.ok ? 1 : 0);
  }
  const mins = Math.round(((ex.finishedAt || Date.now()) - ex.startedAt) / 60000);
  const unsaved = ex.items.filter((x) => x.saved === false).length;
  const mocks = sessions.filter((s) => s.mode === 'mock');
  const prevMock = mocks.filter((s) => s.id !== ex.sessionId).pop();

  view.innerHTML = `
    <section class="card"><div class="result-head">
      <div class="ring" style="--p:${Math.max(0, score)};--c:var(${score >= 75 ? '--ok' : score >= 50 ? '--warn' : '--bad'})"><span>${isMock ? `${fmt10(final10)}<small>/10</small>` : `${score}%`}</span></div>
      <div style="flex:1;min-width:240px">
        <h1>${isMock ? 'Mock exam result' : 'Test result'}</h1>
        ${isMock ? `<p class="final10">Final mark <b>${fmt10(final10)}</b> out of 10 <span class="muted">(${score}%)</span></p>` : ''}
        <p class="muted">${partial ? `${fmtMark(marks)} of ${n} marks · ${right} fully correct` : `${right} of ${n} correct`} · ${mins} min${isMock && prevMock ? ` · previous mock ${fmt10(sess10(prevMock))}/10` : ''}${isMock ? '' : ` · ${esc(ex.label)}`}</p>
        ${partial ? `<p class="muted small">Multi-answer questions: each correct option you pick earns a share of the mark, and each wrong option takes a share away. A question can score below 0.${isMock ? ' The final mark is your total marks divided by the number of questions, times 10 (lowest 0).' : ''}</p>` : ''}
        ${unsaved ? `<p class="chip bad">${icon('alert')}${unsaved} answers were not saved because of a connection problem.</p>` : ''}
        <div class="btn-row">${isMock ? `<a class="btn primary" href="#/exam">${icon('retry')}Next mock exam</a>` : `${ex.opts ? `<button class="btn primary" id="sameAgain">${icon('retry')}New test, same settings</button>` : ''}<a class="btn" href="#/practice">Create another test</a>`}<a class="btn" href="#/progress">${icon('trend')}See progress</a></div>
      </div></div></section>
    <div class="grid two">
      <section class="card" aria-labelledby="rd"><h2 id="rd">By discipline</h2>
        <div class="table-wrap"><table><thead><tr><th>Discipline</th><th class="n">Score</th><th>Result</th></tr></thead><tbody>
        ${[...per.values()].sort((a, b) => (a.d?.sort || 99) - (b.d?.sort || 99)).map((p) => { const a = pctNum(p.ok, p.n); return `<tr><td>${esc(p.d ? p.d.name : 'Other')}</td><td class="n">${partial ? fmtMark(p.ok) : p.ok}/${p.n}</td><td><div class="cov"><span class="bar ${barClass(a)}"><span style="width:${a}%"></span></span><small class="acc ${accClass(a)}">${a}%</small></div></td></tr>`; }).join('')}
        </tbody></table></div></section>
      <section class="card" aria-labelledby="rc"><h2 id="rc">${isMock ? 'Your mock exam scores' : 'Your scores'}</h2><div id="curve"></div></section>
    </div>
    <section class="card" aria-labelledby="rr">
      <div class="row-between"><h2 id="rr">Review answers</h2>
        <div class="filters" role="group" aria-label="Filter answers">${[['wrong', 'Wrong'], ['flagged', 'Marked'], ['all', 'All']].map(([v, l], k) => `<button class="btn sm" data-f="${v}" aria-pressed="${k === 0}">${l}</button>`).join('')}</div></div>
      <ol class="review" id="rlist"></ol>
    </section>`;

  drawCurveInto(view.querySelector('#curve'), isMock ? mocks : sessions, { mockOnly: isMock, highlight: ex.sessionId });
  const sa = view.querySelector('#sameAgain');
  if (sa) sa.onclick = async () => { sa.disabled = true; try { if (!(await startTest(ex.opts))) sa.disabled = false; } catch (e) { toast(errMsg(e), 'bad'); sa.disabled = false; } };
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
  const points = done.map((s, k) => ({ k, s, score: sessPct(s), mock: s.mode === 'mock' }));
  const mocks = points.filter((p) => p.mock); const prac = points.filter((p) => !p.mock);
  const summary = [trendSentence(mocks, 'Mock exams'), mockOnly ? '' : trendSentence(prac, 'Topic tests')].filter(Boolean).join(' ');
  const table = `<details class="data-table"><summary>Show scores as a table</summary><div class="table-wrap"><table><thead><tr><th>Date</th><th>Session</th><th class="n">Score</th><th class="n">Correct</th></tr></thead><tbody>
    ${points.slice().reverse().map((p) => `<tr><td>${fmtDate(p.s.started_at)}</td><td>${p.mock ? '<span class="chip pri">Mock exam</span>' : '<span class="chip">Topic test</span>'} ${esc(p.s.label || '')}</td><td class="n"><span class="acc ${accClass(p.score)}">${p.score}%</span></td><td class="n">${sessScore(p.s)}${p.mock ? ` · <b>${fmt10(sess10(p.s))}/10</b>` : ''}</td></tr>`).join('')}
    </tbody></table></div></details>`;

  if (points.length < 4 || !window.Chart) {
    // Too few points for a meaningful trend line: show them as stat tiles instead.
    box.innerHTML = `<div class="grid stats">${points.slice(-4).map((p) => `<div class="stat"><span class="label">${p.mock ? 'Mock exam' : 'Topic test'} · ${shortDate(p.s.started_at)}</span><span class="value">${p.mock ? `${fmt10(sess10(p.s))}<small>/10</small>` : `${p.score}<small>%</small>`}</span><span class="hint">${p.mock ? `${p.score}% · ` : ''}${sessScore(p.s)}${p.s.points != null ? '' : ' correct'}</span></div>`).join('')}</div>
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
  if (prac.length && !mockOnly) datasets.push({ label: 'Topic tests', data: points.map((p) => (!p.mock ? p.score : null)), borderColor: grey, backgroundColor: grey,
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
          label: (c) => { const p = points[c.dataIndex]; return `${p.mock ? 'Mock exam' : 'Topic test'}: ${c.parsed.y}%${p.mock ? ` · ${fmt10(sess10(p.s))}/10` : ''} (${sessScore(p.s)})`; },
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
  const [meta, stats, sessions, pool] = await Promise.all([loadMeta(), topicStats(userId), sessionsFor(userId), loadPool(userId)]);
  const r = readiness(meta, stats);
  const wrongBy = new Map(); const markedBy = new Map();
  for (const q of pool) { if (q.status === 'incorrect') wrongBy.set(q.cat, (wrongBy.get(q.cat) || 0) + 1); if (q.marked) markedBy.set(q.cat, (markedBy.get(q.cat) || 0) + 1); }
  const nWrong = sum([...wrongBy.values()]); const nMarked = sum([...markedBy.values()]);
  const overall = rollUp([...stats.values()]);
  const totalQs = sum(meta.disciplines.map((d) => d.total));
  const mocks = sessions.filter((s) => s.mode === 'mock');
  const best = mocks.length ? Math.max(...mocks.map(sessPct)) : null;
  const best10 = mocks.length ? Math.max(...mocks.map(sess10)) : null;
  const html = `
    <div class="grid stats">
      <div class="stat"><span class="label">${icon('target')}Estimated exam score</span><span class="value">${r.score === null ? '–' : r.score + '<small>%</small>'}</span><span class="hint">${r.score === null ? 'Not enough answers yet' : `Covers ${r.weightCovered}% of the exam weight`}</span></div>
      <div class="stat"><span class="label">${icon('layers')}Questions used</span><span class="value">${overall.answered.toLocaleString()}<small>/${totalQs.toLocaleString()}</small></span><span class="hint">${pct(overall.answered, totalQs)} of the bank</span></div>
      <div class="stat"><span class="label">${icon('check')}Accuracy</span><span class="value">${pct(overall.correct, overall.attempts)}</span><span class="hint">${nWrong.toLocaleString()} incorrect · ${nMarked.toLocaleString()} marked</span></div>
      <div class="stat"><span class="label">${icon('exam')}Mock exams</span><span class="value">${mocks.length}</span><span class="hint">${best === null ? 'None yet' : `Best ${fmt10(best10)}/10 · latest ${fmt10(sess10(mocks[mocks.length - 1]))}/10`}</span></div>
    </div>
    ${mocks.length ? `<section class="card" aria-labelledby="pmk"><h2 id="pmk">${icon('exam')}Mock exams</h2>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th class="n">Final mark</th><th class="n">Score</th><th class="n">Marks</th><th class="n">Time</th><th></th></tr></thead><tbody>
      ${mocks.slice().reverse().map((m) => `<tr><td>${esc(fmtDate(m.started_at))}</td><td class="n"><b>${fmt10(sess10(m))}</b>/10</td>
        <td class="n"><span class="acc ${accClass(sessPct(m))}">${sessPct(m)}%</span></td><td class="n">${sessScore(m)}</td>
        <td class="n small">${m.finished_at ? Math.max(1, Math.round((Date.parse(m.finished_at) - Date.parse(m.started_at)) / 60000)) + ' min' : '<span class="muted">not finished</span>'}</td>
        <td class="n">${m.details_cleared || !m.finished_at ? `<span class="muted small">${m.finished_at ? 'Score only' : ''}</span>` : `<a class="btn sm" href="#/mockreview/${m.id}">${icon('eye')}Review</a>`}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="muted small">Answers are kept for review for the last 3 mock exams. For older ones, only the score is kept.</p></section>` : ''}
    <section class="card" aria-labelledby="pc"><h2 id="pc">Improvement curve</h2><p class="muted small">Every finished session, oldest to newest. Weighted mock exams are the solid line; topic tests (tutor and exam mode) are dashed.</p><div id="curve"></div></section>
    <section class="card" aria-labelledby="pd"><h2 id="pd">Readiness by discipline</h2>
      <p class="muted small">Accuracy per discipline, with its weight in the exam. The estimated score weights these the same way the real paper does.</p>
      <div class="table-wrap"><table><thead><tr><th>Discipline</th><th class="n">Weight</th><th>Coverage</th><th class="n">Accuracy</th><th>Last practised</th></tr></thead><tbody>
      ${r.per.filter((p) => p.d.total).map((p) => `<tr><td>${esc(p.d.name)}</td><td class="n">${p.d.weight}%</td>
        <td><div class="cov"><span class="bar"><span style="width:${p.coverage || 0}%"></span></span><small>${p.s.answered}/${p.d.total}</small></div></td>
        <td class="n"><span class="acc ${accClass(p.acc)}">${p.acc === null ? '–' : p.acc + '%'}</span></td><td>${fmtDate(p.s.last)}</td></tr>`).join('')}
      </tbody></table></div></section>
    <section class="card" aria-labelledby="ptp"><h2 id="ptp">By topic</h2>
      <div class="table-wrap"><table><thead><tr><th>Topic</th><th>Coverage</th><th class="n">Accuracy</th><th class="n">Incorrect</th><th class="n">Marked</th></tr></thead><tbody>
      ${meta.disciplines.filter((d) => d.total).map((d) => `<tr class="group"><td colspan="5">${esc(d.name)}</td></tr>` + d.topics.filter((t) => meta.totals.get(t.id)).map((t) => {
        const s = stats.get(t.id); const total = meta.totals.get(t.id); const a = s ? pctNum(s.correct, s.attempts) : null;
        return `<tr><td>${esc(t.name)}</td><td><div class="cov"><span class="bar"><span style="width:${s ? Math.round((100 * s.answered) / total) : 0}%"></span></span><small>${s ? s.answered : 0}/${total}</small></div></td>
          <td class="n"><span class="acc ${accClass(a)}">${a === null ? '–' : a + '%'}</span></td><td class="n">${wrongBy.get(t.id) || 0}</td><td class="n">${markedBy.get(t.id) || 0}</td></tr>`;
      }).join('')).join('')}
      </tbody></table></div></section>`;
  return { html, sessions, meta, pool };
}

async function renderMyProgress() {
  const view = shell('progress', loading);
  const { html, sessions, meta, pool } = await progressHTML(state.profile.id);
  view.innerHTML = `<div class="page-head"><div><h1>Progress</h1><p class="muted">How your scores are moving, and where to focus next.</p></div></div>` + html + ankiCardHTML(meta, pool);
  drawCurveInto(view.querySelector('#curve'), sessions);
  wireAnki(view, meta, pool);
}


/* =========================================================================
   Mock exam review: every answer of one finished mock, for the learner and the admin
   ========================================================================= */
const REVIEW_FILTERS = [['all', 'All'], ['wrong', 'Wrong'], ['partial', 'Partly right'], ['right', 'Right']];
async function renderMockReview(id) {
  const isAdmin = state.profile.role === 'admin';
  const view = shell(isAdmin ? 'admin' : 'progress', loading);
  const { data: sess, error } = await sb.from('sessions').select('id,user_id,mode,label,total,answered,correct,points,started_at,finished_at,details_cleared').eq('id', id).maybeSingle();
  if (error || !sess) { view.innerHTML = `<div class="card empty">${icon('alert')}<h2>Mock exam not found</h2><p class="muted">It may belong to someone else or have been removed.</p><a class="btn" href="#/progress">Back to Progress</a></div>`; return; }
  const mine = sess.user_id === state.profile.id;
  const back = mine ? '#/progress' : `#/admin/learner/${sess.user_id}`;
  if (sess.details_cleared) {
    view.innerHTML = `<div class="card empty">${icon('exam')}<h2>Review no longer available</h2>
      <p class="muted">Answers are kept for review for the last 3 mock exams only. This one scored <b>${fmt10(sess10(sess))}/10</b> (${sessPct(sess)}%) on ${esc(fmtDate(sess.started_at))}.</p>
      <a class="btn" href="${back}">${icon('left')}Back</a></div>`;
    return;
  }
  const [meta, answers, who] = await Promise.all([
    loadMeta(),
    fetchAll(() => sb.from('answers').select('question_id,selected,is_correct,mark,answered_at').eq('session_id', id).order('answered_at')),
    mine ? null : sb.from('profiles').select('full_name,email').eq('id', sess.user_id).maybeSingle().then((r) => r.data),
  ]);
  const qs = await fetchQuestions([...new Set(answers.map((a) => a.question_id))]);
  const qById = new Map(qs.map((q) => [q.id, q]));
  const partialScoring = sess.points != null;
  const rows = answers.map((a, i) => {
    const q = qById.get(a.question_id); const sel = new Set(a.selected || []);
    const mark = a.mark != null ? Number(a.mark) : a.is_correct ? 1 : 0;
    const kind = a.is_correct ? 'right' : mark > 0 ? 'partial' : 'wrong';
    const t = q && meta.topicById.get(q.category_id); const d = t && meta.discById.get(t.discipline_id);
    return { n: i + 1, a, q, sel, mark, kind, t, d };
  });
  const unanswered = Math.max(0, (sess.total || 0) - answers.length);
  const counts = { right: rows.filter((r) => r.kind === 'right').length, partial: rows.filter((r) => r.kind === 'partial').length, wrong: rows.filter((r) => r.kind === 'wrong').length };
  const byDisc = new Map();
  for (const r of rows) { const k = r.d ? r.d.id : 0; const x = byDisc.get(k) || { d: r.d, n: 0, marks: 0 }; x.n++; x.marks += r.mark; byDisc.set(k, x); }
  const discRows = [...byDisc.values()].sort((a, b) => (b.n - b.marks) - (a.n - a.marks));
  const mins = sess.finished_at ? Math.max(1, Math.round((Date.parse(sess.finished_at) - Date.parse(sess.started_at)) / 60000)) : null;
  const ui = { f: 'all', disc: 'all' };
  const qCard = (r) => {
    if (!r.q) return `<li class="card rv-q rv-${r.kind}"><p class="muted">Question #${r.a.question_id} is no longer in the bank.</p></li>`;
    const key = new Set(r.q.correct || []);
    return `<li class="card rv-q rv-${r.kind}" data-kind="${r.kind}" data-disc="${r.d ? r.d.id : 0}">
      <div class="row-between"><span><b>${r.n}.</b> ${r.d ? `<span class="chip pri">${esc(r.d.name)}</span>` : ''} ${r.t && (!r.d || r.t.name !== r.d.name) ? `<span class="chip">${esc(r.t.name)}</span>` : ''} <span class="chip">${r.q.qtype}</span> <span class="chip">#${r.q.id}</span></span>
        <span class="chip ${r.kind === 'right' ? 'ok' : r.kind === 'partial' ? 'warn' : 'bad'}">${r.kind === 'right' ? 'Right' : r.kind === 'partial' ? 'Partly right' : 'Wrong'} · ${r.mark > 0 ? '+' : ''}${fmtMark(r.mark)}</span></div>
      <p class="rv-text">${esc(r.q.question)}</p>
      <ol class="rv-opts">${r.q.options.map((o, i) => { const picked = r.sel.has(i); const ok = key.has(i);
        const cls = picked && ok ? 'hit' : picked ? 'miss' : ok ? 'missed' : '';
        const tag = picked && ok ? `${icon('check')}Picked · correct` : picked ? `${icon('x')}Picked · wrong` : ok ? 'Correct, not picked' : '';
        return `<li class="${cls}"><b>${LETTERS[i]}</b> <span>${esc(o)}</span>${tag ? `<span class="rv-tag">${tag}</span>` : ''}</li>`; }).join('')}</ol>
      ${!r.sel.size ? '<p class="small muted">No option was picked.</p>' : ''}
      ${r.q.explanation ? `<p class="small"><b>Explanation:</b> ${esc(r.q.explanation)}</p>` : ''}
    </li>`;
  };
  view.innerHTML = `
    <div class="page-head"><div><a class="small" href="${back}">${icon('left')}${mine ? 'Back to Progress' : 'Back to ' + esc(who?.full_name || who?.email || 'the learner')}</a>
      <h1>Mock exam review</h1>
      <p class="muted">${mine ? '' : `<b>${esc(who?.full_name || who?.email || 'Learner')}</b> · `}${esc(fmtDate(sess.started_at))}${mins ? ` · ${mins} min` : ''}${sess.finished_at ? '' : ' · not finished'}</p></div></div>
    <div class="grid stats">
      <div class="stat"><span class="label">${icon('exam')}Final mark</span><span class="value">${fmt10(sess10(sess))}<small>/10</small></span><span class="hint">${sessPct(sess)}% · ${sessScore(sess)}</span></div>
      <div class="stat"><span class="label">${icon('check')}Right</span><span class="value">${counts.right}</span><span class="hint">of ${sess.total} questions</span></div>
      <div class="stat"><span class="label">${icon('alert')}Partly right</span><span class="value">${counts.partial}</span><span class="hint">${partialScoring ? 'Multi-answer, some marks' : 'Not scored partially (older mock)'}</span></div>
      <div class="stat"><span class="label">${icon('x')}Wrong</span><span class="value">${counts.wrong}</span><span class="hint">${unanswered ? `${unanswered} not answered` : 'All answered'}</span></div>
    </div>
    <section class="card"><h2>Marks lost by discipline</h2>
      <div class="table-wrap"><table><thead><tr><th>Discipline</th><th class="n">Questions</th><th class="n">Marks</th><th class="n">Lost</th></tr></thead><tbody>
      ${discRows.map((x) => `<tr><td>${esc(x.d ? x.d.name : 'Other')}</td><td class="n">${x.n}</td><td class="n">${fmtMark(x.marks)}</td><td class="n"><b>${fmtMark(x.n - x.marks)}</b></td></tr>`).join('')}
      </tbody></table></div>
      ${!mine ? '' : `<div class="btn-row" style="margin-top:12px"><button class="btn primary" id="rvPractise" ${counts.wrong + counts.partial ? '' : 'disabled'}>${icon('retry')}Practise the ${counts.wrong + counts.partial} I missed</button></div>`}
    </section>
    <section aria-labelledby="rvQ"><div class="row-between"><h2 id="rvQ">Every question</h2>
      <div class="btn-row"><div class="seg" role="group" aria-label="Show">${REVIEW_FILTERS.map(([k, l]) => `<button class="btn sm ${k === 'all' ? 'primary' : 'ghost'}" data-f="${k}">${l}${k === 'all' ? ` (${rows.length})` : ` (${counts[k]})`}</button>`).join('')}</div>
        <label class="sr" for="rvDisc">Discipline</label><select id="rvDisc"><option value="all">All disciplines</option>${discRows.filter((x) => x.d).map((x) => `<option value="${x.d.id}">${esc(x.d.name)}</option>`).join('')}</select></div></div>
      ${unanswered ? `<p class="muted small">${unanswered} question${unanswered === 1 ? ' was' : 's were'} not answered and can't be listed.</p>` : ''}
      <p class="muted small">Options are shown in the question bank's order (A–E). In the exam they were shuffled, so the letters may differ from what was on screen.</p>
      <ol class="rv-list">${rows.map(qCard).join('')}</ol></section>`;
  const apply = () => view.querySelectorAll('.rv-q[data-kind]').forEach((li) => { li.hidden = (ui.f !== 'all' && li.dataset.kind !== ui.f) || (ui.disc !== 'all' && li.dataset.disc !== ui.disc); });
  view.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { ui.f = b.dataset.f; view.querySelectorAll('[data-f]').forEach((x) => { x.classList.toggle('primary', x === b); x.classList.toggle('ghost', x !== b); }); apply(); }));
  view.querySelector('#rvDisc').onchange = (e) => { ui.disc = e.target.value; apply(); };
  const pr = view.querySelector('#rvPractise');
  if (pr) pr.onclick = async () => {
    pr.disabled = true;
    try { await startTutor(rows.filter((r) => r.q && r.kind !== 'right').map((r) => r.q), `Mistakes from mock ${shortDate(sess.started_at)}`, null, true); }
    catch (e) { pr.disabled = false; toast(errMsg(e), 'bad'); }
  };
}

/* =========================================================================
   Anki export (incorrect / marked questions as an Anki import file)
   ========================================================================= */

function ankiFile(meta, qs, deck) {
  const field = (v) => '"' + String(v).replace(/"/g, '""').replace(/\t/g, ' ').replace(/\r?\n/g, '<br>') + '"';
  const tagify = (v) => String(v).trim().replace(/\s+/g, '_').replace(/"/g, '');
  const lines = ['#separator:tab', '#html:true', '#notetype:Basic', `#deck:${deck}`, '#tags column:3'];
  for (const q of qs) {
    const t = meta.topicById.get(q.category_id); const d = t && meta.discById.get(t.discipline_id);
    const multi = q.qtype === 'CM' || q.correct.length > 1;
    const opts = q.options.map((o, i) => `${LETTERS[i]}. ${esc(o)}`).join('<br>');
    const front = `${esc(q.question)}<br><br>${opts}<br><br><i>${multi ? 'Multiple answers (CM)' : 'Single answer (CS)'}</i>`;
    const back = `<b>Answer: ${q.correct.map((c) => LETTERS[c]).join(', ')}</b><br>${q.correct.map((c) => `${LETTERS[c]}. ${esc(q.options[c])}`).join('<br>')}`
      + (q.explanation ? `<br><br>${esc(q.explanation)}` : '') + `<br><br><small>${esc(d ? d.name : '')}${t && d && t.name !== d.name ? ' › ' + esc(t.name) : ''}</small>`;
    const tags = ['USMF', d ? `USMF::${tagify(d.name)}${t && t.name !== d.name ? '::' + tagify(t.name) : ''}` : ''].filter(Boolean).join(' ');
    lines.push([field(front), field(back), field(tags)].join('\t'));
  }
  return lines.join('\n') + '\n';
}

function ankiCardHTML(meta, pool) {
  const discs = meta.disciplines.filter((d) => d.total);
  const nW = pool.filter((q) => q.status === 'incorrect').length; const nM = pool.filter((q) => q.marked).length;
  return `<section class="card" aria-labelledby="ak"><h2 id="ak">Export to Anki</h2>
    <p class="muted small">Download your incorrect and marked questions as an Anki file (in Anki: File → Import). Cards show the question with its options on the front and the official key on the back, tagged by discipline and topic.</p>
    <div class="choices">
      <label class="choice"><input type="checkbox" name="ankiPool" value="incorrect" checked><span><b>Incorrect <span class="count num">(${nW})</span></b><small>Wrong the last time you answered</small></span></label>
      <label class="choice"><input type="checkbox" name="ankiPool" value="marked" ${nM ? 'checked' : ''}><span><b>Marked <span class="count num">(${nM})</span></b><small>Questions you flagged</small></span></label>
    </div>
    <div class="row">
      <label class="field" style="margin:0;min-width:220px"><span class="sr">Discipline</span><select id="ankiDisc"><option value="">All disciplines</option>${discs.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label>
      <button class="btn primary" id="ankiBtn">${icon('download')}Download for Anki</button>
      <span class="muted small" id="ankiInfo" aria-live="polite"></span>
    </div></section>`;
}

function wireAnki(view, meta, pool) {
  const btn = view.querySelector('#ankiBtn'); if (!btn) return;
  const pick = () => {
    const pools = [...view.querySelectorAll('input[name=ankiPool]:checked')].map((b) => b.value);
    const disc = +view.querySelector('#ankiDisc').value || null;
    const hits = pool.filter((q) => (pools.includes(q.status) || (q.marked && pools.includes('marked')))
      && (!disc || meta.topicById.get(q.cat)?.discipline_id === disc));
    return { pools, disc, hits };
  };
  const sync = () => { const { hits } = pick(); view.querySelector('#ankiInfo').textContent = `${hits.length} card${hits.length === 1 ? '' : 's'}`; btn.disabled = !hits.length; };
  view.querySelectorAll('input[name=ankiPool], #ankiDisc').forEach((el) => el.addEventListener('change', sync));
  sync();
  btn.onclick = async () => {
    const { pools, disc, hits } = pick();
    btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const qs = await fetchQuestions(hits.map((q) => q.id));
      const what = pools.map((p) => (p === 'incorrect' ? 'Incorrect' : 'Marked')).join(' + ');
      const dname = disc ? meta.discById.get(disc).name : '';
      const deck = `USMF Exam Prep::${what}${dname ? '::' + dname.replace(/::/g, ' ') : ''}`;
      const stamp = new Date().toISOString().slice(0, 10);
      download(`usmf-anki-${what.toLowerCase().replace(/\W+/g, '-')}${dname ? '-' + dname.toLowerCase().replace(/\W+/g, '-') : ''}-${stamp}.txt`, ankiFile(meta, qs, deck), 'text/plain;charset=utf-8');
      toast(`Exported ${qs.length} cards for Anki.`, 'ok');
    } catch (e) { toast(errMsg(e), 'bad'); }
    finally { btn.innerHTML = `${icon('download')}Download for Anki`; sync(); }
  };
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
    </div>
    ${p.role === 'admin' ? '<section class="card" id="mfaCard"><h2>Two-step sign-in</h2><p class="muted">Loading…</p></section>' : ''}`);
  if (p.role === 'admin') paintMfaCard(view.querySelector('#mfaCard'));
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

async function paintMfaCard(card) {
  let list = [];
  try { list = (await mfaFactors()).verified; } catch (e) { card.innerHTML = `<h2>Two-step sign-in</h2><p class="form-error">${esc(errMsg(e))}</p>`; return; }
  card.innerHTML = `<h2>${icon('shield')}Two-step sign-in</h2>
    <p class="muted">${list.length ? 'On. Every admin sign-in needs a 6-digit code from one of these authenticators.' : 'Off. You will be asked to set it up at your next sign-in.'}</p>
    ${list.length ? `<ul class="mfa-list">${list.map((f) => `<li><span><b>${esc(f.friendly_name || 'Authenticator')}</b><br><span class="muted small">Added ${esc(fmtDate(f.created_at))}</span></span>
      ${list.length > 1 ? `<button class="btn sm danger" type="button" data-unenroll="${esc(f.id)}">Remove</button>` : '<span class="muted small">Add a backup before removing this one</span>'}</li>`).join('')}</ul>` : ''}
    <div class="btn-row"><a class="btn" href="#/account/backup">${icon('shield')}Add a backup authenticator</a></div>`;
  card.querySelectorAll('[data-unenroll]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this authenticator? Its codes will stop working.')) return;
    b.disabled = true;
    const { error } = await sb.auth.mfa.unenroll({ factorId: b.dataset.unenroll });
    if (error) { b.disabled = false; toast(errMsg(error), 'bad'); return; }
    await sb.auth.refreshSession().catch(() => {});
    toast('Authenticator removed.', 'ok'); paintMfaCard(card);
  }));
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
  <a href="#/admin/questions" ${active === 'questions' ? 'aria-current="page"' : ''}>${icon('layers')}Questions &amp; blueprint</a>
  <a href="#/admin/reports" ${active === 'reports' ? 'aria-current="page"' : ''}>${icon('alert')}Reports <span class="tbadge" data-tab-badge>${reportCache.n || ''}</span></a>
  <a href="#/admin/notices" ${active === 'notices' ? 'aria-current="page"' : ''}>${icon('flag')}Notices</a>
  <a href="#/admin/insights" ${active === 'insights' ? 'aria-current="page"' : ''}>${icon('trend')}Insights</a>
  <a href="#/admin/security" ${active === 'security' ? 'aria-current="page"' : ''}>${icon('shield')}Security</a></nav>`;

/* ---------- Admin: notices ---------- */

const NOTICE_ICONS = [['check', 'Tick'], ['alert', 'Alert'], ['flag', 'Flag'], ['bell', 'Bell'], ['clock', 'Clock'], ['layers', 'Layers'], ['target', 'Target'], ['trend', 'Chart'], ['book', 'Book'], ['retry', 'Repeat'], ['shield', 'Shield'], ['exam', 'Exam']];
const absDate = (ts) => new Date(ts).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const toLocalInput = (ts) => { const d = new Date(ts); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const noticeStatus = (a) => { const now = Date.now(); if (Date.parse(a.show_from) > now) return ['Scheduled', 'pri']; if (a.show_until && Date.parse(a.show_until) <= now) return ['Ended', '']; return ['Live', 'ok']; };

async function renderAdminNotices() {
  const view = shell('admin', loading);
  const [{ data: list, error }, reads, people] = await Promise.all([
    sb.from('announcements').select('id,title,intro,items,issuer,show_from,show_until,created_at,set_id').order('show_from', { ascending: false }),
    sb.from('notice_reads').select('announcement_id,user_id'),
    sb.from('profiles').select('id,full_name,email,role,active'),
    loadSets(true),
  ]);
  const accessRows = await fetchAll(() => sb.from('set_access').select('user_id,set_id').order('user_id')).catch(() => []);
  const setName = (id) => state.sets?.find((x) => x.id === id)?.name || 'a removed set';
  if (error) throw error;
  const learners = (people.data || []).filter((p) => p.active && p.role !== 'admin');
  const hasSet = new Set(accessRows.map((r) => r.user_id + ':' + r.set_id));
  const audience = (a) => (a.set_id == null ? learners : learners.filter((l) => hasSet.has(l.id + ':' + a.set_id)));
  const readsBy = new Map(); for (const r of reads.data || []) { if (!readsBy.has(r.announcement_id)) readsBy.set(r.announcement_id, new Set()); readsBy.get(r.announcement_id).add(r.user_id); }
  view.innerHTML = `${adminTabs('notices')}
    <div class="row-between"><h1 style="margin:0">Notices</h1><button class="btn primary" id="newNotice">+ New notice</button></div>
    <p class="muted">Notices show on learners' Home page between their start and end time, until each learner taps "Got it". A notice for one question set is shown only to learners who have that set.</p>
    <div id="noticeEditor"></div>
    <section class="card"><div class="table-wrap"><table><thead><tr><th>Notice</th><th>Shown to</th><th>Status</th><th>Shown</th><th class="n">Read</th><th></th></tr></thead><tbody>
    ${list.map((a) => { const [st, cls] = noticeStatus(a); const r = readsBy.get(a.id) || new Set(); const aud = audience(a); const nRead = aud.filter((l) => r.has(l.id)).length;
      return `<tr><td><b>${esc(a.title)}</b>${a.intro ? `<br><span class="muted small">${esc(a.intro.length > 90 ? a.intro.slice(0, 90) + '…' : a.intro)}</span>` : ''}</td>
        <td class="small">${a.set_id == null ? 'Everyone' : esc(setName(a.set_id)) + ' learners'}</td>
        <td><span class="chip ${cls}">${st}</span></td>
        <td class="small">${esc(absDate(a.show_from))}<br><span class="muted">${a.show_until ? 'until ' + esc(absDate(a.show_until)) : 'no end date'}</span></td>
        <td class="n"><span title="${esc(aud.filter((l) => r.has(l.id)).map((l) => l.full_name || l.email).join(', ') || 'Nobody yet')}">${nRead}/${aud.length}</span></td>
        <td><div class="btn-row" style="justify-content:flex-end"><button class="btn sm" data-edit-notice="${esc(a.id)}">Edit</button>${st === 'Ended' ? '' : `<button class="btn sm ghost" data-end-notice="${esc(a.id)}">End now</button>`}<button class="btn sm danger" data-del-notice="${esc(a.id)}">Delete</button></div></td></tr>`; }).join('') || '<tr><td colspan="6" class="muted">No notices yet.</td></tr>'}
    </tbody></table></div><p class="muted small" style="margin:8px 0 0">Read = learners shown the notice who tapped "Got it" (hover to see who). Taps from before 22 Nov were only saved on each device, so older notices show fewer reads.</p></section>`;
  const open = (a) => noticeEditor(view.querySelector('#noticeEditor'), a);
  view.querySelector('#newNotice').onclick = () => open(null);
  view.querySelectorAll('[data-edit-notice]').forEach((b) => (b.onclick = () => open(list.find((x) => x.id === b.dataset.editNotice))));
  view.querySelectorAll('[data-end-notice]').forEach((b) => (b.onclick = async () => {
    if (!confirm('End this notice now? It disappears from Home for everyone it was shown to.')) return;
    try { check(await sb.from('announcements').update({ show_until: new Date().toISOString() }).eq('id', b.dataset.endNotice)); toast('Notice ended.', 'ok'); renderAdminNotices(); } catch (e) { toast(errMsg(e), 'bad'); }
  }));
  view.querySelectorAll('[data-del-notice]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Delete this notice for good? Its read counts are deleted too.')) return;
    try { check(await sb.from('announcements').delete().eq('id', b.dataset.delNotice)); toast('Notice deleted.', 'ok'); renderAdminNotices(); } catch (e) { toast(errMsg(e), 'bad'); }
  }));
}

function noticeEditor(box, a) {
  const isNew = !a;
  const items = a && Array.isArray(a.items) && a.items.length ? a.items.map((x) => [...x]) : [['check', '', '']];
  const until = a ? a.show_until : new Date(Date.now() + 14 * 864e5).toISOString();
  box.innerHTML = `<form class="card" style="border-color:var(--primary)" novalidate>
    <h2>${isNew ? 'New notice' : 'Edit notice'}</h2>
    <label class="field">Title<input name="title" maxlength="120" required value="${esc(a?.title || '')}" placeholder="For example: Question corrected"></label>
    <label class="field">Short introduction<span class="help">Optional, one or two sentences.</span><textarea name="intro" rows="2" maxlength="400">${esc(a?.intro || '')}</textarea></label>
    <fieldset class="field"><legend>Points</legend><div id="nItems"></div><button type="button" class="btn sm" id="addItem">+ Add point</button></fieldset>
    <div class="grid two">
      <label class="field">Show from<input type="datetime-local" name="from" required value="${toLocalInput(a ? a.show_from : Date.now())}"></label>
      <label class="field">Show until<span class="help">Leave empty for no end date.</span><input type="datetime-local" name="until" value="${until ? toLocalInput(until) : ''}"></label>
    </div>
    <label class="field">Shown to<span class="help">If the notice is about questions from one set, choose that set: only learners who have it will see the notice.</span>
      <select name="audience"><option value="">Everyone</option>${(state.sets || []).map((x) => `<option value="${x.id}" ${a?.set_id === x.id ? 'selected' : ''}>Learners with ${esc(x.name)}</option>`).join('')}</select></label>
    <label class="field">Issued by<input name="issuer" maxlength="60" value="${esc(a?.issuer || 'ANYMS')}"></label>
    <h3 class="small muted" style="margin:16px 0 8px">Preview</h3><div id="nPreview"></div>
    <div class="btn-row"><button class="btn primary" type="submit">${icon('check')}${isNew ? 'Publish' : 'Save changes'}</button><button class="btn ghost" type="button" id="nCancel">Cancel</button></div>
    ${!isNew ? '<p class="muted small">Learners who already tapped "Got it" will not see the edited version again. To show it to everyone again, end this notice and publish a new one.</p>' : ''}
    <p class="form-error" role="alert"></p></form>`;
  const f = box.querySelector('form');
  const drawItems = () => {
    f.querySelector('#nItems').innerHTML = items.map(([ic, t, d], i) => `<div class="nitem" data-i="${i}">
      <select aria-label="Icon" data-k="0">${NOTICE_ICONS.map(([k, l]) => `<option value="${k}" ${k === ic ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input data-k="1" maxlength="80" placeholder="Heading" value="${esc(t)}" aria-label="Point heading">
      <textarea data-k="2" rows="2" maxlength="500" placeholder="Text" aria-label="Point text">${esc(d)}</textarea>
      <button type="button" class="btn sm ghost" data-rm="${i}" aria-label="Remove point">${icon('x')}</button></div>`).join('');
    f.querySelectorAll('.nitem [data-k]').forEach((el) => (el.oninput = el.onchange = () => { items[+el.closest('.nitem').dataset.i][+el.dataset.k] = el.value; preview(); }));
    f.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { items.splice(+b.dataset.rm, 1); drawItems(); preview(); }));
  };
  const current = () => ({ id: a?.id || 'notice', title: f.title.value.trim(), intro: f.intro.value.trim() || null, issuer: f.issuer.value.trim() || 'ANYMS',
    items: items.filter(([, t, d]) => t.trim() || d.trim()).map(([ic, t, d]) => [ic, t.trim(), d.trim()]),
    show_from: f.from.value ? new Date(f.from.value).toISOString() : new Date().toISOString(), show_until: f.until.value ? new Date(f.until.value).toISOString() : null,
    set_id: f.audience.value ? Number(f.audience.value) : null });
  const preview = () => {
    const html = updateCards.call(null, [{ ...current(), title: current().title || 'Title' }]);
    f.querySelector('#nPreview').innerHTML = html.replace(/data-dismiss-update="[^"]*"/, 'disabled');
  };
  drawItems(); preview();
  ['title', 'intro', 'issuer', 'from', 'until'].forEach((k) => (f[k].oninput = preview));
  f.querySelector('#addItem').onclick = () => { items.push(['check', '', '']); drawItems(); preview(); };
  f.querySelector('#nCancel').onclick = () => (box.innerHTML = '');
  f.onsubmit = async (e) => {
    e.preventDefault();
    const err = f.querySelector('.form-error'); const row = current();
    if (!row.title) { err.textContent = 'Write a title.'; f.title.focus(); return; }
    if (row.show_until && Date.parse(row.show_until) <= Date.parse(row.show_from)) { err.textContent = 'The end time must be after the start time.'; return; }
    const btn = f.querySelector('[type=submit]'); btn.disabled = true;
    try {
      if (isNew) { row.id = `${row.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'notice'}-${Date.now().toString(36)}`; check(await sb.from('announcements').insert(row)); }
      else { delete row.id; check(await sb.from('announcements').update(row).eq('id', a.id)); }
      toast(isNew ? (Date.parse(row.show_from) > Date.now() ? 'Notice scheduled.' : 'Notice published.') : 'Notice saved.', 'ok'); renderAdminNotices();
    } catch (e2) { btn.disabled = false; err.textContent = errMsg(e2); }
  };
  box.scrollIntoView({ block: 'start' }); f.title.focus({ preventScroll: true });
}

/* ---------- Admin: insights ---------- */

async function renderAdminInsights() {
  const view = shell('admin', loading);
  const [meta, ov, stats, people, mockRows, missed] = await Promise.all([
    loadMeta(),
    sb.rpc('admin_overview'),
    sb.rpc('progress_stats').then(check),
    sb.from('profiles').select('id,full_name,email,role,active').then(check),
    fetchAll(() => sb.from('sessions').select('id,user_id,label,total,answered,correct,points,started_at,finished_at,details_cleared').eq('mode', 'mock').eq('set_id', state.setId).not('finished_at', 'is', null).order('started_at', { ascending: false })),
    sb.rpc('admin_most_missed', { p_limit: 20, p_min: 3, p_set: state.setId }),
  ]);
  const learners = people.filter((p) => p.active && p.role !== 'admin');
  const name = new Map(people.map((p) => [p.id, p.full_name || p.email]));
  const final = EXAMS.find((e) => e.key === 'final'); const mock = EXAMS.find((e) => e.key === 'mock');
  const daysTo = (e) => Math.max(0, Math.ceil((Date.parse(e.at) - Date.now()) / 864e5));

  // Readiness per learner
  const byUser = new Map(); for (const r of stats) { if (!byUser.has(r.user_id)) byUser.set(r.user_id, new Map()); byUser.get(r.user_id).set(r.category_id, r); }
  const totalQs = sum(meta.disciplines.map((d) => d.total));
  const rows = learners.map((p) => {
    const st = byUser.get(p.id) || new Map(); const r = readiness(meta, st); const all = rollUp([...st.values()]);
    const mocks = mockRows.filter((m) => m.user_id === p.id);
    const gaps = r.per.filter((x) => x.d.weight >= 8 && x.d.total && ((x.coverage ?? 0) < 25 || (x.s.attempts >= 5 && x.acc < 60)))
      .map((x) => `${x.d.name} (${x.d.weight}%): ${(x.coverage ?? 0) < 25 ? `${x.coverage ?? 0}% seen` : `${x.acc}% right`}`);
    return { p, score: r.score, cover: pctNum(all.answered, totalQs) || 0, last: all.last, mock: mocks[0], gaps };
  }).sort((a, b) => (a.score ?? -1) - (b.score ?? -1));

  // Mock results: change vs that learner's previous mock
  const prevOf = (m) => mockRows.filter((x) => x.user_id === m.user_id && Date.parse(x.started_at) < Date.parse(m.started_at))[0];
  const groupAvg = mockRows.length ? out10(sum(mockRows.map(sess10)), mockRows.length * 10) : null;

  // Most missed: question text
  const mm = missed.error ? [] : missed.data || [];
  const mmQs = mm.length ? await fetchQuestions(mm.map((x) => x.question_id)) : [];
  const qById = new Map(mmQs.map((q) => [q.id, q]));

  const o = ov.error ? null : ov.data;
  const bar = (v, max) => { const p = Math.min(100, Math.round((100 * v) / max)); return `<span class="bar ${p > 80 ? 'bad' : p > 60 ? 'warn' : 'ok'}"><span style="width:${Math.max(p, 1)}%"></span></span>`; };
  const mb = (b) => (b / 1048576).toFixed(1) + ' MB';

  view.innerHTML = `${adminTabs('insights')}
    <h1 style="margin:0 0 4px">Insights</h1><p class="muted">Mock exam in ${daysTo(mock)} day${daysTo(mock) === 1 ? '' : 's'} · final exam in ${daysTo(final)} days.</p>

    <section class="card" aria-labelledby="inR"><h2 id="inR">${icon('target')}Readiness</h2>
      <p class="muted small">Lowest estimated score first. Flags a heavily weighted discipline (8%+ of the exam) with under 25% of its questions seen, or under 60% right.</p>
      <div class="table-wrap"><table><thead><tr><th>Learner</th><th class="n">Est. score</th><th class="n">Latest mock</th><th class="n">Bank seen</th><th>Needs attention</th><th>Last practised</th></tr></thead><tbody>
      ${rows.map((x) => `<tr><td><a href="#/admin/learner/${x.p.id}">${esc(name.get(x.p.id))}</a></td>
        <td class="n">${x.score === null ? '<span class="muted">–</span>' : `<span class="acc ${accClass(x.score)}">${x.score}%</span>`}</td>
        <td class="n">${x.mock ? `${fmt10(sess10(x.mock))}/10` : '<span class="muted">none</span>'}</td>
        <td class="n">${x.cover}%</td>
        <td class="small">${x.gaps.length ? x.gaps.map((g) => `<span class="chip warn">${esc(g)}</span>`).join(' ') : '<span class="muted">Nothing flagged</span>'}</td>
        <td class="small">${x.last ? esc(fmtDate(x.last)) : '<span class="muted">never</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No learners yet.</td></tr>'}
      </tbody></table></div></section>

    <section class="card" aria-labelledby="inM"><h2 id="inM">${icon('exam')}Mock exam results</h2>
      <p class="muted small">${mockRows.length} finished mock exam${mockRows.length === 1 ? '' : 's'}${groupAvg !== null ? ` · group average ${fmt10(groupAvg)}/10` : ''}. Mocks from 22 Nov use partial marks for multi-answer questions.</p>
      <div class="table-wrap"><table><thead><tr><th>Learner</th><th>Date</th><th class="n">Final mark</th><th class="n">Score</th><th class="n">Marks</th><th class="n">Change</th><th class="n">Time</th><th></th></tr></thead><tbody>
      ${mockRows.map((m) => { const pv = prevOf(m); const d = pv ? Math.round(100 * (sess10(m) - sess10(pv))) / 100 : null; const mins = Math.round((Date.parse(m.finished_at) - Date.parse(m.started_at)) / 60000);
        return `<tr><td>${esc(name.get(m.user_id) || 'Learner')}</td><td class="small">${esc(fmtDate(m.started_at))}</td><td class="n"><b>${fmt10(sess10(m))}</b>/10</td><td class="n"><span class="acc ${accClass(sessPct(m))}">${sessPct(m)}%</span></td><td class="n small">${esc(sessScore(m))}</td>
          <td class="n">${d === null ? '<span class="muted">first</span>' : `<span class="acc ${d >= 0 ? 'hi' : 'lo'}">${d > 0 ? '+' : ''}${d.toFixed(2)}</span>`}</td><td class="n small">${mins} min</td><td class="n">${m.details_cleared ? '<span class="muted small">Score only</span>' : `<a class="btn sm" href="#/mockreview/${m.id}">${icon('eye')}Review</a>`}</td></tr>`; }).join('') || '<tr><td colspan="8" class="muted">No mock exams finished yet.</td></tr>'}
      </tbody></table></div></section>

    <section class="card" aria-labelledby="inX"><h2 id="inX">${icon('alert')}Most missed questions</h2>
      <p class="muted small">First attempts only, questions answered by at least 3 learners. Learners can practise this list from Practice → "Most missed by the group". A question almost everyone gets wrong is worth checking against the university file.</p>
      ${missed.error ? `<p class="muted">${missingInDb(missed.error) ? 'Not switched on yet.' : esc(errMsg(missed.error))}</p>` : mm.length ? `<ol class="mm-list">${mm.map((x) => { const q = qById.get(x.question_id); if (!q) return '';
        const t = meta.topicById.get(q.category_id); const d = t && meta.discById.get(t.discipline_id);
        return `<li class="mm"><div class="row-between"><span class="small">${d ? `<span class="chip pri">${esc(d.name)}</span> ` : ''}<span class="chip">#${q.id}</span></span><span class="chip ${x.wrong_pct >= 70 ? 'bad' : 'warn'}">${x.wrong_pct}% wrong · ${x.wrong}/${x.learners} learners</span></div>
          <p class="rq" style="margin:6px 0">${esc(q.question)}</p>
          <ul class="ropts small">${q.options.map((op, i) => { const key = q.correct.includes(i); const pick = (x.common_wrong || []).includes(i);
            return `<li class="${key ? 'c' : pick ? 'w' : ''}"><b>${LETTERS[i]}</b><span>${esc(op)}</span>${key ? '<span class="tag">Correct</span>' : pick ? `<span class="tag">Common wrong pick${x.common_wrong_n > 1 ? ` (${x.common_wrong_n})` : ''}</span>` : ''}</li>`; }).join('')}</ul>
          <div class="btn-row"><a class="btn sm" href="#/admin/questions" data-open-q="${q.id}">${icon('layers')}Edit in Questions</a></div></li>`; }).join('')}</ol>` : '<p class="muted">Not enough answers yet. Each question needs first attempts from at least 3 learners.</p>'}
    </section>

    <section class="card" aria-labelledby="inU"><h2 id="inU">${icon('shield')}Supabase usage</h2>
      ${o ? `<div class="grid stats">
        <div class="stat"><span class="label">Database size</span><span class="value">${mb(o.db_bytes)}</span><span class="hint">${bar(o.db_bytes, 500 * 1048576)} of 500 MB free-plan limit</span></div>
        <div class="stat"><span class="label">Connections now</span><span class="value">${o.connections}</span><span class="hint">${bar(o.connections, o.max_connections)} of ${o.max_connections}</span></div>
        <div class="stat"><span class="label">Answers</span><span class="value">${Number(o.answers_24h).toLocaleString()}</span><span class="hint">last 24 h · ${Number(o.answers_7d).toLocaleString()} in 7 days</span></div>
        <div class="stat"><span class="label">Learners studying</span><span class="value">${o.learners_24h}</span><span class="hint">last 24 h · ${o.learners_7d} in 7 days · ${o.open_sessions} signed in now</span></div>
      </div>
      <p class="muted small" style="margin:12px 0 0">Largest tables: ${(o.tables || []).map((t) => `${esc(t.name)} ${mb(t.bytes)}`).join(' · ')}. Requests are unlimited on the free plan. Data transfer (5 GB a month) is only shown in the <a href="https://supabase.com/dashboard/project/uzfzkosftfpyhhevjgee/usage" target="_blank" rel="noopener">Supabase dashboard → Usage</a>.</p>`
      : `<p class="muted">${ov.error && missingInDb(ov.error) ? 'Not switched on yet.' : esc(errMsg(ov.error))}</p>`}
    </section>`;

  view.querySelectorAll('[data-open-q]').forEach((a) => (a.onclick = () => { state.openQuestion = +a.dataset.openQ; }));
}

/* ---------- Admin: security ---------- */

const EVENT_LABEL = { login: 'Signed in', replaced_other: 'Other device signed out', blocked_location: 'Blocked: new country', blocked_country: 'Blocked: outside allowed countries', admin_signout: 'Signed out by admin' };

/** Returns null when migration 004 isn't in the database yet. */
async function loadLoginEvents(days = 30, userId = null) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  let q = sb.from('login_events').select('user_id,at,event,device,ip,country,detail').gte('at', since).order('at', { ascending: false }).limit(1000);
  if (userId) q = q.eq('user_id', userId);
  const { data, error } = await q;
  if (error) { if (missingInDb(error)) return null; throw error; }
  return data;
}

/** Signs that an account may be shared, from the last 7 days of sign-ins. */
function sharingFlags(events) {
  const week = Date.now() - 7 * 86400000;
  const ev = events.filter((e) => new Date(e.at).getTime() >= week);
  const out = [];
  const switches = ev.filter((e) => e.event === 'replaced_other').length;
  const countries = [...new Set(ev.filter((e) => e.event === 'login' && e.country).map((e) => e.country))];
  const devices = [...new Set(ev.filter((e) => e.event === 'login' && e.device).map((e) => e.device))];
  const ips = [...new Set(ev.filter((e) => e.event === 'login' && e.ip).map((e) => e.ip))];
  const blocked = ev.filter((e) => e.event === 'blocked_location' || e.event === 'blocked_country').length;
  if (switches >= 3) out.push(`${switches} device take-overs`);
  if (countries.length >= 2) out.push(`signed in from ${countries.join(', ')}`);
  if (blocked) out.push(`${blocked} blocked sign-in${blocked > 1 ? 's' : ''} from a new country`);
  if (devices.length >= 3) out.push(`${devices.length} different devices`);
  if (ips.length >= 6) out.push(`${ips.length} different networks`);
  return out;
}

function eventsTable(events, names = null) {
  if (!events.length) return '<p class="muted">No sign-ins recorded yet.</p>';
  return `<div class="table-wrap"><table><thead><tr><th>When</th>${names ? '<th>Learner</th>' : ''}<th>Event</th><th>Device</th><th>Country</th><th>IP address</th></tr></thead><tbody>
    ${events.map((e) => `<tr><td>${fmtDate(e.at)}</td>${names ? `<td>${esc(names.get(e.user_id) || '–')}</td>` : ''}
      <td>${e.event === 'login' ? EVENT_LABEL.login : `<span class="chip ${e.event.startsWith('blocked') ? 'bad' : 'warn'}">${esc(EVENT_LABEL[e.event] || e.event)}</span>`}${e.detail ? `<br><span class="muted small">${esc(e.detail)}</span>` : ''}</td>
      <td>${esc(e.device || '–')}</td><td>${esc(e.country || '–')}</td><td class="num">${esc(e.ip || '–')}</td></tr>`).join('')}
    </tbody></table></div>`;
}

const notEnabledCard = () => `<section class="card"><h2>${icon('shield')} Security isn't switched on yet</h2>
  <p class="muted">The security rules need a one-time database update. Run <code>supabase/migration_004_security.sql</code> from the repository in the Supabase SQL Editor, then reload this page.</p></section>`;

async function renderAdminSecurity() {
  const view = shell('admin', loading);
  const settingsRes = await sb.from('security_settings').select('*').maybeSingle();
  if (settingsRes.error && missingInDb(settingsRes.error)) { view.innerHTML = adminTabs('security') + notEnabledCard(); return; }
  const c = check(settingsRes);
  const [profiles, events, active, audit, devRows] = await Promise.all([
    sb.from('profiles').select('id,full_name,email,role').then(check),
    loadLoginEvents(30),
    sb.from('user_sessions').select('session_id,user_id,device,ip,country,started_at,last_seen').is('ended_at', null).order('last_seen', { ascending: false }).then(check),
    sb.from('admin_audit').select('id,at,actor,action,target,detail').order('at', { ascending: false }).limit(100).then(({ data, error }) => (error ? null : data)),
    sb.from('devices').select('user_id,fingerprint,device_id,label,last_seen').then(({ data, error }) => (error ? [] : data)),
  ]);
  const names = new Map(profiles.map((p) => [p.id, p.full_name || p.email]));
  const freshCut = Date.now() - Math.max(c.idle_minutes || 60, 5) * 60000;
  const online = active.filter((s) => new Date(s.last_seen).getTime() > freshCut);
  const seenCountries = [...new Set(events.filter((e) => e.country).map((e) => e.country))];
  const opt = (vals, cur, unit) => vals.map((v) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${v === 0 ? 'Off' : `${v} ${unit}${v === 1 ? '' : 's'}`}</option>`).join('');
  const flagged = profiles.map((p) => ({ p, f: sharingFlags(events.filter((e) => e.user_id === p.id)) })).filter((x) => x.f.length);
  // Devices that more than one account has used (same fingerprint or same device cookie)
  const groups = new Map();
  for (const d of devRows) for (const k of [d.fingerprint, d.device_id && 'c:' + d.device_id].filter(Boolean)) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); }
  const sharedDevs = []; const seenSets = new Set();
  for (const list of groups.values()) {
    const users = [...new Set(list.map((d) => d.user_id))]; if (users.length < 2) continue;
    const key = users.sort().join(','); if (seenSets.has(key)) continue; seenSets.add(key);
    sharedDevs.push({ users, label: list[0].label, last: list.map((d) => d.last_seen).sort().pop() });
  }

  view.innerHTML = `${adminTabs('security')}
    <h1>Security</h1>
    <div class="grid two">
      <form class="card" id="secForm">
        <h2>Sign-in rules</h2>
        <label class="choice"><input type="checkbox" name="one_device" ${c.one_device ? 'checked' : ''}><span><b>One device at a time</b><small>Signing in on a new device signs the old one out straight away.</small></span></label>
        <label class="field">Sign out after no activity for<select name="idle_minutes">${opt([0, 15, 30, 60, 120, 240], c.idle_minutes, 'minute')}</select><span class="help">A warning appears a minute before.</span></label>
        <label class="field">Maximum length of a sign-in<select name="max_session_hours">${opt([0, 4, 8, 12, 24, 72, 168], c.max_session_hours, 'hour')}</select><span class="help">After this, the learner has to sign in again even if active.</span></label>
        <label class="field">Block sign-in from a different country within<select name="country_lock_hours">${opt([0, 6, 12, 24, 48, 168], c.country_lock_hours, 'hour')}</select>
          <span class="help">${seenCountries.length ? `Country detection is working (seen: ${esc(seenCountries.join(', '))}).` : 'The country is shown here after the next sign-in. If it never appears, this rule has no effect.'}</span></label>
        <label class="field">Only allow use from<input type="text" name="geo_countries" value="${esc((c.geo_countries || []).join(', '))}" placeholder="Empty = any country" autocomplete="off">
          <span class="help">Two-letter country codes, separated by commas (MD = Moldova, SA = Saudi Arabia). Checked on every request, so a learner who travels or turns on a VPN is signed out. Leave empty to allow every country.${c.geo_countries?.length ? ` Now: ${esc(countryList(c.geo_countries))}.` : ''}</span></label>
        <label class="choice"><input type="checkbox" name="admins_exempt" ${c.admins_exempt ? 'checked' : ''}><span><b>Admins are exempt</b><small>Recommended, so you can't lock yourself out.</small></span></label>
        <div class="row-between" style="margin-top:12px"><span class="muted small">Last changed ${fmtDate(c.updated_at)}</span><button class="btn primary">Save rules</button></div>
      </form>
      <section class="card">
        <h2>Possible account sharing <span class="muted small">(last 7 days)</span></h2>
        ${flagged.length ? `<ul class="flags">${flagged.map((x) => `<li><a href="#/admin/learner/${x.p.id}">${esc(x.p.full_name || x.p.email)}</a><br><span class="muted small">${esc(x.f.join(' · '))}</span></li>`).join('')}</ul>`
          : '<p class="muted">Nothing unusual. Learners are flagged here after repeated device take-overs, sign-ins from several countries or many devices, or blocked sign-ins.</p>'}
        <h2 style="margin-top:24px">Devices used by more than one account</h2>
        ${sharedDevs.length ? `<ul class="flags">${sharedDevs.map((x) => `<li>${icon('alert')} <b>${esc(x.label || 'A device')}</b> · last seen ${fmtDate(x.last)}<br>${x.users.map((u) => `<a href="#/admin/learner/${u}">${esc(names.get(u) || 'Unknown')}</a>`).join(', ')}</li>`).join('')}</ul>`
          : '<p class="muted">None. A device shows up here when two or more accounts sign in on it (same fingerprint or same device cookie).</p>'}
        <h2 style="margin-top:24px">Signed in now</h2>
        ${online.length ? `<div class="table-wrap"><table><thead><tr><th>Learner</th><th>Device</th><th>Country</th><th>Last active</th><th></th></tr></thead><tbody>
          ${online.map((s) => `<tr><td>${esc(names.get(s.user_id) || '–')}</td><td>${esc(s.device || '–')}</td><td>${esc(s.country || '–')}</td><td>${fmtDate(s.last_seen)}</td>
            <td class="n">${s.user_id === state.profile.id ? '' : `<button class="btn sm" data-out="${s.user_id}">Sign out</button>`}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">Nobody right now.</p>'}
      </section>
    </div>
    <section class="card"><h2>Sign-in activity <span class="muted small">(last 30 days)</span></h2>${eventsTable(events.slice(0, 100), names)}</section>
    <section class="card"><h2>Admin activity <span class="muted small">(latest 100)</span></h2>
      <p class="muted small">Every account, allowlist, security-rule and notice change made by an admin. Question edits are in each question's history.</p>
      ${auditTable(audit, names)}</section>`;

  const f = view.querySelector('#secForm');
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const patch = { one_device: f.one_device.checked, idle_minutes: +f.idle_minutes.value, max_session_hours: +f.max_session_hours.value,
      country_lock_hours: +f.country_lock_hours.value, admins_exempt: f.admins_exempt.checked, updated_at: new Date().toISOString() };
    if (f.geo_countries) {
      const codes = [...new Set(f.geo_countries.value.toUpperCase().split(/[\s,;]+/).filter(Boolean))];
      const bad = codes.filter((x) => !/^[A-Z]{2}$/.test(x));
      if (bad.length) { toast(`Not a two-letter country code: ${bad.join(', ')}`, 'bad'); return; }
      patch.geo_countries = codes;
      if (codes.length && !patch.admins_exempt && !confirm(`Admins will also be limited to ${countryList(codes)}. If you are elsewhere, you will be locked out. Continue?`)) return;
    }
    if (!patch.admins_exempt && !confirm('Admins will follow the same rules, including timeouts. Continue?')) return;
    try { check(await sb.from('security_settings').update(patch).eq('id', true)); toast('Rules saved. They apply to everyone straight away.', 'ok'); await heartbeat(false); renderAdminSecurity(); }
    catch (e) { toast(errMsg(e), 'bad'); }
  };
  view.querySelectorAll('[data-out]').forEach((b) => (b.onclick = async () => {
    if (!confirm(`Sign ${names.get(b.dataset.out)} out of every device now?`)) return;
    try { check(await sb.rpc('admin_sign_out_user', { p_user: b.dataset.out })); toast('Signed out.', 'ok'); renderAdminSecurity(); } catch (e) { toast(errMsg(e), 'bad'); }
  }));
}

const AUDIT_LABELS = {
  'user.create': 'Created account', 'user.password': 'Set password', 'account.role': 'Changed role',
  'account.enable': 'Enabled account', 'account.disable': 'Disabled account', 'account.sign_out': 'Signed out of all devices',
  'allowlist.add': 'Added to allowlist', 'allowlist.remove': 'Removed from allowlist', 'allowlist.change': 'Changed allowlist role',
  'edge.denied': 'Blocked call to admin tools (not an admin)', 'security.settings': 'Changed sign-in rules', 'notice.publish': 'Published notice', 'notice.delete': 'Deleted notice',
};
function auditDetail(a) {
  const d = a.detail || {};
  if (a.action === 'account.role' || a.action === 'allowlist.change') return `${esc(d.from ?? '–')} → ${esc(d.to ?? '–')}`;
  if (a.action === 'security.settings') return Object.entries(d).filter(([k]) => k !== 'updated_at').map(([k, v]) => `${esc(k.replace(/_/g, ' '))}: ${esc(String(v.from))} → ${esc(String(v.to))}`).join('; ');
  if (d.title) return esc(d.title);
  if (d.role) return esc(d.role);
  return '';
}
function auditTable(rows, names) {
  if (rows === null) return '<p class="muted">The admin activity log isn\'t switched on yet (migration 013).</p>';
  if (!rows.length) return '<p class="muted">No admin activity recorded yet.</p>';
  const who = (id) => (id ? esc(names.get(id) || 'Unknown admin') : 'System');
  const target = (t) => (t ? esc(names.get(t) || t) : '');
  return `<div class="table-wrap"><table><thead><tr><th>When</th><th>Admin</th><th>Action</th><th>Who / what</th><th>Details</th></tr></thead><tbody>
    ${rows.map((a) => `<tr><td>${fmtDate(a.at)}</td><td>${who(a.actor)}</td><td>${esc(AUDIT_LABELS[a.action] || a.action)}</td><td>${target(a.target)}</td><td class="small">${auditDetail(a)}</td></tr>`).join('')}</tbody></table></div>`;
}

/* Presence: from open sign-in sessions. last_seen moves once a minute, and only
   when the person actually did something, so it means "last activity". */
const ONLINE_ACTIVE_MIN = 3;
async function loadPresence() {
  const { data, error } = await sb.from('user_sessions').select('user_id,last_seen').is('ended_at', null);
  if (error) { if (!missingInDb(error)) console.warn(error); return null; }
  const m = new Map();
  for (const r of data || []) { const t = Date.parse(r.last_seen); if (!m.has(r.user_id) || t > m.get(r.user_id)) m.set(r.user_id, t); }
  return m;
}
function presenceBadge(lastSeen) {
  const idleLimit = Number(SEC.idle) > 0 ? Number(SEC.idle) : 30;
  const mins = lastSeen ? Math.floor((Date.now() - lastSeen) / 60000) : Infinity;
  if (mins < ONLINE_ACTIVE_MIN) return `<span class="chip ok presence"><span class="dot on"></span>Online · active now</span>`;
  if (mins < idleLimit) return `<span class="chip warn presence" title="Signed in, no activity for ${mins} min"><span class="dot idle"></span>Online · idle ${mins} min</span>`;
  return `<span class="chip presence"><span class="dot"></span>Offline</span>`;
}
function paintPresence(root, presence) {
  root.querySelectorAll('[data-presence]').forEach((el) => { el.innerHTML = presence ? presenceBadge(presence.get(el.dataset.presence)) : ''; });
  const n = presence ? [...presence.values()].filter((t) => Date.now() - t < ONLINE_ACTIVE_MIN * 60000).length : 0;
  const sum = root.querySelector('#presenceSum'); if (sum && presence) sum.textContent = `${n} active now · updates every minute`;
}

async function renderAdminLearners() {
  const view = shell('admin', loading);
  const [profiles, stats, sessions, events, sets, access] = await Promise.all([
    sb.from('profiles').select('*').order('created_at').then(check),
    sb.rpc('progress_stats').then(check),
    fetchAll(() => sb.from('sessions').select('user_id,mode,answered,correct,total,started_at').eq('set_id', state.setId).gt('answered', 0).order('started_at')),
    loadLoginEvents(7),
    loadSets(true),
    sb.from('set_access').select('user_id,set_id').then(({ data, error }) => (error ? [] : data)),
  ]);
  const setName = new Map(sets.map((x) => [x.id, x.name]));
  const accessOf = (uid) => access.filter((a) => a.user_id === uid).map((a) => a.set_id);
  const presence = await loadPresence();
  const byUser = new Map();
  for (const r of stats) { if (!byUser.has(r.user_id)) byUser.set(r.user_id, []); byUser.get(r.user_id).push(r); }
  const sessByUser = new Map();
  for (const s of sessions) { if (!sessByUser.has(s.user_id)) sessByUser.set(s.user_id, []); sessByUser.get(s.user_id).push(s); }

  view.innerHTML = `${adminTabs('learners')}
    <div class="row-between"><div><h1 style="margin:0">Learners</h1><p class="muted small" id="presenceSum" style="margin:4px 0 0"></p></div><button class="btn primary" id="showAdd">+ Add learner</button></div>
    <form class="card" id="addForm" hidden novalidate>
      <h2>Add a learner</h2>
      <div class="grid two">
        <label class="field">Full name<input name="name" required autocomplete="off"></label>
        <label class="field">Email<input name="email" type="email" required autocomplete="off"></label>
        <label class="field">Temporary password<span class="input-btn"><input name="password" minlength="8" required autocomplete="off"><button type="button" class="btn sm" id="gen">Generate</button></span><span class="help">At least 8 characters. They can change it under Account.</span></label>
        <label class="field">Role<select name="role"><option value="learner">Learner</option><option value="admin">Admin</option></select></label>
      </div>
      <fieldset class="field"><legend>Question sets</legend><div class="btn-row">${sets.map((x) => `<label class="choice inline"><input type="checkbox" name="sets" value="${x.id}" ${x.id === USMF_SET ? 'checked' : ''}> ${esc(x.name)}</label>`).join('')}</div>
        <span class="help">The learner can only practise and take mocks in the sets ticked here. Admins always see every set.</span></fieldset>
      <div class="btn-row"><button class="btn primary" type="submit">Create account</button><button class="btn ghost" type="button" id="cancelAdd">Cancel</button></div>
      <p class="form-error" id="addErr" role="alert"></p>
    </form>
    <div id="created"></div>
    <section class="card"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th>Email</th><th class="n">Practised</th><th class="n">Accuracy</th><th class="n">Mock exams</th><th class="n">Latest mock</th><th>Question sets</th><th>Last active</th>${events ? '<th>Last sign-in</th>' : ''}<th>Account</th></tr></thead>
      <tbody>${profiles.map((p) => {
        const s = rollUp(byUser.get(p.id) || []); const ss = sessByUser.get(p.id) || []; const mocks = ss.filter((x) => x.mode === 'mock');
        const last = ss.length ? ss[ss.length - 1].started_at : s.last;
        return `<tr class="${p.active ? '' : 'inactive'}">
          <td><a href="#/admin/learner/${p.id}">${esc(p.full_name || '–')}</a>${p.role === 'admin' ? ' <span class="chip pri">admin</span>' : ''}</td>
          <td>${esc(p.email)}</td><td class="n">${s.answered}</td><td class="n">${pct(s.correct, s.attempts)}</td><td class="n">${mocks.length}</td>
          <td class="n">${mocks.length ? pct(mocks[mocks.length - 1].correct, mocks[mocks.length - 1].answered) : '–'}</td>
          <td>${p.role === 'admin' ? '<span class="muted small">All sets</span>' : accessOf(p.id).map((id) => `<span class="chip">${esc(setName.get(id) || '?')}</span>`).join(' ') || '<span class="chip warn">None</span>'}</td>
          <td><div data-presence="${p.id}"></div><span class="small">${fmtDate(last)}</span></td>${events ? (() => {
            const mine = events.filter((e) => e.user_id === p.id); const lastIn = mine.find((e) => e.event === 'login'); const fl = sharingFlags(mine);
            return `<td>${lastIn ? `${esc(lastIn.device || '')}${lastIn.country ? ' · ' + esc(lastIn.country) : ''}<br><span class="muted small">${fmtDate(lastIn.at)}</span>` : '<span class="muted">–</span>'}${fl.length ? `<br><span class="chip bad" title="${esc(fl.join(' · '))}">${icon('alert')}Possible sharing</span>` : ''}</td>`;
          })() : ''}<td>${p.active ? '<span class="chip ok">Enabled</span>' : '<span class="chip">Disabled</span>'}${'notice_version' in p && p.notice_version < NOTICE_VERSION ? '<br><span class="chip warn">Notice not accepted</span>' : ''}</td></tr>`;
      }).join('')}</tbody></table></div></section>`;

  paintPresence(view, presence);
  clearInterval(state.presenceTimer);
  state.presenceTimer = setInterval(async () => {
    const table = view.querySelector('[data-presence]');
    if (!table || !table.isConnected || document.hidden) { if (!table || !table.isConnected) clearInterval(state.presenceTimer); return; }
    paintPresence(view, await loadPresence());
  }, 60000);

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
      const made = await adminAction({ action: 'create_user', email, full_name: name, role, password });
      const chosen = fd.getAll('sets').map(Number);
      if (made?.id && chosen.length) {
        const { error: e2 } = await sb.from('set_access').insert(chosen.map((set_id) => ({ user_id: made.id, set_id })));
        if (e2) toast(`Account created, but question-set access wasn't saved: ${errMsg(e2)}. Set it on the learner's page.`, 'bad');
      }
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

/* Devices: one learner's devices, and which other accounts use the same device. */
async function loadDevices(userId) {
  const { data, error } = await sb.from('devices').select('*').eq('user_id', userId).order('last_seen', { ascending: false });
  if (error) return missingInDb(error) ? null : [];
  const fps = data.map((d) => d.fingerprint); const ids = data.map((d) => d.device_id).filter(Boolean);
  let others = [];
  if (fps.length) {
    const [a, b] = await Promise.all([
      sb.from('devices').select('user_id,fingerprint,device_id').in('fingerprint', fps).neq('user_id', userId),
      ids.length ? sb.from('devices').select('user_id,fingerprint,device_id').in('device_id', ids).neq('user_id', userId) : { data: [] },
    ]);
    others = [...(a.data || []), ...(b.data || [])];
  }
  const uids = [...new Set(others.map((o) => o.user_id))];
  const people = uids.length ? check(await sb.from('profiles').select('id,full_name,email').in('id', uids)) : [];
  const name = new Map(people.map((x) => [x.id, x.full_name || x.email]));
  return data.map((d) => ({ ...d, shared: [...new Set(others.filter((o) => o.fingerprint === d.fingerprint || (d.device_id && o.device_id === d.device_id)).map((o) => name.get(o.user_id) || 'Another account'))] }));
}
const DETAIL_LABELS = [['browser_os', 'Browser and system'], ['model', 'Device model'], ['os_version', 'System version'], ['architecture', 'Architecture'], ['screen', 'Screen'], ['pixel_ratio', 'Pixel ratio'], ['colour_depth', 'Colour depth'],
  ['languages', 'Languages'], ['time_zone', 'Time zone'], ['cpu_cores', 'Processor cores'], ['memory_gb', 'Memory (GB)'], ['touch_points', 'Touch points'], ['gpu', 'Graphics'], ['connection', 'Connection'],
  ['installed_app', 'Installed as app'], ['cookies_enabled', 'Cookies enabled'], ['do_not_track', 'Do Not Track'], ['device_cookie', 'Device cookie ID'], ['canvas', 'Canvas hash'], ['browser_versions', 'Browser versions'], ['user_agent', 'User agent']];
function devicesCard(p, devs) {
  if (devs === null) return '';
  const consent = p.device_consent_version >= DEVICE_CONSENT_VERSION ? `${icon('check')} Allowed the device check and cookies ${fmtDate(p.device_consent_at)}.` : `${icon('alert')} Has not allowed the device check yet. They will be asked at their next sign-in.`;
  const val = (v) => (v === null || v === undefined || v === '' ? '<span class="muted">–</span>' : esc(typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v)));
  return `<section class="card" aria-labelledby="devH"><h2 id="devH">${icon('shield')}Devices</h2>
    <p class="small">${consent}</p>
    ${!devs.length ? '<p class="muted">No devices recorded yet.</p>' : `<ol class="tickets">${devs.map((d) => { const x = d.details || {}; return `<li><details class="card ticket device">
      <summary><div class="row-between"><span><b>${esc(d.label || x.browser_os || 'Device')}</b> <span class="muted small">${esc(x.screen || '')}${x.time_zone ? ' · ' + esc(x.time_zone) : ''}</span></span>
        <span>${d.shared.length ? `<span class="chip bad">${icon('alert')}Also used by ${esc(d.shared.join(', '))}</span> ` : ''}<span class="chip">${d.times_seen} visit${d.times_seen === 1 ? '' : 's'}</span></span></div>
        <span class="muted small">First seen ${esc(fmtDate(d.first_seen))} · last seen ${esc(fmtDate(d.last_seen))}${d.last_country ? ` from ${esc(countryName(d.last_country))}` : ''}${d.last_ip ? ` (${esc(d.last_ip)})` : ''} · fingerprint ${esc(d.fingerprint.slice(0, 12))}…</span></summary>
      <h3 class="small">All details</h3>
      <div class="table-wrap"><table class="kv"><tbody>${DETAIL_LABELS.filter(([k]) => k in x).map(([k, l]) => `<tr><th>${l}</th><td>${val(x[k])}</td></tr>`).join('')}
        <tr><th>Fingerprint</th><td class="mono small">${esc(d.fingerprint)}</td></tr></tbody></table></div>
      <h3 class="small">Cookies and stored data <span class="muted">(${(d.storage || []).length} items, sign-in tokens and keys hidden)</span></h3>
      ${(d.storage || []).length ? `<div class="table-wrap"><table class="kv"><thead><tr><th>Where</th><th>Name</th><th>Value</th></tr></thead><tbody>${d.storage.map((it) => `<tr><td class="small">${esc(it.area)}</td><td class="mono small">${esc(it.name)}</td><td class="mono small">${it.value === '[hidden]' ? '<span class="chip">hidden</span>' : esc(it.value)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted small">Nothing stored.</p>'}
    </details></li>`; }).join('')}</ol>`}
  </section>`;
}

async function paintSetAccess(box, p) {
  const [sets, { data: rows, error }] = await Promise.all([loadSets(true), sb.from('set_access').select('set_id,granted_at').eq('user_id', p.id)]);
  if (error) { box.innerHTML = `<p class="muted">${missingInDb(error) ? 'Question sets are not switched on yet.' : esc(errMsg(error))}</p>`; return; }
  const has = new Map(rows.map((r) => [r.set_id, r.granted_at]));
  box.innerHTML = `${p.role === 'admin' ? '<p class="muted small">Admins can use every set. The ticks matter only if this account becomes a learner.</p>' : '<p class="muted small">The learner can only practise and take mocks in the ticked sets.</p>'}
    <form id="setForm"><ul class="set-list">${sets.map((x) => `<li><label class="choice"><input type="checkbox" name="s" value="${x.id}" ${has.has(x.id) ? 'checked' : ''}><span><b>${esc(x.name)}</b>${has.has(x.id) ? `<small>Since ${esc(fmtDate(has.get(x.id), false))}</small>` : ''}</span></label></li>`).join('')}</ul>
    <button class="btn primary sm">Save access</button></form>`;
  box.querySelector('#setForm').onsubmit = async (e) => {
    e.preventDefault();
    const want = new Set([...box.querySelectorAll('input[name=s]:checked')].map((i) => +i.value));
    const add = [...want].filter((x) => !has.has(x)); const del = [...has.keys()].filter((x) => !want.has(x));
    try {
      if (add.length) check(await sb.from('set_access').insert(add.map((set_id) => ({ user_id: p.id, set_id }))));
      if (del.length) check(await sb.from('set_access').delete().eq('user_id', p.id).in('set_id', del));
      toast(add.length || del.length ? 'Access saved.' : 'Nothing changed.', 'ok'); paintSetAccess(box, p);
    } catch (x) { toast(errMsg(x), 'bad'); }
  };
}

async function renderAdminLearner(id) {
  const view = shell('admin', loading);
  const p = check(await sb.from('profiles').select('*').eq('id', id).maybeSingle());
  if (!p) { view.innerHTML = `${adminTabs('learners')}<div class="card empty"><p>Learner not found.</p><a class="btn" href="#/admin/learners">Back</a></div>`; return; }
  const self = p.id === state.profile.id;
  const [{ html, sessions }, events, secSettings, devs] = await Promise.all([progressHTML(id), loadLoginEvents(30, id),
    sb.from('security_settings').select('country_lock_hours').maybeSingle().then((r) => r.data, () => null),
    loadDevices(id)]);
  const flags = events ? sharingFlags(events) : [];
  const lockOn = secSettings && secSettings.country_lock_hours > 0;
  const allowed = p.location_ok_until && new Date(p.location_ok_until) > new Date();
  view.innerHTML = `${adminTabs('learners')}
    <a class="btn ghost sm" href="#/admin/learners">${icon('left')}All learners</a>
    <div class="page-head"><div><h1>${esc(p.full_name || p.email)}</h1><p class="muted">${esc(p.email)} · ${p.role === 'admin' ? 'Admin' : 'Learner'} · ${p.active ? 'Active' : 'Disabled'} · added ${fmtDate(p.created_at, false)}</p></div></div>
    ${html}
    <section class="card" aria-labelledby="qsH"><h2 id="qsH">${icon('book')}Question sets</h2><div id="setAccess"><p class="muted">Loading…</p></div></section>
    <section class="card"><h2>Manage account</h2>
      <div class="grid two">
        <form id="nameForm" class="inline-form"><label class="field">Name<input name="full_name" value="${esc(p.full_name || '')}"></label><button class="btn">Save</button></form>
        <form id="pwForm" class="inline-form"><label class="field">New password<span class="input-btn"><input name="pw" minlength="8" required placeholder="At least 8 characters" autocomplete="off"><button type="button" class="btn sm" id="gen">Generate</button></span></label><button class="btn">Set password</button></form>
      </div>
      <div class="btn-row" style="margin-top:20px;padding-top:16px;border-top:1px solid var(--line)">
        ${self ? '' : `<button class="btn" id="toggleActive">${p.active ? 'Disable account' : 'Re-enable account'}</button><button class="btn" id="toggleRole">${p.role === 'admin' ? 'Make learner' : 'Make admin'}</button>`}
        <button class="btn danger" id="reset">Reset all progress</button>
      </div></section>
    ${events ? `<section class="card" aria-labelledby="sis"><div class="row-between"><h2 id="sis">Sign-in security</h2>
        <div class="btn-row">${lockOn && !self ? `<button class="btn sm" id="allowLoc" ${allowed ? 'disabled' : ''}>${allowed ? `New country allowed until ${new Date(p.location_ok_until).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : 'Allow a new country for 24 h'}</button>` : ''}
        ${self ? '' : '<button class="btn sm" id="signOutAll">Sign out of all devices</button>'}</div></div>
      ${'notice_version' in p ? `<p class="small">${p.notice_version >= NOTICE_VERSION ? `${icon('check')} Accepted the security notice (version ${p.notice_version}) ${fmtDate(p.notice_accepted_at)}.` : `${icon('alert')} Has not accepted the security notice yet. They will be asked at their next sign-in.`}</p>` : ''}
      ${flags.length ? `<p class="chip bad">${icon('alert')}Possible sharing in the last 7 days: ${esc(flags.join(' · '))}</p>` : '<p class="muted small">No signs of account sharing in the last 7 days.</p>'}
      ${eventsTable(events.slice(0, 30))}</section>` : ''}
    ${devicesCard(p, devs)}`;
  paintSetAccess(view.querySelector('#setAccess'), p);
  drawCurveInto(view.querySelector('#curve'), sessions);
  const so = view.querySelector('#signOutAll');
  if (so) so.onclick = async () => {
    if (!confirm(`Sign ${p.full_name || p.email} out of every device now?`)) return;
    try { check(await sb.rpc('admin_sign_out_user', { p_user: id })); toast('Signed out of all devices.', 'ok'); renderAdminLearner(id); } catch (e) { toast(errMsg(e), 'bad'); }
  };
  const al = view.querySelector('#allowLoc');
  if (al) al.onclick = async () => {
    try { check(await sb.from('profiles').update({ location_ok_until: new Date(Date.now() + 86400000).toISOString() }).eq('id', id)); toast('They can sign in from a new country for the next 24 hours.', 'ok'); renderAdminLearner(id); } catch (e) { toast(errMsg(e), 'bad'); }
  };

  const update = async (patch, msg) => { try { check(await sb.from('profiles').update(patch).eq('id', id)); toast(msg, 'ok'); renderAdminLearner(id); } catch (e) { toast(errMsg(e), 'bad'); } };
  view.querySelector('#nameForm').onsubmit = (ev) => { ev.preventDefault(); update({ full_name: ev.target.full_name.value.trim() || null }, 'Name saved.'); };
  view.querySelector('#gen').onclick = () => { view.querySelector('#pwForm').pw.value = randomPassword(); };
  view.querySelector('#pwForm').onsubmit = async (ev) => {
    ev.preventDefault(); const pw = ev.target.pw.value;
    if (pw.length < 8) { toast('The password must be at least 8 characters.', 'bad'); return; }
    try { await adminAction({ action: 'set_password', user_id: id, password: pw }); } catch (e) { toast(errMsg(e), 'bad'); return; }
    try { await navigator.clipboard.writeText(pw); toast('Password set and copied to clipboard.', 'ok'); } catch { toast('Password set. Copy it from the box before leaving.', 'ok'); }
  };
  const ta = view.querySelector('#toggleActive'); if (ta) ta.onclick = async () => {
    if (p.active && events) await sb.rpc('admin_sign_out_user', { p_user: id }).then(() => {}, () => {});
    update({ active: !p.active }, p.active ? 'Account disabled and signed out.' : 'Account re-enabled.');
  };
  const tr = view.querySelector('#toggleRole'); if (tr) tr.onclick = () => { if (confirm(p.role === 'admin' ? 'Remove admin rights?' : 'Give this person full admin rights?')) update({ role: p.role === 'admin' ? 'learner' : 'admin' }, 'Role updated.'); };
  view.querySelector('#reset').onclick = async () => {
    if (!confirm(`Delete all practice history, marked questions, mock exams and the improvement curve for ${p.full_name || p.email}? This can't be undone.`)) return;
    try {
      check(await sb.from('answers').delete().eq('user_id', id));
      check(await sb.from('sessions').delete().eq('user_id', id));
      check(await sb.from('progress').delete().eq('user_id', id));
      check(await sb.from('marks').delete().eq('user_id', id));
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
    const made = check(await sb.from('disciplines').insert(newDiscs.map((name, k) => ({ name, profile: 'Other', weight: 0, sort: 100 + k, set_id: state.setId }))).select('id,name'));
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
  if (skipDuplicates) (await fetchAll(() => sb.from('questions').select('category_id,question,options').eq('set_id', state.setId).order('id'))).forEach((q) => seen.add(key(q.category_id, q.question, q.options)));
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

/** Question form (new or edit), shown inside editorEl. */
function questionEditor(editorEl, meta, q, opts = {}) {
  if (!meta.topics.length) { toast('Import questions or create a topic first.', 'bad'); return; }
  const isNew = !q;
  q = q || { category_id: opts.defaultCat || meta.disciplines.find((d) => d.topics.length)?.topics[0]?.id, question: '', options: ['', '', '', '', ''], correct: [0], explanation: '' };
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
    if (!isNew) {
      const keyText = (opts2, key) => key.map((k) => opts2[k]).join('|');
      if (!sameSet(correct, q.correct) || keyText(options, correct) !== keyText(q.options, q.correct)) {
        if (!confirm('This changes the answer key, or the text of a correct option.\n\nKeys must match the university file exactly. Continue only if the file says so.')) return;
      }
    }
    try {
      if (isNew) check(await sb.from('questions').insert(row)); else check(await sb.from('questions').update(row).eq('id', q.id));
      toast('Saved.', 'ok'); state.meta = null; opts.onSaved && opts.onSaved();
    } catch (e2) { err.textContent = errMsg(e2); }
  };
  if (!isNew) {
    f.insertAdjacentHTML('beforeend', `<details class="qhist"><summary>${icon('clock')}Change history</summary><div class="qhist-body">${loading}</div></details>`);
    f.querySelector('.qhist').addEventListener('toggle', (e) => { if (e.target.open) loadQuestionHistory(f.querySelector('.qhist-body'), q, opts); }, { once: true });
  }
  editorEl.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  f.question.focus({ preventScroll: true });
}

/** Admin: past versions of one question, with Undo. Every edit is logged by the database. */
async function loadQuestionHistory(box, q, opts = {}) {
  const { data, error } = await sb.from('question_history').select('id,action,changed_at,changed_by,old_row,new_row,key_changed').eq('question_id', q.id).order('changed_at', { ascending: false }).limit(30);
  if (error) { box.innerHTML = `<p class="muted small">${missingInDb(error) ? 'History is not switched on yet.' : esc(errMsg(error))}</p>`; return; }
  if (!data.length) { box.innerHTML = '<p class="muted small">No changes recorded yet. Edits from now on are kept here.</p>'; return; }
  const keyLetters = (r) => (r && Array.isArray(r.correct) ? r.correct.map((k) => LETTERS[k]).join(', ') : '–');
  const what = (h) => {
    if (h.action === 'delete') return 'Question deleted';
    const o = h.old_row, n = h.new_row, parts = [];
    if (o.question !== n.question) parts.push('question text');
    if (JSON.stringify(o.options) !== JSON.stringify(n.options)) parts.push(`options (${(o.options || []).length} → ${(n.options || []).length})`);
    if (JSON.stringify(o.correct) !== JSON.stringify(n.correct)) parts.push(`key ${keyLetters(o)} → ${keyLetters(n)}`);
    if ((o.explanation || '') !== (n.explanation || '')) parts.push('explanation');
    if (o.category_id !== n.category_id) parts.push('topic');
    if (o.active !== n.active) parts.push(n.active ? 'shown' : 'hidden');
    return 'Changed: ' + (parts.join(', ') || 'details');
  };
  box.innerHTML = `<ol class="qhist-list">${data.map((h) => `<li>
      <div class="row-between"><span><b>${esc(fmtDate(h.changed_at))}</b> · ${esc(what(h))}</span>${h.key_changed ? `<span class="chip bad">${icon('alert')}Answer key changed</span>` : ''}</div>
      <details><summary class="small">Version before this change</summary><p class="small"><b>${esc(h.old_row.question)}</b></p>
        <ul class="ropts small">${(h.old_row.options || []).map((o, i) => `<li class="${(h.old_row.correct || []).includes(i) ? 'c' : ''}"><b>${LETTERS[i]}</b><span>${esc(o)}</span>${(h.old_row.correct || []).includes(i) ? '<span class="tag">Correct</span>' : ''}</li>`).join('')}</ul></details>
      ${h.action === 'update' ? `<button class="btn sm" type="button" data-undo="${h.id}">${icon('retry')}Undo: restore this version</button>` : ''}
    </li>`).join('')}</ol>`;
  box.querySelectorAll('[data-undo]').forEach((b) => (b.onclick = async () => {
    const h = data.find((x) => x.id === +b.dataset.undo); const o = h.old_row;
    if (!confirm(`Restore the version from before ${fmtDate(h.changed_at)}?${h.key_changed ? '\n\nThis also restores the old answer key.' : ''}`)) return;
    b.disabled = true;
    try {
      check(await sb.from('questions').update({ category_id: o.category_id, question: o.question, options: o.options, correct: o.correct, correct_index: o.correct_index, qtype: o.qtype, explanation: o.explanation, active: o.active }).eq('id', q.id));
      toast('Previous version restored. The undo is in the history too.', 'ok'); state.meta = null; opts.onSaved && opts.onSaved();
    } catch (e) { b.disabled = false; toast(errMsg(e), 'bad'); }
  }));
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
    <p class="muted">Question set <b>${esc(currentSet()?.name || '')}</b>: ${totalQs.toLocaleString()} active questions in ${meta.topics.length} topics across ${meta.disciplines.length} disciplines. Switch sets in the bar at the top.</p>
    <section class="card" aria-labelledby="qsM"><h2 id="qsM">${icon('book')}Question sets</h2>
      <ul class="set-list">${(state.sets || []).map((x) => `<li class="row-between"><span><b>${esc(x.name)}</b>${x.id === state.setId ? ' <span class="chip pri">Showing</span>' : ''}</span><button class="btn sm ghost" data-rename="${x.id}">Rename</button></li>`).join('')}</ul>
      <form id="newSet" class="inline-form"><label class="field">New set<input name="name" maxlength="60" placeholder="For example: Surgery 4th year"></label><button class="btn">Add set</button></form>
      <p class="muted small">A new set starts empty: switch to it, then use Bulk import or New question. Give learners access on their page under Admin → Learners.</p></section>
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
  view.querySelector('#newSet').onsubmit = async (e) => {
    e.preventDefault(); const name = e.target.name.value.trim();
    if (name.length < 2) { toast('Type a name for the set.', 'bad'); return; }
    try { check(await sb.from('question_sets').insert({ name, sort: (state.sets?.length || 0) + 1 })); await loadSets(true); toast(`Added "${name}".`, 'ok'); renderAdminQuestions(); }
    catch (x) { toast(/duplicate|unique/i.test(errMsg(x)) ? 'A set with that name already exists.' : errMsg(x), 'bad'); }
  };
  view.querySelectorAll('[data-rename]').forEach((b) => (b.onclick = async () => {
    const x = state.sets.find((y) => y.id === +b.dataset.rename);
    const name = (prompt('New name for this question set:', x.name) || '').trim();
    if (!name || name === x.name) return;
    try { check(await sb.from('question_sets').update({ name }).eq('id', x.id)); await loadSets(true); toast('Renamed.', 'ok'); renderAdminQuestions(); }
    catch (err) { toast(errMsg(err), 'bad'); }
  }));
  view.querySelector('#exportBtn').onclick = async () => {
    const qs = await fetchAll(() => sb.from('questions').select('category_id,question,options,qtype,correct,explanation,active').eq('set_id', state.setId).order('id'));
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
  const openEditor = (q) => questionEditor(editorEl, meta, q, { defaultCat: +fTopic.value, onSaved: () => renderAdminQuestions() });
  view.querySelector('#newQ').onclick = () => openEditor(null);
  if (state.openQuestion) {   // arrived from Insights → "Edit in Questions"
    const id = state.openQuestion; state.openQuestion = null;
    const { data } = await sb.from('questions').select(QCOLS + ',active').eq('id', id).maybeSingle();
    if (data) openEditor(data); else toast('That question no longer exists.', 'bad');
  }
}

/* =========================================================================
   Boot
   ========================================================================= */

(async () => {
  if (!configured) {
    $app.innerHTML = '<main class="auth-wrap"><div class="card auth"><h1>Almost there</h1><p>Add your Supabase URL and publishable key to <code>config.js</code>.</p></div></main>';
    return;
  }
  try {
    await loadProfile();
    if (state.profile && (await heartbeat(false))) startSecurityTimers();
  } catch (e) { state.flash = state.flash || errMsg(e); }
  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      if (!SEC.leaving && !state.flash) state.flash = 'You were signed out. This happens when your account is signed in on another device or your session ends.';
      stopSecurityTimers();
      clearInterval(state.timer);
      Object.assign(state, { profile: null, meta: null, run: null, exam: null, examResult: null, drafts: null, noticesOk: false, mfaOk: false, sets: null, setId: null, pool: null });
      document.getElementById('toasts').replaceChildren();
      setTimeout(() => (location.hash === '' || location.hash === '#/login' ? router() : (location.hash = '#/login')), 0);
    }
  });
  window.addEventListener('hashchange', router);
  window.addEventListener('unhandledrejection', (e) => toast(errMsg(e.reason), 'bad'));
  router();
})();
