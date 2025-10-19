
(function(){
  const api = window.MGGameConfig.api;
  const wsURL = window.MGGameConfig.ws;

  const elAuth = document.getElementById('auth');
  const elMsg = document.getElementById('authMsg');
  const email = document.getElementById('email');
  const pw = document.getElementById('password');
  const handle = document.getElementById('handle');
  const btnRegister = document.getElementById('btnRegister');
  const btnLogin = document.getElementById('btnLogin');
  const canvas = document.getElementById('view');
  const ctx = canvas.getContext('2d');

  let token = null;
  let ws = null;
  let player = null;
  let currentChunk = null;

  async function post(path, body) {
    const res = await fetch(api + path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'error');
    return json;
  }

  btnRegister.onclick = async () => {
    try {
      const j = await post('/api/register', { email: email.value, password: pw.value, handle: handle.value });
      token = j.token; player = j.player;
      elMsg.textContent = 'Registered!';
      await startGame();
    } catch(e) { elMsg.textContent = e.message; }
  };

  btnLogin.onclick = async () => {
    try {
      const j = await post('/api/login', { email: email.value, password: pw.value });
      token = j.token; player = j.player;
      elMsg.textContent = 'Logged in!';
      await startGame();
    } catch(e) { elMsg.textContent = e.message; }
  };

  async function startGame(){
    elAuth.style.display = 'none';
    canvas.style.display = 'block';
    await fetchChunk(player.cx, player.cy);
    openWS();
    draw();
    window.addEventListener('keydown', onKey);
  }

  async function fetchChunk(cx, cy) {
    const res = await fetch(api + `/api/chunk?x=${cx}&y=${cy}`, { headers: { Authorization: token }});
    const json = await res.json();
    currentChunk = json.chunk;
  }

  function openWS(){
    ws = new WebSocket(wsURL);
    ws.onopen = () => ws.send(JSON.stringify({ type:'auth', token }));
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'moved') {
        player = msg.player;
        currentChunk = msg.chunk.chunk;
      }
    };
  }

  function onKey(e){
    if (!ws) return;
    const k = e.key.toLowerCase();
    if (k === 'arrowup' || k === 'w') ws.send(JSON.stringify({ type:'move', dy:-1 }));
    if (k === 'arrowdown' || k === 's') ws.send(JSON.stringify({ type:'move', dy:1 }));
    if (k === 'arrowleft' || k === 'a') ws.send(JSON.stringify({ type:'move', dx:-1 }));
    if (k === 'arrowright' || k === 'd') ws.send(JSON.stringify({ type:'move', dx:1 }));
  }

  function draw(){
    requestAnimationFrame(draw);
    if (!currentChunk) return;
    const w = currentChunk.w, h = currentChunk.h;
    const scale = 2;
    const vw = Math.min(canvas.width, w);
    const vh = Math.min(canvas.height, h);
    // quick render of a 128x96 slice around the player
    ctx.clearRect(0,0,canvas.width,canvas.height);
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 128; x++) {
        const tx = Math.max(0, Math.min(w-1, x));
        const ty = Math.max(0, Math.min(h-1, y));
        const t = currentChunk.tiles[ty][tx];
        ctx.fillStyle = colorForBiome(t.biome);
        ctx.fillRect(x*scale, y*scale, scale, scale);
      }
    }
  }

  function colorForBiome(b){
    switch(b){
      case 'grassland': return '#2c6';
      case 'forest': return '#184';
      case 'mountain': return '#777';
      case 'river': return '#25a';
      case 'ocean': return '#147';
      case 'town': return '#aa7';
      default: return '#333';
    }
  }
})();
