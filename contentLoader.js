// contentLoader.js
const fs = require('fs');
const path = require('path');

function readCSV(filePath){
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  const lines = raw.split(/\r?\n/);
  const headers = lines.shift().split(',').map(h => h.trim());
  return lines
    .filter(Boolean)
    .map(line => {
      // NOTE: simple CSV split; if you need quoted commas later we can swap for a library
      const cells = line.split(',').map(c => c.trim());
      const row = {};
      headers.forEach((h, i) => row[h] = cells[i] ?? '');
      return row;
    });
}

function asStringArray(list, key){
  // Export a simple array of codes/names for the current UI
  const out = [];
  for (const row of list){
    const v = String(row[key] || '').trim();
    if (v) out.push(v);
  }
  // unique + stable order
  return Array.from(new Set(out));
}

function loadAllContent(contentDir = path.join(__dirname, 'content')){
  const exists = fs.existsSync(contentDir);
  if (!exists) throw new Error(`Content directory not found: ${contentDir}`);

  const out = {};

  // Effects: expect a 'code' column (e.g. dmg_phys, buff_def, stun, dot_poison)
  const effectsCsv = path.join(contentDir, 'effects.csv');
  if (fs.existsSync(effectsCsv)) {
    out.effects = readCSV(effectsCsv);
    out.effect_codes = asStringArray(out.effects, 'code');
  } else {
    out.effects = []; out.effect_codes = [];
  }

  // Bonuses: expect a 'code' column (e.g. high_crit, pierce_armor, accuracy_up, element_fire, pp_plus_1)
  const bonusesCsv = path.join(contentDir, 'bonuses.csv');
  if (fs.existsSync(bonusesCsv)) {
    out.bonuses = readCSV(bonusesCsv);
    out.bonus_codes = asStringArray(out.bonuses, 'code');
  } else {
    out.bonuses = []; out.bonus_codes = [];
  }

  // Named moves (optional for now): expect 'name','stack_effects','stack_bonuses'
  const namedCsv = path.join(contentDir, 'moves_named.csv');
  if (fs.existsSync(namedCsv)) {
    out.named_moves = readCSV(namedCsv);
  } else {
    out.named_moves = [];
  }

  // Abilities (optional for now)
  const abilitiesCsv = path.join(contentDir, 'abilities.csv');
  if (fs.existsSync(abilitiesCsv)) {
    out.abilities = readCSV(abilitiesCsv);
  } else {
    out.abilities = [];
  }

  // If you later want species from file (instead of DB), drop a species.csv and parse here.

  // Minimal pool for the current move editor UI
  out.pool = {
    effects: out.effect_codes,   // flat list for checkboxes
    bonuses: out.bonus_codes
  };

  // Timestamp so the client can cache-bust
  out.version = Date.now();

  return out;
}

let cache = null;

function getContent(){ return cache; }
function reloadContent(dir){ cache = loadAllContent(dir); return cache; }

module.exports = { getContent, reloadContent };
