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

const { PGHOST, PGDATABASE, PGUSER, PGPASSWORD, PGPORT = 5432, PGSSLMODE = 'require', PORT = 3001 } = process.env;

const pool = new Pool({
  host: PGHOST, database: PGDATABASE, user: PGUSER, password: PGPASSWORD,
  port: Number(PGPORT), ssl: PGSSLMODE === 'require' ? { rejectUnauthorized:false } : false
});

async function initDB(){
  await pool.query(`CREATE TABLE IF NOT EXISTS mg_players (
    id SERIAL PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    handle TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    has_starter BOOLEAN NOT NULL DEFAULT false,
    starter_species INT,
    created_at TIMESTAMPTZ DEFAULT now()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS mg_sessions (
    token TEXT PRIMARY KEY,
    player_id INT NOT NULL REFERENCES mg_players(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ DEFAULT now()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS mg_player_state (
    player_id INT PRIMARY KEY REFERENCES mg_players(id) ON DELETE CASCADE,
    cx INT NOT NULL DEFAULT 0,
    cy INT NOT NULL DEFAULT 0,
    tx INT NOT NULL DEFAULT 128,
    ty INT NOT NULL DEFAULT 128,
    steps INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ DEFAULT now()
  );`);
}
function token(){ return 't-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
async function getPlayerByEmail(email){ const { rows } = await pool.query('SELECT * FROM mg_players WHERE email=$1 LIMIT 1',[email]); return rows[0]||null; }
async function getPlayerByHandle(handle){ const { rows } = await pool.query('SELECT * FROM mg_players WHERE handle=$1 LIMIT 1',[handle]); return rows[0]||null; }
async function createPlayer(email, handle, password){
  const hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query('INSERT INTO mg_players (email,handle,password_hash) VALUES ($1,$2,$3) RETURNING id',[email,handle,hash]);
  const player_id = rows[0].id;
  await pool.query('INSERT INTO mg_player_state (player_id,cx,cy,tx,ty,steps) VALUES ($1,0,0,128,128,0)',[player_id]);
  return player_id;
}
async function createSession(player_id){ const t = token(); await pool.query('INSERT INTO mg_sessions (token, player_id) VALUES ($1,$2)',[t,player_id]); return t; }
async function getSession(t){ const { rows } = await pool.query(
  `SELECT s.token, p.id AS player_id, p.email, p.handle, p.has_starter, p.starter_species
   FROM mg_sessions s JOIN mg_players p ON p.id=s.player_id WHERE s.token=$1 LIMIT 1`, [t]); return rows[0]||null; }
async function getState(pid){ const { rows } = await pool.query('SELECT player_id,cx,cy,tx,ty,steps FROM mg_player_state WHERE player_id=$1 LIMIT 1',[pid]); return rows[0]||null; }
async function setState(pid, cx, cy, tx, ty, steps){ await pool.query('UPDATE mg_player_state SET cx=$1,cy=$2,tx=$3,ty=$4,steps=$5,updated_at=now() WHERE player_id=$6',[cx,cy,tx,ty,steps,pid]); }

app.get('/', (req,res)=>res.type('text').send('Monster Game API online. Try /api/health'));
app.get('/api/health', async (req,res)=>{ try{ const { rows } = await pool.query('SELECT 1 AS ok'); res.json({ ok: rows[0].ok===1 }); }catch(e){ res.status(500).json({ ok:false, db_error:e.code||String(e) }); } });

app.post('/api/register', async (req,res)=>{
  try{
    const { email, password, handle } = req.body || {};
    if(!email || !password || !handle) return res.status(400).json({ error:'Missing fields' });
    if(await getPlayerByEmail(email))  return res.status(409).json({ error:'Email already exists' });
    if(await getPlayerByHandle(handle)) return res.status(409).json({ error:'Handle already exists' });
    const pid = await createPlayer(email, handle, password);
    const tok = await createSession(pid);
    const st = await getState(pid);
    res.json({ token: tok, player: { handle, ...st, party: [] }, hasStarter: false });
  }catch(e){ console.error('register',e); res.status(500).json({ error:'server_error' }); }
});
app.post('/api/login', async (req,res)=>{
  try{
    const { email, password } = req.body || {};
    const p = await getPlayerByEmail(email);
    if(!p) return res.status(401).json({ error:'Invalid credentials' });
    const ok = await bcrypt.compare(password, p.password_hash);
    if(!ok) return res.status(401).json({ error:'Invalid credentials' });
    const tok = await createSession(p.id);
    const st = await getState(p.id);
    res.json({ token: tok, player: { handle:p.handle, ...st, party: [] }, hasStarter: !!p.has_starter, starterSpecies: p.starter_species || null });
  }catch(e){ console.error('login',e); res.status(500).json({ error:'server_error' }); }
});

async function auth(req,res,next){
  try{
    const t = req.headers.authorization || req.query.token;
    if(!t) return res.status(401).json({ error:'Auth required' });
    const sess = await getSession(t);
    if(!sess) return res.status(401).json({ error:'Invalid session' });
    req.session = sess; next();
  }catch(e){ res.status(500).json({ error:'server_error' }); }
}
app.get('/api/me', auth, async (req,res)=>{ const st = await getState(req.session.player_id);
  res.json({ handle:req.session.handle, ...st, party: [], hasStarter: !!req.session.has_starter, starterSpecies: req.session.starter_species||null }); });

app.get('/api/chunk', auth, async (req,res)=>{ const st = await getState(req.session.player_id);
  const x = parseInt(req.query.x ?? st.cx, 10); const y = parseInt(req.query.y ?? st.cy, 10);
  res.json({ x,y, chunk: world.generateChunk(x,y) }); });

app.post('/api/choose_starter', auth, async (req,res)=>{ const { speciesId } = req.body || {};
  if(!speciesId) return res.status(400).json({ error:'speciesId required' });
  await pool.query('UPDATE mg_players SET has_starter=true, starter_species=$1 WHERE id=$2',[speciesId, req.session.player_id]);
  res.json({ ok:true, starterSpecies: speciesId }); });

// movement + simple server-side encounter roll
app.post('/api/move', auth, async (req,res)=>{
  const dx = Math.max(-1, Math.min(1, (req.body?.dx)||0));
  const dy = Math.max(-1, Math.min(1, (req.body?.dy)||0));
  const st = await getState(req.session.player_id);
  let { cx, cy, tx, ty, steps } = st;
  const CHUNK_W = 256, CHUNK_H = 256;
  tx += dx; ty += dy; if (dx||dy) steps++;
  if (tx < 0){ tx = CHUNK_W-1; cx -= 1; }
  if (tx >= CHUNK_W){ tx = 0; cx += 1; }
  if (ty < 0){ ty = CHUNK_H-1; cy -= 1; }
  if (ty >= CHUNK_H){ ty = 0; cy += 1; }
  await setState(req.session.player_id, cx, cy, tx, ty, steps);

  const chunk = world.generateChunk(cx, cy);
  const tile = chunk.tiles[ty][tx];
  const encounterChance = tile.encounterRate || 0.08;
  let encounter = null;
  if (Math.random() < encounterChance){
    const pool = chunk.encounterTable.filter(s=>s.biomes.includes(tile.biome));
    if (pool.length){
      let acc=0, roll=Math.random(), pick=pool[0];
      for(const sp of pool){ acc += sp.baseSpawnRate; if (roll <= acc){ pick=sp; break; } }
      const lvl = Math.round(pick.level[0] + Math.random()*(pick.level[1]-pick.level[0]));
      encounter = { speciesId: pick.speciesId, name: pick.name, level: lvl };
    }
  }
  res.json({ player:{ handle:req.session.handle, cx,cy,tx,ty,steps,party:[] }, chunk, encounter });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
wss.on('connection',(ws)=>{
  ws.isAlive=true; ws.on('pong',()=>ws.isAlive=true);
  ws.on('message', async (raw)=>{
    let msg; try{ msg=JSON.parse(raw); }catch{ return ws.send(JSON.stringify({ type:'error', error:'bad_json' })); }
    if (msg.type==='auth'){
      const sess = await getSession(msg.token);
      if(!sess) return ws.send(JSON.stringify({ type:'error', error:'invalid_token' }));
      ws.session = sess;
      const st = await getState(sess.player_id);
      ws.send(JSON.stringify({ type:'auth_ok', player:{ handle:sess.handle, ...st, party:[] }, hasStarter: !!sess.has_starter, starterSpecies: sess.starter_species||null }));
      return;
    }
    if (!ws.session) return ws.send(JSON.stringify({ type:'error', error:'unauthenticated' }));
    if (msg.type==='move'){
      const dx = Math.max(-1, Math.min(1, msg.dx||0));
      const dy = Math.max(-1, Math.min(1, msg.dy||0));
      const st = await getState(ws.session.player_id);
      let { cx, cy, tx, ty, steps } = st;
      const CHUNK_W = 256, CHUNK_H = 256;
      tx += dx; ty += dy; if (dx||dy) steps++;
      if (tx < 0){ tx = CHUNK_W-1; cx -= 1; }
      if (tx >= CHUNK_W){ tx = 0; cx += 1; }
      if (ty < 0){ ty = CHUNK_H-1; cy -= 1; }
      if (ty >= CHUNK_H){ ty = 0; cy += 1; }
      await setState(ws.session.player_id, cx, cy, tx, ty, steps);
      const chunk = world.generateChunk(cx, cy);
      const tile = chunk.tiles[ty][tx];
      const encounterChance = tile.encounterRate || 0.08;
      let encounter = null;
      if (Math.random() < encounterChance){
        const pool = chunk.encounterTable.filter(s=>s.biomes.includes(tile.biome));
        if (pool.length){
          let acc=0, roll=Math.random(), pick=pool[0];
          for(const sp of pool){ acc += sp.baseSpawnRate; if (roll <= acc){ pick=sp; break; } }
          const lvl = Math.round(pick.level[0] + Math.random()*(pick.level[1]-pick.level[0]));
          encounter = { speciesId: pick.speciesId, name: pick.name, level: lvl };
        }
      }
      ws.send(JSON.stringify({ type:'moved', player:{ handle:ws.session.handle, cx,cy,tx,ty,steps,party:[] }, chunk:{ cx,cy,chunk }, encounter }));
      return;
    }
    ws.send(JSON.stringify({ type:'error', error:'unknown_msg' }));
  });
});
setInterval(()=>{ wss.clients.forEach(ws=>{ if(!ws.isAlive) return ws.terminate(); ws.isAlive=false; ws.ping(); }); }, 30000);

initDB().then(()=>{ server.listen(PORT, ()=>console.log('Monster game server listening on :' + PORT)); }).catch(e=>{ console.error('DB init failed:', e); process.exit(1); });



