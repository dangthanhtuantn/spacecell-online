const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket']
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Constants ─────────────────────────────────────────────────
const GW = 10000, GH = 10000;
const FOOD_COUNT = 800;           // ← GIẢM MẠNH
const BOT_COUNT = 20;
const TICK_MS = 33;               // ← 30 FPS (đủ mượt, tiết kiệm CPU)
const ITEM_MAX = 10;
const WORLD_UPDATE_MS = 500;
const VIEW_BUFFER = 900;          // buffer ngoài viewport

// ── Spatial Grid (đã có sẵn, rất tốt) ────────────────────────
const GRID_SIZE = 500;
const GRID_COLS = Math.ceil(GW / GRID_SIZE);
const GRID_ROWS = Math.ceil(GH / GRID_SIZE);
let foodGrid = [];

function buildFoodGrid() { /* giữ nguyên như cũ */ 
  foodGrid = Array.from({length: GRID_COLS}, () => Array(GRID_ROWS).fill().map(()=>[]));
  food.forEach((f, i) => {
    const c = Math.floor(f.x / GRID_SIZE);
    const r = Math.floor(f.y / GRID_SIZE);
    if (c >= 0 && c < GRID_COLS && r >= 0 && r < GRID_ROWS) foodGrid[c][r].push(i);
  });
}

function nearbyFood(x, y, radius) { /* giữ nguyên như cũ */ 
  const result = [];
  const c0 = Math.max(0, Math.floor((x - radius) / GRID_SIZE));
  const c1 = Math.min(GRID_COLS - 1, Math.floor((x + radius) / GRID_SIZE));
  const r0 = Math.max(0, Math.floor((y - radius) / GRID_SIZE));
  const r1 = Math.min(GRID_ROWS - 1, Math.floor((y + radius) / GRID_SIZE));
  for (let c = c0; c <= c1; c++) {
    for (let r = r0; r <= r1; r++) {
      result.push(...foodGrid[c][r]);
    }
  }
  return result;
}

// ── Helpers (giữ nguyên) ─────────────────────────────────────
const rnd = (a, b) => Math.random() * (b - a) + a;
const dst = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mtr = m => Math.sqrt(m) * 1.5 + 3;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
function speedMult(mass) { /* giữ nguyên */ 
  if (mass >= 10000) return Math.pow(0.9, 5);
  if (mass >= 5000)  return Math.pow(0.9, 4);
  if (mass >= 2000)  return Math.pow(0.9, 3);
  if (mass >= 1000)  return Math.pow(0.9, 2);
  if (mass >= 500)   return Math.pow(0.9, 1);
  return 1;
}
function baseSpd(mass) { return 5 * speedMult(mass); }

// Food & Item (giữ nguyên)
const FOOD_SIZES = [ /* giữ nguyên */ ];
function mkFood() { /* giữ nguyên */ }
const ITEM_TYPES = ['DASH','SHIELD','STEALTH','GROW1','GROW2','GROW5','MAGNET','TOXIC','BOMB'];
const ITEM_COLS  = { /* giữ nguyên */ };
const BNAMES = ['Orion','Lyra','Nebula','Vega','Pulsar','Quasar','Sirius','Nova','Titan','Andromeda','Zeta','Rigel','Spica','Altair','Deneb'];
const BCOLS  = ['#f55','#f90','#ff4','#4f4','#4cf','#f4f','#fa4','#5fa','#f5a','#af5','#5af','#ff8','#f64','#6f4','#46f'];

let _id = 0;
const uid = () => (++_id).toString(36);

// ── State ─────────────────────────────────────────────────────
let players = {}, bots = [], food = [], items = [], bullets = [];
let foodGridDirty = true;

function initWorld() {
  food = Array.from({ length: FOOD_COUNT }, mkFood);
  items = [];
  ITEM_TYPES.forEach(t => { for (let i = 0; i < ITEM_MAX; i++) spawnItem(t); });
  bots = Array.from({ length: BOT_COUNT }, (_, i) => mkBot(i));
  bullets = [];
  buildFoodGrid();
}

function spawnItem(t) { /* giữ nguyên */ }
function schedRespawn(t) { setTimeout(() => spawnItem(t), 15000); }

function mkBot(i) {
  return { id: 'b'+i, x: rnd(500,GW-500), y: rnd(500,GH-500), mass: rnd(15,80), vx:0, vy:0,
    col: BCOLS[i%15], name: BNAMES[i%15]+(i>=15?'_'+(i/15|0):''),
    atx: rnd(0,GW), aty: rnd(0,GH), at: 0, st: 0, nextAI: 0 };   // ← thêm nextAI
}

function mkPlayer(id, name, color, flag, screenW, screenH) {
  return { id, name:name||'Player', color:color||'#00cfff', flag:flag||null,
    x:rnd(500,GW-500), y:rnd(500,GH-500), mass:10, vx:0, vy:0,
    shieldEnd:0, stealthEnd:0, _dashFrames:0, _dashNx:0, _dashNy:0,
    inv:{dash:0,shield:0,stealth:0,bomb:0,magnet:0},
    cdQ:0, cdW:0, cdR:0, cdB:0, cdF:0, _lastShot:0, alive:true,
    screenW: screenW || 1920, screenH: screenH || 1080 };   // ← lưu screen size
}

// ── Sockets ───────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[+]', socket.id);

  socket.on('join', ({ name, color, flag, screenW, screenH }) => {
    players[socket.id] = mkPlayer(socket.id, name, color, flag, screenW, screenH);
    socket.emit('init', { id: socket.id, food, items, bots: bots.map(b => ({id:b.id,x:b.x,y:b.y,mass:b.mass,col:b.col,name:b.name})), worldW: GW, worldH: GH });
    socket.emit('worldUpdate', { food, items });
    io.emit('playerList', playerList());
  });

  socket.on('input', ({ vx, vy }) => { /* giữ nguyên */ });
  socket.on('dash', ({ nx, ny }) => { /* giữ nguyên */ });
  socket.on('shield', () => { /* giữ nguyên */ });
  socket.on('stealth', () => { /* giữ nguyên */ });
  socket.on('bomb', ({ nx, ny }) => { /* giữ nguyên */ });
  socket.on('magnet', () => { /* giữ nguyên */ });
  socket.on('shoot', ({ nx, ny }) => { /* giữ nguyên */ });
  socket.on('ping', () => socket.emit('pong_reply'));
  socket.on('disconnect', () => {
    delete players[socket.id];
    io.emit('playerList', playerList());
  });
});

function playerList() { /* giữ nguyên */ }
function bs(b) { /* giữ nguyên */ }

// ── Game loop (TICK 33ms) ─────────────────────────────────────
const DT = TICK_MS / 16.67;

setInterval(() => {
  const now = Date.now();
  const pArr = Object.values(players);

  // Players + Eat + Pickup (giữ nguyên logic)
  pArr.forEach(p => { /* giữ nguyên toàn bộ phần player update */ });

  // PvP (giữ nguyên)
  pArr.forEach(p => { /* giữ nguyên */ });

  // Bullets (giữ nguyên)
  const dead = new Set();
  /* ... giữ nguyên bullets logic ... */
  bullets = bullets.filter(b => !dead.has(b.id));

  // ── Bots AI (throttle) ─────────────────────────────────────
  bots.forEach(bot => {
    bot.nextAI -= DT;
    if (bot.nextAI <= 0) {
      bot.nextAI = rnd(25, 35);   // chỉ quyết định mỗi ~400-500ms
      bot.at = 0;  // trigger AI ngay
    }

    bot.at -= DT; bot.st -= DT;
    if (bot.at <= 0) {
      bot.at = rnd(20, 60);
      /* ... toàn bộ code tìm target (flee + food + hunt) giữ nguyên ... */
    }
    /* ... phần di chuyển + eat + PvP + shoot + TOXIC giữ nguyên ... */
  });

  if (foodGridDirty) { buildFoodGrid(); foodGridDirty = false; }

  // ── BROADCAST VỚI VIEWPORT CULLING (quan trọng nhất) ───────
  pArr.forEach(p => {
    const socket = io.sockets.sockets.get(p.id);
    if (!socket) return;

    const halfW = (p.screenW / 2) + VIEW_BUFFER;
    const halfH = (p.screenH / 2) + VIEW_BUFFER;

    const left   = p.x - halfW;
    const right  = p.x + halfW;
    const top    = p.y - halfH;
    const bottom = p.y + halfH;

    const visiblePlayers = pArr.filter(q => 
      q.id !== p.id && 
      q.x > left && q.x < right && q.y > top && q.y < bottom
    );

    const visibleBots = bots.filter(b => 
      b.x > left && b.x < right && b.y > top && b.y < bottom
    );

    const visibleBullets = bullets.filter(b => 
      b.x > left && b.x < right && b.y > top && b.y < bottom
    );

    const state = {
      players: visiblePlayers.map(q => ({ 
        id:q.id, name:q.name, color:q.color, flag:q.flag,
        x:q.x, y:q.y, mass:q.mass,
        shielded: now < q.shieldEnd,
        stealthed: now < q.stealthEnd,
        inv:q.inv, cdQ:q.cdQ, cdW:q.cdW, cdR:q.cdR, cdB:q.cdB, cdF:q.cdF 
      })),
      bots: visibleBots.map(b => ({id:b.id, x:b.x, y:b.y, mass:b.mass, col:b.col, name:b.name})),
      bullets: visibleBullets.map(b => ({id:b.id, x:b.x, y:b.y, r:b.r, col:b.col, type:b.type}))
    };

    socket.emit('state', state);
  });

}, TICK_MS);

// World update + Leaderboard (giữ nguyên)
setInterval(() => { io.emit('worldUpdate', { food, items }); }, WORLD_UPDATE_MS);
setInterval(() => { io.emit('playerList', playerList()); }, 2000);

initWorld();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 SpaceCell Optimized at http://localhost:${PORT}`));