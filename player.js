const { CHUNK_W, CHUNK_H } = require('./world');
class Player{
  constructor(handle, token){
    this.handle=handle; this.token=token;
    this.cx=0; this.cy=0;
    this.tx=Math.floor(CHUNK_W/2); this.ty=Math.floor(CHUNK_H/2);
    this.party=[];
  }
  move(dx,dy){
    this.tx += dx; this.ty += dy;
    if (this.tx < 0){ this.tx = CHUNK_W-1; this.cx -= 1; }
    if (this.tx >= CHUNK_W){ this.tx = 0; this.cx += 1; }
    if (this.ty < 0){ this.ty = CHUNK_H-1; this.cy -= 1; }
    if (this.ty >= CHUNK_H){ this.ty = 0; this.cy += 1; }
  }
  toJSON(){ return { handle:this.handle, cx:this.cx, cy:this.cy, tx:this.tx, ty:this.ty, party:this.party }; }
}
module.exports = Player;
