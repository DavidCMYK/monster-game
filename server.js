// server.js — Monster Game backend (Postgres) — SPEC: 256×256 chunks
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const world = require('./world'); // must export generateChunk(cx, cy) with {w:256,h:256,tiles:...}

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(bodyParser.json());

/* -------------------- ENV -------------------- */
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

/* -------------------- CONSTS -------------------- */
const CHUNK_W = 256;
const CHUNK_H = 256;

/* -------------------- DB INIT + NORMALIZE -------------------- */
async function normalizePlayerPositions() {
  console.log('→ Normalizing player positions to 256×256 bounds…');
  await pool.query(`
    WITH norm AS (
      SELECT
        player_id,
        (cx + FLOOR(tx / 256.0))::int AS new_cx,
        (cy + FLOOR(ty / 256.0))::int AS new_cy,
        (CASE WHEN tx >= 0 THEN (tx % 256) ELSE 256 + (tx % 256) END)::int AS new_tx,
        (CASE WHEN ty >= 0 THEN (ty % 256) ELSE 256 + (ty % 256) END)::int AS new_ty
      FROM mg_player_state
      WHERE tx NOT BETWEEN 0 AND 255 OR ty NOT BETWEEN 0 AND 255
    )
    UPDATE mg_player_state s
    SET cx = n.new_cx, cy = n.new_cy, tx = n.new_tx, ty = n.new_ty, updated_at = now()
    FROM norm n
    WHERE s.player_id = n.player_id;
  `);
  console.log('✓ Normalization pass complete.');
}

async function initDB() {
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mg_species (
      id INT PRIMARY KEY,
      name TEXT NOT NULL,
      base_spawn_rate REAL NOT NULL DEFAULT 0.05,
      biomes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      types  TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mg_monsters (
      id SERIAL PRIMARY KEY,
      owner_id INT NOT NULL REFERENCES mg_players(id) ON DELETE CASCADE,
      species_id INT NOT NULL REFERENCES mg_species(id),
      nickname TEXT,
      level INT NOT NULL DEFAULT 1,
      xp INT NOT NULL DEFAULT 0,
      hp INT NOT NULL DEFAULT 20,
      max_hp INT NOT NULL DEFAULT 20,
      ability TEXT,
      moves JSONB DEFAULT '[]'::jsonb
    );
  `);

  // Seed a few species if none exist
  const { rows: cnt } = await pool.query(`SELECT COUNT(*)::int AS c FROM mg_species`);
  if (cnt[0].c === 0) {
    await pool.query(`
      INSERT INTO mg_species (id, name, base_spawn_rate, biomes, types) VALUES
        (1, 'Fieldling', 0.14, ARRAY['grassland','forest'],     ARRAY['fauna']),
        (2, 'Brookfin',  0.10, ARRAY['river','ocean'],          ARRAY['water']),
        (4, 'Cliffpup',  0.08, ARRAY['mountain','grassland'],   ARRAY['fauna','earth']);
    `);
  }

  // One-time/each-boot normalization to kill rubber-banding from OOB tx/ty
  await normalizePlayerPositions();
}

/* -------------------- UTIL -------------------- */
function token(){ return 't-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

async function getPlayerByEmail(email){
  const { rows } = await pool.query(`SELECT * FROM mg_players WHERE email=$1 LIMIT 1`, [email]);
  return rows[0] || null;
}
async function getPlayerByHandle(handle){
  const { rows } = await pool.query(`SELECT * FROM mg_players WHERE handle=$1 LIMIT 1`, [handle]);
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
    `INSERT INTO mg_player_state (player_id, cx, cy, tx, ty) VALUES ($1,0,0,$2,$3)`,
    [player_id, Math.floor(CHUNK_W/2), Math.floor(CHUNK_H/2)]
  );
  // Give a simple starter monster
  await pool.query(`
    INSERT INTO mg_monsters (owner_id, species_id, level, xp, hp, max_hp, ability, moves)
    VALUES ($1, 1, 3, 0, 28, 28, 'rescue:blink', '[
      {"name":"Strike","base":"physical","power":8,"accuracy":0.95,"pp":25,"stack":["dmg_phys"]}
    ]'::jsonb)
  `, [player_id]);
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
    `SELECT player_id, cx, cy, tx, ty FROM mg_player_state WHERE player_id=$1 LIMIT 1`,
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
async function getParty(player_id){
  const { rows } = await pool.query(
    `SELECT id, species_id, nickname, level, xp, hp, max_hp, ability, moves
     FROM mg_monsters WHERE owner_id=$1 ORDER BY id ASC LIMIT 6`, [player_id]);
  return rows;
}

/* -------------------- BASIC -------------------- */
app.get('/', (req,res)=>res.type('text').send('Monster Game API online. Try /api/health'));
app.get('/api/health', async (req,res)=>{
  try { const { rows } = await pool.query('SELECT 1 AS ok'); res.json({ ok: rows[0].ok === 1 }); }
  catch (e){ res.status(500).json({ ok:false, db_error: e.code || String(e) }); }
});

/* -------------------- AUTH -------------------- */
app.post('/api/register', async (req,res)=>{
  try{
    const { email, password, handle } = req.body || {};
    if (!email || !password || !handle) return res.status(400).json({ error:'Missing fields' });
    if (await getPlayerByEmail(email))  return res.status(409).json({ error:'Email already exists' });
    if (await getPlayerByHandle(handle))return res.status(409).json({ error:'Handle already exists' });

    const player_id = await createPlayer(email, handle, password);
    const tok = await createSession(player_id);
    const st = await getState(player_id);
    const party = await getParty(player_id);
    return res.json({ token: tok, player: { handle, cx: st.cx, cy: st.cy, tx: st.tx, ty: st.ty, party } });
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
    const party = await getParty(p.id);
    return res.json({ token: tok, player: { handle: p.handle, cx: st.cx, cy: st.cy, tx: st.tx, ty: st.ty, party } });
  } catch(e){ console.error('login error', e); return res.status(500).json({ error:'server_error' }); }
});

/* -------------------- AUTH MIDDLEWARE -------------------- */
async function auth(req,res,next){
  try{
    const t = req.headers.authorization || req.query.token;
    if (!t) return res.status(401).json({ error:'Auth required' });
    const sess = await getSession(t);
    if (!sess) return res.status(401).json({ error:'Invalid session' });
    req.session = sess; next();
  } catch{ return res.status(500).json({ error:'server_error' }); }
}

/* -------------------- ENCOUNTERS / CHUNK -------------------- */
async function buildEncounterTableForChunk(cx, cy){
  const { rows: sp } = await pool.query(`SELECT id, name, base_spawn_rate, biomes, types FROM mg_species ORDER BY id ASC`);
  const chunk = world.generateChunk(cx, cy); // assumes w=256,h=256
  const counts = {};
  for (let y=0; y<chunk.h; y+=16){
    for (let x=0; x<chunk.w; x+=16){
      const b = chunk.tiles[y][x].biome;
      counts[b] = (counts[b]||0) + 1;
    }
  }
  function biomeWeightFor(spec){
    if (!spec.biomes || spec.biomes.length===0) return 0.5;
    let w=0; for (const b of spec.biomes){ if (counts[b]) w += counts[b]; }
    const total = Object.values(counts).reduce((a,n)=>a+n,1) || 1;
    return w/total;
  }
  const scored = sp.map(s => {
    const fit = biomeWeightFor(s);
    const score = (s.base_spawn_rate || 0.05) * (0.25 + 0.75*fit);
    return { speciesId: s.id, name: s.name, baseSpawnRate: s.base_spawn_rate, biomes: s.biomes, score };
  }).sort((a,b)=>b.score-a.score);
  const pick = scored.slice(0, 12);
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

/* -------------------- MOVE (relative) -------------------- */
app.post('/api/move', auth, async (req,res)=>{
  const dx = Math.max(-1, Math.min(1, (req.body?.dx) || 0));
  const dy = Math.max(-1, Math.min(1, (req.body?.dy) || 0));
  const st = await getState(req.session.player_id);
  let { cx, cy, tx, ty } = st;

  tx += dx; ty += dy;
  if (tx < 0){ tx = CHUNK_W-1; cx -= 1; }
  if (tx >= CHUNK_W){ tx = 0; cx += 1; }
  if (ty < 0){ ty = CHUNK_H-1; cy -= 1; }
  if (ty >= CHUNK_H){ ty = 0; cy += 1; }

  await setState(req.session.player_id, cx, cy, tx, ty);
  const chunk = world.generateChunk(cx, cy);
  const encounterTable = await buildEncounterTableForChunk(cx, cy);
  res.json({ player: { handle: req.session.handle, cx, cy, tx, ty, party: await getParty(req.session.player_id) }, chunk: { ...chunk, encounterTable } });
});

/* -------------------- ABSOLUTE SYNC (authoritative) -------------------- */
function worldTiles(cx, cy, tx, ty){
  return { wx: cx*CHUNK_W + tx, wy: cy*CHUNK_H + ty };
}
app.post('/api/sync', auth, async (req,res)=>{
  let { cx, cy, tx, ty } = req.body || {};
  cx = Number(cx); cy = Number(cy); tx = Number(tx); ty = Number(ty);
  if (!Number.isInteger(cx)||!Number.isInteger(cy)||!Number.isInteger(tx)||!Number.isInteger(ty)){
    return res.status(400).json({ error:'bad_coords' });
  }

  // Normalize into 0..255 and carry into chunk coords
  while (tx < 0){ tx += CHUNK_W; cx -= 1; }
  while (ty < 0){ ty += CHUNK_H; cy -= 1; }
  while (tx >= CHUNK_W){ tx -= CHUNK_W; cx += 1; }
  while (ty >= CHUNK_H){ ty -= CHUNK_H; cy += 1; }

  const st = await getState(req.session.player_id);
  const prev = worldTiles(st.cx, st.cy, st.tx, st.ty);
  const next = worldTiles(cx, cy, tx, ty);
  const dist = Math.abs(next.wx - prev.wx) + Math.abs(next.wy - prev.wy);

  // Allow modest step bursts; clamp only if absurd
  const MAX_ALLOWED = 32; // tiles since last save
  if (dist > MAX_ALLOWED){
    cx = st.cx; cy = st.cy; tx = st.tx; ty = st.ty;
  }

  await setState(req.session.player_id, cx, cy, tx, ty);
  const chunk = world.generateChunk(cx, cy);
  const encounterTable = await buildEncounterTableForChunk(cx, cy);
  res.json({ player: { handle: req.session.handle, cx, cy, tx, ty, party: await getParty(req.session.player_id) }, chunk: { ...chunk, encounterTable } });
});

/* -------------------- PARTY / SPECIES -------------------- */
app.get('/api/party', auth, async (req,res)=>{
  const party = await getParty(req.session.player_id);
  res.json({ party });
});

app.get('/api/species', auth, async (req,res)=>{
  const { rows } = await pool.query(`SELECT id, name, base_spawn_rate AS "baseSpawnRate", biomes, types FROM mg_species ORDER BY id ASC`);
  res.json({ species: rows });
});

/* -------------------- BATTLE (wild) -------------------- */
const battles = new Map();
function rnd(){ return Math.random(); }
function clamp(n,min,max){ return n<min?min:(n>max?max:n); }
function calcDamage(attacker, move, defender){
  const base = move.power || 8;
  const atk = 10 + attacker.level * 2;
  const def = 8  + defender.level * 2;
  const variance = 0.9 + rnd()*0.2;
  return Math.max(1, Math.floor(((base + atk*0.5) - def*0.35) * variance));
}
function levelUp(mon){
  const need = 20 + mon.level * 10;
  if (mon.xp >= need){
    mon.xp -= need;
    mon.level += 1;
    mon.max_hp += 4;
    mon.hp = mon.max_hp;
    return true;
  }
  return false;
}

app.post('/api/battle/start', auth, async (req,res)=>{
  const st = await getState(req.session.player_id);
  const table = await buildEncounterTableForChunk(st.cx, st.cy);

  let total=0; const bag=[];
  for (const e of table){ total += e.baseSpawnRate; bag.push([e, e.baseSpawnRate]); }
  let r = rnd()*total, chosen = bag[0][0];
  for (const [e,w] of bag){ r -= w; if (r<=0){ chosen=e; break; } }

  const enemy = { speciesId: chosen.speciesId, level: 1 + Math.floor(rnd()*5) };
  enemy.max_hp = 16 + enemy.level*4;
  enemy.hp = enemy.max_hp;

  const party = await getParty(req.session.player_id);
  if (!party.length) return res.status(400).json({ error:'no_party' });
  const you = { ...party[0] };

  const battle = { player_id: req.session.player_id, you, enemy, log: [] };
  battles.set(req.session.token, battle);
  res.json({ you, enemy, log: battle.log });
});

app.post('/api/battle/turn', auth, async (req,res)=>{
  const b = battles.get(req.session.token);
  if (!b) return res.status(400).json({ error:'no_battle' });
  const action = req.body?.action;

  const you = b.you;
  const enemy = b.enemy;

  if (action === 'run'){
    if (Math.random() < 0.8){ battles.delete(req.session.token); return res.json({ result:'escaped', you, enemy, log:['You fled.']}); }
    b.log.push('Could not escape!');
    return res.json({ you, enemy, log: b.log });
  }

  if (action === 'move'){
    const moveName = req.body?.move || 'Strike';
    const mv = (you.moves || []).find(m=> (m.name||'').toLowerCase() === moveName.toLowerCase()) || { name:'Strike', power:8, accuracy:0.95 };
    if ((Math.random()) < (mv.accuracy ?? 0.95)){
      const dmg = calcDamage(you, mv, enemy);
      enemy.hp = clamp(enemy.hp - dmg, 0, enemy.max_hp);
      b.log.push(`You used ${mv.name}. It dealt ${dmg}.`);
    } else {
      b.log.push(`Your ${mv.name} missed.`);
    }
    if (enemy.hp <= 0){
      you.xp += enemy.level * 10;
      const leveled = levelUp(you);
      await pool.query(`UPDATE mg_monsters SET level=$1, xp=$2, hp=$3, max_hp=$4 WHERE id=$5 AND owner_id=$6`,
        [you.level, you.xp, you.hp, you.max_hp, you.id, req.session.player_id]);
      return res.json({ result:'enemy_down', you, enemy, log: b.log, canCapture:true });
    }

    if (enemy.hp > 0){
      const em = { name:'Bite', power:7, accuracy:0.9 };
      if (Math.random() < em.accuracy){
        const dmg2 = calcDamage(enemy, em, you);
        you.hp = clamp(you.hp - dmg2, 0, you.max_hp);
        b.log.push(`Enemy used ${em.name}. You took ${dmg2}.`);
      } else {
        b.log.push('Enemy missed.');
      }
      await pool.query(`UPDATE mg_monsters SET hp=$1 WHERE id=$2 AND owner_id=$3`, [you.hp, you.id, req.session.player_id]);
      if (you.hp <= 0){
        battles.delete(req.session.token);
        return res.json({ result:'you_down', you, enemy, log: b.log });
      }
    }
    return res.json({ you, enemy, log: b.log });
  }

  return res.status(400).json({ error:'bad_action' });
});

app.post('/api/battle/capture', auth, async (req,res)=>{
  const b = battles.get(req.session.token);
  if (!b) return res.status(400).json({ error:'no_battle' });
  if (b.enemy.hp > 0) return res.status(400).json({ error:'enemy_not_defeated' });

  const party = await getParty(req.session.player_id);
  const playerLevel = party.reduce((m,p)=>Math.max(m,p.level), 1);
  const baseCapture = 0.25;
  const chance = Math.min(0.95, baseCapture * (1 + playerLevel * 0.03));

  const roll = Math.random();
  if (roll < chance){
    const lvl = Math.max(1, b.enemy.level);
    const max_hp = 14 + lvl*4;
    const { rows } = await pool.query(`
      INSERT INTO mg_monsters (owner_id, species_id, level, xp, hp, max_hp, ability, moves)
      VALUES ($1,$2,$3,0,$4,$5,'rescue:blink','[
        {"name":"Tackle","base":"physical","power":6,"accuracy":0.95,"pp":30,"stack":["dmg_phys"]}
      ]'::jsonb)
      RETURNING id, species_id, level, xp, hp, max_hp, ability, moves
    `, [req.session.player_id, b.enemy.speciesId, Math.max(1, b.enemy.level), max_hp, max_hp]);
    battles.delete(req.session.token);
    return res.json({ result:'captured', captured: rows[0] });
  } else {
    battles.delete(req.session.token);
    return res.json({ result:'escaped' });
  }
});

/* -------------------- WS KEEPALIVE -------------------- */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
wss.on('connection', (ws)=>{ ws.isAlive = true; ws.on('pong', ()=>ws.isAlive = true); });
setInterval(()=>{ wss.clients.forEach(ws=>{ if (!ws.isAlive) return ws.terminate(); ws.isAlive=false; ws.ping(); }); }, 30000);

/* -------------------- BOOT -------------------- */
initDB()
  .then(()=>{ server.listen(PORT, ()=>console.log('Monster game server listening on :' + PORT)); })
  .catch((e)=>{ console.error('DB init failed:', e); process.exit(1); });
