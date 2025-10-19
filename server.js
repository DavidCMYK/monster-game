const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const cors = require('cors');

const world = require('./world');
const Player = require('./player');
const Monster = require('./monster');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(bodyParser.json());

app.get('/', (req,res) => res.type('text').send('Monster Game API online. Try /api/health'));

const players = new Map();
const accounts = new Map();
function token(){ return 't-' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

app.post('/api/register', (req,res)=>{
  const { email, password, handle } = req.body || {};
  if (!email || !password || !handle) return res.status(400).json({ error: 'Missing fields' });
  if (accounts.has(email)) return res.status(409).json({ error: 'Email already exists' });
  accounts.set(email, { email, passwordHash: password, handle });
  const t = token(); const p = new Player(handle, t); players.set(t,p);
  res.json({ token:t, player:p.toJSON() });
});
app.post('/api/login', (req,res)=>{
  const { email, password } = req.body || {};
  const acc = accounts.get(email);
  if (!acc || acc.passwordHash !== password) return res.status(401).json({ error:'Invalid credentials' });
  const t = token(); const p = new Player(acc.handle, t); players.set(t,p);
  res.json({ token:t, player:p.toJSON() });
});

function auth(req,res,next){
  const t = req.headers.authorization || req.query.token;
  if (!t || !players.has(t)) return res.status(401).json({ error:'Auth required' });
  req.player = players.get(t); next();
}

app.get('/api/health', (req,res)=>res.json({ ok:true }));
app.get('/api/me', auth, (req,res)=>res.json(req.player.toJSON()));
app.get('/api/chunk', auth, (req,res)=>{
  const x = parseInt(req.query.x || '0', 10);
  const y = parseInt(req.query.y || '0', 10);
  const chunk = world.generateChunk(x,y);
  res.json({ x,y, chunk });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });
wss.on('connection', (ws)=>{
  ws.isAlive = true;
  ws.on('pong', ()=>ws.isAlive = true);
  ws.on('message', (message)=>{
    let msg; try{ msg = JSON.parse(message); }catch(e){ return ws.send(JSON.stringify({ type:'error', error:'bad_json' })); }
    if (msg.type === 'auth'){
      const p = players.get(msg.token);
      if (!p) return ws.send(JSON.stringify({ type:'error', error:'invalid_token' }));
      ws.player = p;
      ws.send(JSON.stringify({ type:'auth_ok', player:p.toJSON() }));
      return;
    }
    if (!ws.player) return ws.send(JSON.stringify({ type:'error', error:'unauthenticated' }));
    if (msg.type === 'move'){
      const dx = Math.max(-1, Math.min(1, msg.dx || 0));
      const dy = Math.max(-1, Math.min(1, msg.dy || 0));
      ws.player.move(dx, dy);
      const { cx, cy } = ws.player;
      const chunk = world.generateChunk(cx, cy);
      ws.send(JSON.stringify({ type:'moved', player:ws.player.toJSON(), chunk:{ cx, cy, chunk } }));
      return;
    }
    ws.send(JSON.stringify({ type:'error', error:'unknown_msg' }));
  });
});
setInterval(()=>{
  wss.clients.forEach(ws=>{ if (!ws.isAlive) return ws.terminate(); ws.isAlive=false; ws.ping(); });
}, 30000);
const PORT = process.env.PORT || 3001;
server.listen(PORT, ()=>console.log('Monster game server listening on :' + PORT));
