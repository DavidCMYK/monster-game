const CHUNK_W = 256;
const CHUNK_H = 256;

function seedForChunk(x,y){ let s = (x*73856093) ^ (y*19349663) ^ 0x9e3779b9; return s>>>0; }
function rng(seed){ let a = seed>>>0; return ()=>{ a^=a<<13; a>>>=0; a^=a>>17; a>>>=0; a^=a<<5; a>>>=0; return a/0xffffffff; }; }
function choose(r, list){ const t=r(); let acc=0; for(const [val,w] of list){ acc+=w; if(t<=acc) return val; } return list[list.length-1][0]; }

function generateChunk(cx,cy){
  const r=rng(seedForChunk(cx,cy));
  const pool=[ ['grassland',0.35],['forest',0.25],['mountain',0.15],['river',0.10],['ocean',0.05],['town',0.10] ];
  const tiles=new Array(CHUNK_H);
  for(let y=0;y<CHUNK_H;y++){
    tiles[y]=new Array(CHUNK_W);
    for(let x=0;x<CHUNK_W;x++){
      const biome=choose(r,pool);
      tiles[y][x] = { biome, z: biome==='ocean'?-1:(r()<0.1?1:0), encounterRate: biome==='town'?0.01:0.08 };
    }
  }
  const encounterTable = [
    { speciesId: 1, baseSpawnRate: 0.14, biomes: ['grassland','forest'] },
    { speciesId: 2, baseSpawnRate: 0.10, biomes: ['river','ocean'] },
    { speciesId: 4, baseSpawnRate: 0.08, biomes: ['mountain','grassland'] }
  ];
  return { w:CHUNK_W, h:CHUNK_H, tiles, encounterTable };
}

module.exports = { CHUNK_W, CHUNK_H, seedForChunk, generateChunk };


