// world.js — coherent, continuous worldgen with biomes, rivers, towns, z-hints
// Matches design: server-authoritative chunks; continuity across borders; encounter rates by biome.

const CHUNK_W = 256;
const CHUNK_H = 256;

// ---- Deterministic RNG per world coordinate ----
function hash2i(x, y) {
  // 32-bit mix; stable across runtime
  let h = x | 0;
  h = Math.imul(h ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  h = (h + Math.imul((y | 0) ^ 0x9e3779b9, 0x85ebca6b)) | 0;
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return h >>> 0;
}
function rand01(x, y, seed = 1337) {
  const h = hash2i(x + seed * 131, y - seed * 73);
  return (h & 0xffffff) / 0x1000000;
}

// ---- 2D value noise (smooth-ish) without external libs ----
function lerp(a,b,t){ return a + (b-a)*t; }
function fade(t){ return t*t*(3 - 2*t); } // smootherstep-ish
function valueNoise2D(wx, wy, scale, seed){
  // sample on integer grid in "noise space"
  const nx = wx / scale, ny = wy / scale;
  const x0 = Math.floor(nx), y0 = Math.floor(ny);
  const xf = nx - x0,     yf = ny - y0;
  const v00 = rand01(x0,   y0,   seed);
  const v10 = rand01(x0+1, y0,   seed);
  const v01 = rand01(x0,   y0+1, seed);
  const v11 = rand01(x0+1, y0+1, seed);
  const u = fade(xf), v = fade(yf);
  const a = lerp(v00, v10, u);
  const b = lerp(v01, v11, u);
  return lerp(a, b, v);
}
function fbm(wx, wy, seed, octaves, baseScale, gain=0.5, lacunarity=2.0){
  let amp=1, freq=1/baseScale, sum=0, norm=0;
  for (let i=0;i<octaves;i++){
    sum += amp * valueNoise2D(wx, wy, 1/freq, seed + i*97);
    norm += amp;
    amp *= gain; freq *= lacunarity;
  }
  return sum / (norm || 1);
}

// ---- Biome field masks ----
// Height controls ocean/coast/mountain. Moisture separates forest vs grassland. Town mask sparsely marks settlements.
function sampleFields(wx, wy){
  const height   = fbm(wx, wy, 101, 5, 220, 0.55, 2.05);   // 0..1
  const moisture = fbm(wx+9999, wy-7777, 202, 4, 280, 0.6, 2.1);
  const townmask = fbm(wx-32123, wy+54321, 303, 3, 1200, 0.45, 2.2);
  return { height, moisture, townmask };
}

// ---- River routing using gradient descent on height ----
function generateRiversInChunk(cx, cy, tiles, heightFn){
  const W = CHUNK_W, H = CHUNK_H;
  // Start a few candidate sources in highlands and let them flow downhill.
  const seeds = 6;
  for (let i=0;i<seeds;i++){
    const sx = Math.floor((i+1) * W/(seeds+1));
    const sy = Math.floor( ( (i&1)? H*0.3 : H*0.7 ) );
    let wx = cx*W + sx, wy = cy*H + sy;

    // only start if height is relatively high
    if (heightFn(wx,wy) < 0.55) continue;

    let x = sx, y = sy, steps = 0, lastH = heightFn(wx,wy);
    while (steps < W + H) {
      // mark current as river
      tiles[y][x].biome = (tiles[y][x].biome === 'ocean') ? 'ocean' : 'river';
      tiles[y][x].encounterRate = Math.max(tiles[y][x].encounterRate, 0.09); // rivers are lively
      // step to neighbor with lowest height (downhill)
      let best = { x, y, h: lastH, dx:0, dy:1 };
      for (let dy=-1; dy<=1; dy++){
        for (let dx=-1; dx<=1; dx++){
          if (!dx && !dy) continue;
          const nx = x+dx, ny = y+dy;
          if (nx<0||ny<0||nx>=W||ny>=H) continue;
          const nwx = cx*W + nx, nwy = cy*H + ny;
          const h = heightFn(nwx, nwy);
          if (h <= best.h) best = { x:nx, y:ny, h, dx, dy };
        }
      }
      x = best.x; y = best.y; wx = cx*W + x; wy = cy*H + y; lastH = best.h; steps++;
      // stop if we reached ocean-level
      if (lastH < 0.35) break;
      // small chance to stop early to create lakes
      if (steps > 40 && Math.random() < 0.02) break;
      // exit if on border; river will continue in adjacent chunk when that chunk is generated
      if (x===0||y===0||x===W-1||y===H-1) break;
    }
  }
}

// ---- Town stamping (sparse; expands later with growth/decay systems) ----
function stampTown(tiles, cx, cy, wx, wy){
  const W = CHUNK_W, H = CHUNK_H;
  // center near (wx,wy) local to chunk
  const lx = wx - cx*W, ly = wy - cy*H;
  const size = 10 + Math.floor(rand01(wx, wy, 888)*14); // ~10-24 tiles radius-ish footprint
  
  for (let y=-size; y<=size; y++){
    for (let x=-size; x<=size; x++){
      const tx = lx + x, ty = ly + y;
      if (tx<0||ty<0||tx>=W||ty>=H) continue;
      const d = Math.hypot(x,y);
      if (d < size * (0.6 + rand01(wx+x, wy+y, 777)*0.25)) {
        tiles[ty][tx].biome = 'town';
        tiles[ty][tx].encounterRate = 0.01; // very low in town outdoors as per design
        tiles[ty][tx].z = 0;
      }
    }
  }
}

// ---- Main chunk generator ----
function generateChunk(cx, cy){
  const tiles = new Array(CHUNK_H);
  const W = CHUNK_W, H = CHUNK_H;

  // helper to read height via fields
  const heightAt = (wx,wy)=> sampleFields(wx,wy).height;

  for (let y=0;y<H;y++){
    tiles[y] = new Array(W);
    for (let x=0;x<W;x++){
      const wx = cx*W + x, wy = cy*H + y;
      const { height, moisture, townmask } = sampleFields(wx, wy);

      // Base biome thresholds (tunable; ensure continuity)
      let biome = 'grassland';
      if (height < 0.34){
        biome = 'ocean';
      } else if (height > 0.72){
        biome = 'mountain';
      } else {
        // land band — forest vs grassland by moisture
        biome = (moisture > 0.55) ? 'forest' : 'grassland';
      }

      // encounter rates per biome (can be tweaked later)
      let encounterRate = 0.08; // default wilderness
      if (biome === 'ocean')    encounterRate = 0.06;
      if (biome === 'forest')   encounterRate = 0.10;
      if (biome === 'mountain') encounterRate = 0.09;

      // z-hints: ocean < 1, mountains vary, others mild
      let z = 0;
      if (biome === 'ocean') z = -1;
      else if (biome === 'mountain') z = (height > 0.82)? 3 : (height > 0.77 ? 2 : 1);
      else if (biome === 'forest')    z = (rand01(wx,wy,404) < 0.1) ? 1 : 0;

      tiles[y][x] = { biome, z, encounterRate };
    }
  }

  // Rivers: carve after base biomes so they overwrite land to 'river'
  generateRiversInChunk(cx, cy, tiles, heightAt);

  // Towns: sparse placement; not contagious to adjacent chunk automatically (growth later)
  // Chance magnitude can be tuned; start rare
  const wxCenter = cx*W + Math.floor(W/2), wyCenter = cy*H + Math.floor(H/2);
  const { townmask } = sampleFields(wxCenter, wyCenter);
  const townChance = (townmask > 0.73) ? 0.06 : (townmask > 0.67 ? 0.03 : 0.0);
  if (townChance > 0 && Math.random() < townChance){
    // pick a dry, non-mountain, non-ocean local spot
    let placed = false;
    for (let i=0;i<8 && !placed;i++){
      const rx = Math.floor(W* (0.25 + Math.random()*0.5));
      const ry = Math.floor(H* (0.25 + Math.random()*0.5));
      if (tiles[ry][rx].biome !== 'ocean' && tiles[ry][rx].biome !== 'mountain' && tiles[ry][rx].biome !== 'river'){
        stampTown(tiles, cx, cy, cx*W + rx, cy*H + ry);
        placed = true;
      }
    }
  }

  // Return with width/height and tiles array
  return { w: W, h: H, tiles };
}

module.exports = {
  CHUNK_W, CHUNK_H,
  generateChunk
};

