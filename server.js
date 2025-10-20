// server.js — sessions, world, sync, battles (full)
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

/* ---------- DB setup ---------- */
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

/* ---------- helpers ---------- */
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

/* ---------- party & heal ---------- */
app.get('/api/party', auth, async (req,res)=>{
  const party = await getParty(req.session.player_id);
  res.json({ party });
});
async function doHeal(owner_id){
  await pool.query(`UPDATE mg_monsters SET hp = max_hp WHERE owner_id=$1`, [owner_id]);
  const party = await getParty(owner_id);
  return { ok:true, party };
}
app.post('/api/heal', auth, async (req,res)=>{ try{ res.json(await doHeal(req.session.player_id)); }catch(e){ res.status(500).json({ error:'server_error' }); }});
app.get('/api/heal',  auth, async (req,res)=>{ try{ res.json(await doHeal(req.session.player_id)); }catch(e){ res.status(500).json({ error:'server_error' }); }});

/* ---------- species & chunk ---------- */
app.get('/api/species', async (_req,res)=>{
  try{ const { rows } = await pool.query(`SELECT id,name,base_spawn_rate,biomes,types FROM mg_species ORDER BY id ASC`); res.json({ species: rows }); }
  catch(e){ res.status(500).json({ error:'server_error' }); }
});

// helper to get a chunk from `world` in whatever shape the module exposes
function getWorldChunk(cx, cy){
  if (world && typeof world.getChunk === 'function') return world.getChunk(cx,cy);
  if (world && typeof world.chunk === 'function')    return world.chunk(cx,cy);
  if (world && typeof world.generateChunk === 'function') return world.generateChunk(cx,cy);
  // fallback flat grassland if world module is different
  const w=CHUNK_W,h=CHUNK_H;
  const tiles = Array.from({length:h},()=>Array.from({length:w},()=>({ biome:'grassland' })));
  return { w,h,tiles };
}
function chunkHandler(req,res){
  try{
    const cx = parseInt(req.query.x,10)|0;
    const cy = parseInt(req.query.y,10)|0;
    const chunk = getWorldChunk(cx,cy);
    if (!chunk || !Array.isArray(chunk.tiles)) return res.status(500).json({ error:'no_chunk' });
    res.json({ chunk });
  }catch(e){ res.status(500).json({ error:'server_error' }); }
}
app.get('/api/chunk', auth, chunkHandler);
// non-API fallback used by old clients
app.get('/chunk', auth, chunkHandler);

/* ---------- sync (absolute) ---------- */
app.post('/api/sync', auth, async (req,res)=>{
  try{
    const { seq, cx, cy, tx, ty } = req.body || {};
    if (typeof cx!=='number'||typeof cy!=='number'||typeof tx!=='number'||typeof ty!=='number'){
      return res.status(400).json({ error:'bad_coords' });
    }
    // normalize into chunk bounds
    let n_cx=cx|0, n_cy=cy|0, n_tx=tx|0, n_ty=ty|0;
    while (n_tx<0){ n_tx+=CHUNK_W; n_cx-=1; }
    while (n_ty<0){ n_ty+=CHUNK_H; n_cy-=1; }
    while (n_tx>=CHUNK_W){ n_tx-=CHUNK_W; n_cx+=1; }
    while (n_ty>=CHUNK_H){ n_ty-=CHUNK_H; n_cy+=1; }

    await setState(req.session.player_id, n_cx,n_cy,n_tx,n_ty);

    const player = { handle:req.session.handle, cx:n_cx, cy:n_cy, tx:n_tx, ty:n_ty };
    const payload = { seq: Number(seq)||0, player };

    // when crossing chunk, include the new chunk so client can draw immediately
    if (n_cx!== (cx|0) || n_cy!==(cy|0)){
      payload.chunk = getWorldChunk(n_cx, n_cy);
    }
    res.json(payload);
  }catch(e){ res.status(500).json({ error:'server_error' }); }
});

/* ---------- battles ---------- */
// in-memory battle state keyed by session token
const battles = new Map();

function firstAliveIndex(party){
  for (let i=0;i<party.length;i++) if ((party[i].hp|0)>0) return i;
  return -1;
}
function calcDamage(move, atkLevel){
  const power = (move.power|0) || 1;
  const base = Math.max(1, Math.round(power + atkLevel*0.5));
  return base;
}
function makePPMap(moves){
  const map={}; (moves||[]).slice(0,4).forEach(m=>{ map[m.name]= (m.pp|0) || 20; }); return map;
}

async function buildEnemyFromTile(tile){
  // very simple: pick a random species weighted a little by base_spawn_rate
  const { rows } = await pool.query(`SELECT id,name,base_spawn_rate FROM mg_species ORDER BY id ASC`);
  if (!rows.length) return { speciesId:1, name:'Fieldling', level:3, hp:20, max_hp:20, moves:[{name:'Strike', base:'physical', power:8, accuracy:0.95, pp:25}] };
  // weight
  const w = rows.map(r=>Math.max(0.01, Number(r.base_spawn_rate)||0.05));
  const sum = w.reduce((a,b)=>a+b,0);
  let t=Math.random()*sum, pick=rows[0];
  for(let i=0;i<w.length;i++){ if ((t-=w[i])<=0){ pick = rows[i]; break; } }
  const level = 2 + Math.floor(Math.random()*3);
  const hp = 16 + level*4;
  return {
    speciesId: pick.id, name: pick.name, level,
    hp, max_hp: hp,
    moves: [{ name:'Strike', base:'physical', power:8, accuracy:0.95, pp:25 }]
  };
}

app.post('/api/battle/start', auth, async (req,res)=>{
  try{
    const party = await getParty(req.session.player_id);
    const idx = firstAliveIndex(party);
    if (idx<0) return res.status(409).json({ error:'you_fainted' });

    const st = await getState(req.session.player_id);
    const tile = (getWorldChunk(st.cx, st.cy)?.tiles?.[st.ty]||[])[st.tx];

    const enemy = await buildEnemyFromTile(tile);
    const you = { ...party[idx] }; // shallow
    const pp = makePPMap(you.moves);

    const battle = { you, enemy, youIndex: idx, pp, log:[`A wild ${enemy.name} appears!`], allowCapture:false, owner_id:req.session.player_id };
    battles.set(req.session.token, battle);

    res.json({ you, enemy, youIndex: idx, pp, log: battle.log, allowCapture: false });
  }catch(e){ res.status(500).json({ error:'server_error' }); }
});

app.post('/api/battle/turn', auth, async (req,res)=>{
  try{
    const b = battles.get(req.session.token);
    if (!b) return res.status(404).json({ error:'no_battle' });
    const action = (req.body?.action||'').toLowerCase();

    // refresh party entry used for "you" (HP may change between turns due to heal, etc.)
    const party = await getParty(req.session.player_id);
    let you = party[b.youIndex] || party[firstAliveIndex(party)];
    if (!you) return res.status(409).json({ error:'you_team_wiped' });
    b.you = you; // keep latest

    if (b.allowCapture) return res.status(409).json({ error:'capture_or_finish' });

    if (action === 'switch'){
      const curIdx   = b.youIndex|0;
      const targetIdx= Math.max(0, Math.min((req.body.index|0), party.length-1));
      if (!party[targetIdx]) return res.status(400).json({ error:'bad_index' });
      if ((party[targetIdx].hp|0) <= 0) return res.status(400).json({ error:'target_fainted' });
    
      // Enemy priority: act BEFORE the switch if priority > 0
      const eMove = (Array.isArray(b.enemy.moves) && b.enemy.moves[0]) ||
                    { name:'Strike', base:'physical', power:8, accuracy:0.95, pp:25, priority:0 };
      const ePri  = (eMove.priority|0) || 0;
    
      if (ePri > 0){
        if (Math.random() < (eMove.accuracy ?? 1.0)){
          const edmg = Math.max(1, Math.round(6 + (b.enemy.level|0)*0.6));
          const newHp = Math.max(0, (party[curIdx].hp|0) - edmg);
          await pool.query(`UPDATE mg_monsters SET hp=$1 WHERE id=$2 AND owner_id=$3`, [newHp, party[curIdx].id, req.session.player_id]);
          party[curIdx].hp = newHp;
          b.log.push(`${b.enemy.name} (priority) hits for ${edmg}!`);
        } else {
          b.log.push(`${b.enemy.name} (priority) missed!`);
        }
        const refreshed = await getParty(req.session.player_id);
        if (firstAliveIndex(refreshed) < 0){
          battles.delete(req.session.token);
          return res.json({ log:b.log, result:'you_team_wiped' });
        }
      }
    
      // Perform the switch (this consumes your turn)
      b.youIndex = targetIdx;
      b.you = party[targetIdx];
      b.log.push(`You switched to ${b.you.nickname?.trim() || `Monster #${b.you.id}`}.`);
    
      // If NO priority, enemy acts AFTER the switch (hits the new active)
      if (ePri === 0){
        if (Math.random() < (eMove.accuracy ?? 1.0)){
          const edmg = Math.max(1, Math.round(6 + (b.enemy.level|0)*0.6));
          const newHp = Math.max(0, (b.you.hp|0) - edmg);
          await pool.query(`UPDATE mg_monsters SET hp=$1 WHERE id=$2 AND owner_id=$3`, [newHp, b.you.id, req.session.player_id]);
          b.you.hp = newHp;
          b.log.push(`${b.enemy.name} strikes for ${edmg}!`);
        } else {
          b.log.push(`${b.enemy.name} missed!`);
        }
    
        // KO check after being hit post-switch → auto-sub or wipe
        const refreshed = await getParty(req.session.player_id);
        const idxAlive = firstAliveIndex(refreshed);
        if ((b.you.hp|0) <= 0){
          if (idxAlive >= 0){
            b.youIndex = idxAlive;
            b.you = refreshed[idxAlive];
            b.log.push(`Your switched-in monster fainted! ${b.you.nickname?.trim() || 'Next monster'} steps in.`);
          } else {
            battles.delete(req.session.token);
            return res.json({ log:b.log, result:'you_team_wiped' });
          }
        }
      }
    
      return res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:false });
    } else if (action === 'run'){
      b.log.push(`You ran away.`);
      battles.delete(req.session.token);
      return res.json({ log:b.log, result:'escaped' });
    } else if (action === 'move'){
      const moveName = String(req.body.move||'').trim();
      const move = (Array.isArray(b.you.moves)?b.you.moves:[]).find(m=>(m.name||'')===moveName) ||
                   { name:'Strike', base:'physical', power:8, accuracy:0.95, pp:25 };
      if (b.pp[move.name] == null) b.pp[move.name] = (move.pp|0)||20;
      if (b.pp[move.name] <= 0) return res.status(400).json({ error:'no_pp' });
      // accuracy
      if (Math.random() < (move.accuracy ?? 1.0)){
        const dmg = calcDamage(move, b.you.level|0);
        b.enemy.hp = Math.max(0, (b.enemy.hp|0) - dmg);
        b.log.push(`${move.name} hits for ${dmg}!`);
      } else {
        b.log.push(`${move.name} missed!`);
      }
      b.pp[move.name] = Math.max(0, (b.pp[move.name]|0) - 1);

      // enemy KO check
      if ((b.enemy.hp|0) <= 0){
        b.log.push(`Enemy ${b.enemy.name} fainted!`);
        b.allowCapture = true; // only now can capture
        return res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:true });
      }

      // enemy's turn (simple strike)
      if (Math.random() < 0.93){
        const edmg = Math.max(1, Math.round(6 + (b.enemy.level|0)*0.6));
        const cur = Math.max(0, (b.you.hp|0) - edmg);
        await pool.query(`UPDATE mg_monsters SET hp=$1 WHERE id=$2 AND owner_id=$3`, [cur, b.you.id, req.session.player_id]);
        b.you.hp = cur;
        b.log.push(`${b.enemy.name} strikes back for ${edmg}!`);
      } else {
        b.log.push(`${b.enemy.name} missed!`);
      }

      // you KO check → auto-sub if possible
      const refreshed = await getParty(req.session.player_id);
      const idxAlive = firstAliveIndex(refreshed);
      if ((b.you.hp|0) <= 0){
        if (idxAlive >= 0){
          b.youIndex = idxAlive;
          b.you = refreshed[idxAlive];
          b.log.push(`Your previous monster fainted! ${b.you.nickname?.trim() || 'Next monster'} steps in.`);
        } else {
          battles.delete(req.session.token);
          return res.json({ log:b.log, result:'you_team_wiped' });
        }
      }
    } else {
      return res.status(400).json({ error:'bad_action' });
    }

    res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:false });
  }catch(e){ res.status(500).json({ error:'server_error' }); }
});

app.post('/api/battle/capture', auth, async (req,res)=>{
  try{
    const b = battles.get(req.session.token);
    if (!b) return res.status(404).json({ error:'no_battle' });
    if (!b.allowCapture) return res.status(409).json({ error:'not_allowed' });

    // fixed odds (e.g., 60%) per spec: only after KO
    const success = Math.random() < 0.6;
    if (!success){
      b.log.push('Capture failed.');
      return res.json({ result:'failed', log:b.log, allowCapture:true });
    }
    // Add to party
    await pool.query(`
      INSERT INTO mg_monsters (owner_id,species_id,level,xp,hp,max_hp,ability,moves)
      VALUES ($1,$2,$3,0,$4,$4,'wild','[
        {"name":"Strike","base":"physical","power":8,"accuracy":0.95,"pp":25}
      ]'::jsonb)
    `, [req.session.player_id, b.enemy.speciesId, b.enemy.level|0, Math.max(12, b.enemy.max_hp|0)]);

    b.log.push(`Captured ${b.enemy.name}!`);
    battles.delete(req.session.token);
    res.json({ result:'captured', log:b.log });
  }catch(e){ res.status(500).json({ error:'server_error' }); }
});

/* ---------- server / ws ---------- */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
wss.on('connection', ws => { ws.isAlive = true; ws.on('pong', ()=>ws.isAlive = true); });
setInterval(()=>{ wss.clients.forEach(ws=>{ if (!ws.isAlive) return ws.terminate(); ws.isAlive=false; ws.ping(); }); }, 30000);

server.listen(PORT, ()=>console.log('Monster game server listening on :' + PORT));
