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

  const moves = Array.isArray(mon.moves) ? mon.moves : [];
  const effectCodes = new Set();
  const bonusCodes  = new Set();

  for (const m of moves){
    const mid = m && m.move_id ? (m.move_id|0) : 0;
    if (!mid) continue;
    const det = await getMoveDetailsById(mid);
    if (!det) continue;
    // include ALL effects in the move's stack (base + additions) and all bonuses
    for (const e of (det.stack||[])){ if (e) effectCodes.add(String(e).trim()); }
    for (const b of (det.bonuses||[])){ if (b) bonusCodes.add(String(b).trim()); }
  }

  // Add to learned_pool at 100, remove from learn_list if present
  for (const code of effectCodes){
    learnedPool.effects[code] = 100;
    if (learnList.effects[code] != null) delete learnList.effects[code];
  }
  for (const code of bonusCodes){
    learnedPool.bonuses[code] = 100;
    if (learnList.bonuses[code] != null) delete learnList.bonuses[code];
  }

  await learnedPool.query(`UPDATE mg_monsters SET learned_pool=$1, learn_list=$2 WHERE id=$3`,
    [JSON.stringify(learnedPool), JSON.stringify(learnList), monId|0]);
}
