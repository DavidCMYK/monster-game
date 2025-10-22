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
const { getContent, reloadContent } = require('./contentLoader');

// --- Learn-pool helpers ---
function extractTraitsFromMoves(moves){
  const seenEffects = new Set();
  const seenBonuses = new Set();
  const list = Array.isArray(moves) ? moves : [];
  for (const mv of list){
    const stack = Array.isArray(mv?.stack) ? mv.stack : [];
    const bons  = Array.isArray(mv?.bonuses) ? mv.bonuses : [];
    for (const e of stack){ if (e) seenEffects.add(String(e)); }
    for (const b of bons){  if (b) seenBonuses.add(String(b)); }
  }
  return { effects: Array.from(seenEffects), bonuses: Array.from(seenBonuses) };
}

// Shape: learn_pool = { effects: { code: percent }, bonuses: { code: percent } }
function ensureLearnPool(obj){
  if (!obj.learn_pool || typeof obj.learn_pool !== 'object'){
    obj.learn_pool = { effects:{}, bonuses:{} };
  } else {
    obj.learn_pool.effects = obj.learn_pool.effects || {};
    obj.learn_pool.bonuses = obj.learn_pool.bonuses || {};
  }
}

async function incrementLearnPoolForMonster(monsterId, effects, bonuses){
  if (!monsterId) return;

  // 1) fetch monster
  const { rows } = await pool.query(
    `SELECT id, moves, learn_pool FROM mg_monsters WHERE id=$1 LIMIT 1`,
    [monsterId]
  );
  if (!rows.length) return;

  const mon = rows[0];
  // Parse JSONB fields defensively
  try{ if (typeof mon.moves === 'string') mon.moves = JSON.parse(mon.moves); }catch{}
  try{ if (typeof mon.learn_pool === 'string') mon.learn_pool = JSON.parse(mon.learn_pool); }catch{}

  ensureLearnPool(mon);

  // 2) bump by +1 percentage point per distinct trait seen
  for (const code of effects){
    const k = String(code);
    const current = Number(mon.learn_pool.effects[k] || 0);
    mon.learn_pool.effects[k] = Math.max(0, Math.min(100, current + 1));
  }
  for (const code of bonuses){
    const k = String(code);
    const current = Number(mon.learn_pool.bonuses[k] || 0);
    mon.learn_pool.bonuses[k] = Math.max(0, Math.min(100, current + 1));
  }

  // 3) persist
  await pool.query(
    `UPDATE mg_monsters SET learn_pool=$1 WHERE id=$2`,
    [JSON.stringify(mon.learn_pool), monsterId]
  );
}

// --- Stack validation helpers (effects/bonuses) ---
function _contentIndex(){
  const c = getContent() || {};
  const effects = Array.isArray(c.effects) ? c.effects : [];
  const bonuses = Array.isArray(c.bonuses) ? c.bonuses : [];

  const effByCode = Object.create(null);
  for (const e of effects){
    const code = String(e.code || '').trim();
    if (code) effByCode[code] = e;
  }

  const bonByCode = Object.create(null);
  for (const b of bonuses){
    const code = String(b.code || '').trim();
    if (code) bonByCode[code] = b;
  }

  // Heuristic base-effect detector:
  // 1) Prefer explicit CSV flags (any of these columns set to 1/true/yes),
  // 2) fallback: codes that look like base actions (dmg_*, guard, heal*)
  function isBaseEffect(e){
    if (!e) return false;
    const flags = ['base','base_flag','base_flag_eligible','base_eligible','is_base','baseeffect'];
    for (const k of flags){
      const v = String(e[k] ?? '').toLowerCase();
      if (v === '1' || v === 'true' || v === 'yes') return true;
    }
    const code = String(e.code || '');
    return /^dmg_/.test(code) || code === 'guard' || /^heal/.test(code);
  }

  return { effByCode, bonByCode, isBaseEffect };
}

function validateAndSanitizeStack(inputStack, inputBonuses){
  const { effByCode, bonByCode, isBaseEffect } = _contentIndex();

  const rawStack = Array.isArray(inputStack) ? inputStack.map(x => String(x).trim()) : [];
  const rawBonus = Array.isArray(inputBonuses) ? inputBonuses.map(x => String(x).trim()) : [];

  // Keep only codes that exist in the CSV-driven pool
  const stack = rawStack.filter(code => !!effByCode[code]);
  const bonuses = rawBonus.filter(code => !!bonByCode[code]);

  // Enforce exactly one base effect
  const baseCodes = stack.filter(code => isBaseEffect(effByCode[code]));
  if (baseCodes.length === 0){
    return { ok:false, error:'no_base_effect', message:'Your stack must include exactly one base effect (e.g., dmg_phys or dmg_spec).' };
  }
  const baseKeep = baseCodes[0];
  const filtered = [];
  let basePlaced = false;
  for (const code of stack){
    const isBase = isBaseEffect(effByCode[code]);
    if (isBase){
      if (basePlaced){
        // skip any extra base effects
        continue;
      }
      if (code !== baseKeep) continue; // only allow the first-found base
      filtered.push(code);
      basePlaced = true;
    } else {
      filtered.push(code);
    }
  }

  // Guarantee the base is first in the stack (helps downstream resolver)
  if (filtered[0] !== baseKeep){
    const withoutBase = filtered.filter(c => c !== baseKeep);
    filtered.length = 0;
    filtered.push(baseKeep, ...withoutBase);
  }

  return { ok:true, stack: filtered, bonuses };
}

// --- Per-effect resolver helpers (accuracy & PP from base effect) ---
function getEffectRowByCode(code){
  const c = getContent() || {};
  const list = Array.isArray(c.effects) ? c.effects : [];
  const k = String(code || '').trim();
  return list.find(e => String(e.code || '').trim() === k) || null;
}

// --- Canonicalization + move-name registry ---
function canonicalizeStackAndBonuses(stack, bonuses){
  // Both arrays of strings, trimmed, with base effect already validated/first
  const s = Array.isArray(stack) ? stack.map(x=>String(x).trim()).filter(Boolean) : [];
  const b = Array.isArray(bonuses) ? bonuses.map(x=>String(x).trim()).filter(Boolean) : [];
  // keep order on stack (base enforced first by validate) and sort bonuses for stable key
  const bon = b.slice().sort();
  const key = `${s.join('|')}§${bon.join('|')}`;
  return { s, bon, key };
}

// For now: generate name as "effect1+effect2+... [+ bonus1+bonus2...]"
function generatedMoveName(stack, bonuses){
  const left = (Array.isArray(stack)?stack:[]).join('+');
  const right = (Array.isArray(bonuses)&&bonuses.length) ? ('+' + bonuses.join('+')) : '';
  return (left + right) || 'Custom';
}

// Ensure there is a row in mg_moves for this exact combo; return its name
async function ensureMoveRecord(stack, bonuses){
  const { s, bon } = canonicalizeStackAndBonuses(stack, bonuses);

  // try to find existing by canonical key (using the same md5 logic)
  const { rows: found } = await pool.query(
    `
    SELECT name
      FROM mg_moves
     WHERE md5(COALESCE(array_to_string(stack,'│'),'') || '§' || COALESCE(array_to_string(bonuses,'│'),''))
           = md5($1 || '§' || $2)
     LIMIT 1
    `,
    [ s.join('│'), bon.join('│') ]
  );
  if (found.length) return String(found[0].name || '');

  // insert new
  const name = generatedMoveName(s, bon);
  const { rows: ins } = await pool.query(
    `INSERT INTO mg_moves(name, stack, bonuses) VALUES ($1,$2,$3) RETURNING name`,
    [ name, s, bon ]
  );
  return String(ins[0].name || name);
}

function computePPFromBaseEffect(stack, fallbackPP=20){
  const baseCode = Array.isArray(stack) ? String(stack[0]||'').trim() : '';
  if (!baseCode) return fallbackPP|0;
  const row = getEffectRowByCode(baseCode);
  const csvPP = row && row.base_pp != null ? Number(row.base_pp) : null;
  if (csvPP != null && !Number.isNaN(csvPP) && csvPP > 0) return csvPP|0;
  return fallbackPP|0;
}


function getBonusCodes(bonuses){
  return Array.isArray(bonuses) ? bonuses.map(b => String(b).trim()) : [];
}

// Return accuracy for a single effect code, using CSV `accuracy` if available,
// otherwise fall back to the move's accuracy (or 0.95).
function perEffectAccuracy(effectCode, move, bonuses){
  const row = getEffectRowByCode(effectCode);
  let acc = (row && row.accuracy != null) ? Number(row.accuracy) : (move.accuracy ?? 0.95);

  // Simple bonus: if the move has 'accuracy_up', add +0.10 (cap at 0.99).
  const bon = getBonusCodes(bonuses);
  if (bon.includes('accuracy_up')) acc += 0.10;

  acc = Math.max(0.05, Math.min(0.99, Number(acc) || 0.95));
  return acc;
}

// Resolve a single effect (hit/miss). For damage effects, apply damage and return { hit, dmg }.
// For non-damage, just log that it applied (mechanics can be added later).
async function resolveSingleEffect(effectCode, move, attacker, defender, b){
  const acc = perEffectAccuracy(effectCode, move, move?.bonuses);
  const hit = Math.random() < acc;

  if (!hit){
    b.log.push(`${move.name} (${effectCode}) missed!`);
    return { hit:false, dmg:0 };
  }

  // If it’s a damage effect, compute damage using a temporary move that only includes that effect.
  if (effectCode === 'dmg_phys' || effectCode === 'dmg_spec'){
    const tempMove = { ...move, stack:[effectCode] }; // force moveKind to read this single effect
    const atkStats = await getMonDerivedStats(attacker);
    const defStats = await getEnemyDerivedStats(defender);
    const dmg = await calcDamage(atkStats, defStats, tempMove, attacker.level|0);
    defender.hp = Math.max(0, (defender.hp|0) - dmg);
    b.log.push(`${move.name} (${effectCode}) hits for ${dmg}!`);
    return { hit:true, dmg };
  }

  // Non-damage effect: stub behavior for now
  b.log.push(`${move.name} applied ${effectCode}.`);
  return { hit:true, dmg:0 };
}


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
// --- Load content from CSV files at startup ---
try { reloadContent(); } catch(e){ console.error('Content load failed:', e.message); }


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

  await pool.query(`ALTER TABLE mg_species ADD COLUMN IF NOT EXISTS base_hp  INT NOT NULL DEFAULT 40`);
  await pool.query(`ALTER TABLE mg_species ADD COLUMN IF NOT EXISTS base_phy INT NOT NULL DEFAULT 10`);
  await pool.query(`ALTER TABLE mg_species ADD COLUMN IF NOT EXISTS base_mag INT NOT NULL DEFAULT 10`);
  await pool.query(`ALTER TABLE mg_species ADD COLUMN IF NOT EXISTS base_def INT NOT NULL DEFAULT 10`);
  await pool.query(`ALTER TABLE mg_species ADD COLUMN IF NOT EXISTS base_res INT NOT NULL DEFAULT 10`);
  await pool.query(`ALTER TABLE mg_species ADD COLUMN IF NOT EXISTS base_spd INT NOT NULL DEFAULT 10`);
  await pool.query(`ALTER TABLE mg_species ADD COLUMN IF NOT EXISTS base_acc INT NOT NULL DEFAULT 95`);
  await pool.query(`ALTER TABLE mg_species ADD COLUMN IF NOT EXISTS base_eva INT NOT NULL DEFAULT 5`);

  await pool.query(`CREATE TABLE IF NOT EXISTS mg_monsters (id SERIAL PRIMARY KEY, owner_id INT NOT NULL REFERENCES mg_players(id) ON DELETE CASCADE, species_id INT NOT NULL REFERENCES mg_species(id), nickname TEXT, level INT NOT NULL DEFAULT 1, xp INT NOT NULL DEFAULT 0, hp INT NOT NULL DEFAULT 20, max_hp INT NOT NULL DEFAULT 20, ability TEXT, moves JSONB DEFAULT '[]'::jsonb);`);
  
  // Unique canonical moves table (one row per effects/bonuses combination)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mg_moves (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      stack TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      bonuses TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // keep name unique per exact stack/bonuses combo via functional index on canonical key
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS mg_moves_canonical_uniq
      ON mg_moves (
        md5(
          COALESCE(array_to_string(stack, '│'), '') || '§' ||
          COALESCE(array_to_string(bonuses, '│'), '')
        )
      );
  `);

  await pool.query(`ALTER TABLE mg_monsters ADD COLUMN IF NOT EXISTS growth JSONB`);
  await pool.query(`ALTER TABLE mg_monsters ADD COLUMN IF NOT EXISTS slot INT`);
  await pool.query(`
    UPDATE mg_monsters
    SET growth = jsonb_build_object(
      'HP', 1.00 + (random()*0.20 - 0.10),
      'PHY',1.00 + (random()*0.20 - 0.10),
      'MAG',1.00 + (random()*0.20 - 0.10),
      'DEF',1.00 + (random()*0.20 - 0.10),
      'RES',1.00 + (random()*0.20 - 0.10),
      'SPD',1.00 + (random()*0.20 - 0.10),
      'ACC',1.00 + (random()*0.10 - 0.05),
      'EVA',1.00 + (random()*0.10 - 0.05)
    )
    WHERE growth IS NULL
  `);

  await pool.query(`UPDATE mg_monsters SET slot = id WHERE slot IS NULL`);
  await pool.query(`
    WITH ranked AS (
      SELECT id, owner_id, ROW_NUMBER() OVER (PARTITION BY owner_id ORDER BY slot NULLS LAST, id) AS rn
      FROM mg_monsters
    )
    UPDATE mg_monsters m
       SET slot = ranked.rn
      FROM ranked
     WHERE m.id = ranked.id AND m.slot IS NULL
  `);
  await pool.query(`ALTER TABLE mg_monsters ADD COLUMN IF NOT EXISTS current_pp JSONB`);
  await pool.query(`ALTER TABLE mg_monsters ADD COLUMN IF NOT EXISTS learned_pool JSONB`);
  await pool.query(`ALTER TABLE mg_monsters ADD COLUMN IF NOT EXISTS learn_list JSONB`);

  // Defaults so all existing monsters start empty (as requested)
  await pool.query(`ALTER TABLE mg_monsters ALTER COLUMN learned_pool SET DEFAULT '{"effects":[],"bonuses":[]}'::jsonb`);
  await pool.query(`ALTER TABLE mg_monsters ALTER COLUMN learn_list   SET DEFAULT '{"effects":{},"bonuses":{}}'::jsonb`);

  // Backfill any NULLs
  await pool.query(`UPDATE mg_monsters SET learned_pool = '{"effects":[],"bonuses":[]}'::jsonb WHERE learned_pool IS NULL`);
  await pool.query(`UPDATE mg_monsters SET learn_list   = '{"effects":{},"bonuses":{}}'::jsonb       WHERE learn_list   IS NULL`);

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
  // pick your intended starter species id (keeping 1 for now) and level
  const starterSpeciesId = 1;
  const starterLevel = 3;
  
  // species + growth → derived stats for HP
  const srow   = await getSpeciesRow(starterSpeciesId);
  const growth = randomGrowth();
  const derived = srow ? deriveStats(srow, growth, starterLevel) : { HP: 28 };
  
  await pool.query(`
    INSERT INTO mg_monsters (owner_id,species_id,level,xp,hp,max_hp,ability,moves,slot,growth)
    VALUES ($1,$2,$3,0,$4,$4,'rescue:blink','[
      {"name":"Strike","base":"physical","power":8,"accuracy":0.95,"pp":25,"stack":["dmg_phys"]},
      {"name":"Guard","base":"status","power":0,"accuracy":1.0,"pp":15,"stack":["buff_def"]}
    ]'::jsonb, 10, $5)
  `, [player_id, starterSpeciesId, starterLevel, Math.max(1, derived.HP|0), JSON.stringify(growth)]);


  return player_id;
}

// -------- CSV import helpers + content override --------
const https = require('https');
let OVERRIDE_CONTENT = null; // { effects:[], bonuses:[], named_moves:[], pool:{effects:[],bonuses:[]}, version:number }

function httpGetText(url){
  return new Promise((resolve,reject)=>{
    https.get(url, res=>{
      if (res.statusCode && res.statusCode >= 400) return reject(new Error('HTTP '+res.statusCode));
      let data=''; res.setEncoding('utf8');
      res.on('data', chunk=> data+=chunk);
      res.on('end', ()=> resolve(data));
    }).on('error', reject);
  });
}

// very small CSV parser: handles commas and double-quotes ("" -> ")
function parseCSV(text){
  const out = [];
  let row=[], cur='', inQ=false, i=0;
  while(i<text.length){
    const c=text[i];
    if (inQ){
      if (c==='"' && text[i+1]==='"'){ cur+='"'; i+=2; continue; }
      if (c==='"'){ inQ=false; i++; continue; }
      cur+=c; i++; continue;
    }
    if (c==='"' ){ inQ=true; i++; continue; }
    if (c===','){ row.push(cur); cur=''; i++; continue; }
    if (c==='\r'){ i++; continue; }
    if (c==='\n'){ row.push(cur); cur=''; out.push(row); row=[]; i++; continue; }
    cur+=c; i++;
  }
  row.push(cur); out.push(row);
  // header -> objects
  const header = (out.shift()||[]).map(h=>String(h||'').trim());
  return out.filter(r=>r.length && r.some(x=>String(x).trim().length)).map(r=>{
    const o={}; for (let j=0;j<header.length;j++){ o[header[j]] = r[j]!=null ? r[j] : ''; }
    return o;
  });
}

// map helpers
function toTextArrayCell(v){
  // allow "a|b|c" OR JSON-like ["a","b"]
  const s = String(v||'').trim();
  if (!s) return [];
  if (s.startsWith('[')) { try { const arr = JSON.parse(s); return Array.isArray(arr)?arr.map(String):[]; } catch { return []; } }
  return s.split('|').map(x=>x.trim()).filter(Boolean);
}

function numOr(def, v){ const n=Number(v); return Number.isFinite(n)? n : def; }
function intOr(def, v){ const n=parseInt(v,10); return Number.isFinite(n)? n : def; }
function boolish(v){ const s=String(v||'').toLowerCase(); return (s==='1'||s==='true'||s==='yes'); }


async function createSession(player_id){ const t = token(); await pool.query(`INSERT INTO mg_sessions (token,player_id) VALUES ($1,$2)`, [t,player_id]); return t; }
async function getSession(tok){
  const { rows } = await pool.query(`SELECT s.token, p.id AS player_id, p.email, p.handle FROM mg_sessions s JOIN mg_players p ON p.id=s.player_id WHERE s.token=$1 LIMIT 1`, [tok]);
  return rows[0]||null;
}
async function deleteSession(tok){ await pool.query(`DELETE FROM mg_sessions WHERE token=$1`, [tok]); }
async function getState(player_id){ const { rows } = await pool.query(`SELECT player_id,cx,cy,tx,ty FROM mg_player_state WHERE player_id=$1 LIMIT 1`, [player_id]); return rows[0]||null; }
async function setState(player_id,cx,cy,tx,ty){ await pool.query(`UPDATE mg_player_state SET cx=$1,cy=$2,tx=$3,ty=$4,updated_at=now() WHERE player_id=$5`,[cx,cy,tx,ty,player_id]); }
async function getParty(player_id){
  const { rows } = await pool.query(`
    SELECT id,
           species_id,
           nickname,
           level,
           xp,
           hp,
           max_hp,
           ability,
           moves,
           slot,
           growth,
           learned_pool,
           learn_list
      FROM mg_monsters
     WHERE owner_id = $1
  ORDER BY COALESCE(slot, id) ASC, id ASC
     LIMIT 6
  `, [player_id]);
  return rows;
}



async function ensureHasParty(owner_id){
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM mg_monsters WHERE owner_id=$1`, [owner_id]);
  if ((rows[0]?.c||0) === 0){
    const starterSpeciesId = 1;
    const starterLevel = 3;
    const srow   = await getSpeciesRow(starterSpeciesId);
    const growth = randomGrowth();
    const derived = srow ? deriveStats(srow, growth, starterLevel) : { HP: 28 };
    
    await pool.query(`
      INSERT INTO mg_monsters (owner_id,species_id,level,xp,hp,max_hp,ability,moves,growth)
      VALUES ($1,$2,$3,0,$4,$4,'rescue:blink','[
        {"name":"Strike","base":"physical","power":8,"accuracy":0.95,"pp":25,"stack":["dmg_phys"]},
        {"name":"Guard","base":"status","power":0,"accuracy":1.0,"pp":15,"stack":["buff_def"]}
      ]'::jsonb, $5)
    `, [owner_id, starterSpeciesId, starterLevel, Math.max(1, derived.HP|0), JSON.stringify(growth)]);

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

async function speciesNameById(id){
  const { rows } = await pool.query(`SELECT name FROM mg_species WHERE id=$1 LIMIT 1`, [id|0]);
  return rows[0]?.name || `Species ${id||'?'}`;
}
async function monName(mon){
  const nick = (mon?.nickname||'').trim();
  if (nick) return nick;
  return await speciesNameById(mon.species_id);
}


/* ---------- learning: seen-traits list + learned pool ---------- */
function normLearnState(lp, ll){
  // learned_pool → arrays, unique
  let learned = (lp && typeof lp === 'object') ? lp : { effects:[], bonuses:[] };
  if (!Array.isArray(learned.effects)) learned.effects = [];
  if (!Array.isArray(learned.bonuses)) learned.bonuses = [];
  learned.effects = Array.from(new Set(learned.effects.map(String)));
  learned.bonuses = Array.from(new Set(learned.bonuses.map(String)));

  // learn_list → maps name->int (0-100)
  let list = (ll && typeof ll === 'object') ? ll : { effects:{}, bonuses:{} };
  if (typeof list.effects !== 'object' || Array.isArray(list.effects)) list.effects = {};
  if (typeof list.bonuses !== 'object' || Array.isArray(list.bonuses)) list.bonuses = {};
  return { learned, list };
}

async function loadLearnState(monId){
  const { rows } = await pool.query(`SELECT learned_pool, learn_list FROM mg_monsters WHERE id=$1 LIMIT 1`, [monId|0]);
  const lp = rows[0]?.learned_pool, ll = rows[0]?.learn_list;
  return normLearnState(lp, ll);
}

async function saveLearnState(ownerId, monId, learned, list){
  await pool.query(
    `UPDATE mg_monsters SET learned_pool=$1, learn_list=$2 WHERE id=$3 AND owner_id=$4`,
    [learned, list, monId|0, ownerId|0]
  );
}

// After you KO an enemy, add their effects/bonuses to your learn_list at +1% each occurrence.
// If already present in learned_pool, ignore. If already in list, increment by 1 (cap 100).
async function recordEncounteredTraits(ownerId, monId, enemyMoves){
  const { learned, list } = await loadLearnState(monId);
  const learnedE = new Set(learned.effects);
  const learnedB = new Set(learned.bonuses);

  const effMap = list.effects;
  const bonMap = list.bonuses;

  const moves = Array.isArray(enemyMoves) ? enemyMoves.slice(0, 4) : [];
  for (const m of moves){
    const stacks  = Array.isArray(m?.stack)   ? m.stack   : [];
    const bonuses = Array.isArray(m?.bonuses) ? m.bonuses : [];
    for (const e of stacks.map(String)){
      if (learnedE.has(e)) continue;
      effMap[e] = Math.min(100, (parseInt(effMap[e]||0,10) || 0) + 1);
    }
    for (const b of bonuses.map(String)){
      if (learnedB.has(b)) continue;
      bonMap[b] = Math.min(100, (parseInt(bonMap[b]||0,10) || 0) + 1);
    }
  }

  await saveLearnState(ownerId, monId, learned, { effects: effMap, bonuses: bonMap });
}

// On each level-up, roll once for every entry in learn_list.
// If roll succeeds (rand 1..100 <= chance), move it to learned_pool and remove from the list.
function applyLevelUpLearning(learned, list, rng=Math.random){
  const gained = { effects:[], bonuses:[] };

  const rollSide = (map, poolArr, gainedArr)=>{
    for (const name of Object.keys(map)){
      const chance = Math.max(0, Math.min(100, parseInt(map[name]||0, 10) || 0));
      if (chance <= 0) continue;
      const roll = Math.floor(rng()*100) + 1;  // 1..100
      if (roll <= chance){
        // learn it
        if (!poolArr.includes(name)) poolArr.push(name);
        gainedArr.push(name);
        delete map[name];
      }
    }
  };

  rollSide(list.effects, learned.effects, gained.effects);
  rollSide(list.bonuses, learned.bonuses, gained.bonuses);

  // keep pools unique
  learned.effects = Array.from(new Set(learned.effects));
  learned.bonuses = Array.from(new Set(learned.bonuses));

  return { learned, list, gained };
}


/* ---------- stat helpers (species + growth → derived stats) ---------- */
function levelCurve(L){
  L = Math.max(1, L|0);
  return 1 + (L-1)*0.075; // simple curve; tweak later to match design doc
}
function statRound(x){ return Math.max(1, Math.round(Number(x)||0)); }

async function getSpeciesRow(id){
  const { rows } = await pool.query(`
    SELECT id,name,types,
           base_hp,base_phy,base_mag,base_def,base_res,base_spd,base_acc,base_eva
    FROM mg_species WHERE id=$1 LIMIT 1
  `,[id|0]);
  return rows[0] || null;
}

function randomGrowth(){
  return {
    HP:  1.00 + (Math.random()*0.20 - 0.10),
    PHY: 1.00 + (Math.random()*0.20 - 0.10),
    MAG: 1.00 + (Math.random()*0.20 - 0.10),
    DEF: 1.00 + (Math.random()*0.20 - 0.10),
    RES: 1.00 + (Math.random()*0.20 - 0.10),
    SPD: 1.00 + (Math.random()*0.20 - 0.10),
    ACC: 1.00 + (Math.random()*0.10 - 0.05),
    EVA: 1.00 + (Math.random()*0.10 - 0.05),
  };
}

function deriveStats(speciesRow, growth, level){
  const gp = (k, def=1)=> Number((growth||{})[k] ?? def);
  const f  = levelCurve(level);
  return {
    HP:  statRound((speciesRow.base_hp  * gp('HP'))  * f),
    PHY: statRound((speciesRow.base_phy * gp('PHY')) * f),
    MAG: statRound((speciesRow.base_mag * gp('MAG')) * f),
    DEF: statRound((speciesRow.base_def * gp('DEF')) * f),
    RES: statRound((speciesRow.base_res * gp('RES')) * f),
    SPD: statRound((speciesRow.base_spd * gp('SPD')) * f),
    ACC: statRound((speciesRow.base_acc * gp('ACC'))), // usually not scaled by level
    EVA: statRound((speciesRow.base_eva * gp('EVA'))), // usually not scaled by level
  };
}

function buildPPFromMoves(mon){
  const map={}; (Array.isArray(mon.moves)?mon.moves:[]).slice(0,4).forEach(m=>{
    const n=m?.name; if (!n) return; map[n]=(m.pp|0)||20;
  }); return map;
}

async function getCurrentPP(mon){
  if (mon.current_pp && typeof mon.current_pp === 'object') return mon.current_pp;
  const { rows } = await pool.query(`SELECT current_pp, moves FROM mg_monsters WHERE id=$1 LIMIT 1`, [mon.id]);
  let map = rows[0]?.current_pp;
  if (!map || typeof map !== 'object') {
    const moves = rows[0]?.moves || mon.moves;
    map = {};
    (Array.isArray(moves)?moves:[]).slice(0,4).forEach(m=>{
      const n=m?.name; if (!n) return; map[n]=(m.pp|0)||20;
    });
    await pool.query(`UPDATE mg_monsters SET current_pp=$1 WHERE id=$2`, [map, mon.id]);
  }
  return map;
}

async function setCurrentPP(monId, ownerId, map){
  await pool.query(`UPDATE mg_monsters SET current_pp=$1 WHERE id=$2 AND owner_id=$3`, [map, monId, ownerId]);
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
app.post('/api/party/reorder', auth, async (req,res)=>{
  try{
    const party = await getParty(req.session.player_id);
    const from = Math.max(0, Math.min((req.body.from|0), party.length-1));
    const to   = Math.max(0, Math.min((req.body.to|0),   party.length-1));
    if (from === to) return res.json({ ok:true, party });

    const a = party[from], b = party[to];
    if (!a || !b) return res.status(400).json({ error:'bad_index' });

    await pool.query('BEGIN');
    await pool.query(`UPDATE mg_monsters SET slot=$1 WHERE id=$2 AND owner_id=$3`, [b.slot|0, a.id, req.session.player_id]);
    await pool.query(`UPDATE mg_monsters SET slot=$1 WHERE id=$2 AND owner_id=$3`, [a.slot|0, b.id, req.session.player_id]);
    await pool.query('COMMIT');
    

    const updated = await getParty(req.session.player_id);

    // Invalidate any cached battle for this session so next start is fresh
    if (battles.has(req.session.token)) battles.delete(req.session.token);
    
    res.json({ ok:true, party: updated });
  }catch(e){
    try{ await pool.query('ROLLBACK'); }catch(_){}
    res.status(500).json({ error:'server_error' });
  }
});

// update a specific move's stack/bonuses for one monster
app.post('/api/monster/move', auth, async (req,res)=>{
  try{
    const { id, index, stack, bonuses } = req.body || {};
    const monId = id|0, idx = index|0;

    const { rows } = await pool.query(
      `SELECT id, owner_id, moves FROM mg_monsters WHERE id=$1 AND owner_id=$2 LIMIT 1`,
      [monId, req.session.player_id]
    );
    if (!rows.length) return res.status(404).json({ error:'not_found' });

    const moves = Array.isArray(rows[0].moves) ? rows[0].moves : [];
    if (idx < 0 || idx >= moves.length) return res.status(400).json({ error:'bad_index' });

    // --- Validate & sanitize against CSV content
    const result = validateAndSanitizeStack(stack, bonuses);
    if (!result.ok){
      return res.status(400).json({ error: result.error, message: result.message });
    }

    const newStack   = result.stack;
    const newBonuses = result.bonuses;

    // Recompute MAX PP from base effect (from CSV; fallback to prior or 20)
    const prior = moves[idx] || {};
    const newPP = computePPFromBaseEffect(newStack, (prior.pp|0) || 20);

    // --- Ensure DB-stored move name for this exact combo
    const ensuredName = await ensureMoveRecord(newStack, newBonuses);

    // Merge into move object (overwrite name with canonical)
    moves[idx] = { ...prior, name: ensuredName, stack:newStack, bonuses:newBonuses, pp:newPP };

    // Clamp CURRENT PP (do not refill here; refill happens on heal)
    const { rows: curRows } = await pool.query(
      `SELECT current_pp FROM mg_monsters WHERE id=$1 AND owner_id=$2 LIMIT 1`,
      [monId, req.session.player_id]
    );
    let curMap = curRows[0]?.current_pp;
    if (typeof curMap !== 'object' || curMap === null) curMap = {};
    const mvName = String(moves[idx]?.name || '');
    if (mvName){
      const cur = (curMap[mvName]|0) || 0;
      if (cur > newPP) curMap[mvName] = newPP; // clamp down if needed
    }

    await pool.query(
      `UPDATE mg_monsters SET moves=$1, current_pp=$2 WHERE id=$3 AND owner_id=$4`,
      [JSON.stringify(moves), curMap, monId, req.session.player_id]
    );

    res.json({ ok:true, moves, sanitized:true });

  }catch(e){
    console.error('monster/move error:', e);
    res.status(500).json({ error:'server_error' });
  }
});


async function doHeal(owner_id){
  await pool.query(`UPDATE mg_monsters SET hp = max_hp WHERE owner_id=$1`, [owner_id]);
  await pool.query(`UPDATE mg_monsters SET current_pp = NULL WHERE owner_id=$1`, [owner_id]);

  const party = await getParty(owner_id);
  return { ok:true, party };
}
app.post('/api/heal', auth, async (req,res)=>{ try{ res.json(await doHeal(req.session.player_id)); }catch(e){ res.status(500).json({ error:'server_error' }); }});
app.get('/api/heal',  auth, async (req,res)=>{ try{ res.json(await doHeal(req.session.player_id)); }catch(e){ res.status(500).json({ error:'server_error' }); }});

app.post('/api/monster/nickname', auth, async (req,res)=>{
  try{
    const id = req.body?.id|0;
    const nickname = String(req.body?.nickname||'').slice(0,24);
    if (!id) return res.status(400).json({ error:'bad_id' });
    await pool.query(`UPDATE mg_monsters SET nickname=$1 WHERE id=$2 AND owner_id=$3`, [nickname, id, req.session.player_id]);
    const party = await getParty(req.session.player_id);
    res.json({ ok:true, party });
  }catch(e){ res.status(500).json({ error:'server_error' }); }
});

// release a monster (out of battle only)
app.post('/api/monster/release', auth, async (req,res)=>{
  try{
    // 1) forbid in-battle releases
    if (battles.has(req.session.token)){
      return res.status(409).json({ error:'in_battle' });
    }

    const monId = req.body?.id|0;
    if (!monId) return res.status(400).json({ error:'bad_id' });

    // 2) verify ownership
    const { rows } = await pool.query(
      `SELECT id FROM mg_monsters WHERE id=$1 AND owner_id=$2 LIMIT 1`,
      [monId, req.session.player_id]
    );
    if (!rows.length) return res.status(404).json({ error:'not_found' });

    // 3) delete the monster
    await pool.query(`DELETE FROM mg_monsters WHERE id=$1 AND owner_id=$2`, [monId, req.session.player_id]);

    // 4) compact remaining slots 1..N for this owner (stable order by slot, id)
    await pool.query(`
      WITH ordered AS (
        SELECT id,
               ROW_NUMBER() OVER (PARTITION BY owner_id ORDER BY slot NULLS LAST, id) AS rn
        FROM mg_monsters
        WHERE owner_id = $1
      )
      UPDATE mg_monsters m
         SET slot = o.rn
        FROM ordered o
       WHERE m.id = o.id
    `, [req.session.player_id]);

    // 5) return updated party
    const updated = await getParty(req.session.player_id);
    return res.json({ ok:true, party: updated });
  }catch(e){
    console.error('release error:', e);
    return res.status(500).json({ error:'server_error' });
  }
});

/* ---------- species & chunk ---------- */
app.get('/api/species', async (_req,res)=>{
  try{
    const { rows } = await pool.query(`
      SELECT id,
             name,
             base_spawn_rate,
             biomes,
             types,
             base_hp,
             base_phy,
             base_mag,
             base_def,
             base_res,
             base_spd,
             base_acc,
             base_eva
        FROM mg_species
    ORDER BY id ASC`);
    res.json({ species: rows });
  }catch(e){
    res.status(500).json({ error:'server_error' });
  }
});

/* ---------- content (effects/bonuses/moves) ---------- */
app.get('/api/content/pool', auth, (req, res) => {
  const c = OVERRIDE_CONTENT || getContent();
  return res.json(c?.pool || { effects:[], bonuses:[] });
});

app.get('/api/content/effects', auth, (req, res) => {
  const c = OVERRIDE_CONTENT || getContent();
  return res.json({ effects: c?.effects || [], version: c?.version || 0 });
});

app.get('/api/content/bonuses', auth, (req, res) => {
  const c = OVERRIDE_CONTENT || getContent();
  return res.json({ bonuses: c?.bonuses || [], version: c?.version || 0 });
});

app.get('/api/content/abilities', auth, (req, res) => {
  const c = OVERRIDE_CONTENT || getContent();
  return res.json({ abilities: c?.abilities || [], version: c?.version || 0 });
});

app.get('/api/content/moves', auth, (req, res) => {
  const c = OVERRIDE_CONTENT || getContent();
  return res.json({ moves: c?.moves || [], version: c?.version || 0 });
});


// Optional: quick admin-only reload (temporary guard: player_id === 1)
app.post('/api/admin/content/reload', auth, (req, res) => {
  if (req.session?.player_id !== 1) return res.status(403).json({ error:'forbidden' });
  const c = reloadContent();
  return res.json({ ok:true, version: c?.version || 0 });
});

// Admin: import CSVs from a base URL (HTTPS). Requires player_id === 1 (same temporary guard)
app.post('/api/admin/content/import', auth, async (req,res)=>{
  if (req.session?.player_id !== 1) return res.status(403).json({ error:'forbidden' });

  try{
    const base = String(req.body?.base_url||'').trim();
    if (!base || !(base.startsWith('https://') || base.startsWith('http://'))){
      return res.status(400).json({ error:'bad_url', message:'Provide a full HTTP(S) base URL (e.g., https://example.com/content/).' });
    }
    const join = (p)=> base.endsWith('/') ? base + p : base + '/' + p;

    // 1) Fetch CSV files as text
    const [speciesTxt, effectsTxt, bonusesTxt, abilitiesTxt, movesTxt] = await Promise.all([
      httpGetText(join('species.csv')),
      httpGetText(join('effects.csv')),
      httpGetText(join('bonuses.csv')),
      httpGetText(join('abilities.csv')),
      httpGetText(join('moves.csv')),
    ]);

    // 2) Parse
    const speciesRows = parseCSV(speciesTxt);
    const effectsRows = parseCSV(effectsTxt);
    const bonusesRows = parseCSV(bonusesTxt);
    const abilitiesRows = parseCSV(abilitiesTxt);
    const movesRows = parseCSV(movesTxt);

    // 3) Upsert species into DB (same as before)
    const ensure = (o,k,def)=> (o[k]==null || String(o[k]).trim()==='') ? (o[k]=def) : o[k];
    await pool.query('BEGIN');
    for (const r of speciesRows){
      const id               = intOr(0, r.id);
      const name             = String(r.name||'').trim();
      const base_spawn_rate  = numOr(0.05, r.base_spawn_rate);
      const biomes           = toTextArrayCell(r.biomes);
      const types            = toTextArrayCell(r.types);
      ensure(r,'base_hp',40); ensure(r,'base_phy',10); ensure(r,'base_mag',10);
      ensure(r,'base_def',10); ensure(r,'base_res',10); ensure(r,'base_spd',10);
      ensure(r,'base_acc',95); ensure(r,'base_eva',5);

      if (!id || !name) continue;

      await pool.query(`
        INSERT INTO mg_species (id,name,base_spawn_rate,biomes,types,base_hp,base_phy,base_mag,base_def,base_res,base_spd,base_acc,base_eva)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (id) DO UPDATE SET
          name=$2, base_spawn_rate=$3, biomes=$4, types=$5,
          base_hp=$6, base_phy=$7, base_mag=$8, base_def=$9, base_res=$10, base_spd=$11, base_acc=$12, base_eva=$13
      `, [
        id, name, base_spawn_rate, biomes, types,
        intOr(40, r.base_hp), intOr(10, r.base_phy), intOr(10, r.base_mag),
        intOr(10, r.base_def), intOr(10, r.base_res), intOr(10, r.base_spd),
        intOr(95, r.base_acc), intOr(5, r.base_eva)
      ]);
    }
    await pool.query('COMMIT');

    // 4) Build in-memory content override from effects/bonuses/abilities/moves
    const normEffects = effectsRows.map(row=>{
      const code = String(row.code||'').trim();
      return {
        ...row,
        code,
        accuracy: (row.accuracy!==undefined && row.accuracy!=='') ? Number(row.accuracy) : undefined,
        base_pp:  (row.base_pp!==undefined  && row.base_pp!=='')  ? Number(row.base_pp)  : undefined,
        base_flag_eligible: (row.base_flag_eligible!==undefined ? row.base_flag_eligible : row.base),
        base: row.base
      };
    }).filter(r=>r.code);

    const normBonuses = bonusesRows.map(row=>{
      const code = String(row.code||'').trim();
      return { ...row, code };
    }).filter(r=>r.code);

    const normAbilities = abilitiesRows.map(row=>{
      const code = String(row.code||'').trim();
      const name = String(row.name||'').trim();
      const field_effect = String(row.field_effect||'').trim();
      const stack_effects = toTextArrayCell(row.stack_effects);
      const stack_bonuses = toTextArrayCell(row.stack_bonuses);
      return { ...row, code, name, field_effect, stack_effects, stack_bonuses };
    }).filter(r=>r.code);

    const normMoves = movesRows.map(row=>{
      // every row is a stack recipe; name may be empty (we can still carry it for editors)
      const name = String(row.name||'').trim();
      const stack_effects = toTextArrayCell(row.stack_effects);
      const stack_bonuses = toTextArrayCell(row.stack_bonuses);
      return { ...row, name, stack_effects, stack_bonuses };
    });

    const poolEffects = normEffects.map(e=>e.code);
    const poolBonuses = normBonuses.map(b=>b.code);

    OVERRIDE_CONTENT = {
      effects: normEffects,
      bonuses: normBonuses,
      abilities: normAbilities,
      moves: normMoves,              // edited/testing list (not the DB registry)
      pool: { effects: poolEffects, bonuses: poolBonuses },
      version: Date.now()
    };

    return res.json({ ok:true, imported:{
      species: speciesRows.length,
      effects: normEffects.length,
      bonuses: normBonuses.length,
      abilities: normAbilities.length,
      moves: normMoves.length
    }});
  }catch(e){
    try{ await pool.query('ROLLBACK'); }catch(_){}
    console.error('import error:', e);
    return res.status(500).json({ error:'server_error', message:String(e.message||e) });
  }
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
function aliveIndices(party){
  const out=[]; for (let i=0;i<party.length;i++) if ((party[i].hp|0)>0) out.push(i);
  return out;
}

// --- Damage helpers (PHY/MAG vs DEF/RES) ---
function moveKind(move){
  const base = (move?.base||'').toLowerCase();
  const stack = Array.isArray(move?.stack) ? move.stack.map(s=>String(s).toLowerCase()) : [];
  if (base === 'status') return 'status';
  if (base === 'physical' || stack.includes('dmg_phys')) return 'physical';
  if (base === 'special'  || stack.includes('dmg_spec')) return 'special';
  // default to physical if unspecified
  return 'physical';
}

async function getMonDerivedStats(mon){
  // mon must have species_id, level, growth
  const srow = await getSpeciesRow(mon.species_id);
  if (!srow) return null;
  return deriveStats(srow, mon.growth || {}, mon.level|0);
}

async function getEnemyDerivedStats(enemy){
  // wild enemies use neutral growth (1.0 multipliers)
  const srow = await getSpeciesRow(enemy.speciesId);
  if (!srow) return null;
  const neutral = { HP:1, PHY:1, MAG:1, DEF:1, RES:1, SPD:1, ACC:1, EVA:1 };
  return deriveStats(srow, neutral, enemy.level|0);
}

async function calcDamage(attackerStats, defenderStats, move, attackerLevel){
  const kind = moveKind(move);
  if (kind === 'status') return 0;

  const atk = kind === 'physical' ? (attackerStats?.PHY||10) : (attackerStats?.MAG||10);
  const def = kind === 'physical' ? (defenderStats?.DEF||10) : (defenderStats?.RES||10);
  const power = Math.max(1, (move.power|0) || 1);

  // Simple but expressive curve: scales with move power, level, and stat ratio
  const levelFactor = 0.6 + (Math.max(1, attackerLevel|0) * 0.08); // L1=0.68 … L10≈1.4 … L30≈3.0
  const ratio = Math.max(0.25, Math.min(2.5, (atk / Math.max(1, def)))); // clamp extremes
  const raw = power * levelFactor * ratio;

  return Math.max(1, Math.round(raw));
}


function xpNeeded(level){
  return 20 + (level | 0) * (level | 0) * 10;
}

async function awardXP(ownerId, mon, enemyLevel){
  const gain = Math.max(5, Math.round(10 + (enemyLevel | 0) * 4));
  let xp = (mon.xp | 0) + gain;
  let level = mon.level | 0;
  let hp = mon.hp | 0;
  let max_hp = mon.max_hp | 0;
  const msgs = [];

  const srow = await getSpeciesRow(mon.species_id);
  const growth = mon.growth || {};

  // Load current learn state
  let { learned, list } = await loadLearnState(mon.id);

  // Level-up loop
  while (xp >= xpNeeded(level)){
    xp -= xpNeeded(level);
    level += 1;

    // Recompute derived to update HP progression
    const derived = srow ? deriveStats(srow, growth, level) : { HP: max_hp + 4 };
    const oldMax = max_hp;
    max_hp = Math.max(1, derived.HP | 0);
    const delta = Math.max(0, max_hp - oldMax);
    hp = Math.min(max_hp, hp + Math.max(2, Math.ceil(delta * 0.5)));

    const nm = await monName(mon);
    msgs.push(`${nm} grew to Lv${level}!`);

    // On each level-up: roll for entries in learn_list
    const beforeEffects = learned.effects.length;
    const beforeBonuses = learned.bonuses.length;

    const rolled = applyLevelUpLearning(learned, list);
    learned = rolled.learned;
    list = rolled.list;

    // Announce anything gained
    const newEffects = (learned.effects.length - beforeEffects);
    const newBonuses = (learned.bonuses.length - beforeBonuses);

    if (newEffects > 0){
      const justGained = rolled.gained.effects;
      justGained.forEach(n => msgs.push(`Learned effect: ${n}`));
    }
    if (newBonuses > 0){
      const justGained = rolled.gained.bonuses;
      justGained.forEach(n => msgs.push(`Learned bonus: ${n}`));
    }
  }

  // Persist stats and learning state
  await pool.query(
    `UPDATE mg_monsters
        SET xp=$1, level=$2, hp=$3, max_hp=$4, learned_pool=$5, learn_list=$6
      WHERE id=$7 AND owner_id=$8`,
    [xp, level, hp, max_hp, learned, list, mon.id, ownerId]
  );

  const { rows } = await pool.query(
    `SELECT id,species_id,nickname,level,xp,hp,max_hp,ability,moves,growth
       FROM mg_monsters
      WHERE id=$1 AND owner_id=$2`,
    [mon.id, ownerId]
  );
  return { updated: rows[0], gain, msgs };
}

function makePPMap(moves){
  const map={}; (moves||[]).slice(0,4).forEach(m=>{ map[m.name]= (m.pp|0) || 20; }); return map;
}

async function buildEnemyFromTile(tile){
  // pick a random species weighted by base_spawn_rate
  const { rows } = await pool.query(`SELECT id,name,base_spawn_rate FROM mg_species ORDER BY id ASC`);
  if (!rows.length){
    return {
      speciesId: 1, name: 'Fieldling', level: 3,
      hp: 20, max_hp: 20,
      moves: [{ name:'Strike', base:'physical', power:8, accuracy:0.95, pp:25, stack:['dmg_phys'], bonuses:[] }]
    };
  }

  const w = rows.map(r=>Math.max(0.01, Number(r.base_spawn_rate)||0.05));
  const sum = w.reduce((a,b)=>a+b,0);
  let t=Math.random()*sum, pick=rows[0];
  for(let i=0;i<w.length;i++){ if ((t-=w[i])<=0){ pick = rows[i]; break; } }

  const level = 2 + Math.floor(Math.random()*3);
  const hp = 16 + level*4;

  // --- Build a tiny stacked move from content (base + maybe 1 extra effect + maybe 1 bonus)
  const c = getContent() || {};
  const effects = Array.isArray(c.effects) ? c.effects : [];
  const bonuses = Array.isArray(c.bonuses) ? c.bonuses : [];
  const baseEligible = effects.filter(e=>{
    const v = String(e.base_flag_eligible ?? e.base ?? e.is_base ?? '').toLowerCase();
    return v==='1' || v==='true' || v==='yes';
  }).map(e=>String(e.code||'').trim()).filter(Boolean);

  // Fallbacks if content is empty
  const base = baseEligible[0] || 'dmg_phys';

  // 50% chance add an extra non-base effect if available
  const extraEffects = effects.map(e=>String(e.code||'').trim())
    .filter(code => code && code !== base);
  const maybeExtra = (extraEffects.length>0 && Math.random()<0.5) ? [ extraEffects[Math.floor(Math.random()*extraEffects.length)] ] : [];

  // 50% chance add a bonus
  const bonusCodes = bonuses.map(b=>String(b.code||'').trim()).filter(Boolean);
  const maybeBonus = (bonusCodes.length>0 && Math.random()<0.5) ? [ bonusCodes[Math.floor(Math.random()*bonusCodes.length)] ] : [];

  // Validate & sanitize via the helper we added earlier
  const v = validateAndSanitizeStack([base, ...maybeExtra], maybeBonus);
  const stack = v.ok ? v.stack : [base];
  const bonz  = v.ok ? v.bonuses : [];

  // Compute PP from base effect (CSV), keep simple power/accuracy for now
  const pp = computePPFromBaseEffect(stack, 25);
  const wildMove = {
    name: 'Strike',
    base: (stack[0]==='dmg_spec' ? 'special' : (stack[0]==='buff_def' ? 'status' : 'physical')),
    power: 8, accuracy: 0.95, pp,
    stack, bonuses: bonz
  };


  return {
    speciesId: pick.id, name: pick.name, level,
    hp, max_hp: hp,
    moves: [ wildMove ]
  };
}


app.post('/api/battle/start', auth, async (req,res)=>{
  try{
    // If a battle already exists for this session, return it instead of creating a new one.
    //const existing = battles.get(req.session.token);
    //if (existing){
    //  return res.json({
    //    you: existing.you,
    //    enemy: existing.enemy,
    //    youIndex: existing.youIndex|0,
    //    pp: existing.pp || {},
    //    log: existing.log || [],
    //    allowCapture: !!existing.allowCapture,
    //    requireSwitch: !!existing.requireSwitch
    //  });
    //}
    // Instead, proactively discard any old battle:
    if (battles.has(req.session.token)) battles.delete(req.session.token);
    
    const party = await getParty(req.session.player_id);
    const idx = firstAliveIndex(party);
    if (idx<0) return res.status(409).json({ error:'you_fainted' });

    const st = await getState(req.session.player_id);
    const tile = (getWorldChunk(st.cx, st.cy)?.tiles?.[st.ty]||[])[st.tx];

    const enemy = await buildEnemyFromTile(tile);
    const you = { ...party[idx] };
    const pp = await getCurrentPP(you);

    const battle = {
      you, enemy, youIndex: idx, pp,
      log:[`A wild ${enemy.name} appears!`],
      allowCapture:false, owner_id:req.session.player_id,
      requireSwitch:false
    };
    battles.set(req.session.token, battle);

    res.json({
      you, enemy, youIndex: idx, pp,
      log: battle.log, allowCapture: false, requireSwitch:false
    });
  }catch(e){ res.status(500).json({ error:'server_error' }); }
});


app.post('/api/battle/turn', auth, async (req,res)=>{
  try{
    const b = battles.get(req.session.token);
    if (!b) return res.status(404).json({ error:'no_battle' });
    const action = (req.body?.action||'').toLowerCase();

    // If your active fainted this round, you must switch before doing anything else
    if (b.requireSwitch && action !== 'switch'){
      return res.status(409).json({ error:'must_switch' });
    }

    // refresh party entry used for "you" (HP may change between turns due to heal, etc.)
    const party = await getParty(req.session.player_id);
    let you = party[b.youIndex] || party[firstAliveIndex(party)];
    if (!you) return res.status(409).json({ error:'you_team_wiped' });
    b.you = you; // keep latest

    if (b.allowCapture) return res.status(409).json({ error:'capture_or_finish' });

    if (action === 'switch'){
      const party = await getParty(req.session.player_id);
      const targetIdx = Math.max(0, Math.min((req.body.index|0), party.length-1));
      if (!party[targetIdx]) return res.status(400).json({ error:'bad_index' });
      if ((party[targetIdx].hp|0) <= 0) return res.status(400).json({ error:'target_fainted' });
    
      // If we are in a forced switch phase, switching does NOT consume a turn and the enemy does NOT act again.
      if (b.requireSwitch){
        b.youIndex = targetIdx;
        b.you = party[targetIdx];
        b.pp = await getCurrentPP(b.you);
        b.requireSwitch = false;
        b.log.push(`You sent out ${await monName(b.you)}.`);
        return res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:false, requireSwitch:false });
      }
    
      // Normal (non-forced) switch still consumes your turn; enemy may act (as before)
      const curIdx = b.youIndex|0;
      const eMove = (Array.isArray(b.enemy.moves) && b.enemy.moves[0]) ||
                    { name:'Strike', base:'physical', power:8, accuracy:0.95, pp:25, priority:0 };
      const ePri  = (eMove.priority|0) || 0;
    
      if (ePri > 0){
        if (Math.random() < (eMove.accuracy ?? 1.0)){
          const defStats = await getMonDerivedStats(party[curIdx]);
          const atkStats = await getEnemyDerivedStats(b.enemy);
          const edmg = await calcDamage(atkStats, defStats, eMove, b.enemy.level|0);
      
          const newHp = Math.max(0, (party[curIdx].hp|0) - edmg);
          await pool.query(`UPDATE mg_monsters SET hp=$1 WHERE id=$2 AND owner_id=$3`, [newHp, party[curIdx].id, req.session.player_id]);
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
    
      b.youIndex = targetIdx;
      b.you = party[targetIdx];
      b.pp = await getCurrentPP(b.you);
      b.log.push(`You switched to ${await monName(b.you)}.`);
    
      if (ePri === 0){
        if (Math.random() < (eMove.accuracy ?? 1.0)){
          const defStats = await getMonDerivedStats(b.you);
          const atkStats = await getEnemyDerivedStats(b.enemy);
          const edmg = await calcDamage(atkStats, defStats, eMove, b.enemy.level|0);

          const newHp = Math.max(0, (b.you.hp|0) - edmg);
          await pool.query(`UPDATE mg_monsters SET hp=$1 WHERE id=$2 AND owner_id=$3`, [newHp, b.you.id, req.session.player_id]);
          b.you.hp = newHp;
          b.log.push(`${b.enemy.name} strikes for ${edmg}!`);
        } else {
          b.log.push(`${b.enemy.name} missed!`);
        }
    
        const refreshed = await getParty(req.session.player_id);
        const idxAlive = firstAliveIndex(refreshed);
        if ((b.you.hp|0) <= 0){
          const alives = aliveIndices(refreshed);
          if (alives.length > 0){
            if (alives.length === 1){
              b.youIndex = alives[0]; b.you = refreshed[alives[0]];
              b.pp = await getCurrentPP(b.you);
              b.log.push(`${await monName(refreshed[curIdx])} fainted! ${await monName(b.you)} steps in.`);
            } else {
              // forced switch next round start
              b.requireSwitch = true;
              b.log.push(`Your monster fainted! Choose a replacement.`);
              return res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:false, requireSwitch:true });
            }
          } else {
            battles.delete(req.session.token);
            return res.json({ log:b.log, result:'you_team_wiped' });
          }
        }
      }
    
      return res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:false, requireSwitch:false });
    } else if (action === 'run'){
      b.log.push(`You ran away.`);
      battles.delete(req.session.token);
      return res.json({ log:b.log, result:'escaped' });
    } else if (action === 'move'){
      const moveName = String(req.body.move||'').trim();
      const yourMove = (Array.isArray(b.you.moves)?b.you.moves:[]).find(m=>(m.name||'')===moveName) ||
                       { name:'Strike', base:'physical', power:8, accuracy:0.95, pp:25 };
      if (!b.pp) b.pp = await getCurrentPP(b.you);
    
      if (b.pp[yourMove.name] == null) b.pp[yourMove.name] = (yourMove.pp|0)||20;
      if (b.pp[yourMove.name] <= 0) return res.status(400).json({ error:'no_pp' });
    
      // --- Enemy priority check (enemy can act BEFORE you) ---
      const eMove = (Array.isArray(b.enemy.moves) && b.enemy.moves[0]) ||
                    { name:'Strike', base:'physical', power:8, accuracy:0.95, pp:25, priority:0 };
      const ePri  = (eMove.priority|0) || 0;
    
      if (ePri > 0){
        if (Math.random() < (eMove.accuracy ?? 1.0)){
          const defStats = await getMonDerivedStats(b.you);
          const atkStats = await getEnemyDerivedStats(b.enemy);
          const edmg = await calcDamage(atkStats, defStats, eMove, b.enemy.level|0);

          const newHp = Math.max(0, (b.you.hp|0) - edmg);
          await pool.query(`UPDATE mg_monsters SET hp=$1 WHERE id=$2 AND owner_id=$3`, [newHp, b.you.id, req.session.player_id]);
          b.you.hp = newHp;
          b.log.push(`${b.enemy.name} (priority) hits for ${edmg}!`);
        } else {
          b.log.push(`${b.enemy.name} (priority) missed!`);
        }
    
        // If you fainted from priority hit → auto-sub and CANCEL your queued move
        const refreshedP = await getParty(req.session.player_id);
        const alivesP = aliveIndices(refreshedP);
        if ((b.you.hp|0) <= 0){
          if (alivesP.length === 0){
            battles.delete(req.session.token);
            return res.json({ log:b.log, result:'you_team_wiped' });
          }
          if (alivesP.length === 1){
            // Auto-sub the only survivor; CANCEL your queued move; round ends here
            const prevName = await monName(b.you);
            b.youIndex = alivesP[0];
            b.you = refreshedP[alivesP[0]];
            b.pp = await getCurrentPP(b.you);
            b.log.push(`${prevName} fainted! ${await monName(b.you)} steps in.`);
            return res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:false, requireSwitch:false });
          }
          // Multiple choices → force switch; CANCEL your queued move; round ends here
          b.requireSwitch = true;
          b.log.push(`Your monster fainted! Choose a replacement.`);
          return res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:false, requireSwitch:true });
        }
      }
    
      // --- Your move (only if you're still alive here) ---
      if ((b.pp[yourMove.name] | 0) <= 0){
        return res.status(400).json({ error:'no_pp' });
      }


      // Resolve each effect in order; stop early if enemy faints
      const stackList = Array.isArray(yourMove.stack) ? yourMove.stack.map(String) : [];
      if (stackList.length === 0){
        // Fallback to legacy single roll if no stack present
        if (Math.random() < (yourMove.accuracy ?? 1.0)){
          const atkStats = await getMonDerivedStats(b.you);
          const defStats = await getEnemyDerivedStats(b.enemy);
          const dmg = await calcDamage(atkStats, defStats, yourMove, b.you.level|0);
          b.enemy.hp = Math.max(0, (b.enemy.hp|0) - dmg);
          b.log.push(`${yourMove.name} hits for ${dmg}!`);
        } else {
          b.log.push(`${yourMove.name} missed!`);
        }
      } else {
        for (const effectCode of stackList){
          const out = await resolveSingleEffect(effectCode, yourMove, b.you, b.enemy, b);
          // If the enemy fainted at any point, stop further effects
          if ((b.enemy.hp|0) <= 0) break;
        }
      }

      // Consume PP: one per use (we’ll add PP-modifying bonuses later)
      b.pp[yourMove.name] = Math.max(0, (b.pp[yourMove.name]|0) - 1);
      await setCurrentPP(b.you.id, req.session.player_id, b.pp);

      // enemy KO check
      if ((b.enemy.hp|0) <= 0){
        b.log.push(`${b.enemy.name} fainted!`);

        // 1) Add enemy move traits to your learn_list (+1% each)
        try{
          await recordEncounteredTraits(req.session.player_id, b.you.id, b.enemy.moves || []);
        }catch(_){ /* non-fatal */ }

        // 2) Award XP (this may trigger level-up learning rolls)
        try{
          const { updated, gain, msgs } = await awardXP(req.session.player_id, b.you, b.enemy.level|0);
          b.you = updated;
          const nm = await monName(updated);
          b.log.push(`${nm} gained ${gain} XP!`);
          msgs.forEach(m => b.log.push(m));
        }catch(_){ /* non-fatal */ }

        b.allowCapture = true; // only now can capture
        return res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:true });
      }

      // --- Enemy acts AFTER you when no priority ---
      if (ePri === 0){
        if (Math.random() < (eMove.accuracy ?? 1.0)){
          const defStats = await getMonDerivedStats(b.you);
          const atkStats = await getEnemyDerivedStats(b.enemy);
          const edmg = await calcDamage(atkStats, defStats, eMove, b.enemy.level|0);

          const newHp = Math.max(0, (b.you.hp|0) - edmg);
          await pool.query(`UPDATE mg_monsters SET hp=$1 WHERE id=$2 AND owner_id=$3`, [newHp, b.you.id, req.session.player_id]);
          b.you.hp = newHp;
          b.log.push(`${b.enemy.name} strikes back for ${edmg}!`);
        } else {
          b.log.push(`${b.enemy.name} missed!`);
        }
    
        // You KO check → auto-sub or wipe
        const refreshed = await getParty(req.session.player_id);
        const alives = aliveIndices(refreshed);
        if ((b.you.hp|0) <= 0){
          if (alives.length === 0){
            battles.delete(req.session.token);
            return res.json({ log:b.log, result:'you_team_wiped' });
          }
          if (alives.length === 1){
            const prevName = await monName(b.you);
            b.youIndex = alives[0];
            b.you = refreshed[alives[0]];
            b.pp = await getCurrentPP(b.you);
            b.log.push(`${prevName} fainted! ${await monName(b.you)} steps in.`);
            return res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:false, requireSwitch:false });
          }
          b.requireSwitch = true;
          b.log.push(`Your monster fainted! Choose a replacement.`);
          return res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:false, requireSwitch:true });
        }
      }
    
      return res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:false });
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

    // Placeholder capture odds (we'll swap to the spec formula later)
    const success = Math.random() < 0.6;
    if (!success){
      b.log.push('Capture failed.');
      return res.json({ result:'failed', log:b.log, allowCapture:true });
    }

    // Preserve the enemy's stacked move(s) if present
    const moves = Array.isArray(b.enemy.moves) && b.enemy.moves.length
      ? b.enemy.moves
      : [{ name:'Strike', base:'physical', power:8, accuracy:0.95, pp:25, stack:['dmg_phys'], bonuses:[] }];

    // Compute growth and derived HP for the captured species/level
    const capSpeciesId = b.enemy.speciesId|0;
    const capLevel     = b.enemy.level|0;
    const capSrow      = await getSpeciesRow(capSpeciesId);
    const capGrowth    = randomGrowth();
    const capDerived   = capSrow ? deriveStats(capSrow, capGrowth, capLevel)
                                 : { HP: Math.max(12, b.enemy.max_hp|0) };

    await pool.query(`
      INSERT INTO mg_monsters (owner_id,species_id,level,xp,hp,max_hp,ability,moves,growth)
      VALUES ($1,$2,$3,0,$4,$4,'wild',$5,$6)
    `, [
      req.session.player_id,
      capSpeciesId,
      capLevel,
      Math.max(1, capDerived.HP|0),
      JSON.stringify(moves),
      JSON.stringify(capGrowth)
    ]);

    b.log.push(`Captured ${b.enemy.name}!`);
    battles.delete(req.session.token);
    return res.json({ result:'captured', log:b.log });
  }catch(e){
    console.error('capture error:', e);
    return res.status(500).json({ error:'server_error' });
  }
});


app.post('/api/battle/finish', auth, async (req,res)=>{
  try{
    // Clear any existing battle for this session
    if (battles.has(req.session.token)) battles.delete(req.session.token);
    return res.json({ ok:true });
  }catch(e){
    return res.status(500).json({ error:'server_error' });
  }
});

/* ---------- server / ws ---------- */
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
wss.on('connection', ws => { ws.isAlive = true; ws.on('pong', ()=>ws.isAlive = true); });
setInterval(()=>{ wss.clients.forEach(ws=>{ if (!ws.isAlive) return ws.terminate(); ws.isAlive=false; ws.ping(); }); }, 30000);

server.listen(PORT, ()=>console.log('Monster game server listening on :' + PORT));
