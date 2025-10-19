
class Player {
  constructor(handle, token) {
    this.handle = handle;
    this.token = token;
    // start in chunk 0,0
    this.cx = 0;
    this.cy = 0;
    this.tx = 128; // tile x in chunk
    this.ty = 128; // tile y in chunk
    this.party = [];
  }

  move(dx, dy) {
    this.tx += dx;
    this.ty += dy;
    if (this.tx < 0) { this.tx = 255; this.cx -= 1; }
    if (this.tx > 255) { this.tx = 0; this.cx += 1; }
    if (this.ty < 0) { this.ty = 255; this.cy -= 1; }
    if (this.ty > 255) { this.ty = 0; this.cy += 1; }
  }

  toJSON() {
    return {
      handle: this.handle,
      cx: this.cx, cy: this.cy,
      tx: this.tx, ty: this.ty,
      party: this.party.map(m => m.toJSON()),
    };
  }
}

module.exports = Player;
