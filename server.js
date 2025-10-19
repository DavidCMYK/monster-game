// server.js — Postgres, server-side encounters, species registry
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const world = require('./world');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(bodyParser.json());

const {
  PGHOST, PGDATABASE, PGUSER, PGPASSWORD, PGPORT = 5432, PGSSLMODE = 'require',
  PORT = 3001
} = process.env;

const pool = new Pool({
  host: PGHOST,
  database: PGDATABASE,
  user: PGUSER,
  password: PGPASSWORD,
  port: Number(PGPORT),
  ssl: PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false
});

// ---------- DB init ----------
async function initDB() {
  // Players / sessions / state
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mg_players (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      handle TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mg_sessions (
      token TEXT PRIMARY KEY,
      player_id INT NOT NULL REFERENCES mg_players(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mg_player_state (
      player_id INT PRIMARY KEY REFERENCES mg_players(id) ON DELETE CASCADE,
      cx INT NOT NULL DEFAULT 0,
      cy INT NOT NULL DEFAULT 0,
      tx INT NOT NULL DEFAULT 128,
      ty INT NOT NULL DEFAULT 128,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Species registry for spawn tables (foundation; effects/bonuses added later)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mg_species (
      id INT PRIMARY KEY,
      name TEXT NOT NULL,
      base_spawn_rate REAL NOT NULL DEFAULT 0.05,
      // biomes a species MAY be assigned to in a chunk’s table
      biomes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      // types per design (initial: fire, electric, air, ice, water, flora, earth, fauna)
      types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
    );
  `);

  // Optional pre-seed if empty, matching our earlier debug trio:
  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS c FROM mg_species`);
  if (cnt[0].c === 0) {
    await pool.query(`
      INSERT INTO mg_species (id, name, base_spawn_rate, biomes, types) VALUES
        (1,  'Fieldling', 0.14, ARRAY['grassland','forest'], ARRAY['fauna']),
        (2,  'Brookfin',  0.10, ARRAY['river','ocean'],      ARRAY['water']),
        (4,  'Cliffpup',  0.08, ARRAY['mountain','grassland'], ARRAY['fauna','earth']);
    `);
  }

  // (Future) Parties/caught monsters; left out until we add battle/capture next.
}

function token(){ return 't-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

// ---------- player utils ----------
async function getPlayerByEmail(email){
  const { rows } = await pool.query(`SELECT * FROM mg_players WHERE email = $1 LIMIT 1`, [email]);
  return rows[0] || null;
}
async function getPlayerByHandle(handle){
  const { rows } = await pool.query(`SELECT * FROM mg_players WHERE handle = $1 LIMIT 1`, [handle]);
  return rows[0] || null;
}
async function createPlayer(email, handle, password){
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO mg_players (email, handle, password_hash) VALUES ($1,$2,$3) RETURNING id`,
    [email, handle, hash]
  );
  const player_id = rows[0].id;
  await pool.query(
    `INSERT INTO mg_player_state (player_id, cx, cy, tx, ty) VALUES ($1,0,0,128,128)`,
    [player_id]
  );
  return player_id;
}
async function createSession(player_id){
  const t = token();
  await pool.query(`INSERT INTO mg_sessions (token, player_id) VALUES ($1,$2)`, [t, player_id]);
  return t;
}
async function getSession(tokenStr){
  const { rows } = await pool.query(
    `SELECT s.token, p.id AS player_id, p.email, p.handle
     FROM mg_sessions s JOIN mg_players p ON p.id = s.player_id
     WHERE s.token = $1 LIMIT 1`, [tokenStr]
  );
  return rows[0] || null;
}
async function getState(player_id){
  const { rows } = await pool.query(
    `SELECT player_id, cx, cy, tx, ty FROM mg_player_state WHERE player_id = $1 LIMIT 1`,
    [player_id]
  );
  return rows[0] || null;
}
async function setState(player_id, cx, cy, tx, ty){
  await pool.query(
    `UPDATE mg_player_state SET cx=$1, cy=$2, tx=$3, ty=$4, updated_at=now() WHERE player_id=$5`,
    [cx, cy, tx, ty, player_id]
  );
}

// ---------- health ----------
app.get('/', (req,res)=>res.type('text').send('Monster Game API online. Try /api/health'));
app.get('/api/health', async (req,res)=>{
  try { const { rows } = await pool.query('SELECT 1 AS ok'); res.json({ ok: rows[0].ok === 1 }); }
  catch (e){ res.status(500).json({ ok:false, db_error: e.code || String(e) }); }
});

// ---------- auth ----------
app.post('/api/register', async (req,res)=>{
  try{
    const { email, password, handle } = req.body || {};
    if (!email || !password || !handle) return res.status(400).json({ error:'Missing fields' });
    if (await getPlayerByEmail(email))  return res.status(409).json({ error:'Email already exists' });
    if (await getPlayerByHandle(handle))return res.status(409).json({ error:'Handle already exists' });

    const player_id = await createPlayer(email, handle, password);
    const tok = await createSession(player_id);
    const st = await getState(player_id);
    return res.json({ token: tok, player: { handle, cx: st.cx, cy: st.cy, tx: st.tx, ty: st.ty, party: [] } });
  } catch(e){ console.error('register error', e); return res.status(500).json({ error:'server_error' }); }
});
app.post('/api/login', async (req,res)=>{
  try{
    const { email, password } = req.body || {};
    const p = await getPlayerByEmail(email);
    if (!p) return res.status(401).json({ error:'Invalid credentials' });
    const ok = await bcrypt.compare(password, p.password_hash);
    if (!ok) return res.status(401).json({ error:'Invalid credentials' });
    const tok = await createSession(p.id);
    const st = await getState(p.id);
    return res.json({ token: tok, player: { handle: p.handle, cx: st.cx, cy: st.cy, tx: st.tx, ty: st.ty, party: [] } });
  } catch(e){ console.error('login error', e); return res.status(500).json({ error:'server_error' }); }
});

// ---------- auth middleware ----------
async function auth(req,res,next){
  try{
    const t = req.headers.authorization || req.query.token;
    if (!t) return res.status(401).json({ error:'Auth required' });
    const sess = await getSession(t);
    if (!sess) return res.status(401).json({ error:'Invalid session' });
    req.session = sess; next();
  } catch{ return res.status(500).json({ error:'server_error' }); }
}

// ---------- world + encounters ----------
/**
 * Server-authoritative chunk that includes a 10-slot encounter table derived from mg_species,
 * weighted by species.base_spawn_rate and biome fit per design.
 */
async function buildEncounterTableForChunk(cx, cy){
  const { rows: sp } = await pool.query(`SELECT id, name, base_spawn_rate, biomes, types FROM mg_species ORDER BY id ASC`);
  // Select up to 10 species for the chunk; bias by nearby biome composition (from generated tiles)
  const chunk = world.generateChunk(cx, cy);
  // Estimate biome mix by sampling a grid
  const counts = {};
  for (let y=0; y<chunk.h; y+=16){
    for (let x=0; x<chunk.w; x+=16){
      const b = chunk.tiles[y][x].biome;
      counts[b] = (counts[b]||0) + 1;
    }
  }
  const biomeKeys = Object.keys(counts);
  function biomeWeightFor(spec){
    if (!spec.biomes || spec.biomes.length===0) return 0.5;
    let w=0;
    for (const b of spec.biomes){ if (counts[b]) w += counts[b]; }
    return w / (Object.values(counts).reduce((a,n)=>a+n,1) || 1);
  }

  // Score species by spawn_rate * biome fit
  const scored = sp.map(s => {
    const fit = biomeWeightFor(s);
    const score = (s.base_spawn_rate || 0.05) * (0.25 + 0.75*fit);
    return { speciesId: s.id, name: s.name, baseSpawnRate: s.base_spawn_rate, biomes: s.biomes, score };
  }).sort((a,b)=>b.score-a.score);

  // Take top ~12 and normalize to 10 entries with weights
  const pick = scored.slice(0, 12);
  // Normalize weights approx to sum 1.0
  const sum = pick.reduce((a,x)=>a+x.baseSpawnRate, 0) || 1;
  const table = pick.slice(0,10).map(x => ({
    speciesId: x.speciesId,
    name: x.name,
    baseSpawnRate: Math.max(0.01, x.baseSpawnRate / sum),
    biomes: x.biomes
  }));
  return table;
}

app.get('/api/chunk', auth, async (req,res)=>{
  const st = await getState(req.session.player_id);
  const x = parseInt(req.query.x ?? st.cx, 10);
  const y = parseInt(req.query.y ?? st.cy, 10);
  const chunk = world.generateChunk(x, y);
  const encounterTable = await buildEncounterTableForChunk(x, y);
  res.json({ x, y, chunk: { ...chunk, encounterTable } });
});

// Movement (HTTP fallback; WS mirrors same server authority)
app.post('/api/move', auth, async (req,res)=>{
  const dx = Math.max(-1, Math.min(1, (req.body?.dx) || 0));
  const dy = Math.max(-1, Math.min(1, (req.body?.dy) || 0));
  const st = await getState(req.session.player_id);
  let { cx, cy, tx, ty } = st;
  const CHUNK_W = 256, CHUNK_H = 256;
  tx += dx; ty += dy;
  if (tx < 0){ tx = CHUNK_W-1; cx -= 1; }
  if (tx >= CHUNK_W){ tx = 0; cx += 1; }
  if (ty < 0){ ty = CHUNK_H-1; cy -= 1; }
  if (ty >= CHUNK_H){ ty = 0; cy += 1; }
  await setState(req.session.player_id, cx, cy, tx, ty);
  const chunk = world.generateChunk(cx, cy);
  const encounterTable = await buildEncounterTableForChunk(cx, cy);
  res.json({ player: { handle: req.session.handle, cx, cy, tx, ty, party: [] }, chunk: { ...chunk, encounterTable } });
});

// Catalog (for client debug/admin later)
app.get('/api/species', auth, async (req,res)=>{
  const { rows } = await pool.query(`SELECT id, name, base_spawn_rate AS "baseSpawnRate", biomes, types FROM mg_species ORDER BY id ASC`);
  res.json({ species: rows });
});

// ---------- WS ----------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

wss.on('connection', (ws)=>{
  ws.isAlive = true;
  ws.on('pong', ()=>ws.isAlive = true);
  ws.on('message', async (raw)=>{
    let msg; try{ msg = JSON.parse(raw); }catch{ return ws.send(JSON.stringify({ type:'error', error:'bad_json' })); }
    if (msg.type === 'auth'){
      const sess = await getSession(msg.token);
      if (!sess) return ws.send(JSON.stringify({ type:'error', error:'invalid_token' }));
      ws.session = sess;
      const st = await getState(sess.player_id);
      ws.send(JSON.stringify({ type:'auth_ok', player: { handle: sess.handle, ...st, party: [] } }));
      return;
    }
    if (!ws.session) return ws.send(JSON.stringify({ type:'error', error:'unauthenticated' }));

    if (msg.type === 'move'){
      const dx = Math.max(-1, Math.min(1, msg.dx || 0));
      const dy = Math.max(-1, Math.min(1, msg.dy || 0));
      const st = await getState(ws.session.player_id);
      let { cx, cy, tx, ty } = st;
      const CHUNK_W = 256, CHUNK_H = 256;
      tx += dx; ty += dy;
      if (tx < 0){ tx = CHUNK_W-1; cx -= 1; }
      if (tx >= CHUNK_W){ tx = 0; cx += 1; }
      if (ty < 0){ ty = CHUNK_H-1; cy -= 1; }
      if (ty >= CHUNK_H){ ty = 0; cy += 1; }
      await setState(ws.session.player_id, cx, cy, tx, ty);
      const chunk = world.generateChunk(cx, cy);
      const encounterTable = await buildEncounterTableForChunk(cx, cy);
      ws.send(JSON.stringify({ type:'moved', player: { handle: ws.session.handle, cx, cy, tx, ty, party: [] }, chunk: { cx, cy, chunk: { ...chunk, encounterTable } } }));
      return;
    }

    ws.send(JSON.stringify({ type:'error', error:'unknown_msg' }));
  });
});

setInterval(()=>{ wss.clients.forEach(ws=>{ if (!ws.isAlive) return ws.terminate(); ws.isAlive=false; ws.ping(); }); }, 30000);

initDB()
  .then(()=>{ server.listen(PORT, ()=>console.log('Monster game server listening on :' + PORT)); })
  .catch((e)=>{ console.error('DB init failed:', e); process.exit(1); });
