const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ── World constants ───────────────────────────────────────────
const CELL = 1000, GRID = 10;
const GW = CELL * GRID, GH = CELL * GRID;
const FOOD_COUNT = 5000;
const BOT_COUNT = 50;
const TICK_MS = 1000 / 60;
const ITEM_MAX = 30;
const FOOD_SIZES = [
  { mass: 5,   r: 3, w: 50 },
  { mass: 10,  r: 4, w: 25 },
  { mass: 20,  r: 5, w: 15 },
  { mass: 50,  r: 7, w: 5  },
  { mass: 100, r: 10,w: 5  },
];
const ITEM_TYPES = ['DASH','SHIELD','STEALTH','GROW1','GROW2','GROW5','MAGNET','TOXIC','BOMB'];
const ITEM_COLS  = { DASH:'#0cf',SHIELD:'#88f',STEALTH:'#ccc',GROW1:'#4f4',GROW2:'#2d2',GROW5:'#1a1',MAGNET:'#f0f',TOXIC:'#8f0',BOMB:'#f80' };
const BNAMES = ['Orion','Lyra','Nebula','Vega','Pulsar','Quasar','Sirius','Nova','Titan','Andromeda','Zeta','Rigel','Spica','Altair','Deneb'];
const BCOLS  = ['#f55','#f90','#ff4','#4f4','#4cf','#f4f','#fa4','#5fa','#f5a','#af5','#5af','#ff8','#f64','#6f4','#46f'];

// ── Helpers ───────────────────────────────────────────────────
const rnd  = (a, b) => Math.random() * (b - a) + a;
const dst  = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mtr  = m => Math.sqrt(m) * 1.5 + 3;
const clamp= (v, a, b) => v < a ? a : v > b ? b : v;
function speedMult(mass) {
  if (mass >= 10000) return Math.pow(0.9, 5);
  if (mass >= 5000)  return Math.pow(0.9, 4);
  if (mass >= 2000)  return Math.pow(0.9, 3);
  if (mass >= 1000)  return Math.pow(0.9, 2);
  if (mass >= 500)   return Math.pow(0.9, 1);
  return 1;
}
function baseSpd(mass) { return 5 * speedMult(mass); }

function mkFood() {
  const roll = Math.random() * 100;
  let acc = 0;
  for (const ft of FOOD_SIZES) { acc += ft.w; if (roll < acc) return { id: uid(), x: rnd(30, GW - 30), y: rnd(30, GH - 30), mass: ft.mass, r: ft.r, col: `hsl(${0|rnd(0,360)},80%,65%)` }; }
  return { id: uid(), x: rnd(30, GW - 30), y: rnd(30, GH - 30), mass: 5, r: 3, col: '#aaa' };
}

let _id = 0;
function uid() { return (++_id).toString(36); }

// ── State ─────────────────────────────────────────────────────
let players = {};  // socket.id → player
let bots    = [];
let food    = [];
let items   = [];
let bullets = [];

function initWorld() {
  food  = Array.from({ length: FOOD_COUNT }, mkFood);
  items = [];
  ITEM_TYPES.forEach(t => { for (let i = 0; i < ITEM_MAX; i++) spawnItem(t); });
  bots  = Array.from({ length: BOT_COUNT }, (_, i) => mkBot(i));
  bullets = [];
}

function spawnItem(t) {
  const cnt = items.filter(x => x.type === t).length;
  if (cnt >= ITEM_MAX) return;
  items.push({ id: uid(), x: rnd(100, GW - 100), y: rnd(100, GH - 100), type: t, r: 14, col: ITEM_COLS[t], label: t, pickup: t !== 'TOXIC' });
}
function schedRespawn(t) { setTimeout(() => spawnItem(t), 15000); }

function mkBot(i) {
  return { id: 'bot_' + i, x: rnd(500, GW - 500), y: rnd(500, GH - 500), mass: rnd(15, 80), vx: 0, vy: 0, col: BCOLS[i % 15], name: BNAMES[i % 15] + (i >= 15 ? '_' + (i / 15 | 0) : ''), atx: rnd(0, GW), aty: rnd(0, GH), at: 0, st: 0, isBot: true };
}

function mkPlayer(id, name, color, flag) {
  return { id, name: name || 'Player', color: color || '#00cfff', flag: flag || null, x: rnd(500, GW - 500), y: rnd(500, GH - 500), mass: 10, vx: 0, vy: 0, shieldEnd: 0, stealthEnd: 0, _dashFrames: 0, _dashNx: 0, _dashNy: 0, inv: { dash: 0, shield: 0, stealth: 0, bomb: 0, magnet: 0 }, cdQ: 0, cdW: 0, cdR: 0, cdB: 0, cdF: 0, alive: true };
}

// ── Socket events ─────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[+]', socket.id);

  socket.on('join', ({ name, color, flag }) => {
    players[socket.id] = mkPlayer(socket.id, name, color, flag);
    socket.emit('init', { id: socket.id, food, items, bots: bots.map(botsnapshot), worldW: GW, worldH: GH });
    io.emit('playerList', playerList());
  });

  socket.on('input', ({ vx, vy }) => {
    const p = players[socket.id];
    if (!p || !p.alive) return;
    p.inputVx = clamp(vx, -1, 1);
    p.inputVy = clamp(vy, -1, 1);
  });

  socket.on('dash', ({ nx, ny }) => {
    const p = players[socket.id];
    if (!p || p.inv.dash <= 0 || p.cdQ > 0) return;
    p.inv.dash--;
    p.cdQ = 2000;
    p.vx = nx * 40; p.vy = ny * 40;
    p._dashFrames = 12; p._dashNx = nx; p._dashNy = ny;
  });

  socket.on('shield', () => {
    const p = players[socket.id];
    if (!p || p.inv.shield <= 0 || p.cdW > 0) return;
    p.inv.shield--; p.cdW = 3000; p.shieldEnd = Date.now() + 3000;
  });

  socket.on('stealth', () => {
    const p = players[socket.id];
    if (!p || p.inv.stealth <= 0 || p.cdR > 0) return;
    p.inv.stealth--; p.cdR = 3000; p.stealthEnd = Date.now() + 3000;
  });

  socket.on('bomb', ({ nx, ny }) => {
    const p = players[socket.id];
    if (!p || p.inv.bomb <= 0 || p.cdB > 0) return;
    p.inv.bomb--; p.cdB = 1500;
    const pr = mtr(p.mass);
    bullets.push({ id: uid(), x: p.x + nx * (pr + 8), y: p.y + ny * (pr + 8), vx: nx * 20, vy: ny * 20, type: 'bomb', r: 14, life: 15, col: '#f80', ownerId: socket.id });
  });

  socket.on('magnet', () => {
    const p = players[socket.id];
    if (!p || p.inv.magnet <= 0 || p.cdF > 0) return;
    p.inv.magnet--; p.cdF = 1000;
    const range = mtr(p.mass) + 300;
    let n = 0;
    for (let i = food.length - 1; i >= 0; i--) {
      if (dst(p, food[i]) < range) { p.mass = Math.min(10000, p.mass + food[i].mass); food[i] = mkFood(); n++; }
    }
    socket.emit('msg', { text: `MAGNET pulled ${n} food!`, col: '#f0f' });
  });

  socket.on('shoot', ({ nx, ny }) => {
    const p = players[socket.id];
    if (!p || p.mass <= 20) return;
    const now = Date.now();
    if (!p._lastShot) p._lastShot = 0;
    if (now - p._lastShot < 100) return;
    p._lastShot = now;
    p.mass -= 1;
    const r = mtr(p.mass);
    bullets.push({ id: uid(), x: p.x + nx * (r + 8), y: p.y + ny * (r + 8), vx: nx * 20, vy: ny * 20, type: 'shot', r: 3, life: 25, col: p.color, ownerId: socket.id });
  });

  socket.on('disconnect', () => {
    console.log('[-]', socket.id);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
    io.emit('playerList', playerList());
  });
});

function playerList() {
  return Object.values(players).map(p => ({ id: p.id, name: p.name, mass: Math.floor(p.mass) })).sort((a, b) => b.mass - a.mass);
}
function botsnapshot(b) { return { id: b.id, x: b.x, y: b.y, mass: b.mass, col: b.col, name: b.name, isBot: true }; }

// ── Game loop ─────────────────────────────────────────────────
const DT = TICK_MS / 16.67;

setInterval(() => {
  const now = Date.now();
  const pArr = Object.values(players).filter(p => p.alive);

  // Update players
  pArr.forEach(p => {
    // Cooldowns
    if (p.cdQ > 0) p.cdQ -= TICK_MS;
    if (p.cdW > 0) p.cdW -= TICK_MS;
    if (p.cdR > 0) p.cdR -= TICK_MS;
    if (p.cdB > 0) p.cdB -= TICK_MS;
    if (p.cdF > 0) p.cdF -= TICK_MS;

    const spd = baseSpd(p.mass);
    if (p._dashFrames > 0) {
      p._dashFrames--;
      p.vx *= 0.82; p.vy *= 0.82;
    } else if (p.inputVx !== undefined) {
      p.vx += (p.inputVx * spd - p.vx) * 0.15;
      p.vy += (p.inputVy * spd - p.vy) * 0.15;
      p.vx *= 0.85; p.vy *= 0.85;
    }
    const pr = mtr(p.mass);
    p.x = clamp(p.x + p.vx * DT, pr, GW - pr);
    p.y = clamp(p.y + p.vy * DT, pr, GH - pr);
    p.mass = clamp(p.mass, 10, 10000);

    // Eat food
    for (let i = food.length - 1; i >= 0; i--) {
      const f = food[i];
      if (p.mass > f.mass * 1.1 && dst(p, f) < pr + f.r) {
        p.mass = Math.min(10000, p.mass + f.mass);
        food[i] = mkFood();
      }
    }

    // Pickup items
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it.pickup) continue;
      if (dst(p, it) < pr + it.r) {
        if (it.type === 'DASH')    p.inv.dash++;
        else if (it.type === 'SHIELD')  p.inv.shield++;
        else if (it.type === 'STEALTH') p.inv.stealth++;
        else if (it.type === 'GROW1')   p.mass = Math.min(10000, p.mass + 100);
        else if (it.type === 'GROW2')   p.mass = Math.min(10000, p.mass + 200);
        else if (it.type === 'GROW5')   p.mass = Math.min(10000, p.mass + 500);
        else if (it.type === 'MAGNET')  p.inv.magnet++;
        else if (it.type === 'BOMB')    p.inv.bomb++;
        const t = it.type;
        items.splice(i, 1);
        schedRespawn(t);
      }
    }

    // TOXIC passive
    items.forEach(it => {
      if (it.type !== 'TOXIC') return;
      if (dst(p, it) < 100) p.mass = Math.max(10, p.mass * (1 - 0.05 * DT / 60));
    });
  });

  // Player vs player
  pArr.forEach(p => {
    const shielded = now < p.shieldEnd;
    pArr.forEach(q => {
      if (p.id === q.id) return;
      if (p.mass > q.mass * 1.1 && dst(p, q) < mtr(p.mass)) {
        if (now < q.shieldEnd) return;
        p.mass = Math.min(10000, p.mass + q.mass * 0.7);
        io.emit('explode', { x: q.x, y: q.y, col: q.color });
        io.emit('msg', { text: `${p.name} absorbed ${q.name}!`, col: '#0ff' });
        q.mass = 10; q.x = rnd(500, GW - 500); q.y = rnd(500, GH - 500);
        io.to(q.id).emit('respawn');
      }
    });
  });

  // Bullets
  const eatenBullets = [];
  bullets.forEach(b => {
    b.x += b.vx * DT; b.y += b.vy * DT; b.life -= DT;
    if (b.life <= 0 || b.x < 0 || b.x > GW || b.y < 0 || b.y > GH) { eatenBullets.push(b.id); return; }

    // Hit players
    pArr.forEach(p => {
      if (p.id === b.ownerId || now < p.shieldEnd) return;
      if (dst(b, p) < b.r + mtr(p.mass)) {
        if (b.type === 'bomb') { p.mass = Math.max(10, p.mass * 0.7); }
        else { p.mass -= 5; }
        io.emit('explode', { x: b.x, y: b.y, col: b.col });
        eatenBullets.push(b.id);
        if (p.mass < 20) {
          io.emit('explode', { x: p.x, y: p.y, col: p.color });
          io.emit('msg', { text: `${p.name} eliminated!`, col: '#f44' });
          p.mass = 10; p.x = rnd(500, GW - 500); p.y = rnd(500, GH - 500);
          io.to(p.id).emit('respawn');
        }
      }
    });

    // Hit bots
    bots.forEach(bot => {
      if (b.ownerId === bot.id) return;
      if (dst(b, bot) < b.r + mtr(bot.mass)) {
        if (b.type === 'bomb') { bot.mass = Math.max(5, bot.mass * 0.7); }
        else { bot.mass -= 5; }
        io.emit('explode', { x: b.x, y: b.y, col: b.col });
        eatenBullets.push(b.id);
        if (bot.mass < 20) {
          io.emit('explode', { x: bot.x, y: bot.y, col: bot.col });
          bot.mass = rnd(20, 60); bot.x = rnd(100, GW - 100); bot.y = rnd(100, GH - 100);
        }
      }
    });
  });
  bullets = bullets.filter(b => !eatenBullets.includes(b.id));

  // Bot AI
  bots.forEach(bot => {
    bot.at -= DT; bot.st -= DT;
    if (bot.at <= 0) {
      bot.at = rnd(20, 60);
      let best = null, bs = -Infinity, fleeX = 0, fleeY = 0, fleeing = false;

      // Flee from bigger threats
      bots.forEach(b2 => {
        if (b2 === bot) return;
        const d = dst(bot, b2);
        if (b2.mass > bot.mass * 1.1 && d < 300) { fleeX += (bot.x - b2.x) / d; fleeY += (bot.y - b2.y) / d; fleeing = true; }
      });
      pArr.forEach(p => {
        if (now < p.stealthEnd) return;
        const d = dst(bot, p);
        if (p.mass > bot.mass * 1.1 && d < 300) { fleeX += (bot.x - p.x) / d; fleeY += (bot.y - p.y) / d; fleeing = true; }
      });

      if (fleeing) {
        const fl = Math.hypot(fleeX, fleeY) || 1;
        bot.atx = clamp(bot.x + fleeX / fl * 400, 100, GW - 100);
        bot.aty = clamp(bot.y + fleeY / fl * 400, 100, GH - 100);
      } else {
        food.forEach(f => { if (bot.mass > f.mass * 1.1) { const s = f.mass / (dst(bot, f) + 1); if (s > bs) { bs = s; best = f; } } });
        bots.forEach(b2 => { if (b2 !== bot && bot.mass > b2.mass * 1.1) { const s = 400 / (dst(bot, b2) + 1); if (s > bs) { bs = s; best = b2; } } });
        pArr.forEach(p => {
          if (now < p.stealthEnd) return;
          if (bot.mass > p.mass * 1.1 && dst(bot, p) < 500) { const s = 600 / (dst(bot, p) + 1); if (s > bs) { bs = s; best = p; } }
        });
        bot.atx = best ? best.x : rnd(100, GW - 100);
        bot.aty = best ? best.y : rnd(100, GH - 100);
      }
    }

    const bdx = bot.atx - bot.x, bdy = bot.aty - bot.y, bl = Math.hypot(bdx, bdy) || 1;
    const bspd = baseSpd(bot.mass);
    bot.vx += (bdx / bl * bspd - bot.vx) * 0.12; bot.vy += (bdy / bl * bspd - bot.vy) * 0.12;
    bot.vx *= 0.85; bot.vy *= 0.85;
    const br = mtr(bot.mass);
    bot.x = clamp(bot.x + bot.vx * DT, br, GW - br);
    bot.y = clamp(bot.y + bot.vy * DT, br, GH - br);

    // Bot eat food
    for (let i = food.length - 1; i >= 0; i--) { if (bot.mass > food[i].mass * 1.1 && dst(bot, food[i]) < br + food[i].r) { bot.mass = Math.min(10000, bot.mass + food[i].mass); food[i] = mkFood(); } }
    // Bot eat smaller bot
    bots.forEach(b2 => { if (b2 === bot) return; if (bot.mass > b2.mass * 1.1 && dst(bot, b2) < br) { bot.mass = Math.min(10000, bot.mass + b2.mass * 0.7); b2.mass = rnd(20, 60); b2.x = rnd(100, GW - 100); b2.y = rnd(100, GH - 100); } });
    // Bot eat player
    pArr.forEach(p => {
      if (now < p.shieldEnd) return;
      if (bot.mass > p.mass * 1.1 && dst(bot, p) < br) {
        bot.mass = Math.min(10000, bot.mass + p.mass * 0.7);
        io.emit('explode', { x: p.x, y: p.y, col: p.color });
        io.emit('msg', { text: `${p.name} absorbed by ${bot.name}!`, col: '#f80' });
        p.mass = 10; p.x = rnd(500, GW - 500); p.y = rnd(500, GH - 500);
        io.to(p.id).emit('respawn');
      }
    });
    // Player eat bot
    pArr.forEach(p => { if (p.mass > bot.mass * 1.1 && dst(p, bot) < mtr(p.mass)) { p.mass = Math.min(10000, p.mass + bot.mass * 0.7); bot.mass = rnd(20, 60); bot.x = rnd(100, GW - 100); bot.y = rnd(100, GH - 100); } });
    // Bot shoot
    if (bot.st <= 0) {
      bot.st = rnd(80, 220);
      pArr.forEach(p => {
        if (now < p.stealthEnd) return;
        const dd = dst(bot, p);
        if (dd < 500 && dd > 1 && bot.mass > 20) {
          const nx = (p.x - bot.x) / dd, ny = (p.y - bot.y) / dd;
          bullets.push({ id: uid(), x: bot.x + nx * (br + 8), y: bot.y + ny * (br + 8), vx: nx * 16, vy: ny * 16, type: 'shot', r: 3, life: 32, col: bot.col, ownerId: bot.id });
          bot.mass = Math.max(5, bot.mass - 1);
        }
      });
    }
    // TOXIC passive on bots
    items.forEach(it => { if (it.type !== 'TOXIC') return; if (dst(bot, it) < 100) bot.mass = Math.max(5, bot.mass * (1 - 0.05 * DT / 60)); });
    if (bot.mass < 20) { bot.mass = rnd(20, 60); bot.x = rnd(100, GW - 100); bot.y = rnd(100, GH - 100); }
  });

  // Broadcast game state (every tick)
  const state = {
    players: pArr.map(p => ({
      id: p.id, name: p.name, color: p.color, flag: p.flag,
      x: p.x, y: p.y, mass: p.mass,
      shielded: now < p.shieldEnd, stealthed: now < p.stealthEnd,
      inv: p.inv, cdQ: p.cdQ, cdW: p.cdW, cdR: p.cdR, cdB: p.cdB, cdF: p.cdF,
    })),
    bots: bots.map(b => ({ id: b.id, x: b.x, y: b.y, mass: b.mass, col: b.col, name: b.name })),
    bullets: bullets.map(b => ({ id: b.id, x: b.x, y: b.y, r: b.r, col: b.col, type: b.type })),
  };
  io.emit('state', state);

  // Leaderboard every 1s
}, TICK_MS);

setInterval(() => { io.emit('playerList', playerList()); }, 1000);

// Start
initWorld();
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SpaceCell Online running at http://localhost:${PORT}`));
