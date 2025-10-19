class Monster{
  constructor(speciesId, level){
    this.speciesId=speciesId; this.level=level;
    this.stats={ HP:40+level*3, PHY:10, MAG:10, DEF:10, RES:10, SPD:10, ACC:95, EVA:5 };
    this.currentHP=this.stats.HP; this.status=null;
    this.moves=[]; this.ability=null;
  }
  toJSON(){ return { speciesId:this.speciesId, level:this.level, stats:this.stats, currentHP:this.currentHP, status:this.status, moves:this.moves, ability:this.ability }; }
}
module.exports = Monster;
