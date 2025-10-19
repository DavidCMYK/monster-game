// server.js — MySQL persistence + WS + HTTP fallback

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');

const world = require('./world');

const app = express();

// --- CORS (loose for now; tighten origin to your WP domain later) ---
app.use(cors({
  origin: '*',
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());
app.use(bodyParser.json());

// --- Environment ---
const {
  DB_HOST, DB_USER, DB_PASS, DB_NAME,
  PORT = 3001
} = process.env;

// --- MySQL pool ---
let pool;
async function initDB() {
  pool = await mysql.createPool({
    host: DB_HOST,
    user: DB_USER,
    password: DB_PASS,
    database: DB_NAME,
    waitForConnections: true,
    connectionLimit: 5,
    namedPlaceholders: true
  });

  // Ensure tables
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mg_players (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      handle VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mg_sessions (
      token VARCHAR(128) PRIMARY KEY,
      player_id INT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (player_id) REFERENCES mg_players(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS mg_player_state (
      player_id INT PRIMARY KEY,
      cx INT NOT NULL DEFAULT 0,
      cy INT NOT NULL DEFAULT 0,
      tx INT NOT NULL DEFAULT 128,
      ty INT NOT NULL DEFAULT 128,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (player_id) REFERENCES mg_players(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}
function token() {
  return 't-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// --- Utilities ---
async function getPlayerByEmail(email) {
  const [rows] = await pool.query(`SELECT * FROM mg_players WHERE email = ? LIMIT 1`, [email]);
  return rows[0] || null;
}
async function getPlayerByHandle(handle) {
  const [rows] = await pool.query(`SELECT * FROM mg_players WHERE handle = ? LIMIT 1`, [handle]);
  return rows[0] || null;
}
async function createPlayer(email, handle, password) {
  const hash = await bcrypt.hash(password, 10);
  const [res] = await pool.query(
    `INSERT INTO mg_players (email, handle, password_hash) VALUES (?,?,?)`,
    [email, handle, hash]
  );
  const player_id = res.insertId;
  // initial state center-ish of 256x256 chunk
  await pool.query(`
    INSERT INTO mg_player_state (player_id, cx, cy, tx, ty) VALUES (?,0,0,128,128)
  `, [player_id]);
  return player_id;
}
async function createSession(player_id) {
  const t = token();
  await pool.query(`INSERT INTO mg_sessions (token, player_id) VALUES (?,?)`, [t, player_id]);
  return t;
}
async function getSession(tokenStr) {
  const [rows] = await pool.query(`
    SELECT s.token, p.id AS player_id, p.email, p.handle
    FROM mg_sessions s
    JOIN mg_players p ON p.id = s.player_id
    WHERE s.token = ? LIMIT 1`, [tokenStr]);
  return rows[0] || null;
}
async function getState(player_id) {
  const [rows] = await pool.query(`SELECT player_id, cx, cy, tx, ty FROM mg_player_state WHERE player_id = ? LIMIT 1`, [player_id]);
  return rows[0] || null;
}
async function setState(player_id, cx, cy, tx, ty) {
  await pool.query(`
    UPDATE mg_player_state SET cx=?, cy=?, tx=?, ty=? WHERE player_id=?
  `, [cx, cy, tx, ty, player_id]);
}

// --- Simple root & health ---
app.get('/', (req, res) => res.type('text').send('Monster Game API online. Try /api/health'));
app.get('/api/health', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT 1 AS ok');
    res.json({ ok: true, db: rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, db_error: e.code || String(e) });
  }
});

// --- Auth ---
app.post('/api/register', async (req, res) => {
  try {
    const { email, password, handle } = req.body || {};
    if (!email || !password || !handle) return res.status(400).json({ error: 'Missing fields' });
    const existingEmail = await getPlayerByEmail(email);
    if (existingEmail) return res.status(409).json({ error: 'Email already exists' });
    const existingHandle = await getPlayerByHandle(handle);
    if (existingHandle) return res.status(409).json({ error: 'Handle already exists' });

    const player_id = await createPlayer(email, handle, password);
    const tok = await createSession(player_id);
    const state = await getState(player_id);

    return res.json({
      token: tok,
      player: { handle, cx: state.cx, cy: state.cy, tx: state.tx, ty: state.ty, party: [] }
    });
  } catch (e) {
    console.error('register error', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const player = await getPlayerByEmail(email);
    if (!player) return res.status(401).json({ error: 'Invalid credentials' });
    const ok = await bcrypt.compare(password, player.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    const tok = await createSession(player.id);
    const state = await getState(player.id);

    return res.json({
      token: tok,
      player: { handle: player.handle, cx: state.cx, cy: state.cy, tx: state.tx, ty: state.ty, party: [] }
    });
  } catch (e) {
    console.error('login error', e);
    return res.status(500).json({ error: 'server_error' });
  }
});

// --- Auth middleware (from DB session) ---
async function auth(req, res, next) {
  try {
    const t = req.headers.authorization || req.query.token;
    if (!t) return res.status(401).json({ error: 'Auth required' });
    const sess = await getSession(t);
    if (!sess) return res.status(401).json({ error: 'Invalid session' });
    req.session = sess; // { token, player_id, email, handle }
    next();
  } catch (e) {
    return res.status(500).json({ error: 'server_error' });
  }
}

// --- World endpoints ---
app.get('/api/me', auth, async (req, res) => {
  const st = await getState(req.session.player_id);
  res.json({ handle: req.session.handle, cx: st.cx, cy: st.cy, tx: st.tx, ty: st.ty, party: [] });
});

app.get('/api/chunk', auth, async (req, res) => {
  const st = await getState(req.session.player_id);
  const x = parseInt(req.query.x ?? st.cx, 10);
  const y = parseInt(req.query.y ?? st.cy, 10);
  const chunk = world.generateChunk(x, y);
  res.json({ x, y, chunk });
});

// HTTP fallback movement (works if WS blocked)
app.post('/api/move', auth, async (req, res) => {
  const dx = Math.max(-1, Math.min(1, (req.body?.dx) || 0));
  const dy = Math.max(-1, Math.min(1, (req.body?.dy) || 0));
  const st = await getState(req.session.player_id);
  let { cx, cy, tx, ty } = st;

  tx += dx; ty += dy;
  const CHUNK_W = 256, CHUNK_H = 256;
  if (tx < 0) { tx = CHUNK_W - 1; cx -= 1; }
  if (tx >= CHUNK_W) { tx = 0; cx += 1; }
  if (ty < 0) { ty = CHUNK_H - 1; cy -= 1; }
  if (ty >= CHUNK_H) { ty = 0; cy += 1; }

  await setState(req.session.player_id, cx, cy, tx, ty);
  const chunk = world.generateChunk(cx, cy);
  return res.json({
    player: { handle: req.session.handle, cx, cy, tx, ty, party: [] },
    chunk
  });
});

// --- HTTP + WS server ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      return ws.send(JSON.stringify({ type: 'error', error: 'bad_json' }));
    }

    // Authenticate socket
    if (msg.type === 'auth') {
      const sess = await getSession(msg.token);
      if (!sess) return ws.send(JSON.stringify({ type: 'error', error: 'invalid_token' }));
      ws.session = sess;
      const st = await getState(sess.player_id);
      ws.send(JSON.stringify({ type: 'auth_ok', player: { handle: sess.handle, ...st, party: [] } }));
      return;
    }

    if (!ws.session) return ws.send(JSON.stringify({ type: 'error', error: 'unauthenticated' }));

    // Movement over WS
    if (msg.type === 'move') {
      const dx = Math.max(-1, Math.min(1, msg.dx || 0));
      const dy = Math.max(-1, Math.min(1, msg.dy || 0));
      const st = await getState(ws.session.player_id);
      let { cx, cy, tx, ty } = st;
      const CHUNK_W = 256, CHUNK_H = 256;

      tx += dx; ty += dy;
      if (tx < 0) { tx = CHUNK_W - 1; cx -= 1; }
      if (tx >= CHUNK_W) { tx = 0; cx += 1; }
      if (ty < 0) { ty = CHUNK_H - 1; cy -= 1; }
      if (ty >= CHUNK_H) { ty = 0; cy += 1; }

      await setState(ws.session.player_id, cx, cy, tx, ty);
      const chunk = world.generateChunk(cx, cy);
      ws.send(JSON.stringify({
        type: 'moved',
        player: { handle: ws.session.handle, cx, cy, tx, ty, party: [] },
        chunk: { cx, cy, chunk }
      }));
      return;
    }

    ws.send(JSON.stringify({ type: 'error', error: 'unknown_msg' }));
  });
});

// keepalive
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false; ws.ping();
  });
}, 30000);

initDB()
  .then(() => {
    server.listen(PORT, () => console.log('Monster game server listening on :' + PORT));
  })
  .catch((e) => {
    console.error('DB init failed:', e);
    process.exit(1);
  });

