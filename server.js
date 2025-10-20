// server.js — sessions, world, encounters, absolute sync
// Battles: PP, capture-after-KO with fixed odds, party switch, auto-sub on KO, heal
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

/* ---------- ENV ---------- */
const {
  PGHOST, PGDATABASE, PGUSER, PGPASSWORD, PGPORT = 5432, PGSSLMODE = 'require',
  PORT = 3001, SKIP_NORMALIZE_ON_BOOT = 'false'
} = process.env;

const pool = new Pool({
  host: PGHOST, database: PGDATABASE, user: PGUSER, password: PGPASSWORD,
  port: Number(PGPORT), ssl: PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 4000, idleTimeoutMillis: 30000
});

const CHUNK_W = 256, CHUNK_H = 256;

/* ---------- DB / helpers (unchanged from last drop) ---------- */
async function normalizePlayerPositions(){ if (String(SKIP_NORMALIZE_ON_BOOT).toLowerCase() === 'true') return;
  await pool.query(`
    WITH norm AS (
      SELECT player_id,
             (cx + FLOOR(tx/256.0))::int AS new_cx,
             (cy + FLOOR(ty/256.0))::int AS new_cy,
             (CASE WHEN tx>=0 THEN (tx%256) ELSE 256+(tx%256) END)::int AS new_tx,
             (CASE WHEN ty>=0 THEN (ty%256) ELSE 256+(ty%256) END)::int AS new_ty
      FROM mg_player_state
      WHERE tx NOT BETWEEN 0 AND 255 OR ty NOT BETWEEN 0 AND 255
    )
    UPDATE mg_player_state s
       SET cx=n.new_cx, cy=n.new_cy, tx=n.new_tx, ty=n.new_ty, updated_at=now()
     FROM norm n
    WHERE s.player_id=n.player_id;
  `);
}
async function initDB(){
  await pool.query(`CREATE TABLE IF NOT EXISTS mg_players (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, handle TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ DEFAULT now());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS mg_sessions (token TEXT PRIMARY KEY, player_id INT NOT NULL REFERENCES mg_players(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT now());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS mg_player_state (player_id INT PRIMARY KEY REFERENCES mg_players(id) ON DELETE CASCADE, cx INT NOT NULL DEFAULT 0, cy INT NOT NULL DEFAULT 0, tx INT NOT NULL DEFAULT 128, ty INT NOT NULL DEFAULT 128, updated_at TIMESTAMPTZ DEFAULT now());`);
  await pool.query(`CREATE TABLE IF NOT EXISTS mg_species (id INT PRIMARY KEY, name TEXT NOT NULL, base_spawn_rate REAL NOT NULL DEFAULT 0.05, biomes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS mg_monsters (id SERIAL PRIMARY KEY, owner_id INT NOT NULL REFERENCES mg_players(id) ON DELETE CASCADE, species_id INT NOT NULL REFERENCES mg_species(id), nickname TEXT, level INT NOT NULL DEFAULT 1, xp INT NOT NULL DEFAULT 0, hp INT NOT NULL DEFAULT 20, max_hp INT NOT NULL DEFAULT 20, ability TEXT, moves JSONB DEFAULT '[]'::jsonb);`);
  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS c FROM mg_species`);
  if (cnt[0].c === 0){
    await pool.query(`
      INSERT INTO mg_species (id,name,base_spawn_rate,biomes,types) VALUES
      (1,'Fieldling',0.14,ARRAY['grassland','forest'],ARRAY['fauna']),
      (2,'Brookfin', 0.10,ARRAY['river','ocean'],    ARRAY['water']),
      (4,'Cliffpup', 0.08,ARRAY['mountain','grassland'],ARRAY['fauna','earth']);
    `);
  }
  await normalizePlayerPositions();
}
initDB().then(()=>console.log('✓ DB ready')).catch(e=>{ console.error('DB init failed',e); process.exit(1); });

function token(){ return 't-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
async function getPlayerByEmail(email){ const { rows } = await pool.query(`SELECT * FROM mg_players WHERE email=$1 LIMIT 1`, [email]); return rows[0]||null; }
async function getPlayerByHandle(handle){ const { rows } = await pool.query(`SELECT * FROM mg_players WHERE handle=$1 LIMIT 1`, [handle]); return rows[0]||null; }
async function createPlayer(email, handle, password){
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(`INSERT INTO mg_players (email,handle,password_hash) VALUES ($1,$2,$3) RETURNING id`, [email,handle,hash]);
  const player_id = rows[0].id;
  await pool.query(`INSERT INTO mg_player_state (player_id,cx,cy,tx,ty) VALUES ($1,0,0,$2,$3)`, [player_id, Math.floor(CHUNK_W/2), Math.floor(CHUNK_H/2)]);
  await pool.query(`
    INSERT INTO mg_monsters (owner_id,species_id,level,xp,hp,max_hp,ability,moves)
    VALUES ($1,1,3,0,28,28,'rescue:blink','[
      {"name":"Strike","base":"physical","power":8,"accuracy":0.95,"pp":25,"stack":["dmg_phys"]},
      {"name":"Guard","base":"status","power":0,"accuracy":1.0,"pp":15,"stack":["buff_def"]}
    ]'::jsonb)
  `,[player_id]);
  return player_id;
}
async function createSession(player_id){ const t = token(); await pool.query(`INSERT INTO mg_sessions (token,player_id) VALUES ($1,$2)`, [t,player_id]); return t; }
async function getSession(tok){
  const { rows } = await pool.query(`SELECT s.token, p.id AS player_id, p.email, p.handle FROM mg_sessions s JOIN mg_players p ON p.id=s.player_id WHERE s.token=$1 LIMIT 1`, [tok]);
  return rows[0]||null;
}
async function deleteSession(tok){ await pool.query(`DELETE FROM mg_sessions WHERE token=$1`, [tok]); }
async function getState(player_id){ const { rows } = await pool.query(`SELECT player_id,cx,cy,tx,ty FROM mg_player_state WHERE player_id=$1 LIMIT 1`, [player_id]); return rows[0]||null; }
async function setState(player_id,cx,cy,tx,ty){ await pool.query(`UPDATE mg_player_state SET cx=$1,cy=$2,tx=$3,ty=$4,updated_at=now() WHERE player_id=$5`,[cx,cy,tx,ty,player_id]); }
async function getParty(player_id){
  const { rows } = await pool.query(`SELECT id,species_id,nickname,level,xp,hp,max_hp,ability,moves FROM mg_monsters WHERE owner_id=$1 ORDER BY id ASC LIMIT 6`, [player_id]);
  return rows;
}
async function ensureHasParty(owner_id){
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM mg_monsters WHERE owner_id=$1`, [owner_id]);
  if ((rows[0]?.c||0) === 0){
    await pool.query(`
      INSERT INTO mg_monsters (owner_id,species_id,level,xp,hp,max_hp,ability,moves)
      VALUES ($1,1,3,0,28,28,'rescue:blink','[
        {"name":"Strike","base":"physical","power":8,"accuracy":0.95,"pp":25,"stack":["dmg_phys"]},
        {"name":"Guard","base":"status","power":0,"accuracy":1.0,"pp":15,"stack":["buff_def"]}
      ]'::jsonb)
    `,[owner_id]);
  }
}
async function ensureStarterMoves(owner_id){
  const { rows } = await pool.query(`SELECT id,moves FROM mg_monsters WHERE owner_id=$1 ORDER BY id ASC LIMIT 1`, [owner_id]);
  if (!rows.length) return;
  const id = rows[0].id;
  let moves = rows[0].moves || [];
  const hasGuard = moves.some(m => (m.name||'').toLowerCase()==='guard');
  if (!hasGuard){
    moves = moves.slice(0,3).concat([{ name:'Guard', base:'status', power:0, accuracy:1.0, pp:15, stack:['buff_def'] }]);
    await pool.query(`UPDATE mg_monsters SET moves=$1 WHERE id=$2 AND owner_id=$3`, [JSON.stringify(moves), id, owner_id]);
  }
}

/* ---------- middleware ---------- */
async function auth(req,res,next){
  try{
    const t = req.headers.authorization || req.query.token;
    if (!t) return res.status(401).json({ error:'Auth required' });
    const s = await getSession(t);
    if (!s) return res.status(401).json({ error:'Invalid session' });
    req.session = s; next();
  }catch{ res.status(500).json({ error:'server_error' }); }
}

/* ---------- basics / auth ---------- */
app.get('/', (_,res)=>res.type('text').send('Monster Game API online'));
app.get('/api/health', async (_req,res)=>{ try{ const { rows } = await pool.query('SELECT 1 AS ok'); res.json({ ok: rows[0].ok===1 }); }catch(e){ res.status(500).json({ ok:false, db_error:String(e) }); } });

app.post('/api/register', async (req,res)=>{
  try{
    const { email,password,handle } = req.body||{};
    if (!email||!password||!handle) return res.status(400).json({ error:'Missing fields' });
    if (await getPlayerByEmail(email))  return res.status(409).json({ error:'Email already exists' });
    if (await getPlayerByHandle(handle))return res.status(409).json({ error:'Handle already exists' });
    const id = await createPlayer(email,handle,password);
    const tok = await createSession(id);
    const st = await getState(id);
    const party = await getParty(id);
    res.json({ token: tok, player: { handle, cx:st.cx,cy:st.cy,tx:st.tx,ty:st.ty, party } });
  }catch(e){ res.status(500).json({ error:'server_error' }); }
});
app.post('/api/login', async (req,res)=>{
  try{
    const { email,password } = req.body||{};
    const p = await getPlayerByEmail(email);
    if (!p) return res.status(401).json({ error:'Invalid credentials' });
    const ok = await bcrypt.compare(password, p.password_hash);
    if (!ok) return res.status(401).json({ error:'Invalid credentials' });
    const tok = await createSession(p.id);
    await ensureHasParty(p.id); await ensureStarterMoves(p.id);
    const st = await getState(p.id);
    const party = await getParty(p.id);
    res.json({ token: tok, player: { handle:p.handle, cx:st.cx,cy:st.cy,tx:st.tx,ty:st.ty, party } });
  }catch(e){ res.status(500).json({ error:'server_error' }); }
});
app.get('/api/session', auth, async (req,res)=>{
  await ensureHasParty(req.session.player_id);
  await ensureStarterMoves(req.session.player_id);
  const st = await getState(req.session.player_id);
  const party = await getParty(req.session.player_id);
  res.json({ token: req.session.token, player: { handle:req.session.handle, cx:st.cx,cy:st.cy,tx:st.tx,ty:st.ty, party } });
});
app.post('/api/logout', auth, async (req,res)=>{ await deleteSession(req.session.token); res.json({ ok:true }); });

/* ---------- NEW: party endpoint ---------- */
app.get('/api/party', auth, async (req,res)=>{
  const party = await getParty(req.session.player_id);
  res.json({ party });
});

/* ---------- heal ---------- */
app.post('/api/heal', auth, async (req,res)=>{
  await pool.query(`UPDATE mg_monsters SET hp = max_hp WHERE owner_id=$1`, [req.session.player_id]);
  const party = await getParty(req.session.player_id);
  res.json({ ok:true, party });
});

/* ---------- world/chunk, sync, battles ---------- */
/* ... KEEP THE REST OF THE FILE EXACTLY AS IN THE LAST VERSION I GAVE YOU ...
   (chunk/species endpoints, /api/move, /api/sync, and all battle routes remain unchanged) */
// ----- helper: build an encounter table for a generated chunk -----
async function buildEncounterTableForChunk(cx, cy) {
  // Generate chunk to analyze its biomes
  const ch = world.generateChunk(cx, cy);
  const counts = {};
  for (const row of ch.tiles) {
    for (const t of row) {
      const b = (t && t.biome) || 'unknown';
      counts[b] = (counts[b] || 0) + 1;
    }
  }
  // Dominant biome in this chunk
  let dominant = 'grassland';
  let max = -1;
  for (const [b, c] of Object.entries(counts)) {
    if (c > max) { max = c; dominant = b; }
  }
  // Pull species that can spawn in this biome
  const { rows } = await pool.query(
    `SELECT id, name, base_spawn_rate
       FROM mg_species
      WHERE $1 = ANY(biomes)
      ORDER BY id ASC`,
    [dominant]
  );
  // Make a simple weighted table. If none match, fall back to all species.
  const list = rows.length ? rows : (await pool.query(
    `SELECT id, name, base_spawn_rate FROM mg_species ORDER BY id ASC`
  )).rows;

  // Normalize to simple weights for the client (not probabilities)
  // Weight floor to avoid zeros
  const table = list.map(s => ({
    speciesId: Number(s.id),
    weight: Math.max(1, Math.round((s.base_spawn_rate || 0.05) * 100))
  }));

  return { biome: dominant, table };
}

// ----- species list (no auth required; safe to cache on client) -----
app.get('/api/species', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, name, base_spawn_rate AS "baseSpawnRate", biomes, types
         FROM mg_species
         ORDER BY id ASC`
    );
    res.json({ species: rows });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ----- chunk fetch (auth) -----
app.get('/api/chunk', auth, async (req, res) => {
  try {
    // Use requested x,y or the player's current chunk
    const st = await getState(req.session.player_id);
    const x = parseInt(req.query.x ?? st.cx, 10);
    const y = parseInt(req.query.y ?? st.cy, 10);
    const ch = world.generateChunk(x, y);
    const enc = await buildEncounterTableForChunk(x, y);
    res.json({ x, y, chunk: { ...ch, encounterTable: enc.table, biome: enc.biome } });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ----- alias without /api for older clients or direct Render base -----
app.get('/chunk', auth, async (req, res) => {
  try {
    const st = await getState(req.session.player_id);
    const x = parseInt(req.query.x ?? st.cx, 10);
    const y = parseInt(req.query.y ?? st.cy, 10);
    const ch = world.generateChunk(x, y);
    const enc = await buildEncounterTableForChunk(x, y);
    res.json({ x, y, chunk: { ...ch, encounterTable: enc.table, biome: enc.biome } });
  } catch (e) {
    res.status(500).json({ error: 'server_error' });
  }
});


const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
wss.on('connection', ws => { ws.isAlive = true; ws.on('pong', ()=>ws.isAlive = true); });
setInterval(()=>{ wss.clients.forEach(ws=>{ if (!ws.isAlive) return ws.terminate(); ws.isAlive=false; ws.ping(); }); }, 30000);
server.listen(PORT, ()=>console.log('Monster game server listening on :' + PORT));
