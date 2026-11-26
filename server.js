const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. See README.md.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const isLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

const PUZZLES = ['333','222','444','555','666','777','333bf','333fm','333oh',
  'clock','minx','pyram','skewb','sq1','444bf','555bf'];
const PENALTIES = ['none', 'plus2', 'dnf'];

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);
const sign = u => jwt.sign({ id: u.id, username: u.username }, JWT_SECRET, { expiresIn: '90d' });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    req.user = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Your login expired. Please log in again.' });
  }
}

/* ---------- accounts ---------- */
app.post('/api/register', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^[a-z0-9_]{3,24}$/.test(username))
    return res.status(400).json({ error: 'Username must be 3 to 24 letters, numbers or underscores.' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username',
      [username, hash]);
    res.json({ token: sign(r.rows[0]), username });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That username is taken.' });
    throw e;
  }
}));

app.post('/api/login', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const r = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash)))
    return res.status(401).json({ error: 'Wrong username or password.' });
  res.json({ token: sign(u), username: u.username });
}));

/* ---------- sessions ---------- */
app.get('/api/sessions', auth, wrap(async (req, res) => {
  const r = await pool.query(
    'SELECT id, name, puzzle FROM sessions WHERE user_id = $1 ORDER BY id', [req.user.id]);
  res.json(r.rows);
}));

app.post('/api/sessions', auth, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40) || 'Session';
  const puzzle = PUZZLES.includes(req.body.puzzle) ? req.body.puzzle : '333';
  const r = await pool.query(
    'INSERT INTO sessions (user_id, name, puzzle) VALUES ($1, $2, $3) RETURNING id, name, puzzle',
    [req.user.id, name, puzzle]);
  res.json(r.rows[0]);
}));

app.patch('/api/sessions/:id', auth, wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: 'Name cannot be empty.' });
  const r = await pool.query(
    'UPDATE sessions SET name = $1 WHERE id = $2 AND user_id = $3 RETURNING id, name, puzzle',
    [name, req.params.id, req.user.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Session not found.' });
  res.json(r.rows[0]);
}));

app.delete('/api/sessions/:id', auth, wrap(async (req, res) => {
  await pool.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

/* ---------- solves ---------- */
app.get('/api/sessions/:id/solves', auth, wrap(async (req, res) => {
  const r = await pool.query(
    `SELECT id, time_ms, penalty, scramble, created_at FROM solves
     WHERE session_id = $1 AND user_id = $2 ORDER BY id`, [req.params.id, req.user.id]);
  res.json(r.rows);
}));

app.post('/api/sessions/:id/solves', auth, wrap(async (req, res) => {
  const own = await pool.query('SELECT id FROM sessions WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]);
  if (!own.rows[0]) return res.status(404).json({ error: 'Session not found.' });
  const time = Math.round(Number(req.body.time_ms));
  const penalty = PENALTIES.includes(req.body.penalty) ? req.body.penalty : 'none';
  if (!Number.isFinite(time) || time < 0) return res.status(400).json({ error: 'Invalid time.' });
  const r = await pool.query(
    `INSERT INTO solves (session_id, user_id, time_ms, penalty, scramble)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, time_ms, penalty, scramble, created_at`,
    [req.params.id, req.user.id, time, penalty, String(req.body.scramble || '').slice(0, 2000)]);
  res.json(r.rows[0]);
}));

app.delete('/api/sessions/:id/solves', auth, wrap(async (req, res) => {
  await pool.query('DELETE FROM solves WHERE session_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

app.patch('/api/solves/:id', auth, wrap(async (req, res) => {
  if (!PENALTIES.includes(req.body.penalty)) return res.status(400).json({ error: 'Invalid penalty.' });
  const r = await pool.query(
    'UPDATE solves SET penalty = $1 WHERE id = $2 AND user_id = $3 RETURNING id',
    [req.body.penalty, req.params.id, req.user.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'Solve not found.' });
  res.json({ ok: true });
}));

app.delete('/api/solves/:id', auth, wrap(async (req, res) => {
  await pool.query('DELETE FROM solves WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

/* ---------- start ---------- */
async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      puzzle TEXT NOT NULL DEFAULT '333',
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE IF NOT EXISTS solves (
      id SERIAL PRIMARY KEY,
      session_id INT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      time_ms INT NOT NULL,
      penalty TEXT NOT NULL DEFAULT 'none',
      scramble TEXT,
      created_at TIMESTAMPTZ DEFAULT now());
    CREATE INDEX IF NOT EXISTS solves_session_idx ON solves (session_id, id);
  `);
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('CubeTimer running on port ' + port));
}
init().catch(e => { console.error(e); process.exit(1); });
