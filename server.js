
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors'); // ← add this

const world = require('./world');
const Player = require('./player');
const Monster = require('./monster');

const app = express();

// Allow your WP site to call this API.
// For a quick unblock during setup, '*' is fine. You can tighten to your domain later.
app.use(cors({
  origin: '*', // e.g., 'https://YOUR-WORDPRESS-DOMAIN.com' when you want to lock it down
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors()); // ← add this (handles preflight)

app.use(bodyParser.json());

// In-memory demo store (replace with DB integration from db_schema.sql)
const players = new Map();  // token -> Player
const accounts = new Map(); // email -> { email, passwordHash, handle }

// Very simple token generator (replace with JWT in production)
function token() {
  return 't-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// --- Auth (demo) ---
app.post('/api/register', (req, res) => {
  const { email, password, handle } = req.body || {};
  if (!email || !password || !handle) return res.status(400).json({ error: 'Missing fields' });
  if (accounts.has(email)) return res.status(409).json({ error: 'Email already exists' });
  accounts.set(email, { email, passwordHash: password, handle });
  const t = token();
  const p = new Player(handle, t);
  players.set(t, p);
  res.json({ token: t, player: p.toJSON() });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const acc = accounts.get(email);
  if (!acc || acc.passwordHash !== password) return res.status(401).json({ error: 'Invalid credentials' });
  const t = token();
  const p = new Player(acc.handle, t);
  players.set(t, p);
  res.json({ token: t, player: p.toJSON() });
});

// --- Auth middleware (demo) ---
function auth(req, res, next) {
  const t = req.headers.authorization || req.query.token;
  if (!t || !players.has(t)) return res.status(401).json({ error: 'Auth required' });
  req.player = players.get(t);
  next();
}

// --- World endpoints ---
app.get('/api/chunk', auth, (req, res) => {
  const x = parseInt(req.query.x || '0', 10);
  const y = parseInt(req.query.y || '0', 10);
  const seed = world.seedForChunk(x, y);
  const chunk = world.generateChunk(x, y);
  res.json({ x, y, seed, chunk });
});

app.get('/api/me', auth, (req, res) => {
  res.json(req.player.toJSON());
});

// --- HTTP server + WS ---
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => ws.isAlive = true);

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'auth') {
        const p = players.get(msg.token);
        if (!p) return ws.send(JSON.stringify({ type: 'error', error: 'invalid_token' }));
        ws.player = p;
        ws.send(JSON.stringify({ type: 'auth_ok', player: p.toJSON() }));
        return;
      }
      if (!ws.player) {
        ws.send(JSON.stringify({ type: 'error', error: 'unauthenticated' }));
        return;
      }
      // Movement (demo)
      if (msg.type === 'move') {
        ws.player.move(msg.dx || 0, msg.dy || 0);
        const { cx, cy } = ws.player;
        const chunk = world.generateChunk(cx, cy);
        ws.send(JSON.stringify({ type: 'moved', player: ws.player.toJSON(), chunk: { cx, cy, chunk } }));
        return;
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', error: 'bad_message' }));
    }
  });
});

// health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Monster game server listening on :${PORT}`));

// ping to keep ws alive
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
