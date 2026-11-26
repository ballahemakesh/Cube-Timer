/* CubeTimer front end. No build step: plain ES module. */

const PUZZLES = {
  '333': '3x3', '222': '2x2', '444': '4x4', '555': '5x5', '666': '6x6', '777': '7x7',
  '333bf': '3x3 blindfolded', '333fm': '3x3 fewest moves', '333oh': '3x3 one-handed',
  'clock': 'Clock', 'minx': 'Megaminx', 'pyram': 'Pyraminx', 'skewb': 'Skewb', 'sq1': 'Square-1',
  '444bf': '4x4 blindfolded', '555bf': '5x5 blindfolded',
};
const SCRAMBLE_LIB = 'https://cdn.cubing.net/v0/js/cubing/scramble';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let token = localStorage.getItem('ct_token');
let username = localStorage.getItem('ct_user');
let sessions = [], current = null, solves = [];
let scramble = '', scrambleToken = 0, scrambleFn = null;

/* ---------- API ---------- */
async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) { logout(); throw new Error(data.error || 'Please log in again.'); }
  if (!res.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.id); toast.id = setTimeout(() => (t.hidden = true), 3500);
}

/* ---------- time + stats ---------- */
const eff = s => s.penalty === 'dnf' ? Infinity : s.time_ms + (s.penalty === 'plus2' ? 2000 : 0);
const pad2 = n => String(n).padStart(2, '0');
function fmt(ms) {
  if (ms === null || ms === undefined) return '–';
  if (ms === Infinity) return 'DNF';
  const cs = Math.floor(Math.round(ms) / 10), s = Math.floor(cs / 100), c = cs % 100;
  return s >= 60 ? `${Math.floor(s / 60)}:${pad2(s % 60)}.${pad2(c)}` : `${s}.${pad2(c)}`;
}
// WCA style: drop best and worst 5% (rounded up), mean of 3 drops none.
function avgWindow(w) {
  const n = w.length, trim = n === 3 ? 0 : Math.ceil(n * 0.05);
  const kept = [...w].sort((a, b) => a - b).slice(trim, n - trim);
  return kept.includes(Infinity) ? Infinity : kept.reduce((a, b) => a + b, 0) / kept.length;
}
const currentAvg = (v, n) => v.length >= n ? avgWindow(v.slice(-n)) : null;
function bestAvg(v, n) {
  if (v.length < n) return null;
  let best = null;
  for (let i = 0; i + n <= v.length; i++) {
    const a = avgWindow(v.slice(i, i + n));
    if (best === null || a < best) best = a;
  }
  return best;
}

function renderStats() {
  const v = solves.map(eff);
  const finite = v.filter(x => x !== Infinity);
  const single = { cur: v.length ? v[v.length - 1] : null, best: finite.length ? Math.min(...finite) : null };
  const rows = [['Single', single.cur, single.best]];
  [[3, 'Mean of 3'], [5, 'Average of 5'], [12, 'Average of 12'], [100, 'Average of 100']]
    .forEach(([n, label]) => rows.push([label, currentAvg(v, n), bestAvg(v, n)]));
  $('#stats').innerHTML = '<thead><tr><th></th><th>Current</th><th>Best</th></tr></thead><tbody>' +
    rows.map(r => `<tr><th>${r[0]}</th><td>${fmt(r[1])}</td><td>${fmt(r[2])}</td></tr>`).join('') + '</tbody>';
  const mean = finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : null;
  $('#summary').textContent = `${solves.length} solve${solves.length === 1 ? '' : 's'}, session mean ${fmt(mean)}`;
}

function renderSolves() {
  $('#empty').hidden = solves.length > 0;
  $('#solveList').innerHTML = solves.slice(-100).reverse().map((s, i) => {
    const n = solves.length - i;
    const label = s.penalty === 'dnf' ? `DNF (${fmt(s.time_ms)})` : fmt(eff(s)) + (s.penalty === 'plus2' ? '+' : '');
    return `<li data-id="${s.id}" title="${esc(s.scramble)}"><span class="n">${n}</span>
      <span class="t ${s.penalty}">${label}</span>
      <span class="acts">
        <button data-act="plus2" class="${s.penalty === 'plus2' ? 'on' : ''}" aria-label="Add 2 seconds">+2</button>
        <button data-act="dnf" class="${s.penalty === 'dnf' ? 'on' : ''}" aria-label="Mark DNF">DNF</button>
        <button data-act="del" aria-label="Delete solve">×</button>
      </span></li>`;
  }).join('');
}

$('#solveList').addEventListener('click', async e => {
  const btn = e.target.closest('button[data-act]'); if (!btn) return;
  const id = +btn.closest('li').dataset.id, s = solves.find(x => x.id === id), act = btn.dataset.act;
  try {
    if (act === 'del') {
      await api('/solves/' + id, { method: 'DELETE' });
      solves = solves.filter(x => x.id !== id);
    } else {
      const penalty = s.penalty === act ? 'none' : act;
      await api('/solves/' + id, { method: 'PATCH', body: { penalty } });
      s.penalty = penalty;
    }
    renderAll(); showIdle();
  } catch (err) { toast(err.message); }
});

function renderAll() { renderStats(); renderSolves(); }

/* ---------- scrambles ---------- */
async function newScramble() {
  const mine = ++scrambleToken;
  scramble = '';
  const el = $('#scramble');
  el.className = 'scramble'; el.textContent = 'Generating scramble…';
  try {
    if (!scrambleFn) scrambleFn = (await import(SCRAMBLE_LIB)).randomScrambleForEvent;
    const alg = (await scrambleFn(current.puzzle)).toString();
    if (mine !== scrambleToken) return;
    scramble = alg;
    el.textContent = alg;
    el.className = 'scramble' + (alg.length > 90 ? ' long' : '');
  } catch (err) {
    console.error(err);
    if (mine === scrambleToken) el.textContent = 'Scrambles could not load. You can still time solves.';
  }
}

/* ---------- timer state machine ----------
   States: idle -> holding -> ready -> running -> idle.
   Everything that starts or stops the timer goes through down() and up(), so the
   Bluetooth device can drive the same two functions later (see window.cubeTimer). */
const T = { state: 'idle', holdTimer: null, start: 0, raf: 0, scramble: '' };
const HOLD_MS = 300;

function idleText() {
  const last = solves[solves.length - 1];
  return last ? (last.penalty === 'dnf' ? 'DNF' : fmt(eff(last)) + (last.penalty === 'plus2' ? '+' : '')) : '0.00';
}
function showIdle() { if (T.state === 'idle') $('#time').textContent = idleText(); }
function paint() {
  $('#pad').className = 'pad ' + T.state;
  $('#hint').textContent = {
    idle: 'Hold space (or press and hold here), release when it turns green.',
    holding: 'Keep holding…',
    ready: 'Release to start.',
    running: 'Press any key or tap to stop.',
  }[T.state];
}

function down() {
  if (T.state === 'running') return stop();
  if (T.state !== 'idle' || !current) return;
  T.state = 'holding'; paint(); $('#time').textContent = '0.00';
  T.holdTimer = setTimeout(() => { if (T.state === 'holding') { T.state = 'ready'; paint(); } }, HOLD_MS);
}
function up() {
  if (T.state === 'holding') { clearTimeout(T.holdTimer); T.state = 'idle'; paint(); showIdle(); }
  else if (T.state === 'ready') startRun();
}
function startRun() {
  T.state = 'running'; T.start = performance.now(); T.scramble = scramble; paint();
  const tick = () => {
    if (T.state !== 'running') return;
    $('#time').textContent = fmt(performance.now() - T.start);
    T.raf = requestAnimationFrame(tick);
  };
  tick();
}
async function stop() {
  const ms = Math.floor((performance.now() - T.start) / 10) * 10;
  cancelAnimationFrame(T.raf);
  T.state = 'idle'; paint();
  $('#time').textContent = fmt(ms);
  const sc = T.scramble;
  newScramble();
  try {
    const s = await api(`/sessions/${current.id}/solves`, { method: 'POST', body: { time_ms: ms, penalty: 'none', scramble: sc } });
    solves.push(s); renderAll();
  } catch (err) { toast('Could not save that solve: ' + err.message); }
}
window.cubeTimer = { down, up, stop }; // hook for the Arduino/Bluetooth device

const blocked = e => $('#appView').hidden || document.querySelector('dialog[open]') || e.target.closest('input, textarea');
document.addEventListener('keydown', e => {
  if (blocked(e)) return;
  if (T.state === 'running') { e.preventDefault(); return stop(); }
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) down(); }
});
document.addEventListener('keyup', e => {
  if (e.code === 'Space' && !blocked(e)) { e.preventDefault(); up(); }
});
document.addEventListener('pointerdown', e => {
  if ($('#appView').hidden) return;
  if (T.state === 'running') return stop();
  if (e.target.closest('#pad')) down();
});
document.addEventListener('pointerup', () => up());
document.addEventListener('pointercancel', () => up());

/* ---------- sessions ---------- */
function renderSessions() {
  $('#sessionSelect').innerHTML = sessions.map(s =>
    `<option value="${s.id}" ${s.id === current.id ? 'selected' : ''}>${esc(s.name)} (${PUZZLES[s.puzzle] || s.puzzle})</option>`).join('');
  $('#sessionTitle').textContent = `${current.name}, ${PUZZLES[current.puzzle] || current.puzzle}`;
}
async function selectSession(id) {
  current = sessions.find(s => s.id === id) || sessions[0];
  localStorage.setItem('ct_session', current.id);
  solves = await api(`/sessions/${current.id}/solves`);
  renderSessions(); renderAll(); paint(); showIdle(); newScramble();
}

$('#sessionSelect').addEventListener('change', async e => {
  e.target.blur();
  try { await selectSession(+e.target.value); } catch (err) { toast(err.message); }
});
$('#newPuzzle').innerHTML = Object.entries(PUZZLES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
$('#newBtn').onclick = () => { $('#newName').value = ''; $('#newDialog').showModal(); $('#newName').focus(); };
$('#newCancel').onclick = () => $('#newDialog').close();
$('#newForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const s = await api('/sessions', { method: 'POST', body: { name: $('#newName').value, puzzle: $('#newPuzzle').value } });
    sessions.push(s); $('#newDialog').close(); await selectSession(s.id);
  } catch (err) { toast(err.message); }
};
$('#renameBtn').onclick = async e => {
  e.target.blur();
  const name = prompt('New session name', current.name);
  if (!name || !name.trim()) return;
  try { current = Object.assign(current, await api('/sessions/' + current.id, { method: 'PATCH', body: { name } })); renderSessions(); }
  catch (err) { toast(err.message); }
};
$('#resetBtn').onclick = async e => {
  e.target.blur();
  if (!confirm(`Delete all ${solves.length} solves in "${current.name}"?`)) return;
  try { await api(`/sessions/${current.id}/solves`, { method: 'DELETE' }); solves = []; renderAll(); showIdle(); }
  catch (err) { toast(err.message); }
};
$('#deleteBtn').onclick = async e => {
  e.target.blur();
  if (sessions.length < 2) return toast('Keep at least one session. Create another one first.');
  if (!confirm(`Delete session "${current.name}" and all its solves?`)) return;
  try {
    await api('/sessions/' + current.id, { method: 'DELETE' });
    sessions = sessions.filter(s => s.id !== current.id);
    await selectSession(sessions[0].id);
  } catch (err) { toast(err.message); }
};

/* ---------- login ---------- */
let mode = 'login';
function setMode(m) {
  mode = m;
  $('#authSubmit').textContent = m === 'login' ? 'Log in' : 'Create account';
  $('#authToggle').textContent = m === 'login' ? 'New here? Create an account' : 'Already have an account? Log in';
  $('#authLead').textContent = m === 'login' ? 'Log in to load your sessions and solves.' : 'Pick a username and password. Your solves are saved to it.';
  $('#password').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  $('#authError').textContent = '';
}
$('#authToggle').onclick = () => setMode(mode === 'login' ? 'register' : 'login');
$('#authForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const d = await api('/' + mode, { method: 'POST', body: { username: $('#username').value, password: $('#password').value } });
    token = d.token; username = d.username;
    localStorage.setItem('ct_token', token); localStorage.setItem('ct_user', username);
    $('#password').value = '';
    await enterApp();
  } catch (err) { $('#authError').textContent = err.message; }
};
$('#logoutBtn').onclick = () => logout();
function logout() {
  token = null; localStorage.removeItem('ct_token'); localStorage.removeItem('ct_user');
  $('#appView').hidden = true; $('#authView').hidden = false;
}

async function enterApp() {
  $('#authView').hidden = true; $('#appView').hidden = false;
  $('#who').textContent = username;
  sessions = await api('/sessions');
  if (!sessions.length) sessions = [await api('/sessions', { method: 'POST', body: { name: '3x3 main', puzzle: '333' } })];
  const last = +localStorage.getItem('ct_session');
  await selectSession(sessions.some(s => s.id === last) ? last : sessions[0].id);
}

if (token) enterApp().catch(() => logout()); else $('#authView').hidden = false;
