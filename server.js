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
  const c = (OVERRIDE_CONTENT || getContent() || {});
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

async function validateAndSanitizeStack(inputStack, inputBonuses){
  console.log("validate stack");
  console.log("inputStack");
  console.log(inputStack);
  console.log("inputBonuses");
  console.log(inputBonuses);
  
  //const { effByCode, bonByCode, isBaseEffect } = _contentIndex();
  const { rows: effByCode } = await pool.query(
    `SELECT code, base_flag_eligible FROM mg_effects`,
    []
  );
  console.log("effByCode");
  console.log(effByCode);

  const { rows: bonByCode } = await pool.query(
    `SELECT code FROM mg_bonuses`,
    []
  );
  console.log("bonByCode");
  console.log(bonByCode);
  // console.log("isBaseEffect");
  // console.log(isBaseEffect);

  const rawStack = Array.isArray(inputStack) ? inputStack.map(x => String(x).trim()) : [];
  
  console.log("rawStack");
  console.log(rawStack);
  
  const rawBonus = Array.isArray(inputBonuses) ? inputBonuses.map(x => String(x).trim()) : [];

  console.log("rawBonus");
  console.log(rawBonus);

  // Keep only codes that exist in the CSV-driven pool
  //const stack = rawStack.filter(code => !!effByCode[code]);
  const stack = rawStack.filter(code =>
    effByCode.some(e => e.code === code)
  );
  console.log("stack");
  console.log(stack);

  const bonuses = rawBonus.filter(code => !!bonByCode[code]);
  console.log("bonuses");
  console.log(bonuses);


  // Enforce exactly one base effect
  //const baseCodes = stack.filter(code => isBaseEffect(effByCode[code]));
  const baseCodes = stack.filter(code =>
    effByCode.some(e => e.code === code && e.base_flag_eligible)
  );

  console.log("baseCodes");
  console.log(baseCodes);

  if (baseCodes.length != 1){
    return { ok:false, error:'not one base effect', message:'Your stack must include exactly one base-eligible effect (see mg_effects.base_flag_eligible).' };
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
  const c = (OVERRIDE_CONTENT || getContent() || {});
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

// Ensure there is a row in mg_moves_named for this exact combo; return {id,name}
async function ensureMoveRecord(stack, bonuses){
  const rec = await resolveMoveNameAndPersist(stack, bonuses);
  return { id: rec.id|0, name: String(rec.name||'') };
}


async function getMaxPPForStack(stack, fallbackPP=20){
  const baseCode = Array.isArray(stack) ? String(stack[0]||'').trim() : '';
  if (!baseCode) return fallbackPP|0;
  const { rows } = await pool.query(`SELECT base_pp FROM mg_effects WHERE code=$1 LIMIT 1`, [baseCode]);
  const pp = rows[0]?.base_pp;
  return (pp != null && !Number.isNaN(+pp) && +pp>0) ? (+pp|0) : (fallbackPP|0);
}

//async function getMoveDetailsById(moveId){
//  const { rows } = await pool.query(`SELECT id, name, stack, bonuses FROM mg_moves WHERE id=$1 LIMIT 1`, [moveId|0]);
//  if (!rows.length) return null;
//  return { id: rows[0].id|0, name: String(rows[0].name||''), stack: rows[0].stack||[], bonuses: rows[0].bonuses||[] };
//}

async function getMoveDetailsById(moveId){
  const { rows } = await pool.query(
    `SELECT id, name, stack_effects, stack_bonuses
       FROM mg_moves_named
      WHERE id=$1
      LIMIT 1`,
    [moveId|0]
  );
  if (!rows.length) return null;
  return {
    id: rows[0].id|0,
    name: String(rows[0].name||''),
    stack: Array.isArray(rows[0].stack_effects) ? rows[0].stack_effects : [],
    bonuses: Array.isArray(rows[0].stack_bonuses) ? rows[0].stack_bonuses : []
  };
}

async function syncMonsterLearnedFromMoves(monId){
  console.log("syncMonsterLearnedFromMoves");
  if (!monId) return;
  console.log(monId);

  const { rows: partyRows } = await pool.query(`SELECT id, learned_pool, learn_list, moves FROM mg_monsters WHERE id=$1 LIMIT 1`, [monId]);
  console.log("rows");
  console.log(partyRows);
  
  if (!partyRows.length) return;
  console.log("mon");
  const mon = partyRows?.[0] || null;
  
  console.log(mon);

  let learnedPool = {};
  let learnList = {};
  try{ learnedPool = mon.learned_pool && typeof mon.learned_pool === 'object' ? mon.learned_pool : JSON.parse(mon.learned_pool||'{}'); }catch{ learnedPool={}; }
  try{ learnList = mon.learn_list   && typeof mon.learn_list   === 'object' ? mon.learn_list   : JSON.parse(mon.learn_list||'{}'); }catch{ learnList={}; }
  console.log("pool");
  console.log(learnedPool);
  console.log("learn");
  console.log(learnList);
  
  learnedPool.effects = learnedPool.effects || {};
  learnedPool.bonuses = learnedPool.bonuses || {};
  learnList.effects = learnList.effects || {};
  learnList.bonuses = learnList.bonuses || {};

  console.log("pool");
  console.log(learnedPool);
  console.log("learn");
  console.log(learnList);

  const moves = Array.isArray(mon.moves) ? mon.moves : [];
  console.log("moves");
  console.log(moves);

  const effectCodes = new Set();
  console.log("effectCodes");
  console.log(effectCodes);

  const bonusCodes  = new Set();
  console.log("bonusCodes");
  console.log(bonusCodes);

  for (const m of moves){
    const mid = m && m.move_id ? (m.move_id|0) : 0;
    console.log("mid");
    console.log(mid);
    if (!mid) continue;
    const det = await getMoveDetailsById(mid);
    console.log("det");
    console.log(det);
    if (!det) continue;
    // include ALL effects in the move's stack (base + additions) and all bonuses
    for (const e of (det.stack||[])){ if (e) effectCodes.add(String(e).trim()); }
    for (const b of (det.bonuses||[])){ if (b) bonusCodes.add(String(b).trim()); }
  }
  console.log("effectCodes");
  console.log(effectCodes);
  console.log("bonusCodes");
  console.log(bonusCodes);
  
  // Add to learned_pool at 100, remove from learn_list if present
  for (const code of effectCodes){
    //learnedPool.effects[code] = 100;
    if (!learnedPool.effects.includes(code)) {
      learnedPool.effects.push(code);
    }                           
    if (learnList.effects[code] != null) delete learnList.effects[code];
  }
  for (const code of bonusCodes){
    //learnedPool.bonuses[code] = 100;
    if (!learnList.effects.includes(code)) {
      learnList.effects.push(code);
    } 
    if (learnList.bonuses[code] != null) delete learnList.bonuses[code];
  }
  console.log("pool");
  console.log(learnedPool);
  console.log("learn");
  console.log(learnList);
  await pool.query(`UPDATE mg_monsters SET learned_pool=$1, learn_list=$2 WHERE id=$3`,
    [JSON.stringify(learnedPool), JSON.stringify(learnList), monId|0]);
}


async function attachPPToMoves(mon){
  try{
    if (!mon || !Array.isArray(mon.moves)) return mon;
    // Try to pull any legacy name->pp map (may be null; that's fine)
    let namePPMap = {};
    try{ namePPMap = await getCurrentPP(mon) || {}; }catch(_){ namePPMap = {}; }

    const out = [];
    for (const mv of (mon.moves||[]).slice(0,4)){
      const m = mv ? { ...mv } : {};
      const displayName = (m.name_custom && m.name_custom.trim()) || (m.name && m.name.trim()) || '';
      // Determine max PP from the base effect
      let maxPP = 25;
      if (m.move_id){
        const det = await getMoveDetailsById(m.move_id|0);
        if (det) maxPP = await getMaxPPForStack(det.stack, 25);
        else if (Array.isArray(m.stack)) maxPP = await getMaxPPForStack(m.stack, 25);
      } else if (Array.isArray(m.stack)) {
        maxPP = await getMaxPPForStack(m.stack, 25);
      }

      // Determine current PP (prefer modern field; else legacy; else name map; else max)
      let cur = (m.current_pp|0);
      if (!cur){
        if (m.pp != null) cur = m.pp|0;
        else if (displayName && namePPMap && namePPMap[displayName] != null) cur = namePPMap[displayName]|0;
        else cur = maxPP|0;
      }
      cur = Math.min(Math.max(cur|0, 0), maxPP|0);

      // Normalize fields we send outward
      delete m.pp;
      m.current_pp = cur;
      m.max_pp = maxPP;
      out.push(m);
    }
    mon.moves = out;
    return mon;
  }catch(_){
    return mon;
  }
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

// accuracy for a single effect: prefer row.accuracy; fall back to move.accuracy; bonuses may tweak
function perEffectAccuracy(effectCode, move, bonuses, isSelfTarget){
  // self-target effects auto-hit per spec
  if (isSelfTarget) return 0.99;

  const row = getEffectRowByCode(effectCode);
  let acc = (row && row.accuracy != null) ? Number(row.accuracy) : (move.accuracy ?? 0.95);

  // sample bonus: accuracy_up
  const bon = getBonusCodes(bonuses);
  if (bon.includes('accuracy_up')) acc += 0.10;

  acc = Math.max(0.05, Math.min(0.99, Number(acc) || 0.95));
  return acc;
}

// effect resolver using DB fields: target ('target'|'self'), effect_type ('damage'|'status'|'stat_change'),
// stat (channel for damage; which stat for stat_change; which status for status), amount (decimal for stat_change)
async function resolveSingleEffect(effectCode, move, attacker, defender, b){
  
  //load the full details of the effect
  const row = getEffectRowByCode(effectCode) || {};
  
  //work out which monster suffers the consequences of the effect. lower case, and defaults to 'target'
  const targetKey = (String(row.target || 'target').toLowerCase() === 'self') ? 'self' : 'target';
  
  //get the effect type
  const effectType = String(row.effect_type || '').toLowerCase();
  
  //get the stat used, stat affected, or status caused
  const stat = String(row.stat || '').toUpperCase();         // e.g., 'PHY','MAG','DEF','SLEEP'
  
  //get the amount (of a stat change, for example)
  const amt  = (row.amount != null) ? Number(row.amount) : null;

  // choose who is affected
  const targetMon = (targetKey === 'self') ? attacker : defender;

  // ACC roll. it seems that self-targeted effects auto-hit. Change this ###
  // ### if the base_effect misses, no other effects should be checked
  const acc = perEffectAccuracy(effectCode, move, move?.bonuses, targetKey === 'self');
  
  //work out if the effect hits
  const hit = Math.random() < acc;
  if (!hit){
    const A = await describeMon(attacker, b);
    const T = await describeMon(targetMon, b);
    if (targetKey === 'self'){
      b.log.push(`${A.poss} ${move.name} missed.`);
    } else {
      b.log.push(`${A.poss} ${move.name} missed ${T.cap}.`);
    }
    return { hit:false, dmg:0 };
  }


  // --- DAMAGE ---
  if (effectType === 'damage'){
    // Determine channel from row.stat: PHY → physical, MAG → special (fallback physical)
    const channel = (stat === 'MAG') ? 'dmg_spec' : 'dmg_phys';

    // Pull base power from the EFFECT row (amount), else any row.power, else fallback.
    // You can tune the fallback (8–10 feels good for early game).
    const effectPower =
      (row.amount != null ? Number(row.amount) : NaN);
    const declaredPower =
      (row.power  != null ? Number(row.power)  : NaN);
    const fallbackPower = (move.power != null ? Number(move.power) : 1);

    const power = Number.isFinite(effectPower)
      ? Math.max(1, Math.round(effectPower))
      : (Number.isFinite(declaredPower) ? Math.max(1, Math.round(declaredPower)) : fallbackPower);

    const tempMove = { ...move, stack:[channel], power };


    // Use battle-aware stats (includes any prior stat_change effects)
    const atkStats = await getBattleStats(attacker === b.you ? 'you' : 'enemy', b);
    const defStats = await getBattleStats(targetMon === b.you ? 'you' : 'enemy', b);

    // calculate damage
    const dmg = await calcDamage(atkStats, defStats, tempMove, attacker.level|0);
    targetMon.hp = Math.max(0, (targetMon.hp|0) - dmg);
    const A = await describeMon(attacker, b);
    const T = await describeMon(targetMon, b);
    b.log.push(`${A.poss} ${move.name} dealt ${dmg} damage to ${T.cap}.`);

    return { hit:true, dmg };
  }

  // --- STATUS ---
  if (effectType === 'status'){
    // We'll keep status in battle memory for now (DB field for status may not exist yet in your table)
    // Only one negative status at a time (spec). If empty or 'none', apply.
    const cur = String(targetMon.status_neg || 'none').toLowerCase();
    if (cur !== 'none'){
      b.log.push(`${move.name}: status attempt ignored (already has ${cur}).`);
      return { hit:true, dmg:0 };
    }
    // row.stat holds which status to apply, e.g., 'SLEEP','STUN','POISON'
    const next = stat ? stat.toLowerCase() : 'status';
    targetMon.status_neg = next;
    const A = await describeMon(attacker, b);
    const T = await describeMon(targetMon, b);
    if (targetKey === 'self'){
      b.log.push(`${A.poss} ${move.name} applied ${next}.`);
    } else {
      b.log.push(`${A.poss} ${move.name} inflicted ${next} on ${T.cap}.`);
    }
    return { hit:true, dmg:0 };

  }

  // --- STAT CHANGE ---
  if (effectType === 'stat_change'){
    // amt is fractional (e.g., +0.20 or -0.10), applies until battle end
    if (!b.mods) b.mods = { you:{}, enemy:{} };
    const bucket = (targetMon === b.you) ? (b.mods.you = b.mods.you || {}) : (b.mods.enemy = b.mods.enemy || {});

    // accepted stats: HP/PHY/MAG/DEF/RES/SPD/ACC/EVA (ignore others gracefully)
    const allowed = ['HP','PHY','MAG','DEF','RES','SPD','ACC','EVA'];
    const A = await describeMon(attacker, b);
    const T = await describeMon(targetMon, b);

    if (allowed.includes(stat) && typeof amt === 'number' && amt !== 0){
      bucket[stat] = Number(bucket[stat] || 0) + amt; // stackable
      const pct = Math.round(Math.abs(amt)*100);
      const verb = amt > 0 ? 'raised' : 'lowered';

      if (targetKey === 'self'){
        b.log.push(`${A.poss} ${move.name} ${verb} ${A.pronoun} ${stat} by ${pct}%.`);
      } else {
        b.log.push(`${A.poss} ${move.name} ${verb} ${T.cap}'s ${stat} by ${pct}%.`);
      }
    } else {
      // unknown stat/amount – still say something but keep it tidy
      if (targetKey === 'self'){
        b.log.push(`${A.poss} ${move.name} had no noticeable effect.`);
      } else {
        b.log.push(`${A.poss} ${move.name} had no noticeable effect on ${T.cap}.`);
      }
    }
    return { hit:true, dmg:0 };

  }

  // fallback: unknown type → just log
  b.log.push(`${move.name} applied ${effectCode}.`);
  return { hit:true, dmg:0 };
}

// Resolve a whole move (all effects) from attacker → defender.
// Returns an object describing what happened; DB writes are *not* done here.
async function resolveMoveStackFor(attacker, defender, moveDet, visibleName, b, opts = {}){
  const fallbackPower = Number(opts.fallbackPower ?? 8);
  const fallbackAcc   = Number(moveDet?.accuracy ?? 0.95);

  const stackList = Array.isArray(moveDet?.stack) ? moveDet.stack.map(String) : [];
  if (stackList.length === 0){
    // Fallback so "empty" moves still do something (dev-safe)
    if (Math.random() < fallbackAcc){
      const atkStats = await getBattleStats(attacker === b.you ? 'you' : 'enemy', b);
      const defStats = await getBattleStats(defender === b.you ? 'you' : 'enemy', b);
      const tempMove = { name: visibleName, base:'physical', power:fallbackPower, accuracy:fallbackAcc, stack:['dmg_phys'], bonuses:[] };
      const dmg = await calcDamage(atkStats, defStats, tempMove, attacker.level|0);
      defender.hp = Math.max(0, (defender.hp|0) - dmg);
      const A = await describeMon(attacker, b);
      const T = await describeMon(defender, b);
      b.log.push(`${A.poss} ${visibleName} dealt ${dmg} damage to ${T.cap}.`);
      return { usedFallback:true, totalDamage:dmg };

    } else {
      const A = await describeMon(attacker, b);
      const T = await describeMon(defender, b);
      b.log.push(`${A.poss} ${visibleName} missed ${T.cap}.`);
      return { usedFallback:true, totalDamage:0, missed:true };

    }
  }

  // Normal path: effect-by-effect
  const tempMove = { name: visibleName, accuracy: moveDet.accuracy ?? 0.95, bonuses: moveDet.bonuses, stack: moveDet.stack };
  let totalDamage = 0;
  for (const effectCode of stackList){
    const out = await resolveSingleEffect(effectCode, tempMove, attacker, defender, b);
    if (out?.dmg) totalDamage += (out.dmg|0);
    if ((defender.hp|0) <= 0) break; // stop if target fainted
  }
  return { usedFallback:false, totalDamage };
}




// --- Content Tables (DB) ----------------------------------------------------
// We’ll store effects/bonuses/moves_named/abilities directly in Postgres.
// This helper creates tables if they don’t exist. Call it on boot.
async function ensureContentTables() {
  // Base creates (idempotent)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mg_effects (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      target TEXT DEFAULT 'target',              -- 'self' | 'target'
      accuracy_base NUMERIC(5,2) DEFAULT 1.00,   -- 0..1
      cost INT DEFAULT 0,
      duration TEXT DEFAULT '',                  -- '' | '-1' | 'N'
      base_flag_eligible BOOLEAN DEFAULT FALSE,  -- eligible to be a base effect
      base_pp INT DEFAULT 20,
      tick_source TEXT DEFAULT NULL,             -- e.g. 'PHY' | 'MAG'
      tick_percent NUMERIC(5,2) DEFAULT NULL,    -- e.g. 10.00 = 10%
      effect_type TEXT DEFAULT '',               -- NEW
      stat TEXT DEFAULT '',                      -- NEW
      amount NUMERIC(8,2) DEFAULT 0,             -- NEW
      notes TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS mg_bonuses (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      target_metric TEXT DEFAULT '',
      value_type TEXT DEFAULT 'flat',            -- 'flat' | 'percent' | 'tag'
      value NUMERIC(8,2) DEFAULT 0,
      cost INT DEFAULT 0,
      notes TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS mg_moves_named (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      stack_effects JSONB DEFAULT '[]',          -- ["EFFECT_CODE", ...]
      stack_bonuses JSONB DEFAULT '[]',          -- ["BONUS_CODE", ...]
      notes TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS mg_abilities (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      rescue_flag BOOLEAN DEFAULT FALSE,
      field_effect TEXT DEFAULT '',
      stack_effects JSONB DEFAULT '[]',          -- ["EFFECT_CODE", ...]
      stack_bonuses JSONB DEFAULT '[]',          -- ["BONUS_CODE", ...]
      notes TEXT DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS mg_species (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      base_spawn_rate NUMERIC(5,2) DEFAULT 0,
      biomes TEXT[] DEFAULT '{}',
      types TEXT[]  DEFAULT '{}',
      base_hp  INT DEFAULT 0,
      base_phy INT DEFAULT 0,
      base_mag INT DEFAULT 0,
      base_def INT DEFAULT 0,
      base_res INT DEFAULT 0,
      base_spd INT DEFAULT 0,
      base_acc INT DEFAULT 0,
      base_eva INT DEFAULT 0
    );
  `);

  // Upgrades for existing installs (safe to run every boot)
  await pool.query(`ALTER TABLE mg_effects  ADD COLUMN IF NOT EXISTS effect_type TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE mg_effects  ADD COLUMN IF NOT EXISTS stat TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE mg_effects  ADD COLUMN IF NOT EXISTS amount NUMERIC(8,2) DEFAULT 0`);
  await pool.query(`ALTER TABLE mg_bonuses ADD COLUMN IF NOT EXISTS base_pp INT DEFAULT 0`);
  await pool.query(`ALTER TABLE mg_bonuses   ADD COLUMN IF NOT EXISTS description  TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE mg_abilities ADD COLUMN IF NOT EXISTS rescue_flag  BOOLEAN DEFAULT FALSE`);
  await pool.query(`ALTER TABLE mg_abilities ADD COLUMN IF NOT EXISTS field_effect TEXT DEFAULT ''`);
  await pool.query(`ALTER TABLE mg_abilities ADD COLUMN IF NOT EXISTS stack_effects JSONB DEFAULT '[]'`);
  await pool.query(`ALTER TABLE mg_abilities ADD COLUMN IF NOT EXISTS stack_bonuses JSONB DEFAULT '[]'`);

  console.log('[DB] Content tables ensured/updated');
}

ensureContentTables().catch(e => console.error('ensureContentTables error:', e));

// --- Move naming & persistence ---------------------------------------------
function normalizeMoveParts(stack, bonuses){
  // Keep base effect first; sort the rest for stable matching; de-dup
  const s = Array.isArray(stack) ? stack.map(x=>String(x||'').trim()).filter(Boolean) : [];
  const b = Array.isArray(bonuses) ? bonuses.map(x=>String(x||'').trim()).filter(Boolean) : [];
  const base = s[0] || '';
  const rest = s.slice(1).filter(x=>x!==base).sort();
  const sb = Array.from(new Set([base, ...rest]));           // effects
  const bb = Array.from(new Set(b.sort()));                  // bonuses
  return { stack: sb, bonuses: bb };
}

// If a stack exists in mg_moves_named, use its name; otherwise create it.
// Returns { name, stack, bonuses, id }
async function resolveMoveNameAndPersist(stack, bonuses){
  const n = normalizeMoveParts(stack, bonuses);

  // Try exact match first
  const sel = await pool.query(
    `SELECT id, name FROM mg_moves_named
      WHERE stack_effects = $1::jsonb AND stack_bonuses = $2::jsonb
      LIMIT 1`,
    [JSON.stringify(n.stack), JSON.stringify(n.bonuses)]
  );
  if (sel.rows.length){
    return { id: sel.rows[0].id, name: sel.rows[0].name, stack: n.stack, bonuses: n.bonuses };
  }

  // Build a basic concatenated name from codes
  const builtName = [...n.stack, ...n.bonuses].join(' + ') || 'Unnamed';

  // Insert new named move so the same stack reuses this name next time
  const ins = await pool.query(
    `INSERT INTO mg_moves_named (name, stack_effects, stack_bonuses)
     VALUES ($1, $2::jsonb, $3::jsonb)
     RETURNING id, name`,
    [builtName, JSON.stringify(n.stack), JSON.stringify(n.bonuses)]
  );

  return { id: ins.rows[0].id, name: ins.rows[0].name, stack: n.stack, bonuses: n.bonuses };
}

// --- (optional) load content on startup ---
// Disabled by default to avoid hitting remote CSV host during deploys.
// To enable, set MG_PRELOAD_CONTENT=true in the environment.
const PRELOAD = String(process.env.MG_PRELOAD_CONTENT || 'false').toLowerCase() === 'true';
if (PRELOAD) {
  try { reloadContent(); } catch(e){ console.error('Content load failed:', e.message); }
}


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
//initDB().then(()=>console.log('✓ DB ready')).catch(e=>{ console.error('DB init failed',e); process.exit(1); });
initDB()
  .then(()=>console.log('✓ DB ready'))
  .then(()=>refreshContentCacheFromDB())
  .catch(e=>{ console.error('DB init failed',e); process.exit(1); });

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

/** Load effects/bonuses from DB into the in-memory cache used by legacy helpers */
async function refreshContentCacheFromDB(){
  try{
    const effRes = await pool.query(`
      SELECT code, 
        target, 
        accuracy_base AS accuracy, 
        base_pp,
        effect_type, 
        stat, 
        amount
        COALESCE(base_flag_eligible,false) AS base_flag_eligible
      FROM mg_effects
      ORDER BY id ASC
    `);
    const bonRes = await pool.query(`
      SELECT code, 
        name, 
        description, 
        target_metric, 
        value_type, 
        value, 
        cost,
        base_pp
      FROM mg_bonuses
      ORDER BY id ASC
    `);

    const effects = effRes.rows.map(r => ({
      code: String(r.code || '').trim(),
      target: r.target || 'target',
      accuracy: (r.accuracy == null ? undefined : Number(r.accuracy)),
      base_pp: (r.base_pp == null ? undefined : Number(r.base_pp)),
      effect_type: r.effect_type || '',
      stat: r.stat || '',
      amount: (r.amount == null ? undefined : Number(r.amount)),
      base_flag_eligible: !!r.base_flag_eligible
    }));
    const bonuses = bonRes.rows.map(r => ({
      code: String(r.code || '').trim(),
      name: r.name || '',
      description: r.description || '',
      target_metric: r.target_metric || '',
      value_type: r.value_type || 'flat',
      value: (r.value == null ? undefined : Number(r.value)),
      cost: (r.cost == null ? undefined : Number(r.cost)),
      base_pp: (r.base_pp == null ? undefined : Number(r.base_pp))
    }));

    OVERRIDE_CONTENT = {
      version: Date.now(),
      effects,
      bonuses,
      pool: {
        effects: effects.map(e => e.code),
        bonuses: bonuses.map(b => b.code)
      }
    };
    console.log(`[Content] Cache loaded from DB: ${effects.length} effects, ${bonuses.length} bonuses`);
  }catch(e){
    console.error('refreshContentCacheFromDB error:', e);
  }
}


function httpGetText(url){
  return new Promise((resolve,reject)=>{
    const mod = url.startsWith('https:') ? https : http; // http is already required at top
    const req = mod.get(url, res=>{
      if (res.statusCode && res.statusCode >= 400) {
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data=''; res.setEncoding('utf8');
      res.on('data', chunk=> data+=chunk);
      res.on('end', ()=> resolve(data));
    });
    req.on('error', reject);
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
  console.log("ensureHasParty");
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS c FROM mg_monsters WHERE owner_id=$1`, [owner_id]);
  console.log("rows");
  console.log(rows);
  if ((rows[0]?.c||0) === 0){
    const starterSpeciesId = 1;
    const starterLevel = 3;
    const srow   = await getSpeciesRow(starterSpeciesId);
    const growth = randomGrowth();
    const derived = srow ? deriveStats(srow, growth, starterLevel) : { HP: 28 };
    
    await pool.query(`
      INSERT INTO mg_monsters (owner_id,species_id,level,xp,hp,max_hp,ability,moves,growth)
      VALUES ($1,$2,$3,0,$4,$4,'','[
        {"name_custom":"Strike","current_pp":25,"move_id":2}
      ]'::jsonb, $5)
    `, [owner_id, starterSpeciesId, starterLevel, Math.max(1, derived.HP|0), JSON.stringify(growth)]);

  }
  console.log("end of ensureHasParty");
}

async function ensureStarterMoves(owner_id){
  const { rows } = await pool.query(`SELECT id,moves FROM mg_monsters WHERE owner_id=$1 ORDER BY id ASC LIMIT 1`, [owner_id]);
  if (!rows.length) return;
  const id = rows[0].id;
  let moves = rows[0].moves || [];
  try {
    const hasGuard = moves.some(m => (m.name||'').toLowerCase()==='guard')
  }catch (e) {
    console.log("HasGuard failed");

  };
  
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
  const nick = (mon?.nickname || '').trim();
  if (nick) return nick;

  // Enemy/wild often has a plain .name already
  if (typeof mon?.name === 'string' && mon.name.trim()) return mon.name.trim();

  // Handle both player and enemy shapes
  const sid = Number(mon?.species_id ?? mon?.speciesId) | 0;
  if (sid) return await speciesNameById(sid);

  return 'Species ?';
}


// Returns labels and forms to log monsters nicely.
async function describeMon(mon, b){
  const label = (mon === b.you) ? 'Your' : 'Wild';
  const name = await monName(mon);
  return {
    label,                      // "Your" | "Wild"
    name,                       // nickname or species
    cap: `${label} ${name}`,    // "Your Fieldling"
    poss: `${label} ${name}'s`, // "Your Fieldling's"
    pronoun: 'its'              // possessive pronoun for self-targets
  };
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
  console.log("api/login");
  try{
    const { email,password } = req.body||{};
    const p = await getPlayerByEmail(email);
    if (!p) return res.status(401).json({ error:'Invalid credentials' });
    const ok = await bcrypt.compare(password, p.password_hash);
    if (!ok) return res.status(401).json({ error:'Invalid credentials' });
    const tok = await createSession(p.id);
    await ensureHasParty(p.id);
    console.log("api login effects learned from moves");
    // Sync learned_pool from move compositions for all party monsters
    console.log("player_id");
    console.log(p.id);

    try{
      const { rows: partyRows } = await pool.query(`SELECT id FROM mg_monsters WHERE owner_id=$1 ORDER BY slot ASC`, [p.id]);
      console.log("partyRows");
      console.log(partyRows);
      for (const r of partyRows){
        console.log(r);
        await syncMonsterLearnedFromMoves(r.id|0);
      }
    }catch(err){
      console.error("failed to get player party");
    }

    const st = await getState(p.id);
    const party = await getParty(p.id);
    res.json({ token: tok, player: { handle:p.handle, cx:st.cx,cy:st.cy,tx:st.tx,ty:st.ty, party } });
  }catch(e){
    console.error('LOGIN ERROR:', e); // helps confirm it was a missing column
    res.status(500).json({ error:'server_error' });
  }
});

app.get('/api/session', auth, async (req,res)=>{
  console.log("api/session");
  console.log(player_id);
  await ensureHasParty(req.session.player_id);
  
  // Sync learned_pool from move compositions for all party monsters
  try{
    
    const { rows: partyRows } = await pool.query(`SELECT id FROM mg_monsters WHERE owner_id=$1 ORDER BY slot ASC`, [player_id]);
    console.log(partyRows);

    for (const r of partyRows){
      console.log("api session effects learned from moves");
      await syncMonsterLearnedFromMoves(r.id|0);
    }
  }catch(_){}

  const st = await getState(req.session.player_id);
  const party = await getParty(req.session.player_id);
  res.json({ token: req.session.token, player: { handle:req.session.handle, cx:st.cx,cy:st.cy,tx:st.tx,ty:st.ty, party } });
});

app.post('/api/logout', auth, async (req,res)=>{ await deleteSession(req.session.token); res.json({ ok:true }); });

/* ---------- party & heal ---------- */
app.get('/api/party', auth, async (req,res)=>{
  const party = await getParty(req.session.player_id);
  // attach current_pp/max_pp to every move on every monster
  for (const mon of party){ await attachPPToMoves(mon); }
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
  console.log("Post /monster/move");
  try{
    const { monster_id, move_slot, stack, bonuses } = req.body || {};
    console.log("req.body");
    console.log(req.body);

    console.log("monster_id");
    console.log(monster_id);

    console.log("move_slot");
    console.log(move_slot);

    console.log("stack");
    console.log(stack);

    console.log("bonuses");
    console.log(bonuses);

    const monId = monster_id|0, idx = move_slot|0;
    console.log("monId");
    console.log(monId);

    const { rows } = await pool.query(
      `SELECT id, owner_id, moves FROM mg_monsters WHERE id=$1 LIMIT 1`,
      [monId]
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

    // --- Ensure DB-stored move name/id for this exact combo
    const ensured = await ensureMoveRecord(newStack, newBonuses);

    // Merge; keep move_id, fill name_custom if blank
    const next = { ...prior, move_id: ensured.id, stack: newStack, bonuses: newBonuses, pp: newPP };
    // For future UIs that prefer custom label, set it once if empty:
    if (!next.name_custom || !String(next.name_custom).trim()){
      next.name_custom = ensured.name;
    }
    // Keep legacy 'name' in case any old flows reference it:
    next.name = ensured.name;

    moves[idx] = next;


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
  // Restore HP
  await pool.query(`UPDATE mg_monsters SET hp = max_hp WHERE owner_id=$1`, [owner_id]);

  // Reset PP for every move of every monster to its max
  const { rows } = await pool.query(`SELECT id, moves FROM mg_monsters WHERE owner_id=$1`, [owner_id]);
  for (const r of rows){
    const id = r.id|0;
    const moves = Array.isArray(r.moves) ? r.moves.slice(0,4) : [];
    const updated = [];
    for (const mv of moves){
      const m = mv ? { ...mv } : {};
      let maxPP = 25;
      if (m.move_id){
        const det = await getMoveDetailsById(m.move_id|0);
        if (det) maxPP = await getMaxPPForStack(det.stack, 25);
        else if (Array.isArray(m.stack)) maxPP = await getMaxPPForStack(m.stack, 25);
      } else if (Array.isArray(m.stack)) {
        maxPP = await getMaxPPForStack(m.stack, 25);
      }
      delete m.pp;
      m.current_pp = maxPP|0;
      m.max_pp = maxPP|0;
      updated.push(m);
    }
    await pool.query(`UPDATE mg_monsters SET moves=$1, current_pp=NULL WHERE id=$2 AND owner_id=$3`, [updated, id, owner_id]);
  }

  const party = await getParty(owner_id);
  // Make sure party includes normalized PP fields when returned
  for (const mon of party){ await attachPPToMoves(mon); }
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

/* -----------moves-----------*/
// Batch lookup: /api/moves?ids=1,2,3
app.get('/api/moves', async (req, res) => {
  try {
    const raw = String(req.query.ids || '');
    // Parse, dedupe, and sanitize ids
    const ids = [...new Set(
      raw.split(',')
         .map(s => parseInt(s, 10))
         .filter(n => Number.isInteger(n))
    )];

    if (!ids.length) {
      return res.json([]); // no ids requested → empty list
    }

    // (optional) guardrail to avoid abuse
    if (ids.length > 200) {
      return res.status(413).json({ error: 'Too many IDs; max 200 per request.' });
    }

    // Fetch the moves. Add/adjust columns as you need downstream.
    const { rows } = await pool.query(`
      SELECT id, name, stack_effects, stack_bonuses
      FROM mg_moves_named
      WHERE id = ANY($1::int[])
    `, [ids]);



    // Preserve request order
    const map = new Map(rows.map(r => [r.id, r]));
    const ordered = ids.map(id => map.get(id)).filter(Boolean);

    return res.json(ordered);
  } catch (err) {
    console.error('GET /api/moves error:', err);
    return res.status(500).json({ error: 'Failed to fetch moves' });
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

app.get('/api/effects', async (_req,res)=>{
  try{
    const { rows } = await pool.query(`
      SELECT id,
              code,
             name,
             description,
             target,
             accuracy_base,
             cost,
             duration,
             base_flag_eligible,
             base_pp,
             tick_source,
             tick_percent,
             effect_type,
             stat,
             amount,
             notes
        FROM mg_effects
    ORDER BY id ASC`);
    res.json({ effects: rows });
  }catch(e){
    res.status(500).json({ error:'server_error' });
  }
});

app.get('/api/bonuses', async (_req,res)=>{
  try{
    const { rows } = await pool.query(`
      SELECT id,
              code,
             name,
             description,
             target_metric,
             value_type,
             base_pp,
             notes
        FROM mg_bonuses
    ORDER BY id ASC`);
    res.json({ bonuses: rows });
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


/* -------- Admin: DB-backed Content CRUD (effects/bonuses/moves_named/abilities) -------- */
// TEMP admin guard: only allow player_id === 1
function adminGuard(req, res) {
  if (!req.session || req.session.player_id !== 1) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

// Whitelist to avoid arbitrary table access
// writable=false kinds will be view-only in the editor
const CONTENT_TABLES = {
  // Existing "content" tables — keep editable
  effects:    { table: 'mg_effects',     pk: 'id',     writable: true  },
  bonuses:    { table: 'mg_bonuses',     pk: 'id',     writable: true  },
  moves:      { table: 'mg_moves_named', pk: 'id',     writable: true  },
  abilities:  { table: 'mg_abilities',   pk: 'id',     writable: true  },
  species:    { table: 'mg_species',     pk: 'id',     writable: true  },
  monsters:       { table: 'mg_monsters',      pk: 'id',     writable: true },


  // Additional tables — view-only (safe)
  players:        { table: 'mg_players',       pk: 'id',     writable: false },
  sessions:       { table: 'mg_sessions',      pk: 'token',  writable: false },
  player_state:   { table: 'mg_player_state',  pk: 'player_id', writable: false },
  
  
};



// GET list of all records in a particular table (for the content editor) (with simple pagination later if needed)
app.get('/api/admin/db/:kind', auth, async (req, res) => {
  if (!adminGuard(req, res)) return;
  const kind = String(req.params.kind || '').toLowerCase();
  const meta = CONTENT_TABLES[kind];
  if (!meta) return res.status(400).json({ error: 'bad_kind' });
  try {
    const { rows } = await pool.query(`SELECT * FROM ${meta.table} ORDER BY ${meta.pk} ASC`);
    res.json({ ok:true, rows });
  } catch (e) {
    console.error('admin list error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// UPSERT (insert if no id; update if id is present)
app.post('/api/admin/db/:kind', auth, async (req, res) => {

  //check that the user is admin
  if (!adminGuard(req, res)) return;

  //get the kind (table name) from the passed request
  const kind = String(req.params.kind || '').toLowerCase();

  //pick the correct table. If doesn't exist, error 400
  const meta = CONTENT_TABLES[kind];
  if (!meta) return res.status(400).json({ error: 'bad_kind' });

  // Block edits on read-only kinds
  if (!meta.writable) {
    return res.status(403).json({ error: 'read_only', message: `The '${kind}' table is view-only.` });
  }
  
  const body = req.body || {};
  try {
    let q, params;
    if (kind === 'effects') {
      const {
        id, code, name, description='',
        target='target', accuracy_base=1.00, cost=0,
        duration='', base_flag_eligible=false, base_pp=20,
        tick_source=null, tick_percent=null,
        effect_type='', stat='', amount=0,
        notes=''
      } = body;
      if (!code || !name) return res.status(400).json({ error:'missing_fields' });

      if (id) {
        q = `
          UPDATE mg_effects SET
            code=$1, name=$2, description=$3, target=$4, accuracy_base=$5, cost=$6,
            duration=$7, base_flag_eligible=$8, base_pp=$9, tick_source=$10, tick_percent=$11,
            effect_type=$12, stat=$13, amount=$14, notes=$15
          WHERE id=$16
          RETURNING *`;
        params = [code, name, description, target, accuracy_base, cost,
                  duration, base_flag_eligible, base_pp, tick_source, tick_percent,
                  effect_type, stat, amount, notes, id];
      } else {
        q = `
          INSERT INTO mg_effects
            (code,name,description,target,accuracy_base,cost,duration,base_flag_eligible,base_pp,tick_source,tick_percent,effect_type,stat,amount,notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
          RETURNING *`;
        params = [code, name, description, target, accuracy_base, cost,
                  duration, base_flag_eligible, base_pp, tick_source, tick_percent,
                  effect_type, stat, amount, notes];
      }
    } else if (kind === 'bonuses') {
      const {
        id, 
        code, 
        name, 
        description='', 
        target_metric='', 
        value_type='flat', 
        value=0, 
        cost=0, 
        base_pp=0,
        notes=''
      } = body;
      if (!code || !name) return res.status(400).json({ error:'missing_fields' });
      if (id) {
        q = `
          UPDATE mg_bonuses SET
            code=$1, name=$2, description=$3, target_metric=$4, value_type=$5, value=$6, cost=$7, base_pp=$8, notes=$9
          WHERE id=$10
          RETURNING *`;
        params = [code, name, description, target_metric, value_type, value, cost, base_pp, notes, id];
      } else {
        q = `
          INSERT INTO mg_bonuses (code,name,description,target_metric,value_type,value,cost,base_pp,notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING *`;
        params = [code, name, description, target_metric, value_type, value, cost, base_pp, notes];
      }
    } else if (kind === 'moves') {
      const { id, name, stack_effects=[], stack_bonuses=[], notes='' } = body;
      if (!name) return res.status(400).json({ error:'missing_fields' });
      const eff = Array.isArray(stack_effects) ? stack_effects : [];
      const bon = Array.isArray(stack_bonuses) ? stack_bonuses : [];
      if (id) {
        q = `
          UPDATE mg_moves_named SET
            name=$1, stack_effects=$2::jsonb, stack_bonuses=$3::jsonb, notes=$4
          WHERE id=$5
          RETURNING *`;
        params = [name, JSON.stringify(eff), JSON.stringify(bon), notes, id];
      } else {
        q = `
          INSERT INTO mg_moves_named (name,stack_effects,stack_bonuses,notes)
          VALUES ($1,$2::jsonb,$3::jsonb,$4)
          RETURNING *`;
        params = [name, JSON.stringify(eff), JSON.stringify(bon), notes];
      }
    } else if (kind === 'abilities') {
      const {
        id, code, name,
        rescue_flag=false,
        field_effect='',
        stack_effects=[],
        stack_bonuses=[],
        notes=''
      } = body;
      if (!code || !name) return res.status(400).json({ error:'missing_fields' });

      const eff = Array.isArray(stack_effects) ? stack_effects : [];
      const bon = Array.isArray(stack_bonuses) ? stack_bonuses : [];

      if (id) {
        q = `
          UPDATE mg_abilities SET
            code=$1, name=$2, rescue_flag=$3, field_effect=$4, stack_effects=$5::jsonb, stack_bonuses=$6::jsonb, notes=$7
          WHERE id=$8
          RETURNING *`;
        params = [code, name, !!rescue_flag, field_effect, JSON.stringify(eff), JSON.stringify(bon), notes, id];
      } else {
        q = `
          INSERT INTO mg_abilities (code,name,rescue_flag,field_effect,stack_effects,stack_bonuses,notes)
          VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)
          RETURNING *`;
        params = [code, name, !!rescue_flag, field_effect, JSON.stringify(eff), JSON.stringify(bon), notes];
      }
    } else if (kind === 'species') {
      const {
        id,
        name,
        base_spawn_rate = 0,
        biomes = [],
        types  = [],
        base_hp = 0, base_phy = 0, base_mag = 0,
        base_def = 0, base_res = 0, base_spd = 0,
        base_acc = 0, base_eva = 0
      } = body;

      if (!name) return res.status(400).json({ error:'missing_fields' });

      const asArray = v => Array.isArray(v) ? v : String(v||'').split(',').map(s=>s.trim()).filter(Boolean);

      const biomesArr = asArray(biomes);
      const typesArr  = asArray(types);

      const ints = v => Number.isFinite(+v) ? parseInt(v,10) : 0;

      if (id) {
        q = `
          UPDATE mg_species SET
            name=$1, base_spawn_rate=$2, biomes=$3, types=$4,
            base_hp=$5, base_phy=$6, base_mag=$7, base_def=$8, base_res=$9, base_spd=$10, base_acc=$11, base_eva=$12
          WHERE id=$13
          RETURNING *`;
        params = [ name, base_spawn_rate, biomesArr, typesArr,
                   ints(base_hp), ints(base_phy), ints(base_mag),
                   ints(base_def), ints(base_res), ints(base_spd),
                   ints(base_acc), ints(base_eva), id ];
      } else {
        q = `
          INSERT INTO mg_species
            (name,base_spawn_rate,biomes,types,base_hp,base_phy,base_mag,base_def,base_res,base_spd,base_acc,base_eva)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          RETURNING *`;
        params = [ name, base_spawn_rate, biomesArr, typesArr,
                   ints(base_hp), ints(base_phy), ints(base_mag),
                   ints(base_def), ints(base_res), ints(base_spd),
                   ints(base_acc), ints(base_eva) ];
      }
    } else if (kind === 'monsters') {
      console.log(JSON.stringify(body));
      
      //set the body object
      const {
        id,
        owner_id,
        species_id,
        nickname,
        level,
        xp,
        hp,
        max_hp,
        ability,
        moves = [],
        slot,
        //growth,
        //current_pp,
        learned_pool = {"effects":[],"bonuses":[]},
        learn_list = {"effects":[],"bonuses":[]}
      } = body;

      console.log(moves);

      if (!id) return res.status(400).json({ error:'missing_fields' });

      //create a function (asArray) that takes one input (v) and converts it into an array
      const asArray = v => Array.isArray(v) ? v : String(v||'').split(',').map(s=>s.trim()).filter(Boolean);
      //create a function that takes one input (v) and converts it to an integer
      const ints = v => Number.isFinite(+v) ? parseInt(v,10) : 0;

      //enforce moves as an array
      const mov = Array.isArray(moves) ? moves : [];


      if (id) { //, growth=$12, current_pp=$13
        q = `
          UPDATE mg_monsters SET
            owner_id=$2, species_id=$3, nickname=$4,level=$5, xp=$6, hp=$7, max_hp=$8, ability=$9, moves=$10::jsonb, slot=$11, learned_pool=$12, learn_list=$13
          WHERE id=$1
          RETURNING *`;
        console.log(q);
        params = [ id, owner_id, species_id, nickname,
                   ints(level), ints(xp), ints(hp),
                   ints(max_hp), ability, JSON.stringify(mov), ints(slot), learned_pool, learn_list//, growth, ints(current_pp)
        ];
      } else { //, growth, current_pp, learned_pool, learn_list
        q = `
          INSERT INTO mg_monsters
            (owner_id, species_id, nickname, level, xp, hp, max_hp, ability, moves, slot, learned_pool, learn_list)
          VALUES ($2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
          RETURNING *`;
        console.log(q);
        params = [ id, owner_id, species_id, nickname,
                   ints(level), ints(xp), ints(hp),
                   ints(max_hp), ability, JSON.stringify(mov),ints(slot), learned_pool, learn_list //, growth, ints(current_pp)
        ];
      }
    } else {
      return res.status(400).json({ error:'bad_kind' });
    }

    const { rows } = await pool.query(q, params);

    // If content tables changed, refresh the in-memory cache
    if (['effects','bonuses'].includes(kind)) {
      try { await refreshContentCacheFromDB(); } catch(_) {}
    }

    return res.json({ ok:true, row: rows[0] });

  } catch (e) {
    console.error('admin upsert error', e);
    res.status(500).json({ error:'server_error' });
  }
});

// DELETE a record from a database table by id
app.delete('/api/admin/db/:kind/:id', auth, async (req, res) => {
  if (!adminGuard(req, res)) return;
  const kind = String(req.params.kind || '').toLowerCase();
  const meta = CONTENT_TABLES[kind];
  if (!meta) return res.status(400).json({ error: 'bad_kind' });

  // Block deletes on read-only kinds
  if (!meta.writable) {
    return res.status(403).json({ error: 'read_only', message: `The '${kind}' table is view-only.` });
  }
  
  const id = Number(req.params.id || 0);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  try {
    await pool.query(`DELETE FROM ${meta.table} WHERE ${meta.pk}=$1`, [id]);

    if (['effects','bonuses'].includes(kind)) {
      try { await refreshContentCacheFromDB(); } catch(_) {}
    }

    return res.json({ ok:true });
  } catch (e) {
    console.error('admin delete error', e);
    res.status(500).json({ error:'server_error' });
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

// Apply % mods like { PHY:+0.30, DEF:-0.10 } to a derived stat set
function applyStatMods(derived, mods){
  if (!derived) return null;
  const out = { ...derived };
  if (!mods || typeof mods !== 'object') return out;
  const keys = ['HP','PHY','MAG','DEF','RES','SPD','ACC','EVA'];
  for (const k of keys){
    if (typeof mods[k] === 'number'){
      const base = Number(derived[k] || 0);
      const mult = 1 + Number(mods[k]);
      out[k] = Math.max(1, Math.round(base * mult));
    }
  }
  return out;
}

// Get battle-aware stats (derived + any active temporary modifiers)
// side ∈ 'you' | 'enemy'; for enemy we use neutral growth per existing helper
async function getBattleStats(side, b){
  if (side === 'you'){
    const d = await getMonDerivedStats(b.you);
    return applyStatMods(d, b?.mods?.you);
  } else {
    const d = await getEnemyDerivedStats(b.enemy);
    return applyStatMods(d, b?.mods?.enemy);
  }
}

//work out which monster in the player's party is the first not fainted
function firstAliveIndex(party){
  for (let i=0;i<party.length;i++) if ((party[i].hp|0)>0) return i;
  return -1;
}

//return a list of all mosters in the party not fainted
function aliveIndices(party){
  const out=[]; for (let i=0;i<party.length;i++) if ((party[i].hp|0)>0) out.push(i);
  return out;
}

// --- Damage helpers (PHY/MAG vs DEF/RES) ---

//Work out is a move's damage is physical or magical
function moveKind(move){
  const base = (move?.base||'').toLowerCase();
  const stack = Array.isArray(move?.stack) ? move.stack.map(s=>String(s).toLowerCase()) : [];
  if (base === 'status') return 'status';
  if (base === 'physical' || stack.includes('dmg_phys')) return 'physical';
  if (base === 'special'  || stack.includes('dmg_spec')) return 'special';
  // default to physical if unspecified
  return 'physical';
}

//return the current stats for a specific player monster
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

// Return the amount of damage an attack does
async function calcDamage(attackerStats, defenderStats, move, attackerLevel){
  console.log("calcDamage")
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

//return a map of the supplied moves with their ?current? PP 
function makePPMap(moves){
  const map={}; (moves||[]).slice(0,4).forEach(m=>{ map[m.name]= (m.pp|0) || 20; }); return map;
}

//create a monster from scratch when an encounter is triggered
async function buildEnemyFromTile(tile){
  // pick species weighted by base_spawn_rate
  const { rows: speciesRows } = await pool.query(`SELECT id,name,base_spawn_rate FROM mg_species ORDER BY id ASC`);
  
  //if the list of potential species is empty, use this fallback
  if (!speciesRows.length){
    const { id: fallbackId, name: fallbackName } = await ensureMoveRecord(['dmg_phys'], []);
    const maxPP = await getMaxPPForStack(['dmg_phys'], 25);
    return {
      speciesId: 1, name: 'Fieldling', level: 3,
      hp: 20, max_hp: 20,
      moves: [{ move_id: fallbackId, current_pp: maxPP, name_custom: fallbackName }]
    };
  }

  //for each species in the potential list, give a weight
  const weights = speciesRows.map(r => Math.max(0.01, Number(r.base_spawn_rate)||0.05));

  //work out the total of all the wieghts
  const total   = weights.reduce((a,b)=>a+b,0);

  //random number between 0 and total, and use that to pick the species
  let t = Math.random()*total, pick = speciesRows[0];
  for (let i=0;i<weights.length;i++){ if ((t -= weights[i]) <= 0){ pick = speciesRows[i]; break; } }

  // set the starting level of the monster. For now, this is just a random number between 2 and 5
  const level = 2 + Math.floor(Math.random()*3);

  // set the monsters base and derived (levelled-up) stats. Levelled-up stat calculation needs to be revisited
  const srow    = await getSpeciesRow(pick.id);
  const neutral = { HP:1, PHY:1, MAG:1, DEF:1, RES:1, SPD:1, ACC:1, EVA:1 };
  const derived = srow ? deriveStats(srow, neutral, level) : { HP: 16 + level*4 };
  const hp = Math.max(1, derived.HP|0);

  // content pools (from DB)
  const { rows: baseEffRows } = await pool.query(`SELECT code, COALESCE(base_pp, 25) AS base_pp FROM mg_effects WHERE COALESCE(base_flag_eligible,false)=true`);
  const baseEligible = baseEffRows.map(r => String(r.code||'').trim()).filter(Boolean);
  const basePPMap = Object.fromEntries(baseEffRows.map(r => [String(r.code||'').trim(), Number(r.base_pp)||25]));
  const { rows: nonBaseEffRows } = await pool.query(`SELECT code FROM mg_effects WHERE COALESCE(base_flag_eligible,false)=false`);
  const nonBaseEffects = nonBaseEffRows.map(r => String(r.code||'').trim()).filter(Boolean);
  const { rows: bonusRows } = await pool.query(`SELECT code FROM mg_bonuses`);
  const bonusCodes = bonusRows.map(r => String(r.code||'').trim()).filter(Boolean);

  const pickOne = (arr)=> arr[Math.floor(Math.random()*arr.length)];

  // first move: a single base-eligible effect
  const firstBase = baseEligible.length ? pickOne(baseEligible) : 'dmg_phys';
  const firstRec  = await ensureMoveRecord([firstBase], []);
  const firstPP   = basePPMap[firstBase] || await getMaxPPForStack([firstBase], 25);
  const moves = [{ move_id: firstRec.id, current_pp: firstPP, name_custom: firstRec.name }];

  // for each level above 1: 20% new move else add one effect/bonus to an existing move
  const steps = Math.max(0, (level|0)-1);
  for (let i=0;i<steps;i++){
    const doNewMove = Math.random()<0.20 && moves.length<4;

    if (doNewMove && baseEligible.length){
      const b = pickOne(baseEligible);
      const rec = await ensureMoveRecord([b], []);
      const maxPP = basePPMap[b] || await getMaxPPForStack([b], 25);
      moves.push({ move_id: rec.id, current_pp: maxPP, name_custom: rec.name });
      continue;
    }

    // else augment random existing move
    const slot = Math.floor(Math.random()*moves.length);
    const m    = moves[slot];
    const det  = await getMoveDetailsById(m.move_id);
    if (!det) continue;

    let stack = det.stack.slice();
    let bons  = det.bonuses.slice();

    const doEffect = Math.random()<0.5;
    if (doEffect && nonBaseEffects.length){
      const pool = nonBaseEffects.filter(e => e && !stack.includes(e));
      if (pool.length) stack.push(pickOne(pool));
      else if (bonusCodes.length){
        const bpool = bonusCodes.filter(b => b && !bons.includes(b));
        if (bpool.length) bons.push(pickOne(bpool));
      }
    } else if (bonusCodes.length){
      const bpool = bonusCodes.filter(b => b && !bons.includes(b));
      if (bpool.length) bons.push(pickOne(bpool));
      else if (nonBaseEffects.length){
        const pool = nonBaseEffects.filter(e => e && !stack.includes(e));
        if (pool.length) stack.push(pickOne(pool));
      }
    }

    // re-resolve to canonical record (creates it if new); clamp PP
    const rec = await ensureMoveRecord(stack, bons);
    const maxPP = await getMaxPPForStack(stack, m.current_pp||25);
    m.move_id     = rec.id;
    m.current_pp  = Math.min(m.current_pp|0, maxPP|0);
    if (!m.name_custom || !m.name_custom.trim()) m.name_custom = rec.name;
  }

  return { speciesId: pick.id, species_id: pick.id, name: pick.name, level, hp, max_hp: hp, moves };

}

//api call to attrt a new battle
app.post('/api/battle/start', auth, async (req,res)=>{
  try{
    // proactively discard any old battle:
    if (battles.has(req.session.token)) battles.delete(req.session.token);
    
    //get and hold the party details
    const party = await getParty(req.session.player_id);

    //get the first non-fainted party member. If none, end battle
    const idx = firstAliveIndex(party);
    if (idx<0) return res.status(409).json({ error:'you_fainted' });

    //work out where in the world the player is
    const st = await getState(req.session.player_id);
    const tile = (getWorldChunk(st.cx, st.cy)?.tiles?.[st.ty]||[])[st.tx];

    //create an appropriate enemy for the tile the player is on
    const enemy = await buildEnemyFromTile(tile);

    //create an object (you) that is the first active monster in player party
    const you = { ...party[idx] };

    //for the current monster's moves, work out max ppl
    await attachPPToMoves(you);

    //also get the current pp
    const pp = await getCurrentPP(you);
    
    //battle is the return object, containing the important state information for each step of the battle
    const battle = {
      you, enemy, youIndex: idx, pp,
      log:[`A wild ${enemy.name} appears!`],
      allowCapture:false, owner_id:req.session.player_id,
      requireSwitch:false
    };

    //add battle to the battles list
    battles.set(req.session.token, battle);

    res.json({
      you, enemy, youIndex: idx, pp,
      log: battle.log, allowCapture: false, requireSwitch:false
    });
  }catch(e){ res.status(500).json({ error:'server_error' }); }
});


app.post('/api/battle/turn', auth, async (req,res)=>{ //when the player has chosen an action
  try{
    const b = battles.get(req.session.token);
    if (!b) return res.status(404).json({ error:'no_battle' });
    const action = (req.body?.action||'').toLowerCase();
    console.log("/api/battle/turn post called");

    // If your active fainted this round, you must switch before doing anything else
    if (b.requireSwitch && action !== 'switch'){
      console.log("Switch required due to active fainted!");
      return res.status(409).json({ error:'must_switch' });
    }

    // refresh party entry used for "you" (HP may change between turns due to heal, etc.)
    const party = await getParty(req.session.player_id);
    console.log(party);
    let you = party[b.youIndex] || party[firstAliveIndex(party)];
    if (!you) return res.status(409).json({ error:'you_team_wiped' });
    b.you = you; // keep latest
    console.log(b.you);

    if (b.allowCapture) return res.status(409).json({ error:'capture_or_finish' });
    console.log(action);
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
        await attachPPToMoves(b.you);
        return res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:false, requireSwitch:false });
      }
    
      // Normal (non-forced) switch still consumes your turn; enemy may act (as before)
      const curIdx = b.youIndex|0;
      const eEntry = (Array.isArray(b.enemy.moves) && b.enemy.moves[0]) || null;
      const eDet   = eEntry ? await getMoveDetailsById(eEntry.move_id|0) : null;
      const eMove  = eDet
        ? { name: (eEntry?.name_custom && eEntry.name_custom.trim()) ? eEntry.name_custom.trim() : eDet.name,
            base:'physical', power:8, accuracy:0.95, stack: eDet.stack, bonuses: eDet.bonuses, priority:0 }
        : { name:'Strike', base:'physical', power:8, accuracy:0.95, stack:['dmg_phys'], bonuses:[], priority:0 };
      const ePri  = 0;

    
      if (ePri > 0){
        if (eEntry && (eEntry.current_pp|0) <= 0){
          b.log.push(`${b.enemy.name} hesitates (no PP).`);
        } else {
          await resolveMoveStackFor(b.enemy, b.you, eMove, eMove.name, b);
          if (eEntry){ eEntry.current_pp = Math.max(0, (eEntry.current_pp|0) - 1); }

          // Persist your HP once after enemy finishes acting
          await pool.query(
            `UPDATE mg_monsters SET hp=$1 WHERE id=$2 AND owner_id=$3`,
            [b.you.hp|0, b.you.id, req.session.player_id]
          );
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
        if (eEntry && (eEntry.current_pp|0) <= 0){
          b.log.push(`${b.enemy.name} hesitates (no PP).`);
        } else {
          await resolveMoveStackFor(b.enemy, b.you, eMove, eMove.name, b);
          if (eEntry){ eEntry.current_pp = Math.max(0, (eEntry.current_pp|0) - 1); }
          await pool.query(
            `UPDATE mg_monsters SET hp=$1 WHERE id=$2 AND owner_id=$3`,
            [b.you.hp|0, b.you.id, req.session.player_id]
          );
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
      //get the move_id of the move selected
      const moveId = Number(req.body.move_id||0)|0;
      console.log("move ID: "+moveId);
      const yourEntry = (Array.isArray(b.you.moves)?b.you.moves:[]).find(m => (m.move_id|0) === moveId);
      if (!yourEntry) return res.status(400).json({ error:'bad_move' });
      console.log(yourEntry);

      // Load canonical details from DB
      const yourDet = await getMoveDetailsById(yourEntry.move_id);
      if (!yourDet) return res.status(400).json({ error:'move_missing' });
      console.log(yourDet);

      // Compute max PP from the base effect; ensure current_pp is not over cap
      const maxPP = await getMaxPPForStack(yourDet.stack, 25);
      yourEntry.current_pp = Math.min(yourEntry.current_pp|0, maxPP|0);
      console.log(yourEntry);

      // Visible name = player-defined; if blank, fall back to DB name
      const visibleName = (yourEntry.name_custom && yourEntry.name_custom.trim()) ? yourEntry.name_custom.trim() : yourDet.name;

      // Use the monster's own current_pp instead of legacy b.pp
      if ((yourEntry.current_pp|0) <= 0) return res.status(400).json({ error:'no_pp' });

      // This is getting the details of the enemy's move. This will need a lot of work. ###
      // --- Enemy priority check (enemy can act BEFORE you) ---
      const eEntry = (Array.isArray(b.enemy.moves) && b.enemy.moves[0]) || null;
      const eDet   = eEntry ? await getMoveDetailsById(eEntry.move_id|0) : null;
      const eMove  = eDet
        ? { name: (eEntry?.name_custom && eEntry.name_custom.trim()) ? eEntry.name_custom.trim() : eDet.name,
            base:'physical', power:8, accuracy:0.95, stack: eDet.stack, bonuses: eDet.bonuses, priority:0 }
        : { name:'Strike', base:'physical', power:8, accuracy:0.95, stack:['dmg_phys'], bonuses:[], priority:0 };
      const ePri  = 0;

      console.log(eMove);

    
      if (ePri > 0){
        if (eEntry && (eEntry.current_pp|0) <= 0){
          b.log.push(`${b.enemy.name} hesitates (no PP).`);
        } else {
          await resolveMoveStackFor(b.enemy, b.you, eMove, eMove.name, b);

          // Enemy PP (kept in-memory, wilds aren’t persisted for PP)
          if (eEntry){ eEntry.current_pp = Math.max(0, (eEntry.current_pp|0) - 1); }

          // Persist *your* HP once after enemy finishes its action
          await pool.query(
            `UPDATE mg_monsters SET hp=$1 WHERE id=$2 AND owner_id=$3`,
            [b.you.hp|0, b.you.id, req.session.player_id]
          );
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
      if ((yourEntry.current_pp|0) <= 0){
        return res.status(400).json({ error:'no_pp' });
      }


      // Resolve each effect in order (from DB), stop early if enemy faints
      const stackList = Array.isArray(yourDet.stack) ? yourDet.stack.map(String) : [];
      console.log(stackList);

      if (stackList.length === 0){
        // Fallback if a move somehow has no stack: simple 95% hit, fixed power
        console.log("empty stack");
        const fallbackAcc = 0.95;
        if (Math.random() < fallbackAcc){
          const atkStats = await getBattleStats('you', b);
          const defStats = await getBattleStats('enemy', b);

          const tempMove = { name: visibleName, base:'physical', power:8, accuracy:fallbackAcc, stack:['dmg_phys'], bonuses:[] };
          const dmg = await calcDamage(atkStats, defStats, tempMove, b.you.level|0);
          b.enemy.hp = Math.max(0, (b.enemy.hp|0) - dmg);
          b.log.push(`${visibleName} hits for ${dmg}!`);
        } else {
          b.log.push(`${visibleName} missed!`);
        }
      } else {
        // HERE is where Effects are resolved into the move. Check this ###
        console.log("resolve effects");
       // const tempMove = { name: visibleName, accuracy: 0.95, bonuses: yourDet.bonuses, stack: yourDet.stack };
       // for (const effectCode of stackList){
       //   console.log(effectCode)
       //   const out = await resolveSingleEffect(effectCode, tempMove, b.you, b.enemy, b);
          // If the enemy fainted at any point, stop further effects
       //   if ((b.enemy.hp|0) <= 0) break;
       // }
        await resolveMoveStackFor(b.you, b.enemy, yourDet, visibleName, b);

      }
      console.log("Effects Resolved");

      // consume PP from the monster's own move entry
      yourEntry.current_pp = Math.max(0, (yourEntry.current_pp|0) - 1);
      console.log(b.you.moves);
      // persist the whole moves array (minimal objects) back to DB
      //await pool.query(`UPDATE mg_monsters SET moves=$1 WHERE id=$2 AND owner_id=$3`, [b.you.moves, b.you.id, req.session.player_id]);
      
      // Build a clean JSON payload for DB storage
      const movesPayload = (Array.isArray(b.you?.moves) ? b.you.moves : []).map(m => ({
        move_id: (m?.move_id|0) || 0,
        current_pp: (m?.current_pp|0) || 0,
        max_pp: (m?.max_pp|0) || 0,
        name_custom: String(m?.name_custom ?? '').slice(0,120)
      }));

      // Write as JSONB (important: stringify + ::jsonb)
      await pool.query(
        `UPDATE mg_monsters
            SET moves = $1::jsonb
          WHERE id = $2 AND owner_id = $3`,
        [ JSON.stringify(movesPayload), b.you.id|0, req.session.player_id|0 ]
      );
      console.log("pp consumed")

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
        if (eEntry && (eEntry.current_pp|0) <= 0){
          b.log.push(`${b.enemy.name} hesitates (no PP).`);
        } else {
          await resolveMoveStackFor(b.enemy, b.you, eMove, eMove.name, b);

          if (eEntry){ eEntry.current_pp = Math.max(0, (eEntry.current_pp|0) - 1); }

          await pool.query(
            `UPDATE mg_monsters SET hp=$1 WHERE id=$2 AND owner_id=$3`,
            [b.you.hp|0, b.you.id, req.session.player_id]
          );
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
          await attachPPToMoves(b.you);
          return res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:false, requireSwitch:true });
        }
      }
    
      return res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:false });
    } else {
      return res.status(400).json({ error:'bad_action' });
    }

    res.json({ you:b.you, enemy:b.enemy, youIndex:b.youIndex, pp:b.pp, log:b.log, allowCapture:false });
  }catch(e){ 
    res.status(500).json({ error:'server_error' }); 
    console.error("/battle/turn error")
  }
});

app.post('/api/battle/capture', auth, async (req,res)=>{
  try{
    // hold the details of the current battle, or return an error if it doesn't exist or if catpture isn't allowed
    const b = battles.get(req.session.token);
    if (!b) return res.status(404).json({ error:'no_battle' });
    if (!b.allowCapture) return res.status(409).json({ error:'not_allowed' });

    // Placeholder capture odds (we'll swap to the spec formula later)
    const success = Math.random() < 0.6;
    if (!success){
      b.log.push('Capture failed.');
      return res.json({ result:'failed', log:b.log, allowCapture:true });
    }

    // Preserve enemy moves; if none, create a minimal DB-backed move entry
    let fallbackBase = 'dmg_phys';
    try{
      const { rows: baseEffRows } = await pool.query(
        `SELECT code, COALESCE(base_pp,25) AS base_pp
          FROM mg_effects
          WHERE COALESCE(base_flag_eligible,false)=true
          ORDER BY id ASC
          LIMIT 1`
      );
      if (baseEffRows.length) fallbackBase = String(baseEffRows[0].code||fallbackBase).trim() || fallbackBase;
    }catch(_){ /* keep default */ }

    const fallbackRec = await ensureMoveRecord([fallbackBase], []);
    const fallbackPP  = await getMaxPPForStack([fallbackBase], 25);
    const moves = Array.isArray(b.enemy.moves) && b.enemy.moves.length
      ? b.enemy.moves
      : [{ move_id: fallbackRec.id, current_pp: fallbackPP, name_custom: fallbackRec.name }];

    // Compute growth and derived HP for the captured species/level (should this really be done here?)
    // I think this should be done when monster is created, and persist
    const capSpeciesId = b.enemy.speciesId|0;
    const capLevel     = b.enemy.level|0;
    const capSrow      = await getSpeciesRow(capSpeciesId);
    const capGrowth    = randomGrowth();
    const capDerived   = capSrow ? deriveStats(capSrow, capGrowth, capLevel)
                                 : { HP: Math.max(12, b.enemy.max_hp|0) };

    //insert the new mon into the db monsters table. ### need to add abilities
    await pool.query(`
      INSERT INTO mg_monsters (owner_id,species_id,level,xp,hp,max_hp,ability,moves,growth)
      VALUES ($1,$2,$3,0,$4,$4,'',$5,$6)
    `, [
      req.session.player_id,
      capSpeciesId,
      capLevel,
      Math.max(1, capDerived.HP|0),
      JSON.stringify(moves),
      JSON.stringify(capGrowth)
    ]);

    //make sure the monster has learned all the effects and bonuses it already knows
    const newId = ins.rows[0]?.id|0;
    if (newId) {
      console.log("api battle capture effects learned from moves");
      try { await syncMonsterLearnedFromMoves(newId); } catch(_){}
    }

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
