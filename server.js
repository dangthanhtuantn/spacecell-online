const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// ── Constants ─────────────────────────────────────────────────
const GW = 6000, GH = 6000;
const FOOD_COUNT = 1200; // same density as before (1500/10000² * 6000² ≈ 540, boost to 1200)
const BOT_COUNT = 20;
const TICK_MS = 33;           // ~30fps tick; client interpolates to 60fps
const LERP_P=0.2;   // player lerp per tick (33ms)
const LERP_B=0.15;  // bot lerp per tick
const FRIC=0.82;    // friction per tick

// Frame-rate independent physics helpers
// These scale lerp/friction correctly for any DT
function lerpFactor(base,dt){return 1-Math.pow(1-base,dt);}
function fricFactor(dt){return Math.pow(FRIC,dt);}

let accumulator=0; // fixed timestep accumulator
let lastTick=Date.now(); // for elapsed measurement
const ITEM_MAX = 10;
const WORLD_UPDATE_MS = 600;
const AOI_RANGE = 3500;       // Area of Interest radius
const BOT_AI_GROUP = 4;       // Interleaved AI: update 4 bots per tick

// ── Spatial Grid — local update only, no full rebuild ─────────
const GRID_SIZE = 500;
const GRID_COLS = Math.ceil(GW / GRID_SIZE);
const GRID_ROWS = Math.ceil(GH / GRID_SIZE);
const foodGrid = Array.from({length:GRID_COLS}, ()=>Array.from({length:GRID_ROWS}, ()=>new Set()));

function gridCell(x, y) {
  return [clamp(Math.floor(x/GRID_SIZE),0,GRID_COLS-1), clamp(Math.floor(y/GRID_SIZE),0,GRID_ROWS-1)];
}
function gridAdd(i)    { const [c,r]=gridCell(food[i].x,food[i].y); foodGrid[c][r].add(i); }
function gridRemove(i) { const [c,r]=gridCell(food[i].x,food[i].y); foodGrid[c][r].delete(i); }

function buildFoodGrid() {
  for (let c=0;c<GRID_COLS;c++) for (let r=0;r<GRID_ROWS;r++) foodGrid[c][r].clear();
  for (let i=0;i<food.length;i++) gridAdd(i);
}

function nearbyFood(x, y, radius) {
  const result=[], c0=clamp(Math.floor((x-radius)/GRID_SIZE),0,GRID_COLS-1),
    c1=clamp(Math.floor((x+radius)/GRID_SIZE),0,GRID_COLS-1),
    r0=clamp(Math.floor((y-radius)/GRID_SIZE),0,GRID_ROWS-1),
    r1=clamp(Math.floor((y+radius)/GRID_SIZE),0,GRID_ROWS-1);
  for (let c=c0;c<=c1;c++) for (let r=r0;r<=r1;r++) for (const i of foodGrid[c][r]) result.push(i);
  return result;
}

// Replace food[i] in-place + update grid locally (no full rebuild)
function replaceFood(i) {
  gridRemove(i);
  food[i] = mkFood();
  gridAdd(i);
}

// ── Helpers ───────────────────────────────────────────────────
const rnd = (a,b) => Math.random()*(b-a)+a;
const dst2 = (ax,ay,bx,by) => (ax-bx)*(ax-bx)+(ay-by)*(ay-by);
const dst  = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
const mtr  = m => Math.sqrt(m)*1.5+3;
const clamp = (v,a,b) => v<a?a:v>b?b:v;

function speedMult(mass) {
  if (mass>=10000) return 0.59049; if (mass>=5000) return 0.6561;
  if (mass>=2000)  return 0.729;   if (mass>=1000) return 0.81;
  if (mass>=500)   return 0.9;     return 1;
}
function baseSpd(mass) { return 5*speedMult(mass); }

const FOOD_SIZES=[{mass:5,r:3,w:50},{mass:10,r:4,w:25},{mass:20,r:5,w:15},{mass:50,r:7,w:5},{mass:100,r:10,w:5}];
function mkFood() {
  const roll=Math.random()*100; let acc=0;
  for (const ft of FOOD_SIZES) { acc+=ft.w; if(roll<acc) return {x:rnd(30,GW-30),y:rnd(30,GH-30),mass:ft.mass,r:ft.r,col:`hsl(${0|rnd(0,360)},80%,65%)`}; }
  return {x:rnd(30,GW-30),y:rnd(30,GH-30),mass:5,r:3,col:'#aaa'};
}

const ITEM_TYPES=['DASH','SHIELD','STEALTH','GROW1','GROW2','GROW5','MAGNET','TOXIC','BOMB'];
const ITEM_COLS={DASH:'#0cf',SHIELD:'#88f',STEALTH:'#ccc',GROW1:'#4f4',GROW2:'#2d2',GROW5:'#1a1',MAGNET:'#f0f',TOXIC:'#8f0',BOMB:'#f80'};
const BNAMES=['Orion','Lyra','Nebula','Vega','Pulsar','Quasar','Sirius','Nova','Titan','Andromeda','Zeta','Rigel','Spica','Altair','Deneb'];
const BCOLS=['#f55','#f90','#ff4','#4f4','#4cf','#f4f','#fa4','#5fa','#f5a','#af5','#5af','#ff8','#f64','#6f4','#46f'];
let _id=0; const uid=()=>(++_id).toString(36);

// ── State ─────────────────────────────────────────────────────
let players={}, bots=[], food=[], items=[], bullets=[];
let botAIOffset=0;

// Bullet pool — reuse objects to reduce GC pressure
const POOL_SIZE=300;
const bulletPool=Array.from({length:POOL_SIZE},()=>({active:false}));
function acquireBullet(props) {
  let b=null;
  for (let i=0;i<POOL_SIZE;i++) if (!bulletPool[i].active){b=bulletPool[i];break;}
  if (!b) b={active:false};
  return Object.assign(b,props,{active:true});
}

function initWorld() {
  food=Array.from({length:FOOD_COUNT},mkFood);
  items=[];
  ITEM_TYPES.forEach(t=>{for(let i=0;i<ITEM_MAX;i++)spawnItem(t);});
  bots=Array.from({length:BOT_COUNT},(_,i)=>mkBot(i));
  bullets=[];
  buildFoodGrid();
}

function spawnItem(t) {
  if (items.filter(x=>x.type===t).length>=ITEM_MAX) return;
  items.push({id:uid(),x:rnd(100,GW-100),y:rnd(100,GH-100),type:t,r:14,col:ITEM_COLS[t],label:t,pickup:t!=='TOXIC'});
}
function schedRespawn(t){setTimeout(()=>spawnItem(t),15000);}

function mkBot(i) {
  return {id:'b'+i,x:rnd(500,GW-500),y:rnd(500,GH-500),mass:rnd(15,80),vx:0,vy:0,
    col:BCOLS[i%15],name:BNAMES[i%15]+(i>=15?'_'+(i/15|0):''),atx:rnd(0,GW),aty:rnd(0,GH),at:0,st:0};
}
function mkPlayer(id,name,color,flag) {
  return {id,name:name||'Player',color:color||'#00cfff',flag:flag||null,
    x:rnd(300,GW-300),y:rnd(300,GH-300),mass:20,vx:0,vy:0,
    shieldEnd:0,stealthEnd:0,_dashFrames:0,
    inv:{dash:0,shield:0,stealth:0,bomb:0,magnet:0},
    cdQ:0,cdW:0,cdR:0,cdB:0,cdF:0,_lastShot:0};
}
function bSnap(b){return {id:b.id,x:b.x,y:b.y,mass:b.mass,col:b.col,name:b.name};}

// ── Sockets ───────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('[+]', socket.id);

  socket.on('join',({name,color,flag})=>{
    const p=mkPlayer(socket.id,name,color,flag);
    players[socket.id]=p;
    socket.emit('init',{id:socket.id,spawnX:p.x,spawnY:p.y,food,items,bots:bots.map(bSnap),worldW:GW,worldH:GH});
    socket.emit('worldUpdate',{food,items});
    io.emit('playerList',playerList());
  });

  socket.on('input',({vx,vy})=>{
    const p=players[socket.id];if(!p)return;
    p.inputVx=clamp(vx,-1,1);p.inputVy=clamp(vy,-1,1);
  });
  socket.on('dash',({nx,ny})=>{
    const p=players[socket.id];if(!p||p.inv.dash<=0||p.cdQ>0)return;
    p.inv.dash--;p.cdQ=2000;p.vx=nx*40;p.vy=ny*40;p._dashFrames=12;
  });
  socket.on('shield',()=>{
    const p=players[socket.id];if(!p||p.inv.shield<=0||p.cdW>0)return;
    p.inv.shield--;p.cdW=3000;p.shieldEnd=Date.now()+3000;
  });
  socket.on('stealth',()=>{
    const p=players[socket.id];if(!p||p.inv.stealth<=0||p.cdR>0)return;
    p.inv.stealth--;p.cdR=5000;p.stealthEnd=Date.now()+5000;
  });
  socket.on('bomb',({nx,ny})=>{
    const p=players[socket.id];if(!p||p.inv.bomb<=0||p.cdB>0)return;
    p.inv.bomb--;p.cdB=1500;const pr=mtr(p.mass);
    bullets.push(acquireBullet({id:uid(),x:p.x+nx*(pr+8),y:p.y+ny*(pr+8),vx:nx*20,vy:ny*20,type:'bomb',r:14,life:15,col:'#f80',ownerId:socket.id}));
  });
  socket.on('magnet',()=>{
    const p=players[socket.id];if(!p||p.inv.magnet<=0||p.cdF>0)return;
    p.inv.magnet--;p.cdF=1000;
    const range=mtr(p.mass)+300,range2=range*range;
    const nearby=nearbyFood(p.x,p.y,range);let n=0;
    for (let k=0;k<nearby.length;k++){
      const i=nearby[k];
      if(dst2(p.x,p.y,food[i].x,food[i].y)<range2){p.mass=Math.min(10000,p.mass+food[i].mass);replaceFood(i);n++;}
    }
    socket.emit('msg',{text:'MAGNET pulled '+n+' food!',col:'#f0f'});
  });
  socket.on('shoot',({nx,ny})=>{
    const p=players[socket.id];if(!p||p.mass<=20)return;
    const now=Date.now();if(now-p._lastShot<100)return;
    p._lastShot=now;p.mass-=1;const r=mtr(p.mass);
    bullets.push(acquireBullet({id:uid(),x:p.x+nx*(r+8),y:p.y+ny*(r+8),vx:nx*20,vy:ny*20,type:'shot',r:3,life:25,col:p.color,ownerId:socket.id}));
  });
  socket.on('ping',()=>socket.emit('pong_reply',{t:Date.now()}));
  socket.on('disconnect',()=>{
    delete players[socket.id];
    io.emit('playerLeft',socket.id);
    io.emit('playerList',playerList());
  });
});

function playerList() {
  const arr=Object.values(players),result=[];
  for(let i=0;i<arr.length;i++) result.push({id:arr[i].id,name:arr[i].name,mass:Math.floor(arr[i].mass)});
  return result.sort((a,b)=>b.mass-a.mass);
}

// ── Game loop ──────────────────────────────────────────────────

// Pending events — batched after physics to avoid mid-loop emit delays
const pendingEmits=[];
function qEmit(ev,data){pendingEmits.push({ev,data,to:null});}
function qEmitTo(id,ev,data){pendingEmits.push({ev,data,to:id});}

// Self-correcting game loop using setTimeout (avoids setInterval drift)
function tick(){
  const now=Date.now();
  const elapsed=Math.min(now-lastTick,66); // cap at 66ms to prevent spiral
  lastTick=now;
  accumulator+=elapsed;

  // Run fixed-step physics (TICK_MS per step) - stable regardless of real elapsed
  let steps=0;
  while(accumulator>=TICK_MS&&steps<3){ // max 3 steps per real tick
    accumulator-=TICK_MS;
    steps++;
    const DT=1; // 1.0 = exactly one tick - physics are normalized per tick now
    physicsStep(DT,now);
  }

  // Broadcast once per real tick (not per physics step)
  broadcastState(now);

  const spent=Date.now()-now;
  setTimeout(tick,Math.max(0,TICK_MS-spent));
}

function physicsStep(DT,now){
  const pArr=Object.values(players),pLen=pArr.length,bLen=bots.length;
  const lP=lerpFactor(LERP_P,DT), lB=lerpFactor(LERP_B,DT), fr=fricFactor(DT);

  for(let pi=0;pi<pLen;pi++){
    const p=pArr[pi];
    if(p.cdQ>0)p.cdQ-=TICK_MS;if(p.cdW>0)p.cdW-=TICK_MS;
    if(p.cdR>0)p.cdR-=TICK_MS;if(p.cdB>0)p.cdB-=TICK_MS;if(p.cdF>0)p.cdF-=TICK_MS;
    const spd=baseSpd(p.mass);
    if(p._dashFrames>0){p._dashFrames--;p.vx*=fr;p.vy*=fr;}
    else if(p.inputVx!==undefined){p.vx+=(p.inputVx*spd-p.vx)*lP;p.vy+=(p.inputVy*spd-p.vy)*lP;p.vx*=0.82;p.vy*=0.82;}
    const pr=mtr(p.mass);
    p.x=clamp(p.x+p.vx*DT,pr,GW-pr);p.y=clamp(p.y+p.vy*DT,pr,GH-pr);
    p.mass=clamp(p.mass,10,10000);
    const er=pr+15, nearby=nearbyFood(p.x,p.y,er);
    const eaten=new Set(); // prevent double-eating replaced food
    for(let k=0;k<nearby.length;k++){
      const i=nearby[k]; if(eaten.has(i)) continue;
      const f=food[i], hitR=pr+f.r;
      if(p.mass>f.mass*1.05&&dst2(p.x,p.y,f.x,f.y)<hitR*hitR){
        p.mass=Math.min(10000,p.mass+f.mass);
        replaceFood(i); eaten.add(i);
        qEmit('foodEaten',{ni:i,nf:food[i]});
      }
    }
    for(let i=items.length-1;i>=0;i--){
      const it=items[i];if(!it.pickup)continue;const hitR=pr+it.r;
      if(dst2(p.x,p.y,it.x,it.y)<hitR*hitR){
        if(it.type==='DASH')p.inv.dash++;else if(it.type==='SHIELD')p.inv.shield++;
        else if(it.type==='STEALTH')p.inv.stealth++;else if(it.type==='GROW1')p.mass=Math.min(10000,p.mass+100);
        else if(it.type==='GROW2')p.mass=Math.min(10000,p.mass+200);else if(it.type==='GROW5')p.mass=Math.min(10000,p.mass+500);
        else if(it.type==='MAGNET')p.inv.magnet++;else if(it.type==='BOMB')p.inv.bomb++;
        const t=it.type,rid=it.id;items.splice(i,1);schedRespawn(t);qEmit('itemRemoved',rid);
      }
    }
    for(let i=0;i<items.length;i++){if(items[i].type==='TOXIC'&&dst2(p.x,p.y,items[i].x,items[i].y)<10000)p.mass=Math.max(10,p.mass*(1-0.05*DT/60));}
  }

  for(let i=0;i<pLen;i++){
    const p=pArr[i],pr=mtr(p.mass),pr2=pr*pr;
    for(let j=0;j<pLen;j++){
      if(i===j)continue;const q=pArr[j];
      if(now<q.shieldEnd||now<q.stealthEnd)continue;
      if(p.mass>q.mass*1.1&&dst2(p.x,p.y,q.x,q.y)<pr2){
        p.mass=Math.min(10000,p.mass+q.mass*0.7);qEmit('explode',{x:q.x,y:q.y,col:q.color});
        qEmit('msg',{text:p.name+' absorbed '+q.name+'!',col:'#0ff'});qEmitTo(q.id,'died',{by:p.name});
        q.mass=10;q.x=rnd(500,GW-500);q.y=rnd(500,GH-500);
      }
    }
  }

  for(let bi=bullets.length-1;bi>=0;bi--){
    const b=bullets[bi];b.x+=b.vx*DT;b.y+=b.vy*DT;b.life-=DT;
    if(b.life<=0||b.x<0||b.x>GW||b.y<0||b.y>GH){b.active=false;bullets.splice(bi,1);continue;}
    let hit=false;
    for(let pi=0;pi<pLen&&!hit;pi++){
      const p=pArr[pi];if(p.id===b.ownerId||now<p.shieldEnd)continue;
      const hr=b.r+mtr(p.mass);
      if(dst2(b.x,b.y,p.x,p.y)<hr*hr){b.type==='bomb'?p.mass=Math.max(10,p.mass*0.7):p.mass-=5;qEmit('explode',{x:b.x,y:b.y,col:b.col});b.active=false;bullets.splice(bi,1);hit=true;if(p.mass<20){qEmitTo(p.id,'died',{by:'bullet'});p.mass=10;p.x=rnd(500,GW-500);p.y=rnd(500,GH-500);}}
    }
    if(hit)continue;
    for(let bi2=0;bi2<bLen&&!hit;bi2++){
      const bot=bots[bi2];if(bot.id===b.ownerId)continue;
      const hr=b.r+mtr(bot.mass);
      if(dst2(b.x,b.y,bot.x,bot.y)<hr*hr){b.type==='bomb'?bot.mass=Math.max(5,bot.mass*0.7):bot.mass-=5;qEmit('explode',{x:b.x,y:b.y,col:b.col});b.active=false;bullets.splice(bi,1);hit=true;if(bot.mass<20){bot.mass=rnd(20,60);bot.x=rnd(100,GW-100);bot.y=rnd(100,GH-100);}}
    }
  }

  for(let bi=0;bi<BOT_AI_GROUP;bi++){
    const bot=bots[(botAIOffset+bi)%bLen];
    bot.at-=TICK_MS*BOT_AI_GROUP/bLen;bot.st-=DT;
    if(bot.at<=0){
      bot.at=rnd(20,60);let best=null,bestScore=-Infinity,fleeX=0,fleeY=0,fleeing=false;
      for(let pi=0;pi<pLen;pi++){const p=pArr[pi];if(now<p.stealthEnd)continue;const d2=dst2(bot.x,bot.y,p.x,p.y);if(p.mass>bot.mass*1.1&&d2<90000){const d=Math.sqrt(d2);fleeX+=(bot.x-p.x)/d;fleeY+=(bot.y-p.y)/d;fleeing=true;}}
      if(fleeing){const fl=Math.hypot(fleeX,fleeY)||1;bot.atx=clamp(bot.x+fleeX/fl*400,100,GW-100);bot.aty=clamp(bot.y+fleeY/fl*400,100,GH-100);}
      else{
        const nb=nearbyFood(bot.x,bot.y,600);
        for(let k=0;k<nb.length;k++){const f=food[nb[k]];if(bot.mass<=f.mass*1.1)continue;const s=f.mass/(Math.hypot(bot.x-f.x,bot.y-f.y)+1);if(s>bestScore){bestScore=s;best=f;}}
        for(let pi=0;pi<pLen;pi++){const p=pArr[pi];if(now<p.stealthEnd||bot.mass<=p.mass*1.1)continue;const d2=dst2(bot.x,bot.y,p.x,p.y);if(d2<250000){const s=600/(Math.sqrt(d2)+1);if(s>bestScore){bestScore=s;best=p;}}}
        bot.atx=best?best.x:rnd(100,GW-100);bot.aty=best?best.y:rnd(100,GH-100);
      }
    }
    const bdx=bot.atx-bot.x,bdy=bot.aty-bot.y,bl=Math.hypot(bdx,bdy)||1,bspd=baseSpd(bot.mass);
    bot.vx+=(bdx/bl*bspd-bot.vx)*lB;bot.vy+=(bdy/bl*bspd-bot.vy)*lB;bot.vx*=fr;bot.vy*=fr;
    const br=mtr(bot.mass);
    bot.x=clamp(bot.x+bot.vx*DT,br,GW-br);bot.y=clamp(bot.y+bot.vy*DT,br,GH-br);
    const bnear=nearbyFood(bot.x,bot.y,br+15);
    for(let k=0;k<bnear.length;k++){const i=bnear[k],f=food[i],hr=br+f.r;if(bot.mass>f.mass*1.1&&dst2(bot.x,bot.y,f.x,f.y)<hr*hr){bot.mass=Math.min(10000,bot.mass+f.mass);replaceFood(i);}}
    for(let pi=0;pi<pLen;pi++){
      const p=pArr[pi];if(now<p.shieldEnd)continue;
      if(bot.mass>p.mass*1.1&&dst2(bot.x,bot.y,p.x,p.y)<br*br){bot.mass=Math.min(10000,bot.mass+p.mass*0.7);qEmit('explode',{x:p.x,y:p.y,col:p.color});qEmitTo(p.id,'died',{by:bot.name});p.mass=10;p.x=rnd(500,GW-500);p.y=rnd(500,GH-500);}
      const prd=mtr(p.mass);
      if(p.mass>bot.mass*1.1&&dst2(p.x,p.y,bot.x,bot.y)<prd*prd){p.mass=Math.min(10000,p.mass+bot.mass*0.7);qEmit('explode',{x:bot.x,y:bot.y,col:bot.col});bot.mass=rnd(20,60);bot.x=rnd(100,GW-100);bot.y=rnd(100,GH-100);}
    }
    if(bot.st<=0&&bot.mass>20){bot.st=rnd(80,220);for(let pi=0;pi<pLen;pi++){const p=pArr[pi];if(now<p.stealthEnd)continue;const dd2=dst2(bot.x,bot.y,p.x,p.y);if(dd2>1&&dd2<250000){const dd=Math.sqrt(dd2),nx=(p.x-bot.x)/dd,ny=(p.y-bot.y)/dd;bullets.push(acquireBullet({id:uid(),x:bot.x+nx*(br+8),y:bot.y+ny*(br+8),vx:nx*16,vy:ny*16,type:'shot',r:3,life:32,col:bot.col,ownerId:bot.id}));bot.mass=Math.max(5,bot.mass-1);}}}
    for(let ii=0;ii<items.length;ii++){if(items[ii].type==='TOXIC'&&dst2(bot.x,bot.y,items[ii].x,items[ii].y)<10000)bot.mass=Math.max(5,bot.mass*(1-0.05*DT/60));}
    if(bot.mass<20){bot.mass=rnd(20,60);bot.x=rnd(100,GW-100);bot.y=rnd(100,GH-100);}
  }
  if(bLen>0) botAIOffset=(botAIOffset+BOT_AI_GROUP)%bLen;

  // Flush batched events AFTER all physics
  for(let i=0;i<pendingEmits.length;i++){const e=pendingEmits[i];e.to?io.to(e.to).emit(e.ev,e.data):io.emit(e.ev,e.data);}
  pendingEmits.length=0;
} // end physicsStep

function broadcastState(now){
  const pArr=Object.values(players),pLen=pArr.length,bLen=bots.length;
  const aoiR2=AOI_RANGE*AOI_RANGE;
  for(let pi=0;pi<pLen;pi++){
    const p=pArr[pi],sock=io.sockets.sockets.get(p.id);if(!sock)continue;
    const visP=[],visB=[],visBu=[];
    // Self: use compact keys to reduce bandwidth
    visP.push({i:p.id,n:p.name,c:p.color,f:p.flag,x:Math.round(p.x),y:Math.round(p.y),m:Math.round(p.mass),sh:now<p.shieldEnd?1:0,st:now<p.stealthEnd?1:0,inv:p.inv,cQ:p.cdQ,cW:p.cdW,cR:p.cdR,cB:p.cdB,cF:p.cdF});
    for(let j=0;j<pLen;j++){
      if(j===pi)continue;const q=pArr[j];
      if(dst2(p.x,p.y,q.x,q.y)<aoiR2)
        visP.push({i:q.id,n:q.name,c:q.color,f:q.flag,x:Math.round(q.x),y:Math.round(q.y),m:Math.round(q.mass),sh:now<q.shieldEnd?1:0,st:now<q.stealthEnd?1:0,inv:q.inv,cQ:q.cdQ,cW:q.cdW,cR:q.cdR,cB:q.cdB,cF:q.cdF});
    }
    for(let bi=0;bi<bLen;bi++){
      const b=bots[bi];
      if(dst2(p.x,p.y,b.x,b.y)<aoiR2)
        visB.push({i:b.id,x:Math.round(b.x),y:Math.round(b.y),m:Math.round(b.mass),c:b.col,n:b.name});
    }
    for(let bi=0;bi<bullets.length;bi++){
      const b=bullets[bi];
      if(dst2(p.x,p.y,b.x,b.y)<aoiR2)
        visBu.push({i:b.id,x:Math.round(b.x),y:Math.round(b.y),r:b.r,c:b.col,t:b.type==='bomb'?1:0});
    }
    sock.emit('state',{t:now,p:visP,b:visB,u:visBu});
  }
}
setTimeout(tick,TICK_MS);


setInterval(()=>{io.emit('worldUpdate',{food,items});},WORLD_UPDATE_MS);
setInterval(()=>{io.emit('playerList',playerList());},2000);

initWorld();
const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`SpaceCell Online at http://localhost:${PORT}`));
